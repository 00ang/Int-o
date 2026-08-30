import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { stableId } from '../core/ids.js';
import { structured } from '../core/llm.js';
import {
  getSource, insertEvent, itemsAwaitingExtraction, markItemExtracted, resolveEntity,
} from '../core/store.js';
import type { Event, EventEntity, Item } from '../core/types.js';
import { type Extraction, ExtractionSchema } from './schema.js';

/**
 * The extraction instructions.
 *
 * Two things in here do most of the work.
 *
 * The `beneficiary` role is the one that makes the connection engine useful.
 * Most extractors record who acted and who was acted upon; recording who stands
 * to gain is what later lets a detector ask whether the gainer was positioned
 * beforehand.
 *
 * The `assertion` level is the guard against laundering speculation into fact.
 * A filing is `documented`. A wire report is `reported`. An indictment's claims
 * are `alleged`. A columnist's inference is `speculated`. Downstream, only
 * documented and reported events can support a high-confidence connection.
 */
const SYSTEM = `You extract structured events from news and primary-source documents for a personal intelligence system.

An event is a specific, datable thing that happened: a rule issued, a contract awarded, a trade disclosed, a suit filed, a strike carried out, a statement made, a finding published. It is not a topic, a trend, or a description of a situation.

Rules:

1. Extract only what the text actually asserts. Never add context you happen to know. If the text does not say it, it is not in the output.
2. One item can contain several events. Emit each separately. An item that asserts no datable action - an explainer, an opinion piece with no news peg, a market snapshot - yields an empty list. An empty list is a correct and common answer.
3. occurredAt is when the thing happened, not when it was published. A Tuesday article about a Monday announcement has occurredAt on Monday. When the text gives no date, use the publication date and set occurredAtInferred to true.
4. Entity roles carry the analytical weight, so assign them carefully:
   - actor: did the thing
   - target: had it done to them
   - beneficiary: stands to gain materially from it, where the text supports that reading
   - regulator: the body with authority over it
   - counterparty: the other side of a transaction
   - mentioned: present but none of the above
   Assign beneficiary only where the text gives a concrete basis - a named contractor, a named sector, a named holder. Do not infer beneficiaries from general reasoning about who tends to gain.
5. Use full canonical names. Expand acronyms. Add the ticker when the text identifies a public company.
6. assertion records how firmly the source establishes the event:
   - documented: a filing, register entry, court record, official release or dataset
   - reported: a newsroom asserting it as verified fact
   - alleged: a claim by a party to a dispute, an indictment, an accusation
   - speculated: analysis, prediction, or inference presented as such
   Report the source's footing, not your own confidence.
7. summary is one past-tense sentence naming who did what to whom, readable on its own with no other context.`;

function buildUserPrompt(item: Item, sourceName: string, tier: string): string {
  const parts = [
    `SOURCE: ${sourceName} (credibility tier: ${tier})`,
    `PUBLISHED: ${item.publishedAt}`,
    `URL: ${item.url}`,
    `TITLE: ${item.title}`,
  ];
  if (item.summary) parts.push(`SUMMARY: ${item.summary}`);
  if (item.body) {
    // Long bodies are truncated at a generous bound rather than sent whole:
    // the lede carries the events, and the tail is usually boilerplate.
    const body = item.body.length > 12_000 ? `${item.body.slice(0, 12_000)}\n[truncated]` : item.body;
    parts.push(`BODY:\n${body}`);
  }
  return parts.join('\n');
}

/** Normalise whatever date shape the model returned to an ISO instant. */
function toIso(value: string, fallback: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T12:00:00.000Z`;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

export interface ExtractResult {
  itemId: string;
  eventCount: number;
  error: string | null;
}

/** Extract one item, resolving its entities and writing its events. */
export async function extractItem(db: DB, cfg: Config, item: Item): Promise<ExtractResult> {
  const source = getSource(db, item.sourceId);
  const result: ExtractResult = { itemId: item.id, eventCount: 0, error: null };

  try {
    const out = await structured<Extraction>(cfg, {
      system: SYSTEM,
      user: buildUserPrompt(item, source?.name ?? item.sourceId, source?.tier ?? 'unknown'),
      schema: ExtractionSchema,
      effort: 'medium',
      maxTokens: 8_000,
    });

    const tx = db.transaction(() => {
      for (const [i, e] of out.events.entries()) {
        const entities: EventEntity[] = e.entities.map((ent) => {
          const resolved = resolveEntity(db, {
            name: ent.name,
            kind: ent.kind,
            aliases: ent.surfaceForm === ent.name ? [] : [ent.surfaceForm],
            ticker: ent.ticker ? ent.ticker.toUpperCase() : null,
            country: ent.country,
            seenAt: item.publishedAt,
          });
          return { entityId: resolved.id, role: ent.role, surfaceForm: ent.surfaceForm };
        });

        const event: Event = {
          // Content-addressed on (item, index, summary) so re-extracting an item
          // replaces its events instead of duplicating them.
          id: stableId('evt', item.id, i, e.summary),
          itemId: item.id,
          type: e.type,
          summary: e.summary,
          occurredAt: toIso(e.occurredAt, item.publishedAt),
          occurredAtInferred: e.occurredAtInferred,
          domains: e.domains,
          entities,
          amount: e.amountValue != null
            ? { value: e.amountValue, currency: e.amountCurrency ?? 'USD' }
            : null,
          tags: e.tags,
          assertion: e.assertion,
          createdAt: new Date().toISOString(),
        };
        insertEvent(db, event);
        result.eventCount++;
      }
      markItemExtracted(db, item.id, null);
    });
    tx();
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    // Recorded on the item so a failing source shows up instead of the item
    // silently sitting in the queue forever.
    markItemExtracted(db, item.id, result.error);
  }

  return result;
}

export async function extract(
  db: DB,
  cfg: Config,
  opts: { limit?: number; onProgress?: (r: ExtractResult) => void } = {},
): Promise<ExtractResult[]> {
  const items = itemsAwaitingExtraction(db, opts.limit ?? cfg.extractBatchLimit);
  const results: ExtractResult[] = [];
  for (const item of items) {
    const r = await extractItem(db, cfg, item);
    results.push(r);
    opts.onProgress?.(r);
  }
  return results;
}

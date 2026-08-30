import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { stableId } from '../core/ids.js';
import { structured } from '../core/llm.js';
import { eventsSince, getEntity, insertConnection } from '../core/store.js';
import type { Connection, Event } from '../core/types.js';
import { runAllPairRules, runEntityOverlap } from './detectors/deterministic.js';
import { HypothesesSchema, type Hypothesis } from './schema.js';

/**
 * Hypothesis generation.
 *
 * This is the part of the system most likely to produce something that reads
 * well and is not true, so the instructions push hard in the other direction:
 * name a mechanism, name a falsifier, and decline rather than reach.
 */
const HYPOTHESIS_SYSTEM = `You look for non-obvious connections between recent events for a personal intelligence system.

You are given a numbered list of events. Propose links between them that a well-informed reader would want to know about and would not spot from a headline.

What counts as a connection worth proposing:
- One event materially changes the conditions for another (a rule change alters what a market can do; an export control reroutes a supply chain).
- Two events share a party whose interest in both is not obvious from either alone.
- Two events are steps in one escalation, or one is a precedent for the other.
- Two credible sources assert things that cannot both be true.

Hard rules:

1. Cite only the events given. Never introduce an event, actor, or fact that is not in the list.
2. Every hypothesis needs a mechanism - the actual path by which one thing bears on the other. "Both involve the defense sector" is a category, not a mechanism, and is not a connection.
3. Every hypothesis needs a falsifier: a specific, checkable observation that would show the link is not real. If you cannot state one, do not propose the link.
4. Calibrate confidence honestly. 0.3 means "worth a look". 0.6 means "the mechanism is clear and the timing fits". Above 0.7 should be rare, and only where the events nearly state the link themselves.
5. Shared nationality, shared sector, or proximity in time are not connections on their own.
6. Returning an empty list is correct when the events are genuinely unrelated. Most randomly co-occurring events are unrelated. Do not manufacture a narrative to fill the output.
7. Do not propose links that assert coordination, corruption or conspiracy unless the events themselves document the connecting act. You may note that a pattern is consistent with such a reading; you may not assert it happened.`;

function renderEventList(db: DB, events: Event[]): string {
  return events.map((e, i) => {
    const parties = e.entities
      .map((en) => `${getEntity(db, en.entityId)?.name ?? '?'} (${en.role})`)
      .join(', ');
    return [
      `[${i}] ${e.occurredAt.slice(0, 10)} | ${e.type} | ${e.assertion}`,
      `    ${e.summary}`,
      parties ? `    parties: ${parties}` : '',
      e.amount ? `    amount: ${e.amount.currency} ${e.amount.value.toLocaleString('en-US')}` : '',
      e.tags.length ? `    tags: ${e.tags.join(', ')}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n');
}

/** Hypotheses are capped below the deterministic floor so they never lead a brief. */
const HYPOTHESIS_CONFIDENCE_CAP = 0.7;

export async function generateHypotheses(
  db: DB,
  cfg: Config,
  events: Event[],
): Promise<Connection[]> {
  if (events.length < 2) return [];

  const out = await structured<{ hypotheses: Hypothesis[] }>(cfg, {
    system: HYPOTHESIS_SYSTEM,
    user: `Events under consideration:\n\n${renderEventList(db, events)}`,
    schema: HypothesesSchema,
    // Synthesis across many events benefits from more room to reason than
    // mechanical extraction does.
    effort: 'high',
    maxTokens: 16_000,
  });

  const now = new Date().toISOString();
  return out.hypotheses.flatMap((h) => {
    const from = events[h.fromEventIndex];
    const to = events[h.toEventIndex];
    // Guard against an out-of-range index rather than trusting the indices.
    if (!from || !to || from.id === to.id) return [];
    if (!h.falsifier?.trim()) return [];

    const lagDays =
      (new Date(to.occurredAt).getTime() - new Date(from.occurredAt).getTime()) / 86_400_000;

    return [{
      id: stableId('con', 'llm', from.id, to.id, h.kind),
      kind: h.kind,
      basis: 'hypothesis' as const,
      fromEventId: from.id,
      toEventId: to.id,
      explanation: h.explanation,
      falsifier: h.falsifier,
      confidence: Math.min(h.confidence, HYPOTHESIS_CONFIDENCE_CAP),
      lagDays: Number(lagDays.toFixed(2)),
      sharedEntityIds: from.entities
        .map((e) => e.entityId)
        .filter((id) => to.entities.some((e) => e.entityId === id)),
      producedBy: 'llm',
      createdAt: now,
      verdict: 'unreviewed' as const,
    }];
  });
}

export interface LinkResult {
  deterministic: number;
  entityOverlap: number;
  hypotheses: number;
}

/**
 * Run the connection engine over a recent window.
 *
 * Deterministic rules run first and always; they need no API key and cost
 * nothing. Hypotheses run only when asked, because they cost money and are the
 * weakest evidence in the system.
 */
export async function link(
  db: DB,
  cfg: Config,
  opts: { sinceDays?: number; hypotheses?: boolean; maxEventsForLlm?: number } = {},
): Promise<LinkResult> {
  const { sinceDays = 7, hypotheses = false, maxEventsForLlm = 60 } = opts;
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  const result: LinkResult = { deterministic: 0, entityOverlap: 0, hypotheses: 0 };

  const write = (cs: Connection[]) => {
    const tx = db.transaction((batch: Connection[]) => {
      for (const c of batch) insertConnection(db, c);
    });
    tx(cs);
    return cs.length;
  };

  result.deterministic = write(runAllPairRules(db, since));
  result.entityOverlap = write(runEntityOverlap(db, since));

  if (hypotheses) {
    // Documented and reported events only: asking the model to find mechanisms
    // between two pieces of speculation produces speculation about speculation.
    const candidates = eventsSince(db, since)
      .filter((e) => e.assertion === 'documented' || e.assertion === 'reported')
      .slice(0, maxEventsForLlm);
    result.hypotheses = write(await generateHypotheses(db, cfg, candidates));
  }

  return result;
}

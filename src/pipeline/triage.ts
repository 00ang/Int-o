import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { structured } from '../core/llm.js';
import { getSource, itemsAwaitingTriage, saveTriage } from '../core/store.js';
import type { Item, TriageVerdict } from '../core/types.js';
import { type TriageBatch, TriageBatchSchema, type TriagedItem } from './schema.js';

/**
 * Triage: the judgement that decides what deserves any further effort.
 *
 * This runs before extraction, on everything, and it is the cheapest stage in
 * the system by design. The corpus is mostly procedural - rule amendments,
 * routine awards, scheduled data releases - and the previous ordering, which
 * extracted every item in date order, spent the same money on a locomotive horn
 * regulation as on a disclosed position in a defence contractor. That is how
 * the interesting cases drown.
 *
 * Two properties matter more than accuracy here:
 *
 * **It must be willing to say mundane.** A triage stage that finds everything
 * interesting has not filtered anything, it has only added cost. Most news is
 * exactly what it appears to be and the prompt says so repeatedly.
 *
 * **It must never conclude that something is suspicious.** The ceiling is
 * "worth a look", and what actually gets investigated is a human decision.
 * Nothing downstream of triage runs on its own initiative.
 */
const SYSTEM = `You triage news and primary-source records for one reader, deciding what deserves their attention.

For each item you are given, answer one question: is there plausibly more here than the headline says?

That is not the same as importance. A major earthquake, an expected rate decision, a company reporting the earnings it guided to - these are important and completely mundane for this purpose, because they are exactly what they appear to be. What you are looking for is power or money doing something that the summary does not fully explain.

Signals that something is worth a look:
- A named party stands to gain in a way the piece mentions only in passing, or not at all
- The timing is doing work: an action that lands just before or just after something else that matters
- A decision that is narrower or broader than its stated rationale requires
- A party acting outside their usual remit, or against their apparent interest
- A quiet reversal of a previous position, presented as continuity
- Money, access or authority moving toward someone specific, where the piece frames it as procedural

Signals that something is mundane:
- Scheduled, statutory or calendar-driven events happening on schedule
- Routine regulatory housekeeping: technical amendments, form retirements, deadline notices
- Reporting that fully explains itself, where the interesting facts are all stated
- Commentary, analysis and opinion with no new fact in it
- Disasters, accidents, weather and casualty counts. A flood that kills a thousand people is a tragedy and it is mundane here: it is exactly what it appears to be. It becomes interesting only if the story is about who profits from the response, who was warned and did nothing, or where the reconstruction money goes.

Rules:

1. Most items are mundane. That is the correct and common answer, and a run where most things are interesting is a broken run.
2. Judge what the text actually says. Never supply context you happen to know, and never treat an item as interesting because the parties involved are famous or because the topic is contentious.
3. This is not an importance ranking. Both non-mundane verdicts mean the same thing - something here does not fully add up - and differ only in degree. "worth-a-look" is the ordinary case. "notable" is for when the gap between what is stated and what is actually happening is large and you can name it precisely. A major, consequential, front-page event with nothing hidden in it is mundane, and you should say so without hesitation.
4. Scale and death toll are not evidence of hidden depth. Neither is conflict, controversy, or a famous name.
5. Several items often cover the same underlying event. Judge each on what it adds. Heavy coverage is a fact about the newsroom, not about the story.
6. angle is the thing you would check next, named concretely: a party, a beneficiary, a date, a filing. If you cannot name it, angle is null and the verdict is mundane. Never write a vague angle to justify a verdict, and never write one that is really just "what happens next".
7. You are not concluding that anything improper happened, and you must not imply it. You are saying where a person should look.
8. topic is for scanning a list. A few words, specific, no preamble.

Return exactly one entry per input item, with its index copied from the input.`;

function renderItem(db: DB, item: Item, index: number): string {
  const source = getSource(db, item.sourceId);
  const parts = [
    `[${index}]`,
    `SOURCE: ${source?.name ?? item.sourceId} (tier: ${source?.tier ?? 'unknown'})`,
    `PUBLISHED: ${item.publishedAt.slice(0, 10)}`,
    `TITLE: ${item.title}`,
  ];
  // Triage reads what the source published, not the full body: the judgement
  // is "is this worth opening", and paying for the whole article to decide
  // that would defeat the point of having a cheap stage at all.
  if (item.summary) {
    const s = item.summary.length > 1_200 ? `${item.summary.slice(0, 1_200)}...` : item.summary;
    parts.push(`SUMMARY: ${s}`);
  }
  return parts.join('\n');
}

export interface TriageResult {
  itemId: string;
  verdict: TriageVerdict;
  topic: string;
  angle: string | null;
}

export interface TriageRunResult {
  results: TriageResult[];
  /** Items the model returned no judgement for. Left untriaged, so they retry. */
  unjudged: number;
  batches: number;
}

/**
 * Triage one batch of items in a single call.
 *
 * Batching is what makes this affordable: one call per item over a corpus this
 * size costs more than the extraction it is meant to save. The index echo is
 * how a batched response stays attributable - an entry whose index we did not
 * send is discarded rather than guessed at.
 */
export async function triageBatch(
  db: DB,
  cfg: Config,
  items: Item[],
): Promise<TriageResult[]> {
  if (items.length === 0) return [];

  const out = await structured<TriageBatch>(cfg, {
    system: SYSTEM,
    user: items.map((it, i) => renderItem(db, it, i)).join('\n\n---\n\n'),
    schema: TriageBatchSchema,
    maxTokens: 8_000,
    model: cfg.triageModel,
    // Classification against a fixed rubric. The small models support neither
    // adaptive thinking nor the effort parameter, and need neither here.
    thinking: false,
    effort: null,
  });

  const attributed = attribute(items, out.items);
  for (const { item, judged } of attributed) {
    saveTriage(db, item.id, judged.verdict, judged.topic, judged.reason, judged.angle);
  }
  return attributed.map(({ item, judged }) => ({
    itemId: item.id,
    verdict: judged.verdict,
    topic: judged.topic,
    angle: judged.angle,
  }));
}

/**
 * Match a batched response back to the items it was asked about.
 *
 * The index echo is the only thing tying a judgement to an item, so it is
 * checked rather than trusted: an index we did not send, or one sent twice, is
 * dropped. Attaching a judgement to whichever item happens to sit at that
 * position would put a confident verdict on the wrong story, which is worse
 * than leaving it unjudged - an unjudged item simply comes back around on the
 * next run.
 */
export function attribute(
  items: Item[],
  judged: TriagedItem[],
): Array<{ item: Item; judged: TriagedItem }> {
  const out: Array<{ item: Item; judged: TriagedItem }> = [];
  const seen = new Set<number>();
  for (const j of judged) {
    const item = items[j.index];
    if (!item || seen.has(j.index)) continue;
    seen.add(j.index);
    out.push({ item, judged: j });
  }
  return out;
}

export async function triage(
  db: DB,
  cfg: Config,
  opts: { limit?: number; onBatch?: (r: TriageResult[]) => void } = {},
): Promise<TriageRunResult> {
  const items = itemsAwaitingTriage(db, opts.limit ?? cfg.triageBatchLimit);
  const results: TriageResult[] = [];
  let batches = 0;

  for (let i = 0; i < items.length; i += cfg.triageBatchSize) {
    const slice = items.slice(i, i + cfg.triageBatchSize);
    const judged = await triageBatch(db, cfg, slice);
    results.push(...judged);
    batches++;
    opts.onBatch?.(judged);
  }

  return { results, unjudged: items.length - results.length, batches };
}

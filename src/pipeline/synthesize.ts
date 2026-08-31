import { z } from 'zod';
import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { edgeEvidence } from '../core/graph.js';
import { structured } from '../core/llm.js';
import { getItem } from '../core/store.js';
import { type ActivationResult, activateFromItem } from './activate.js';
import { eventsForItem } from '../core/store.js';

/**
 * Synthesis over a fired region of the map.
 *
 * Activation says the corpus has a weighted path between this story and some
 * party it never mentions. That is a structural fact and it is not yet worth
 * anyone's time: most paths through a co-occurrence graph are coincidence
 * wearing a route. This is the stage that reads the actual events along each
 * path and says whether any of them amount to something.
 *
 * The model is given the evidence, not the scores. It never sees the energy
 * numbers, because a number it did not compute is a number it will rationalise
 * - "0.91" invites a story about why the link is strong. It sees the story, the
 * party that lit up, the chain of events that connects them, and it is asked
 * whether that chain is a mechanism or a coincidence.
 *
 * Everything the honest-by-construction rules demand of a hypothesis applies
 * here and is enforced by the schema rather than requested in prose: a
 * mechanism must be stated, a falsifier is mandatory, confidence is capped
 * below any deterministic finding, and returning nothing is explicitly the
 * expected answer.
 */

export const LEAD_CAP = 0.7;

const SYSTEM = `You review candidate connections found in an intelligence corpus and decide which, if any, are worth a person's time.

You are given one story, and a set of parties that the corpus connects to it INDIRECTLY - each through a chain of intermediate parties, with the actual events along that chain. The story never mentions these parties. A statistical procedure found the paths; your job is to read the evidence and judge them.

The default answer is that a path is coincidence. Two parties can be connected through a shared regulator, a busy news week, a common venue, or an outlet that covers both. None of that is a connection between them. Returning an empty list is the correct and common outcome, and a review that finds something every time is a review that is not reading.

Reject a path when:
- The intermediate party is generic: a government, a regulator, a large platform, a country. Everything routes through those.
- The link is topical rather than causal: both concern energy policy, both are technology companies, both were in the news the same week.
- The events on the chain are about the intermediary, and the two ends never act on each other.
- The only thing joining them is that one source wrote about both.

Consider a path worth surfacing when the events along it describe parties ACTING on each other or on the same specific thing: a decision that names one and benefits another, money or authority moving along the chain, a party appearing on both sides of a transaction, a timing relationship the chain makes visible.

For each lead you do surface:
- mechanism: how the parties are actually connected, in one or two sentences, naming the events. Not "both are involved in energy policy" - what specifically passes between them.
- whatWouldConfirm: a specific record or observation that would establish it. Something a person could go and look for.
- falsifier: a specific observation that would show it is not real. Mandatory. If you cannot state one, you do not have a lead.
- confidence: never above 0.7. These are proposals from a statistical procedure, and they must never outrank a deterministic finding.

You are not concluding that anything improper occurred and you must not imply it. You are saying that a specific chain of records is worth a person examining, and naming what would settle it either way.`;

export const LeadSchema = z.object({
  party: z.string()
    .describe('The party that lit up, copied exactly from the candidate list.'),
  mechanism: z.string()
    .describe('How they are connected, naming the events on the chain. Specific, not topical.'),
  whatWouldConfirm: z.string()
    .describe('A specific record or observation that would establish this.'),
  falsifier: z.string()
    .describe('A specific observation that would show this is not real. Mandatory.'),
  confidence: z.number().min(0.01).max(LEAD_CAP)
    .describe('Never above 0.7. A proposal from a statistical procedure outranks nothing.'),
});

export const SynthesisSchema = z.object({
  leads: z.array(LeadSchema)
    .describe('Zero or more leads. Empty is correct when every path is coincidence.'),
  dismissed: z.string()
    .describe('One sentence on what you rejected and why, so the reader can disagree with the filter.'),
});

export type Lead = z.infer<typeof LeadSchema>;
export type Synthesis = z.infer<typeof SynthesisSchema>;

export interface SynthesisResult {
  itemId: string;
  activation: ActivationResult;
  candidates: number;
  leads: Lead[];
  dismissed: string;
  /** Set when there was nothing to review. */
  skipped: string | null;
}

/**
 * Render one candidate path as the evidence behind it.
 *
 * Each step of the chain becomes the events that actually put that edge in the
 * graph. This is the whole input: if a step has no events worth showing, the
 * model should see that the chain is thin.
 */
function renderCandidate(db: DB, node: ActivationResult['nodes'][number]): string {
  const lines: string[] = [`PARTY: ${node.name} (${node.kind})`];
  lines.push(`CHAIN: ${node.pathNames.join(' -> ')}`);
  for (let i = 0; i < node.path.length - 1; i++) {
    const a = node.path[i]!;
    const b = node.path[i + 1]!;
    const evidence = edgeEvidence(db, a, b, 3);
    lines.push(`  LINK ${node.pathNames[i]} <-> ${node.pathNames[i + 1]}:`);
    if (evidence.length === 0) {
      lines.push('    (no event names both directly)');
    }
    for (const e of evidence) {
      lines.push(`    ${e.occurredAt.slice(0, 10)} [${e.type}] ${e.summary} (${e.source})`);
    }
  }
  return lines.join('\n');
}

/**
 * Fire the map from one item, then review what lit up.
 *
 * The two halves are deliberately separate. Activation is cheap, deterministic
 * and repeatable; synthesis costs a model call and is the only part that
 * exercises judgement. Running activation alone is a legitimate and free way to
 * see the structure before deciding to pay for an opinion about it.
 */
export async function synthesize(
  db: DB,
  cfg: Config,
  itemId: string,
  opts: { maxCandidates?: number; hops?: number } = {},
): Promise<SynthesisResult> {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`No item ${itemId}.`);

  const activation = activateFromItem(db, itemId, { hops: opts.hops ?? 3 });
  const candidates = activation.distant.slice(0, opts.maxCandidates ?? 12);

  const base: SynthesisResult = {
    itemId, activation, candidates: candidates.length, leads: [], dismissed: '', skipped: null,
  };

  if (activation.seeds.length === 0) {
    return { ...base, skipped: 'This item has no extracted parties to fire from.' };
  }
  if (candidates.length === 0) {
    return {
      ...base,
      skipped: 'Nothing lit beyond direct co-occurrence, so there is no indirect path to review.',
    };
  }

  const events = eventsForItem(db, itemId);
  const story = [
    `STORY: ${item.title}`,
    item.triageTopic ? `TOPIC: ${item.triageTopic}` : '',
    item.triageAngle ? `FLAGGED FOR CHECK: ${item.triageAngle}` : '',
    '',
    'EVENTS IN THIS STORY:',
    ...events.map((e) => `  ${e.occurredAt.slice(0, 10)} [${e.type}] ${e.summary}`),
  ].filter(Boolean).join('\n');

  const out = await structured<Synthesis>(cfg, {
    system: SYSTEM,
    user: [
      story,
      '',
      `CANDIDATE PARTIES CONNECTED INDIRECTLY (${candidates.length}):`,
      '',
      candidates.map((c) => renderCandidate(db, c)).join('\n\n'),
    ].join('\n'),
    schema: SynthesisSchema,
    // Judgement across many chains of evidence. This is where capability shows.
    effort: 'high',
    maxTokens: 16_000,
  });

  // A lead naming a party that was never a candidate is discarded rather than
  // shown: the whole value here is that a lead points at a real chain.
  const known = new Set(candidates.map((c) => c.name));
  const leads = out.leads.filter((l) => known.has(l.party));

  return { ...base, leads, dismissed: out.dismissed };
}

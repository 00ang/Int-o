import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { structured } from '../core/llm.js';
import { eventsForItem, getItem } from '../core/store.js';
import { type ActivationResult, activateFromItem } from './activate.js';
import { getProfile } from './profile.js';
import { getEntity } from '../core/store.js';
import {
  type BackgroundSynthesis, BackgroundSynthesisSchema,
  type Reconciliation, ReconciliationSchema,
} from './schema.js';
import { type Lead, type SynthesisResult, synthesize } from './synthesize.js';

/**
 * Two independent reads, then a reconciliation.
 *
 * The evidence track reads the records connecting this story to parties it does
 * not name, and judges whether any chain is a mechanism. The background track
 * reads who those parties are - affiliations, prior episodes, capabilities -
 * and what their position would lead you to expect around this subject. It
 * never sees the chains.
 *
 * That separation is the design, not an implementation detail. A model handed
 * records and background together finds what the background primed it to find,
 * and its agreement with itself is worth nothing. Kept apart, the two tracks
 * can arrive at the same party for different reasons, and that convergence is
 * the strongest thing this system can produce.
 *
 * The reconciliation sees only the two conclusions, never their inputs, so it
 * cannot re-argue either read - only compare them. Its job is to mark what was
 * corroborated, what rests on records alone, what rests on background alone,
 * and where the tracks contradict each other, because a contradiction between
 * two honest reads is itself information.
 *
 * Confidence is bounded by construction: background leads cap at 0.55, below
 * anything built on records this corpus holds, and a reconciled finding caps at
 * 0.7 like every other model proposal here. A background-only finding is the
 * weakest result the system emits and is labelled that way.
 */

const BACKGROUND_SYSTEM = `You assess what a set of parties' backgrounds imply about a subject.

You are given the subject of a story and dossiers on parties the corpus associates with it. You are NOT given the records that connect them, and you must not speculate about what those records say. Your job is the other half: given who these parties are, what would you expect around this subject, and what would be surprising?

Each dossier claim carries a basis. Weight them accordingly:
- corpus: a record in this corpus supports it.
- recalled: asserted from model training. Plausible, unverified, possibly out of date or wrong.
- inferred: follows from the other claims.

Most of what you are reading will be recalled, which means most of what you conclude is provisional. Confidence is capped at 0.55 for that reason and should usually be well below it.

What is worth saying:
- A party whose prior affiliations or capabilities bear directly on this subject, where that is not obvious from the subject alone.
- A capability one of these parties holds that would matter here, and what it would take for them to use it.
- Something the backgrounds make UNEXPECTED about this subject, which therefore needs explaining. An absence can be as telling as a presence.

What is not:
- Restating the dossier. "They are a large company in this sector" is not a lead.
- Generic sector logic. "As an energy company they have an interest in energy policy" is true of every energy company and says nothing.
- Anything about a party whose dossier is thin. No background means no background read; say nothing rather than inventing one.
- Guessing at what the records show. You do not have them.

Rules:
1. Empty is the correct answer when the dossiers say nothing bearing on this subject. That will be common.
2. Every lead must name the specific affiliation, episode or capability it rests on. If you cannot name it, you do not have a lead.
3. Every lead needs a falsifier - a specific observation that would show it is wrong.
4. You are describing position, capability and expectation. Never assert or imply that any party has done anything improper.`;

const RECONCILE_SYSTEM = `You reconcile two independent readings of the same story.

One track read the RECORDS: chains of events in a corpus connecting this story to parties it does not name, and judged which chains are mechanisms rather than coincidence. The other track read the BACKGROUND: who those parties are, and what their history and capabilities would lead you to expect. Neither saw the other's input.

You see only their conclusions. You cannot re-argue either read, and you must not add findings of your own - you can only compare, combine and rank what they gave you.

Standing is the thing you are here to assign:
- corroborated: both tracks reached this party independently, on different grounds. This is the strongest result available and should be ranked first. Note that agreeing on a party is not enough - they must be saying compatible things about it.
- records-only: the evidence track supports it and background neither helps nor hurts.
- background-only: the background track suggests it and no record here supports it yet. This is the weakest result. Say plainly that it is unsupported by anything in the corpus.
- contested: the tracks point in different directions. Do not resolve it by picking one. State the disagreement, because two honest reads diverging is information a person can act on.

Rules:
1. Empty findings is correct when neither track produced anything worth carrying. Say so in the assessment rather than manufacturing a finding.
2. Confidence caps at 0.7. A corroborated finding may approach it. A background-only finding must stay low, because background here is mostly recalled and unverified.
3. Every finding needs a falsifier and a single concrete next check - the most useful thing a person could actually go and look at.
4. The assessment should tell a reader whether this is worth their time. "There is nothing here" is a valuable answer and you should give it when true.
5. Never assert or imply wrongdoing by any party. You are ranking what is worth examining.`;

export interface CombinedResult {
  itemId: string;
  activation: ActivationResult;
  evidence: SynthesisResult;
  background: BackgroundSynthesis | null;
  reconciled: Reconciliation | null;
  /** Parties whose dossiers were available to the background track. */
  dossiersUsed: string[];
  skipped: string | null;
}

/** The dossiers for the parties in play, seeds and lit nodes alike. */
function renderDossiers(
  db: DB,
  activation: ActivationResult,
): { text: string; names: string[] } {
  const ids = [
    ...activation.seeds,
    ...activation.distant.slice(0, 10).map((n) => n.id),
  ];
  const seen = new Set<string>();
  const blocks: string[] = [];
  const names: string[] = [];

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const ent = getEntity(db, id);
    const p = getProfile(db, id);
    if (!ent || !p) continue;

    names.push(ent.name);
    const lines = [`PARTY: ${ent.name} (${ent.kind})`, p.summary];
    const mark = (b: string) => `[${b}]`;
    for (const a of p.affiliations) {
      lines.push(`  AFFILIATION ${mark(a.basis)} ${a.organisation} - ${a.role} (${a.period}), conf ${a.confidence.toFixed(2)}`);
    }
    for (const h of p.history) {
      lines.push(`  PRIOR ${mark(h.basis)} ${h.when}: ${h.what} | matters: ${h.whyItMatters}`);
    }
    for (const c of p.capabilities) {
      lines.push(`  CAPABILITY ${mark(c.basis)} ${c.capability} | would take: ${c.whatItWouldTake} | trace: ${c.observableIfReal}`);
    }
    blocks.push(lines.join('\n'));
  }
  return { text: blocks.join('\n\n'), names };
}

/**
 * Read one item down both tracks and reconcile them.
 *
 * The two tracks run concurrently because they are genuinely independent -
 * neither consumes the other's output - so serialising them would only add wall
 * time. Three model calls where the single-track version made one, which is the
 * real cost of cross-checking rather than confirming.
 */
export async function reconcile(
  db: DB,
  cfg: Config,
  itemId: string,
  opts: { hops?: number; maxCandidates?: number } = {},
): Promise<CombinedResult> {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`No item ${itemId}.`);

  const activation = activateFromItem(db, itemId, { hops: opts.hops ?? 3 });
  const { text: dossiers, names } = renderDossiers(db, activation);

  const base: CombinedResult = {
    itemId,
    activation,
    evidence: {
      itemId, activation, candidates: 0, leads: [], dismissed: '', skipped: null,
    },
    background: null,
    reconciled: null,
    dossiersUsed: names,
    skipped: null,
  };

  if (activation.seeds.length === 0) {
    return { ...base, skipped: 'This item has no extracted parties to work from.' };
  }

  const events = eventsForItem(db, itemId);
  const subject = [
    `SUBJECT: ${item.triageTopic ?? item.title}`,
    `STORY: ${item.title}`,
    item.triageAngle ? `FLAGGED FOR CHECK: ${item.triageAngle}` : '',
    '',
    'WHAT THIS STORY ASSERTS:',
    ...events.map((e) => `  ${e.occurredAt.slice(0, 10)} [${e.type}] ${e.summary}`),
  ].filter(Boolean).join('\n');

  // Track A reads the records. Track B reads the parties. Neither sees the
  // other's material, and they run at the same time.
  const [evidence, background] = await Promise.all([
    synthesize(db, cfg, itemId, { hops: opts.hops, maxCandidates: opts.maxCandidates }),
    dossiers.length === 0
      ? Promise.resolve(null)
      : structured<BackgroundSynthesis>(cfg, {
        system: BACKGROUND_SYSTEM,
        user: `${subject}\n\nDOSSIERS ON THE PARTIES IN PLAY:\n\n${dossiers}`,
        schema: BackgroundSynthesisSchema,
        effort: 'high',
        maxTokens: 12_000,
      }),
  ]);

  if (background === null) {
    return {
      ...base,
      evidence,
      skipped: 'No dossiers exist for these parties yet, so there is no background track to cross-check. Run: all-int profile',
    };
  }

  const renderLeads = (leads: Lead[]) => leads.length === 0
    ? '  (none)'
    : leads.map((l) => [
      `  PARTY: ${l.party} (confidence ${l.confidence.toFixed(2)})`,
      `    mechanism: ${l.mechanism}`,
      `    would confirm: ${l.whatWouldConfirm}`,
      `    falsifier: ${l.falsifier}`,
    ].join('\n')).join('\n');

  const reconciled = await structured<Reconciliation>(cfg, {
    system: RECONCILE_SYSTEM,
    user: [
      subject,
      '',
      'EVIDENCE TRACK - read the records, saw no dossiers:',
      renderLeads(evidence.leads),
      `  dismissed: ${evidence.dismissed || '(nothing stated)'}`,
      evidence.skipped ? `  note: ${evidence.skipped}` : '',
      '',
      'BACKGROUND TRACK - read the dossiers, saw no connecting records:',
      background.leads.length === 0 ? '  (none)' : background.leads.map((l) => [
        `  PARTY: ${l.party} (confidence ${l.confidence.toFixed(2)})`,
        `    expectation: ${l.expectation}`,
        `    rests on: ${l.whyTheirBackground}`,
        `    would confirm: ${l.whatWouldConfirm}`,
        `    falsifier: ${l.falsifier}`,
      ].join('\n')).join('\n'),
      background.surprises.length > 0
        ? `  unexpected given these backgrounds:\n${background.surprises.map((s) => `    - ${s}`).join('\n')}`
        : '',
      `  dismissed: ${background.dismissed || '(nothing stated)'}`,
    ].filter(Boolean).join('\n'),
    schema: ReconciliationSchema,
    effort: 'high',
    maxTokens: 12_000,
  });

  return { ...base, evidence, background, reconciled };
}

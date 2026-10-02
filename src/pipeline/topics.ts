import type { DB } from '../core/db.js';
import { listThreads, triagedQueue } from '../core/store.js';
import { buildLedger, sourceSpread, tally, type Ledger } from './ledger.js';

/**
 * Topic suggestions: what in the corpus is ready to be written about.
 *
 * Ranked in code, from what is on file, and nothing else. A subject earns its
 * place by how much of it a writer could actually state: records joined by a
 * detector, documented events, independent sources, and how recently it moved.
 * A story that is one outlet's one report scores near nothing, however large
 * the headline, because there is nothing in it to stand a sentence on.
 *
 * Every suggestion carries the counts it was ranked on and the gaps it has,
 * so the ranking can be argued with. The suggestion is where to look; what the
 * piece says is decided by the ledger and by you.
 */

export interface TopicSuggestion {
  subject: Ledger['subject'];
  score: number;
  /** The counts the score was computed from. */
  basis: {
    patterns: number;
    records: number;
    reported: number;
    hypotheses: number;
    sources: number;
    primarySources: number;
    /** Days since the subject's most recent record. */
    ageDays: number;
  };
  /** Something already on file to open with: a triage angle or an open question. Model-written earlier, not now. */
  angle: string | null;
  /** What the material lacks, in code's words. */
  gaps: string[];
  /** One line saying what the ranking rests on. */
  pitch: string;
}

/** Weights. Patterns are worth most because they are the thing only this corpus can give a writer. */
const WEIGHT = { pattern: 3, record: 1, source: 1.5, primary: 1, recency: 2 } as const;

/** A subject whose most recent record is older than this gets no recency credit. */
const RECENCY_HORIZON_DAYS = 30;

export function scoreLedger(l: Ledger, now = new Date()): Omit<TopicSuggestion, 'subject' | 'angle' | 'pitch'> {
  const t = tally(l);
  const spread = sourceSpread(l);
  const dates = l.rows.map((r) => r.date).filter((d): d is string => d !== null).sort();
  const latest = dates[dates.length - 1];
  const ageDays = latest ? Math.max(0, Math.round((now.getTime() - Date.parse(`${latest}T12:00:00.000Z`)) / 86_400_000)) : Infinity;
  const recency = Number.isFinite(ageDays) ? Math.max(0, 1 - ageDays / RECENCY_HORIZON_DAYS) : 0;

  const score =
    WEIGHT.pattern * t.pattern +
    WEIGHT.record * t.record +
    WEIGHT.source * Math.max(0, spread.sources - 1) +
    WEIGHT.primary * spread.primary +
    WEIGHT.recency * recency;

  const gaps: string[] = [];
  if (t.pattern === 0) gaps.push('no pattern in the records: a story, not a join');
  if (t.record === 0) gaps.push('nothing documented; every claim is reported or weaker');
  if (spread.sources <= 1) gaps.push('single source');
  if (spread.primary === 0) gaps.push('no primary record');
  if (t.hypothesis > 0) gaps.push(`${t.hypothesis} model hypothes${t.hypothesis === 1 ? 'is' : 'es'} unchecked`);
  if (t.alleged > 0) gaps.push(`${t.alleged} allegation${t.alleged === 1 ? '' : 's'} that must be attributed`);
  if (!l.rows.some((r) => r.kind === 'background')) gaps.push('no dossier on the players');

  return {
    score: Number(score.toFixed(2)),
    basis: {
      patterns: t.pattern,
      records: t.record,
      reported: t.reported,
      hypotheses: t.hypothesis,
      sources: spread.sources,
      primarySources: spread.primary,
      ageDays,
    },
    gaps,
  };
}

function pitchLine(s: Omit<TopicSuggestion, 'subject' | 'angle' | 'pitch'>): string {
  const b = s.basis;
  const parts = [
    b.patterns ? `${b.patterns} pattern${b.patterns === 1 ? '' : 's'} in the records` : null,
    `${b.records} documented`,
    b.reported ? `${b.reported} reported` : null,
    `${b.sources} source${b.sources === 1 ? '' : 's'}${b.primarySources ? ` (${b.primarySources} primary)` : ''}`,
    Number.isFinite(b.ageDays) ? `moved ${b.ageDays}d ago` : 'undated',
  ].filter(Boolean);
  return parts.join(', ') + '.';
}

export interface TopicsOptions {
  limit?: number;
  /** Below this a subject is not suggested. The default drops anything with nothing stateable in it. */
  minScore?: number;
  now?: Date;
}

/**
 * Suggest subjects to write about, best material first.
 *
 * Candidates are the active storylines and the reading queue - everything a
 * person or the pipeline has already decided is worth attention. Each gets a
 * ledger and is scored on it. Nothing is called; nothing is written.
 */
export function suggestTopics(db: DB, opts: TopicsOptions = {}): TopicSuggestion[] {
  const { limit = 10, minScore = 1, now = new Date() } = opts;
  const out: TopicSuggestion[] = [];
  const seenSubjects = new Set<string>();

  for (const t of listThreads(db, 'active', 200)) {
    const l = buildLedger(db, t.id);
    if (!l || l.rows.length === 0) continue;
    const s = scoreLedger(l, now);
    if (s.score < minScore) continue;
    seenSubjects.add(t.id);
    out.push({ subject: l.subject, angle: t.openQuestions[0] ?? null, pitch: pitchLine(s), ...s });
  }

  for (const it of triagedQueue(db, { limit: 300 })) {
    if (seenSubjects.has(it.id)) continue;
    const l = buildLedger(db, it.id);
    // An item with no events yet has nothing to stand a sentence on.
    if (!l || !l.rows.some((r) => r.kind === 'event')) continue;
    const s = scoreLedger(l, now);
    if (s.score < minScore) continue;
    out.push({ subject: l.subject, angle: it.triageAngle, pitch: pitchLine(s), ...s });
  }

  out.sort((a, b) => b.score - a.score || a.basis.ageDays - b.basis.ageDays);
  return out.slice(0, limit);
}

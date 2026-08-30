import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { stableId } from '../core/ids.js';
import { structured } from '../core/llm.js';
import {
  getEntity, listForecasts, listSources, marketItems, insertForecast, listThreads,
  setForecastMarket, threadEvents,
} from '../core/store.js';
import type { Event, Forecast, Thread } from '../core/types.js';
import type { MarketSnapshot } from '../sources/prediction-markets.js';
import { ProposedForecastsSchema, type ProposedForecast } from './schema.js';

/**
 * Forecasting.
 *
 * The rest of this system reconstructs what happened. This is the only part
 * that says what will happen, so it carries the strictest rule in the codebase:
 * every forecast is scored. A question that cannot be graded is not stored, and
 * once graded the Brier score goes on the record whether or not it flatters us.
 *
 * Three pieces:
 *
 *   generate  a model proposes questions from a live storyline, each with a
 *             resolution criterion, a resolution date and a reference class
 *   anchor    pure code matches each question to a prediction market already in
 *             the corpus, so the estimate sits next to a crowd price
 *   score     resolveForecast + calibration turn resolved questions into a
 *             calibration curve
 *
 * `anchor` is deliberately not a model call. Deciding that our question and a
 * market's question are the same question is exactly the kind of judgement that
 * looks fine in prose and is wrong a third of the time, and a forecast anchored
 * to the wrong market is worse than one anchored to nothing. So it is token
 * overlap with a floor, and it declines rather than reaches.
 */

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const FORECAST_SYSTEM = `You propose scoreable forecasts from an ongoing storyline in a personal intelligence system.

You are given a storyline: its running summary, its open questions, and its events in chronological order. Propose forecasts that a reader following this storyline would actually want a number on.

What makes a question usable here:

1. It resolves yes or no. Not "how will this develop" but "will X have happened by DATE".
2. Its resolution criterion names the observation that settles it and where that observation would appear - a filing, a vote, an announcement, a published figure. Two people reading the criterion must agree on the answer once the date arrives.
3. It resolves within roughly one to twelve months. A question resolving in three years cannot teach you anything about your calibration in time to matter.
4. It is genuinely uncertain. A question you would put at 3% or 97% is not worth the slot; aim for questions where you would say something between 15% and 85%.
5. Its reference class is real. State the class of past cases the rate is anchored to and roughly how often those went yes. If you cannot name a reference class, you are making the number up, and you should not propose the question.

The probability is your honest estimate, anchored on the reference class and moved by the specific evidence. Do not round to comfortable numbers. Do not hedge everything toward 50%: a forecast that says 50% about everything is scored exactly as badly as it deserves.

Propose at most three forecasts per storyline, and fewer when the storyline supports fewer. An empty list is the right answer for a storyline that is a sequence of announcements with no pending decision in it. You are not required to produce a forecast.

Do not propose a question whose answer is already determined by the events you were given.`;

function renderThread(db: DB, thread: Thread, events: Event[], today: string): string {
  const evs = events.map((e, i) => {
    const parties = e.entities
      .filter((en) => en.role !== 'mentioned')
      .map((en) => `${getEntity(db, en.entityId)?.name ?? '?'} (${en.role})`)
      .join(', ');
    return `[${i}] ${e.occurredAt.slice(0, 10)} | ${e.type} | ${e.summary}${parties ? `\n    parties: ${parties}` : ''}`;
  }).join('\n');

  return [
    `Today is ${today}.`,
    '',
    `STORYLINE: ${thread.title}`,
    '',
    thread.summary || '(no summary yet)',
    '',
    thread.openQuestions.length ? `Open questions:\n${thread.openQuestions.map((q) => `- ${q}`).join('\n')}` : '',
    '',
    `EVENTS (${events.length}):`,
    evs,
  ].filter((s) => s !== '').join('\n');
}

/** A proposal that survived validation, plus what it was checked against. */
export interface ValidationResult {
  ok: ProposedForecast[];
  rejected: { question: string; reason: string }[];
}

const MIN_HORIZON_DAYS = 3;
const MAX_HORIZON_DAYS = 550;

/**
 * Check what came back before it becomes a row.
 *
 * The schema guarantees the shape, not the sense. A date in the past, a
 * horizon so long the answer arrives after it could teach us anything, or a
 * probability pinned at a certainty are all well-formed and all useless, so
 * they are dropped here with a reason rather than stored.
 */
export function validateProposals(
  proposals: ProposedForecast[],
  now: Date,
  eventCount: number,
): ValidationResult {
  const ok: ProposedForecast[] = [];
  const rejected: { question: string; reason: string }[] = [];

  for (const p of proposals) {
    const resolves = Date.parse(`${p.resolvesAt.slice(0, 10)}T12:00:00.000Z`);
    if (Number.isNaN(resolves)) {
      rejected.push({ question: p.question, reason: 'unparseable resolution date' });
      continue;
    }
    const horizonDays = Math.round((resolves - now.getTime()) / 86_400_000);
    if (horizonDays < MIN_HORIZON_DAYS) {
      rejected.push({ question: p.question, reason: `resolves in ${horizonDays} days, too soon to be a forecast` });
      continue;
    }
    if (horizonDays > MAX_HORIZON_DAYS) {
      rejected.push({ question: p.question, reason: `resolves in ${horizonDays} days, too far out to score usefully` });
      continue;
    }
    if (p.probability <= 0.02 || p.probability >= 0.98) {
      rejected.push({ question: p.question, reason: `${(p.probability * 100).toFixed(0)}% is a statement, not a forecast` });
      continue;
    }
    if (!p.resolutionCriteria.trim()) {
      rejected.push({ question: p.question, reason: 'no resolution criterion' });
      continue;
    }
    if (!p.referenceClass.trim()) {
      rejected.push({ question: p.question, reason: 'no reference class' });
      continue;
    }
    if (p.evidenceEventIndexes.some((i) => i < 0 || i >= eventCount)) {
      rejected.push({ question: p.question, reason: 'cites an event index that does not exist' });
      continue;
    }
    ok.push(p);
  }
  return { ok, rejected };
}

export interface ForecastResult {
  threadsConsidered: number;
  proposed: number;
  stored: number;
  rejected: { question: string; reason: string }[];
}

/**
 * Stable id for a forecast.
 *
 * Derived from the thread and the question so re-running generation over an
 * unchanged storyline updates the same row rather than accumulating near
 * duplicates - the same reason every other id in this system is content
 * addressed.
 */
export function forecastId(threadId: string | null, question: string): string {
  return stableId('fc', threadId ?? '', question.trim().toLowerCase());
}

export async function generateForecasts(
  db: DB,
  cfg: Config,
  opts: {
    threadId?: string;
    minEvents?: number;
    maxThreads?: number;
    now?: Date;
    onProgress?: (threadTitle: string, stored: number) => void;
  } = {},
): Promise<ForecastResult> {
  const { minEvents = 3, maxThreads = 8 } = opts;
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);

  const threads = (opts.threadId
    ? listThreads(db).filter((t) => t.id === opts.threadId)
    : listThreads(db, 'active'))
    .filter((t) => t.eventCount >= minEvents)
    .slice(0, maxThreads);

  const result: ForecastResult = {
    threadsConsidered: threads.length, proposed: 0, stored: 0, rejected: [],
  };

  for (const thread of threads) {
    const events = threadEvents(db, thread.id);
    if (events.length === 0) continue;

    const { forecasts } = await structured<{ forecasts: ProposedForecast[] }>(cfg, {
      system: FORECAST_SYSTEM,
      user: renderThread(db, thread, events, today),
      schema: ProposedForecastsSchema,
      // Synthesis, not mechanical extraction: this is where capability shows.
      effort: 'high',
    });

    result.proposed += forecasts.length;
    const { ok, rejected } = validateProposals(forecasts, now, events.length);
    result.rejected.push(...rejected);

    for (const p of ok) {
      const f: Forecast = {
        id: forecastId(thread.id, p.question),
        threadId: thread.id,
        question: p.question.trim(),
        resolutionCriteria: p.resolutionCriteria.trim(),
        resolvesAt: `${p.resolvesAt.slice(0, 10)}T12:00:00.000Z`,
        probability: p.probability,
        referenceClass: p.referenceClass.trim(),
        marketProbability: null,
        marketUrl: null,
        evidenceEventIds: p.evidenceEventIndexes
          .map((i) => events[i]?.id)
          .filter((id): id is string => id !== undefined),
        reasoning: p.reasoning.trim(),
        createdAt: now.toISOString(),
        resolvedAt: null,
        outcome: null,
        brierScore: null,
      };
      insertForecast(db, f);
      result.stored++;
    }
    opts.onProgress?.(thread.title, ok.length);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Market anchoring
// ---------------------------------------------------------------------------

/**
 * Words carrying no discriminating power between two market questions. Kept
 * short on purpose: over-stripping makes unrelated questions look alike, which
 * is the failure that produces a wrong anchor.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'by',
  'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'do', 'does', 'did', 'have', 'has', 'had', 'it', 'its', 'this', 'that', 'these',
  'those', 'there', 'their', 'than', 'then', 'so', 'any', 'all', 'more', 'most',
  'before', 'after', 'during', 'between', 'about', 'over', 'under', 'up', 'down',
  'who', 'what', 'when', 'where', 'which', 'how', 'why', 'whether',
]);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9%$.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * How alike two questions are, 0-1.
 *
 * Rarer tokens count for more: "semiconductor" agreeing is evidence, "2026"
 * agreeing is not. Rarity is measured against the market corpus itself, so the
 * weighting reflects what is actually being matched against rather than a
 * general-language assumption.
 */
export function similarity(
  a: string,
  b: string,
  documentFrequency: Map<string, number>,
  totalDocuments: number,
): number {
  const at = new Set(tokenize(a));
  const bt = new Set(tokenize(b));
  if (at.size === 0 || bt.size === 0) return 0;

  const weight = (t: string) => {
    const df = documentFrequency.get(t) ?? 1;
    return Math.log((totalDocuments + 1) / (df + 0.5));
  };

  let shared = 0;
  let total = 0;
  const seen = new Set<string>();
  for (const t of [...at, ...bt]) {
    if (seen.has(t)) continue;
    seen.add(t);
    const w = weight(t);
    total += w;
    if (at.has(t) && bt.has(t)) shared += w;
  }
  return total === 0 ? 0 : shared / total;
}

export interface MarketMatch {
  market: MarketSnapshot;
  score: number;
}

/**
 * Below this, a match is coincidence. Set high on purpose: anchoring a forecast
 * to the wrong market silently corrupts the one number that is supposed to be
 * an independent check on ours.
 */
export const MIN_MATCH_SCORE = 0.34;

/**
 * Best market for a question, or null.
 *
 * A market that closes well before the forecast resolves is answering a
 * different question about the same subject and is rejected, however similar
 * the wording.
 */
export function bestMarketMatch(
  question: string,
  resolvesAt: string,
  markets: MarketSnapshot[],
  opts: { minScore?: number; closeSlackDays?: number } = {},
): MarketMatch | null {
  const { minScore = MIN_MATCH_SCORE, closeSlackDays = 45 } = opts;
  if (markets.length === 0) return null;

  const documentFrequency = new Map<string, number>();
  for (const m of markets) {
    for (const t of new Set(tokenize(m.question))) {
      documentFrequency.set(t, (documentFrequency.get(t) ?? 0) + 1);
    }
  }

  const resolves = Date.parse(resolvesAt);
  let best: MarketMatch | null = null;
  for (const m of markets) {
    if (m.probability === null) continue;
    if (m.closesAt && Number.isFinite(resolves)) {
      const closes = Date.parse(m.closesAt);
      if (Number.isFinite(closes) && closes < resolves - closeSlackDays * 86_400_000) continue;
    }
    const score = similarity(question, m.question, documentFrequency, markets.length);
    if (score >= minScore && (best === null || score > best.score)) best = { market: m, score };
  }
  return best;
}

/** Market snapshots already ingested into the corpus, newest first. */
export function loadMarkets(db: DB): MarketSnapshot[] {
  const marketSourceIds = listSources(db)
    .filter((s) => s.kind === 'prediction-market')
    .map((s) => s.id);
  if (marketSourceIds.length === 0) return [];

  return marketItems(db, marketSourceIds).flatMap((item) => {
    const raw = item.raw as Partial<MarketSnapshot> | null;
    if (!raw || typeof raw.question !== 'string') return [];
    return [{
      externalId: item.externalId,
      question: raw.question,
      probability: typeof raw.probability === 'number' ? raw.probability : null,
      url: item.url,
      closesAt: typeof raw.closesAt === 'string' ? raw.closesAt : null,
      volume: typeof raw.volume === 'number' ? raw.volume : null,
      venue: typeof raw.venue === 'string' ? raw.venue : 'unknown',
    }];
  });
}

export interface AnchorResult {
  considered: number;
  anchored: number;
  unmatched: number;
  marketsAvailable: number;
  /** Where our number and the crowd's differ most. The interesting output. */
  disagreements: { forecast: Forecast; market: MarketSnapshot; gap: number }[];
}

/**
 * Attach a crowd price to every open forecast that has a clear match.
 *
 * The market price is recorded beside our estimate, never blended into it.
 * Averaging the two would destroy the only thing this is for: seeing where we
 * disagree with the crowd, and finding out later who was right.
 */
export function anchorForecasts(
  db: DB,
  opts: { minScore?: number; reanchor?: boolean } = {},
): AnchorResult {
  const markets = loadMarkets(db);
  const open = listForecasts(db, { status: 'open' });
  const result: AnchorResult = {
    considered: open.length, anchored: 0, unmatched: 0,
    marketsAvailable: markets.length, disagreements: [],
  };

  for (const f of open) {
    if (f.marketProbability !== null && !opts.reanchor) continue;
    const match = bestMarketMatch(f.question, f.resolvesAt, markets, { minScore: opts.minScore });
    if (!match || match.market.probability === null) { result.unmatched++; continue; }
    setForecastMarket(db, f.id, match.market.probability, match.market.url);
    result.anchored++;
    result.disagreements.push({
      forecast: { ...f, marketProbability: match.market.probability, marketUrl: match.market.url },
      market: match.market,
      gap: Math.abs(f.probability - match.market.probability),
    });
  }
  result.disagreements.sort((a, b) => b.gap - a.gap);
  return result;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface CalibrationBucket {
  /** Inclusive lower and exclusive upper bound of the predicted probability. */
  from: number;
  to: number;
  count: number;
  /** Mean probability we said. */
  meanPredicted: number;
  /** Share that actually resolved yes. Calibration is these two agreeing. */
  observedYesRate: number;
}

/**
 * Bucket resolved forecasts by what we said and compare it to what happened.
 *
 * The mean Brier score says how good the forecasts were. This says *how* they
 * were wrong, which is the part you can act on: a run of buckets where the
 * observed rate sits below the predicted one is overconfidence, and it is
 * fixable in a way that "0.23" is not.
 */
export function calibrationCurve(forecasts: Forecast[], bucketCount = 5): CalibrationBucket[] {
  const scored = forecasts.filter((f) => f.outcome === 'yes' || f.outcome === 'no');
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const from = i / bucketCount;
    const to = (i + 1) / bucketCount;
    const inBucket = scored.filter((f) => {
      // The top bucket is closed so a forecast at exactly 1.0 has a home.
      return f.probability >= from && (i === bucketCount - 1 ? f.probability <= to : f.probability < to);
    });
    if (inBucket.length === 0) { buckets.push({ from, to, count: 0, meanPredicted: 0, observedYesRate: 0 }); continue; }
    const meanPredicted = inBucket.reduce((s, f) => s + f.probability, 0) / inBucket.length;
    const yes = inBucket.filter((f) => f.outcome === 'yes').length;
    buckets.push({
      from, to, count: inBucket.length,
      meanPredicted: Number(meanPredicted.toFixed(4)),
      observedYesRate: Number((yes / inBucket.length).toFixed(4)),
    });
  }
  return buckets;
}

/**
 * How our resolved forecasts scored against the market price we anchored to.
 *
 * Beating the crowd is the only evidence that this is producing information
 * rather than restating a price that was already public.
 */
export function marketComparison(forecasts: Forecast[]): {
  count: number;
  ourBrier: number | null;
  marketBrier: number | null;
} {
  const scored = forecasts.filter(
    (f) => (f.outcome === 'yes' || f.outcome === 'no') && f.marketProbability !== null,
  );
  if (scored.length === 0) return { count: 0, ourBrier: null, marketBrier: null };
  const brier = (p: number, f: Forecast) => (p - (f.outcome === 'yes' ? 1 : 0)) ** 2;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    count: scored.length,
    ourBrier: Number(mean(scored.map((f) => brier(f.probability, f))).toFixed(4)),
    marketBrier: Number(mean(scored.map((f) => brier(f.marketProbability!, f))).toFixed(4)),
  };
}

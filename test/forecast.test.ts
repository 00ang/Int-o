import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/core/db.js';
import {
  calibration, getForecast, insertForecast, insertItem, listForecasts, resolveForecast,
  setForecastMarket, upsertSource,
} from '../src/core/store.js';
import type { Forecast, Source } from '../src/core/types.js';
import type { MarketSnapshot } from '../src/sources/prediction-markets.js';
import { snapshotsToItems } from '../src/sources/prediction-markets.js';
import {
  anchorForecasts, bestMarketMatch, calibrationCurve, forecastId, loadMarkets,
  marketComparison, MIN_MATCH_SCORE, similarity, tokenize, validateProposals,
} from '../src/pipeline/forecast.js';
import type { ProposedForecast } from '../src/pipeline/schema.js';
import { _internal } from '../src/pipeline/brief.js';

const NOW = new Date('2026-08-30T00:00:00.000Z');
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

const proposal = (over: Partial<ProposedForecast> = {}): ProposedForecast => ({
  question: 'Will the Commerce Department extend the licence exemption past March?',
  resolutionCriteria: 'A Federal Register notice extending the exemption, published before the date.',
  resolvesAt: inDays(90).slice(0, 10),
  probability: 0.35,
  referenceClass: 'Comparable BIS exemptions since 2022; roughly half were extended.',
  reasoning: 'Two of the three named licensees have already applied.',
  evidenceEventIndexes: [0, 1],
  ...over,
});

const forecast = (over: Partial<Forecast> = {}): Forecast => ({
  id: 'fc_1', threadId: null,
  question: 'Will the Commerce Department extend the licence exemption past March?',
  resolutionCriteria: 'A Federal Register notice.',
  resolvesAt: inDays(90),
  probability: 0.35,
  referenceClass: 'BIS exemptions since 2022.',
  marketProbability: null, marketUrl: null,
  evidenceEventIds: [], reasoning: 'because',
  createdAt: NOW.toISOString(), resolvedAt: null, outcome: null, brierScore: null,
  ...over,
});

describe('validating what the model proposed', () => {
  it('accepts a well-formed forecast', () => {
    const { ok, rejected } = validateProposals([proposal()], NOW, 3);
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it('rejects a resolution date in the past', () => {
    const { ok, rejected } = validateProposals([proposal({ resolvesAt: '2026-01-01' })], NOW, 3);
    expect(ok).toHaveLength(0);
    expect(rejected[0]!.reason).toContain('too soon');
  });

  it('rejects a horizon too far out to teach us anything in time', () => {
    const { rejected } = validateProposals([proposal({ resolvesAt: inDays(900).slice(0, 10) })], NOW, 3);
    expect(rejected[0]!.reason).toContain('too far out');
  });

  it('rejects a near-certainty, which is a statement rather than a forecast', () => {
    expect(validateProposals([proposal({ probability: 0.99 })], NOW, 3).rejected).toHaveLength(1);
    expect(validateProposals([proposal({ probability: 0.01 })], NOW, 3).rejected).toHaveLength(1);
  });

  it('rejects a forecast with no reference class, because the number came from nowhere', () => {
    const { rejected } = validateProposals([proposal({ referenceClass: '   ' })], NOW, 3);
    expect(rejected[0]!.reason).toBe('no reference class');
  });

  it('rejects a forecast with no resolution criterion, because it cannot be graded', () => {
    const { rejected } = validateProposals([proposal({ resolutionCriteria: '' })], NOW, 3);
    expect(rejected[0]!.reason).toBe('no resolution criterion');
  });

  it('rejects evidence pointing at an event that does not exist', () => {
    const { rejected } = validateProposals([proposal({ evidenceEventIndexes: [0, 9] })], NOW, 2);
    expect(rejected[0]!.reason).toContain('does not exist');
  });

  it('keeps the good ones when only some fail', () => {
    const { ok, rejected } = validateProposals(
      [proposal(), proposal({ question: 'bad', probability: 0.995 })], NOW, 3,
    );
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

describe('forecast ids', () => {
  it('are stable, so regenerating over an unchanged storyline updates in place', () => {
    expect(forecastId('t1', 'Will X happen?')).toBe(forecastId('t1', 'will x happen? '));
  });

  it('differ by question and by storyline', () => {
    expect(forecastId('t1', 'Will X happen?')).not.toBe(forecastId('t1', 'Will Y happen?'));
    expect(forecastId('t1', 'Will X happen?')).not.toBe(forecastId('t2', 'Will X happen?'));
  });
});

describe('question similarity', () => {
  const corpus = [
    'Will the Commerce Department extend the semiconductor licence exemption before March 2027?',
    'Will the Federal Reserve cut rates at the December 2026 meeting?',
    'Will Argentina win the 2026 World Cup?',
    'Will the Commerce Department impose new export controls on China before March 2027?',
  ];
  const df = new Map<string, number>();
  for (const q of corpus) for (const t of new Set(tokenize(q))) df.set(t, (df.get(t) ?? 0) + 1);
  const sim = (a: string, b: string) => similarity(a, b, df, corpus.length);

  it('drops stopwords and keeps content words', () => {
    expect(tokenize('Will the Fed cut rates?')).toEqual(['fed', 'cut', 'rates']);
  });

  it('scores a paraphrase of the same question high', () => {
    expect(sim(
      'Will Commerce extend the semiconductor licence exemption before March 2027?',
      corpus[0]!,
    )).toBeGreaterThan(MIN_MATCH_SCORE);
  });

  it('scores an unrelated question near zero', () => {
    expect(sim('Will Argentina win the World Cup?', corpus[1]!)).toBeLessThan(0.15);
  });

  it('does not confuse two questions that merely share a subject', () => {
    // Both are Commerce Department, March 2027, China-adjacent. Different questions.
    expect(sim(corpus[0]!, corpus[3]!)).toBeLessThan(MIN_MATCH_SCORE);
  });

  it('is symmetric', () => {
    expect(sim(corpus[0]!, corpus[1]!)).toBeCloseTo(sim(corpus[1]!, corpus[0]!), 10);
  });

  it('is zero when either side has no content words', () => {
    expect(sim('the and of', corpus[0]!)).toBe(0);
  });
});

describe('matching a forecast to a market', () => {
  const market = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
    externalId: 'm1',
    question: 'Will the Commerce Department extend the semiconductor licence exemption before March 2027?',
    probability: 0.42,
    url: 'https://polymarket.com/event/commerce-exemption',
    closesAt: inDays(120),
    volume: 100_000,
    venue: 'polymarket',
    ...over,
  });

  const q = 'Will Commerce extend the semiconductor licence exemption before March 2027?';

  it('finds the matching market', () => {
    const m = bestMarketMatch(q, inDays(90), [market()]);
    expect(m).not.toBeNull();
    expect(m!.market.externalId).toBe('m1');
  });

  it('declines rather than reaching for a loosely related market', () => {
    expect(bestMarketMatch(q, inDays(90), [
      market({ question: 'Will the Federal Reserve cut rates in December 2026?' }),
    ])).toBeNull();
  });

  it('skips a market with no current price', () => {
    expect(bestMarketMatch(q, inDays(90), [market({ probability: null })])).toBeNull();
  });

  it('skips a market that closes well before our question resolves', () => {
    // Same wording, but it settles two months before we need an answer, so it
    // is answering a different question.
    expect(bestMarketMatch(q, inDays(90), [market({ closesAt: inDays(10) })])).toBeNull();
  });

  it('tolerates a market closing slightly early', () => {
    expect(bestMarketMatch(q, inDays(90), [market({ closesAt: inDays(60) })])).not.toBeNull();
  });

  it('accepts a market with no stated close date', () => {
    expect(bestMarketMatch(q, inDays(90), [market({ closesAt: null })])).not.toBeNull();
  });

  it('picks the best of several candidates', () => {
    const m = bestMarketMatch(q, inDays(90), [
      market({ externalId: 'far', question: 'Will Commerce act on semiconductors in 2027?' }),
      market({ externalId: 'near' }),
    ]);
    expect(m!.market.externalId).toBe('near');
  });

  it('returns null when there are no markets at all', () => {
    expect(bestMarketMatch(q, inDays(90), [])).toBeNull();
  });
});

describe('anchoring against the ingested corpus', () => {
  const marketSource: Source = {
    id: 'polymarket', name: 'Polymarket', kind: 'prediction-market',
    url: 'https://gamma-api.polymarket.com/markets', tier: 'primary',
    domains: ['markets'], origin: 'US', intervalMinutes: 60,
    verified: true, enabled: true,
  };

  function seedMarkets(snaps: MarketSnapshot[]) {
    upsertSource(db, marketSource);
    for (const item of snapshotsToItems(snaps, marketSource)) insertItem(db, item);
  }

  const snap = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
    externalId: 'm1',
    question: 'Will the Commerce Department extend the semiconductor licence exemption before March 2027?',
    probability: 0.42,
    url: 'https://polymarket.com/event/commerce-exemption',
    closesAt: inDays(120), volume: 1000, venue: 'polymarket',
    ...over,
  });

  it('reads market snapshots back out of the items table', () => {
    seedMarkets([snap()]);
    const markets = loadMarkets(db);
    expect(markets).toHaveLength(1);
    expect(markets[0]!.probability).toBe(0.42);
    expect(markets[0]!.venue).toBe('polymarket');
  });

  it('reports honestly when there are no markets to anchor to', () => {
    insertForecast(db, forecast());
    const r = anchorForecasts(db);
    expect(r.marketsAvailable).toBe(0);
    expect(r.anchored).toBe(0);
  });

  it('attaches the crowd price without touching our estimate', () => {
    seedMarkets([snap()]);
    insertForecast(db, forecast({
      question: 'Will Commerce extend the semiconductor licence exemption before March 2027?',
    }));
    const r = anchorForecasts(db);
    expect(r.anchored).toBe(1);
    const f = getForecast(db, 'fc_1')!;
    expect(f.marketProbability).toBe(0.42);
    expect(f.probability).toBe(0.35);
    expect(f.marketUrl).toContain('polymarket.com');
  });

  it('surfaces the biggest disagreements first', () => {
    seedMarkets([
      snap({ externalId: 'a', probability: 0.9 }),
      snap({
        externalId: 'b', probability: 0.36,
        question: 'Will the Federal Reserve cut rates at the December 2026 meeting?',
        url: 'https://polymarket.com/event/fed-december',
      }),
    ]);
    insertForecast(db, forecast({
      id: 'fc_a', probability: 0.2,
      question: 'Will Commerce extend the semiconductor licence exemption before March 2027?',
    }));
    insertForecast(db, forecast({
      id: 'fc_b', probability: 0.35,
      question: 'Will the Federal Reserve cut rates at the December 2026 meeting?',
    }));
    const r = anchorForecasts(db);
    expect(r.anchored).toBe(2);
    expect(r.disagreements[0]!.forecast.id).toBe('fc_a');
    expect(r.disagreements[0]!.gap).toBeCloseTo(0.7, 5);
  });

  it('leaves an already-anchored forecast alone unless asked to re-anchor', () => {
    seedMarkets([snap()]);
    const f = forecast({
      question: 'Will Commerce extend the semiconductor licence exemption before March 2027?',
    });
    insertForecast(db, f);
    setForecastMarket(db, f.id, 0.11, 'https://example.invalid/old');
    expect(anchorForecasts(db).anchored).toBe(0);
    expect(getForecast(db, f.id)!.marketProbability).toBe(0.11);
    expect(anchorForecasts(db, { reanchor: true }).anchored).toBe(1);
    expect(getForecast(db, f.id)!.marketProbability).toBe(0.42);
  });

  it('counts a forecast with no match as unmatched rather than forcing one', () => {
    seedMarkets([snap({ question: 'Will Argentina win the 2026 World Cup?' })]);
    insertForecast(db, forecast());
    const r = anchorForecasts(db);
    expect(r.anchored).toBe(0);
    expect(r.unmatched).toBe(1);
    expect(getForecast(db, 'fc_1')!.marketProbability).toBeNull();
  });

  it('never anchors a resolved forecast', () => {
    seedMarkets([snap()]);
    insertForecast(db, forecast({
      question: 'Will Commerce extend the semiconductor licence exemption before March 2027?',
      resolvedAt: NOW.toISOString(), outcome: 'yes', brierScore: 0.42,
    }));
    expect(anchorForecasts(db).considered).toBe(0);
  });
});

describe('listing by state', () => {
  beforeEach(() => {
    insertForecast(db, forecast({ id: 'fc_open', resolvesAt: inDays(30) }));
    insertForecast(db, forecast({ id: 'fc_due', resolvesAt: inDays(-5) }));
    insertForecast(db, forecast({
      id: 'fc_done', resolvesAt: inDays(-40),
      resolvedAt: inDays(-39), outcome: 'no', brierScore: 0.1225,
    }));
  });

  it('shows only unresolved forecasts past their date under --due', () => {
    const due = listForecasts(db, { status: 'due', at: NOW });
    expect(due.map((f) => f.id)).toEqual(['fc_due']);
  });

  it('counts an unresolved future forecast as open but not due', () => {
    expect(listForecasts(db, { status: 'open' }).map((f) => f.id).sort())
      .toEqual(['fc_due', 'fc_open']);
  });

  it('lists resolved separately', () => {
    expect(listForecasts(db, { status: 'resolved' }).map((f) => f.id)).toEqual(['fc_done']);
  });
});

describe('scoring', () => {
  it('scores a confident right answer well and a confident wrong one badly', () => {
    insertForecast(db, forecast({ id: 'right', probability: 0.9 }));
    insertForecast(db, forecast({ id: 'wrong', probability: 0.9 }));
    expect(resolveForecast(db, 'right', 'yes')).toBeCloseTo(0.01, 6);
    expect(resolveForecast(db, 'wrong', 'no')).toBeCloseTo(0.81, 6);
  });

  it('leaves an ambiguous resolution unscored rather than guessing', () => {
    insertForecast(db, forecast({ id: 'amb', probability: 0.6 }));
    expect(resolveForecast(db, 'amb', 'ambiguous')).toBeNull();
    expect(getForecast(db, 'amb')!.outcome).toBe('ambiguous');
    expect(calibration(db).count).toBe(0);
  });

  it('averages Brier over everything scored', () => {
    insertForecast(db, forecast({ id: 'a', probability: 0.9 }));
    insertForecast(db, forecast({ id: 'b', probability: 0.9 }));
    resolveForecast(db, 'a', 'yes');
    resolveForecast(db, 'b', 'no');
    const { count, meanBrier } = calibration(db);
    expect(count).toBe(2);
    expect(meanBrier!).toBeCloseTo(0.41, 6);
  });
});

describe('the calibration curve', () => {
  const resolved = (p: number, outcome: 'yes' | 'no', i: number): Forecast =>
    forecast({ id: `f${i}`, probability: p, outcome, resolvedAt: NOW.toISOString(), brierScore: 0 });

  it('puts each forecast in the bucket it was predicted at', () => {
    const curve = calibrationCurve([
      resolved(0.1, 'no', 1), resolved(0.3, 'no', 2),
      resolved(0.5, 'yes', 3), resolved(0.9, 'yes', 4),
    ]);
    expect(curve.map((b) => b.count)).toEqual([1, 1, 1, 0, 1]);
  });

  it('shows a well-calibrated run as predicted matching observed', () => {
    // Ten forecasts at 70%, seven of which happened.
    const fs = Array.from({ length: 10 }, (_, i) => resolved(0.7, i < 7 ? 'yes' : 'no', i));
    const bucket = calibrationCurve(fs).find((b) => b.count > 0)!;
    expect(bucket.meanPredicted).toBeCloseTo(0.7, 4);
    expect(bucket.observedYesRate).toBeCloseTo(0.7, 4);
  });

  it('shows overconfidence as observed falling below predicted', () => {
    const fs = Array.from({ length: 10 }, (_, i) => resolved(0.9, i < 5 ? 'yes' : 'no', i));
    const bucket = calibrationCurve(fs).find((b) => b.count > 0)!;
    expect(bucket.observedYesRate).toBeLessThan(bucket.meanPredicted);
  });

  it('gives a forecast at exactly 1.0 a home in the top bucket', () => {
    expect(calibrationCurve([resolved(1, 'yes', 1)]).at(-1)!.count).toBe(1);
  });

  it('ignores forecasts that resolved ambiguous', () => {
    const amb = forecast({ id: 'amb', probability: 0.5, outcome: 'ambiguous', resolvedAt: NOW.toISOString() });
    expect(calibrationCurve([amb]).every((b) => b.count === 0)).toBe(true);
  });
});

describe('scoring ourselves against the market', () => {
  const anchored = (p: number, mkt: number, outcome: 'yes' | 'no', i: number): Forecast =>
    forecast({
      id: `f${i}`, probability: p, marketProbability: mkt, outcome,
      resolvedAt: NOW.toISOString(),
    });

  it('reports both Brier scores over the anchored and resolved set', () => {
    const m = marketComparison([anchored(0.8, 0.5, 'yes', 1), anchored(0.2, 0.5, 'no', 2)]);
    expect(m.count).toBe(2);
    expect(m.ourBrier!).toBeCloseTo(0.04, 6);
    expect(m.marketBrier!).toBeCloseTo(0.25, 6);
  });

  it('says nothing when nothing was both anchored and resolved', () => {
    expect(marketComparison([forecast()])).toEqual({ count: 0, ourBrier: null, marketBrier: null });
  });

  it('excludes a resolved forecast that was never anchored', () => {
    const unanchored = forecast({ id: 'u', outcome: 'yes', resolvedAt: NOW.toISOString() });
    expect(marketComparison([unanchored, anchored(0.8, 0.5, 'yes', 1)]).count).toBe(1);
  });
});

describe('forecasts in the brief', () => {
  it('renders open forecasts with the market price beside ours, not blended', () => {
    const md = _internal.renderMarkdown(
      db, '2026-08-30', 'narrative', [], [], { items: 0, events: 0 },
      {
        open: [forecast({
          probability: 0.2, marketProbability: 0.42,
          marketUrl: 'https://polymarket.com/event/x',
        })],
        due: [],
      },
    );
    expect(md).toContain('## Forecasts');
    expect(md).toContain('**20%**');
    expect(md).toContain('market 42%');
    expect(md).toContain('https://polymarket.com/event/x');
  });

  it('states the resolution criterion, so a reader can grade it themselves', () => {
    const md = _internal.renderMarkdown(
      db, '2026-08-30', 'narrative', [], [], { items: 0, events: 0 },
      { open: [forecast({ resolutionCriteria: 'A Federal Register notice.' })], due: [] },
    );
    expect(md).toContain('A Federal Register notice.');
  });

  it('surfaces overdue unscored forecasts rather than letting the loop stall quietly', () => {
    const md = _internal.renderMarkdown(
      db, '2026-08-30', 'narrative', [], [], { items: 0, events: 0 },
      { open: [], due: [forecast({ resolvesAt: inDays(-3) })] },
    );
    expect(md).toContain('1 past their resolution date and unscored');
  });

  it('omits the section entirely when there are no forecasts', () => {
    const md = _internal.renderMarkdown(db, '2026-08-30', 'n', [], [], { items: 0, events: 0 });
    expect(md).not.toContain('## Forecasts');
  });
});

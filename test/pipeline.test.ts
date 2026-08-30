import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/core/db.js';
import { slugifyEntity, stableId } from '../src/core/ids.js';
import {
  calibration, counts, eventsSharingEntities, findEntityByTicker, insertConnection,
  insertEvent, insertForecast, insertItem, resolveEntity, resolveForecast, searchItems,
  upsertSource,
} from '../src/core/store.js';
import type { Event, EventEntity, Item, Source } from '../src/core/types.js';
import { runAllPairRules, runEntityOverlap, scorePair } from '../src/pipeline/detectors/deterministic.js';
import { PAIR_RULES } from '../src/pipeline/detectors/rules.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

const source = (over: Partial<Source> = {}): Source => ({
  id: 'src', name: 'Src', kind: 'rss', url: 'https://x/feed', tier: 'primary',
  domains: ['politics'], origin: 'US', intervalMinutes: 60, verified: true,
  enabled: true, ...over,
});

const item = (id: string, sourceId = 'src', over: Partial<Item> = {}): Item => ({
  id, sourceId, externalId: id, url: `https://x/${id}`, title: `Title ${id}`,
  summary: null, body: null, author: null,
  publishedAt: '2026-08-20T12:00:00.000Z', fetchedAt: '2026-08-20T12:00:00.000Z',
  raw: null, extractedAt: null, extractionError: null, ...over,
});

function makeEvent(
  id: string, itemId: string, type: Event['type'], occurredAt: string,
  entities: EventEntity[], over: Partial<Event> = {},
): Event {
  return {
    id, itemId, type, summary: `${type} on ${occurredAt.slice(0, 10)}`,
    occurredAt, occurredAtInferred: false, domains: ['defense'], entities,
    amount: null, tags: [], assertion: 'documented',
    createdAt: '2026-08-28T00:00:00.000Z', ...over,
  };
}

// ---------------------------------------------------------------------------

describe('entity resolution', () => {
  it('strips corporate suffixes so name variants collapse', () => {
    expect(slugifyEntity('Lockheed Martin Corp.')).toBe(slugifyEntity('Lockheed Martin'));
    expect(slugifyEntity('Vertex Defense Systems, Inc.')).toBe('vertex defense systems');
  });

  it('resolves variants of one company to a single entity', () => {
    const a = resolveEntity(db, { name: 'Vertex Defense Systems Inc', kind: 'company' });
    const b = resolveEntity(db, { name: 'Vertex Defense Systems', kind: 'company' });
    expect(b.id).toBe(a.id);
    expect(b.mentionCount).toBe(2);
  });

  it('keeps entities of different kinds distinct', () => {
    const co = resolveEntity(db, { name: 'Georgia', kind: 'company' });
    const country = resolveEntity(db, { name: 'Georgia', kind: 'country' });
    expect(co.id).not.toBe(country.id);
  });

  it('back-fills a ticker learned from a later source', () => {
    resolveEntity(db, { name: 'Vertex Defense Systems', kind: 'company' });
    resolveEntity(db, { name: 'Vertex Defense Systems', kind: 'company', ticker: 'VDS' });
    expect(findEntityByTicker(db, 'VDS')?.name).toBe('Vertex Defense Systems');
  });

  it('records alternate surface forms as aliases', () => {
    resolveEntity(db, { name: 'Vertex Defense Systems', kind: 'company' });
    const e = resolveEntity(db, {
      name: 'Vertex Defense Systems Incorporated', kind: 'company',
    });
    expect(e.aliases).toContain('Vertex Defense Systems Incorporated');
  });
});

describe('store', () => {
  beforeEach(() => upsertSource(db, source()));

  it('is idempotent on re-ingest of the same item', () => {
    expect(insertItem(db, item('i1'))).toBe(true);
    expect(insertItem(db, item('i1'))).toBe(false);
    expect(counts(db).items).toBe(1);
  });

  it('indexes items for full-text search', () => {
    insertItem(db, item('i1', 'src', {
      title: 'Treasury sanctions shipping firms',
      summary: 'Designations target crude oil transfers.',
    }));
    expect(searchItems(db, 'sanctions')).toHaveLength(1);
    expect(searchItems(db, 'crude')).toHaveLength(1);
    expect(searchItems(db, 'semiconductors')).toHaveLength(0);
  });

  it('scores forecasts with Brier on resolution', () => {
    insertForecast(db, {
      id: 'f1', threadId: null, question: 'Will X?', resolutionCriteria: 'X occurs',
      resolvesAt: '2026-12-31T00:00:00.000Z', probability: 0.8, referenceClass: null,
      marketProbability: null, marketUrl: null, evidenceEventIds: [], reasoning: '',
      createdAt: '2026-08-01T00:00:00.000Z', resolvedAt: null, outcome: null, brierScore: null,
    });
    // Predicted 0.8, it happened: (0.8 - 1)^2 = 0.04
    expect(resolveForecast(db, 'f1', 'yes')).toBeCloseTo(0.04);
    expect(calibration(db).meanBrier).toBeCloseTo(0.04);
  });
});

// ---------------------------------------------------------------------------
// The scenario from the original brief: a disclosed position in a defense
// contractor, followed by that contractor winning a federal contract.
// ---------------------------------------------------------------------------

describe('trade-then-award detection', () => {
  function seedScenario(gapDays: number, opts: { sameEntity?: boolean } = {}) {
    upsertSource(db, source({ id: 'edgar', name: 'SEC EDGAR', tier: 'primary' }));
    upsertSource(db, source({ id: 'awards', name: 'USASpending', tier: 'primary' }));
    insertItem(db, item('i-trade', 'edgar'));
    insertItem(db, item('i-award', 'awards'));

    const contractor = resolveEntity(db, {
      name: 'Vertex Defense Systems Inc', kind: 'company', ticker: 'VDS',
    });
    // Deliberately a different surface form, to prove resolution does the join.
    const awardee = opts.sameEntity === false
      ? resolveEntity(db, { name: 'Unrelated Logistics', kind: 'company' })
      : resolveEntity(db, { name: 'Vertex Defense Systems', kind: 'company' });

    const tradeDate = '2026-08-01T12:00:00.000Z';
    const awardDate = new Date(Date.parse(tradeDate) + gapDays * 86_400_000).toISOString();

    insertEvent(db, makeEvent('e-trade', 'i-trade', 'securities-trade', tradeDate, [
      { entityId: contractor.id, role: 'target', surfaceForm: 'VDS' },
    ]));
    insertEvent(db, makeEvent('e-award', 'i-award', 'government-award', awardDate, [
      { entityId: awardee.id, role: 'beneficiary', surfaceForm: 'Vertex Defense Systems' },
    ], { amount: { value: 412_000_000, currency: 'USD' } }));

    return { contractor, tradeDate, awardDate };
  }

  it('links a disclosed position to a later award for the same company', () => {
    seedScenario(12);
    const found = runAllPairRules(db, '2026-01-01T00:00:00.000Z');
    const hit = found.find((c) => c.kind === 'trade-then-award');

    expect(hit).toBeDefined();
    expect(hit!.fromEventId).toBe('e-trade');
    expect(hit!.toEventId).toBe('e-award');
    expect(hit!.lagDays).toBeCloseTo(12);
    expect(hit!.basis).toBe('deterministic');
    // Every deterministic link must ship something the reader can check.
    expect(hit!.falsifier).toContain('Vertex Defense Systems');
  });

  it('scores a tight gap above a loose one', () => {
    seedScenario(3);
    const tight = runAllPairRules(db, '2026-01-01T00:00:00.000Z')
      .find((c) => c.kind === 'trade-then-award')!;

    db = openDb(':memory:');
    seedScenario(85);
    const loose = runAllPairRules(db, '2026-01-01T00:00:00.000Z')
      .find((c) => c.kind === 'trade-then-award')!;

    expect(tight.confidence).toBeGreaterThan(loose.confidence);
  });

  it('does not fire when the award goes to a different company', () => {
    seedScenario(12, { sameEntity: false });
    const found = runAllPairRules(db, '2026-01-01T00:00:00.000Z');
    expect(found.filter((c) => c.kind === 'trade-then-award')).toHaveLength(0);
  });

  it('does not fire outside the rule window', () => {
    seedScenario(200);
    const found = runAllPairRules(db, '2026-01-01T00:00:00.000Z');
    expect(found.filter((c) => c.kind === 'trade-then-award')).toHaveLength(0);
  });

  it('does not fire backwards in time', () => {
    seedScenario(-30);
    const found = runAllPairRules(db, '2026-01-01T00:00:00.000Z');
    expect(found.filter((c) => c.kind === 'trade-then-award')).toHaveLength(0);
  });

  it('produces a stable id so re-running does not duplicate', () => {
    seedScenario(12);
    const first = runAllPairRules(db, '2026-01-01T00:00:00.000Z');
    for (const c of first) insertConnection(db, c);
    for (const c of runAllPairRules(db, '2026-01-01T00:00:00.000Z')) insertConnection(db, c);
    expect(counts(db).connections).toBe(first.length);
  });
});

describe('policy-then-beneficiary detection', () => {
  it('fires only when the policy event named the party as a beneficiary', () => {
    upsertSource(db, source({ id: 'fr', name: 'Federal Register', tier: 'primary' }));
    insertItem(db, item('i-rule', 'fr'));
    insertItem(db, item('i-gain', 'fr'));

    const packer = resolveEntity(db, { name: 'Continental Meatpacking', kind: 'company' });

    insertEvent(db, makeEvent('e-rule', 'i-rule', 'policy-action', '2026-08-01T12:00:00.000Z', [
      { entityId: packer.id, role: 'beneficiary', surfaceForm: 'Continental Meatpacking' },
    ]));
    insertEvent(db, makeEvent('e-gain', 'i-gain', 'corporate-action', '2026-08-20T12:00:00.000Z', [
      { entityId: packer.id, role: 'actor', surfaceForm: 'Continental Meatpacking' },
    ]));

    expect(
      runAllPairRules(db, '2026-01-01T00:00:00.000Z')
        .filter((c) => c.kind === 'policy-then-beneficiary'),
    ).toHaveLength(1);
  });

  it('stays silent when the party was merely mentioned', () => {
    upsertSource(db, source({ id: 'fr', name: 'Federal Register', tier: 'primary' }));
    insertItem(db, item('i-rule', 'fr'));
    insertItem(db, item('i-gain', 'fr'));

    const packer = resolveEntity(db, { name: 'Continental Meatpacking', kind: 'company' });
    insertEvent(db, makeEvent('e-rule', 'i-rule', 'policy-action', '2026-08-01T12:00:00.000Z', [
      { entityId: packer.id, role: 'mentioned', surfaceForm: 'Continental Meatpacking' },
    ]));
    insertEvent(db, makeEvent('e-gain', 'i-gain', 'corporate-action', '2026-08-20T12:00:00.000Z', [
      { entityId: packer.id, role: 'actor', surfaceForm: 'Continental Meatpacking' },
    ]));

    expect(
      runAllPairRules(db, '2026-01-01T00:00:00.000Z')
        .filter((c) => c.kind === 'policy-then-beneficiary'),
    ).toHaveLength(0);
  });
});

describe('confidence scoring', () => {
  const rule = PAIR_RULES.find((r) => r.id === 'trade-then-award')!;
  const row = (over: Record<string, unknown> = {}) => ({
    from_id: 'a', to_id: 'b', entity_id: 'e', entity_name: 'E', lag_days: 5,
    from_assertion: 'documented', to_assertion: 'documented',
    from_tier: 'primary' as const, to_tier: 'primary' as const,
    from_summary: '', to_summary: '', ...over,
  });

  it('never exceeds the rule ceiling', () => {
    expect(scorePair(rule, row({ lag_days: 0 }))).toBeLessThanOrEqual(rule.baseConfidence);
  });

  it('discounts speculation below documentation', () => {
    expect(scorePair(rule, row({ from_assertion: 'speculated' })))
      .toBeLessThan(scorePair(rule, row()));
  });

  it('discounts weaker sources', () => {
    expect(scorePair(rule, row({ from_tier: 'secondary' })))
      .toBeLessThan(scorePair(rule, row()));
  });
});

describe('entity overlap', () => {
  it('does not link two events from the same source to each other', () => {
    upsertSource(db, source({ id: 's1' }));
    insertItem(db, item('i1', 's1'));
    insertItem(db, item('i2', 's1'));
    const e = resolveEntity(db, { name: 'Acme Robotics', kind: 'company' });
    insertEvent(db, makeEvent('e1', 'i1', 'statement', '2026-08-20T12:00:00.000Z',
      [{ entityId: e.id, role: 'actor', surfaceForm: 'Acme' }]));
    insertEvent(db, makeEvent('e2', 'i2', 'statement', '2026-08-21T12:00:00.000Z',
      [{ entityId: e.id, role: 'actor', surfaceForm: 'Acme' }]));

    expect(runEntityOverlap(db, '2026-01-01T00:00:00.000Z')).toHaveLength(0);
  });

  it('links the same party across two independent sources', () => {
    upsertSource(db, source({ id: 's1' }));
    upsertSource(db, source({ id: 's2', tier: 'wire' }));
    insertItem(db, item('i1', 's1'));
    insertItem(db, item('i2', 's2'));
    const e = resolveEntity(db, { name: 'Acme Robotics', kind: 'company' });
    insertEvent(db, makeEvent('e1', 'i1', 'statement', '2026-08-20T12:00:00.000Z',
      [{ entityId: e.id, role: 'actor', surfaceForm: 'Acme' }]));
    insertEvent(db, makeEvent('e2', 'i2', 'report', '2026-08-21T12:00:00.000Z',
      [{ entityId: e.id, role: 'target', surfaceForm: 'Acme' }]));

    const found = runEntityOverlap(db, '2026-01-01T00:00:00.000Z');
    expect(found).toHaveLength(1);
    // Recall-oriented and scored to stay below anything deterministic.
    expect(found[0]!.confidence).toBeLessThan(0.4);
  });
});

describe('event queries', () => {
  it('finds events sharing an entity inside a window', () => {
    upsertSource(db, source());
    insertItem(db, item('i1'));
    insertItem(db, item('i2'));
    const e = resolveEntity(db, { name: 'Acme Robotics', kind: 'company' });
    insertEvent(db, makeEvent('e1', 'i1', 'statement', '2026-08-20T12:00:00.000Z',
      [{ entityId: e.id, role: 'actor', surfaceForm: 'Acme' }]));
    insertEvent(db, makeEvent('e2', 'i2', 'report', '2026-08-25T12:00:00.000Z',
      [{ entityId: e.id, role: 'actor', surfaceForm: 'Acme' }]));

    expect(eventsSharingEntities(db, 'e1', 10)).toHaveLength(1);
    expect(eventsSharingEntities(db, 'e1', 2)).toHaveLength(0);
  });
});

describe('stable ids', () => {
  it('are deterministic across runs', () => {
    expect(stableId('item', 'a', 'b')).toBe(stableId('item', 'a', 'b'));
    expect(stableId('item', 'a', 'b')).not.toBe(stableId('item', 'a', 'c'));
  });
});

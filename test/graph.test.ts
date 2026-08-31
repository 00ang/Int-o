import { beforeEach, describe, expect, it } from 'vitest';
import { type DB, openDb } from '../src/core/db.js';
import {
  ROLE_WEIGHT, buildGraph, edgeContribution, entitiesForDomain, graphStats,
  neighbors, recencyFactor,
} from '../src/core/graph.js';
import {
  HUB_DEGREE, SPECIFICITY_PIVOT, activate, conductance, conducts,
} from '../src/pipeline/activate.js';
import { insertEvent, insertItem, resolveEntity, upsertSource } from '../src/core/store.js';
import type { Event, EventEntity, Item, Source } from '../src/core/types.js';
import { UNTRIAGED } from '../src/core/types.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

const source = (over: Partial<Source> = {}): Source => ({
  id: 'src', name: 'Src', kind: 'rss', url: 'https://x/feed', tier: 'primary',
  domains: ['politics'], origin: 'US', intervalMinutes: 60, verified: true,
  enabled: true, ...over,
});

const item = (id: string): Item => ({
  id, sourceId: 'src', externalId: id, url: `https://x/${id}`, title: `Title ${id}`,
  summary: null, body: null, author: null,
  publishedAt: '2026-08-20T12:00:00.000Z', fetchedAt: '2026-08-20T12:00:00.000Z',
  raw: null, extractedAt: null, extractionError: null, ...UNTRIAGED,
});

/** Put an event on file naming the given parties, and return their ids. */
function eventWith(
  id: string, itemId: string, names: Array<[string, EventEntity['role']]>,
  over: Partial<Event> = {},
): string[] {
  const entities: EventEntity[] = names.map(([name, role]) => {
    const ent = resolveEntity(db, {
      name, kind: 'organization', aliases: [], ticker: null, country: 'US',
      seenAt: '2026-08-20T12:00:00.000Z',
    });
    return { entityId: ent.id, role, surfaceForm: name };
  });
  const ev: Event = {
    id, itemId, type: 'policy-action', summary: `event ${id}`,
    occurredAt: '2026-08-20T12:00:00.000Z', occurredAtInferred: false,
    domains: ['politics'], entities, amount: null, tags: [], assertion: 'documented',
    createdAt: '2026-08-20T12:00:00.000Z', ...over,
  };
  insertEvent(db, ev);
  return entities.map((e) => e.entityId);
}

describe('edge weighting', () => {
  it('weights a background mention far below an actor', () => {
    expect(ROLE_WEIGHT.mentioned).toBeLessThan(ROLE_WEIGHT.actor / 3);
  });

  // Multiplicative, so one weak factor pulls the whole contribution down
  // rather than being averaged away by the strong ones.
  it('lets a weak role drag down an otherwise strong pairing', () => {
    const strong = edgeContribution({
      roleA: 'actor', roleB: 'beneficiary', tier: 'primary',
      occurredAt: '2026-08-20T12:00:00.000Z', now: new Date('2026-08-21T12:00:00.000Z'),
    });
    const weak = edgeContribution({
      roleA: 'actor', roleB: 'mentioned', tier: 'primary',
      occurredAt: '2026-08-20T12:00:00.000Z', now: new Date('2026-08-21T12:00:00.000Z'),
    });
    expect(weak).toBeLessThan(strong / 3);
  });

  it('discounts an old co-occurrence against a fresh one', () => {
    const now = new Date('2026-08-20T12:00:00.000Z');
    expect(recencyFactor('2026-08-20T12:00:00.000Z', now)).toBeCloseTo(1, 5);
    // One half-life back should be worth half as much.
    expect(recencyFactor('2025-02-26T12:00:00.000Z', now)).toBeCloseTo(0.5, 1);
  });

  it('never lets a future date inflate a weight above the present', () => {
    const now = new Date('2026-08-20T12:00:00.000Z');
    expect(recencyFactor('2027-01-01T00:00:00.000Z', now)).toBe(1);
  });
});

describe('building the graph', () => {
  beforeEach(() => {
    upsertSource(db, source());
    insertItem(db, item('i1'));
  });

  it('wires two parties named in one event', () => {
    const [a, b] = eventWith('e1', 'i1', [['Alpha Corp', 'actor'], ['Beta Corp', 'beneficiary']]);
    buildGraph(db);
    expect(neighbors(db, a!).map((n) => n.id)).toEqual([b]);
  });

  it('records one edge per pair, not one per direction', () => {
    eventWith('e1', 'i1', [['Alpha Corp', 'actor'], ['Beta Corp', 'beneficiary']]);
    buildGraph(db);
    expect(graphStats(db).edges).toBe(1);
  });

  it('strengthens an edge each time the pair recurs', () => {
    eventWith('e1', 'i1', [['Alpha Corp', 'actor'], ['Beta Corp', 'beneficiary']]);
    buildGraph(db);
    const once = neighbors(db, resolveEntity(db, {
      name: 'Alpha Corp', kind: 'organization', aliases: [], ticker: null,
      country: 'US', seenAt: '2026-08-20T12:00:00.000Z',
    }).id)[0]!.weight;

    eventWith('e2', 'i1', [['Alpha Corp', 'actor'], ['Beta Corp', 'beneficiary']]);
    buildGraph(db);
    const twice = neighbors(db, resolveEntity(db, {
      name: 'Alpha Corp', kind: 'organization', aliases: [], ticker: null,
      country: 'US', seenAt: '2026-08-20T12:00:00.000Z',
    }).id)[0]!.weight;

    expect(twice).toBeGreaterThan(once);
  });

  // Without this the map is a pile of small cliques and energy cannot travel.
  it('wires parties that share a document but no single event', () => {
    const [a] = eventWith('e1', 'i1', [['Alpha Corp', 'actor'], ['Shared Corp', 'target']]);
    const [, c] = eventWith('e2', 'i1', [['Shared Corp', 'actor'], ['Gamma Corp', 'target']]);
    buildGraph(db);
    // Alpha and Gamma never appear in one event, only in one document.
    expect(neighbors(db, a!).map((n) => n.id)).toContain(c);
  });

  it('rebuilds from scratch rather than accumulating duplicates', () => {
    eventWith('e1', 'i1', [['Alpha Corp', 'actor'], ['Beta Corp', 'beneficiary']]);
    buildGraph(db);
    buildGraph(db);
    expect(graphStats(db).edges).toBe(1);
  });

  it('links parties to the topics of the events they appear in', () => {
    eventWith('e1', 'i1', [['Alpha Corp', 'actor'], ['Beta Corp', 'beneficiary']],
      { domains: ['energy', 'markets'] });
    buildGraph(db);
    expect(entitiesForDomain(db, 'energy').length).toBe(2);
    expect(entitiesForDomain(db, 'legal').length).toBe(0);
  });
});

describe('conductance', () => {
  it('passes everything through a specific party untouched', () => {
    expect(conductance(1)).toBe(1);
    expect(conductance(SPECIFICITY_PIVOT)).toBe(1);
  });

  // A party wired to everything says nothing by wiring two more things.
  it('attenuates in proportion to how connected a party is', () => {
    expect(conductance(SPECIFICITY_PIVOT * 2)).toBeCloseTo(0.5, 5);
    expect(conductance(SPECIFICITY_PIVOT * 10)).toBeCloseTo(0.1, 5);
  });

  it('falls monotonically, with no cliff', () => {
    for (let d = 1; d < 60; d++) {
      expect(conductance(d + 1)).toBeLessThanOrEqual(conductance(d));
    }
  });
});

describe('what may relay energy', () => {
  it('relays through a named party', () => {
    expect(conducts('Lockheed Martin', 'company')).toBe(true);
    expect(conducts('Federal Railroad Administration', 'government-body')).toBe(true);
  });

  // A country is a container. Routing through it says only that both ends are
  // in the same country, which is true of almost everything on file.
  it('will not relay through a country or a place', () => {
    expect(conducts('United States', 'country')).toBe(false);
    expect(conducts('Kyiv', 'location')).toBe(false);
  });

  it('will not relay through a party the source declined to name', () => {
    expect(conducts('an unnamed private company', 'company')).toBe(false);
    expect(conducts('Unnamed Former Official', 'person')).toBe(false);
    expect(conducts('U.S. official', 'person')).toBe(false);
    expect(conducts('senior official', 'person')).toBe(false);
  });

  it('does not mistake a real name containing a common word', () => {
    expect(conducts('Official Payments Corp', 'company')).toBe(true);
    expect(conducts('Source Global', 'company')).toBe(true);
  });
});

describe('spreading activation', () => {
  beforeEach(() => {
    upsertSource(db, source());
    insertItem(db, item('i1'));
  });

  /**
   * A -- B -- C, so C is only reachable through B.
   *
   * The two events must sit in DIFFERENT documents. Parties sharing a document
   * are wired directly, which is correct behaviour and would short the chain:
   * A and C would become neighbours and there would be nothing to traverse.
   */
  function chain() {
    insertItem(db, item('i2'));
    const [a, b] = eventWith('e1', 'i1', [['Alpha Corp', 'actor'], ['Bravo Corp', 'beneficiary']]);
    const [, c] = eventWith('e2', 'i2', [['Bravo Corp', 'actor'], ['Charlie Corp', 'beneficiary']]);
    buildGraph(db);
    return { a: a!, b: b!, c: c! };
  }

  it('reaches a party no event names beside the seed', () => {
    const { a, c } = chain();
    const r = activate(db, [a]);
    expect(r.nodes.map((n) => n.id)).toContain(c);
  });

  it('marks how far away a party was reached', () => {
    const { a, b, c } = chain();
    const r = activate(db, [a]);
    expect(r.nodes.find((n) => n.id === b)!.hops).toBe(1);
    expect(r.nodes.find((n) => n.id === c)!.hops).toBe(2);
  });

  // The whole point: one hop is co-occurrence, which a join already finds.
  it('separates the indirectly reached from the directly named', () => {
    const { a, b, c } = chain();
    const r = activate(db, [a]);
    expect(r.distant.map((n) => n.id)).toContain(c);
    expect(r.distant.map((n) => n.id)).not.toContain(b);
  });

  it('keeps the route that lit each party, so it can be walked', () => {
    const { a, b, c } = chain();
    const r = activate(db, [a]);
    expect(r.nodes.find((n) => n.id === c)!.path).toEqual([a, b, c]);
  });

  it('falls off with distance', () => {
    const { a, b, c } = chain();
    const r = activate(db, [a]);
    const near = r.nodes.find((n) => n.id === b)!.energy;
    const far = r.nodes.find((n) => n.id === c)!.energy;
    expect(far).toBeLessThan(near);
  });

  it('never returns the seed as its own result', () => {
    const { a } = chain();
    expect(activate(db, [a]).nodes.map((n) => n.id)).not.toContain(a);
  });

  it('stops where the hop budget runs out', () => {
    const { a, c } = chain();
    expect(activate(db, [a], { hops: 1 }).nodes.map((n) => n.id)).not.toContain(c);
  });

  it('reports nothing rather than failing when the seed is unknown to the map', () => {
    chain();
    const r = activate(db, ['ent_nonexistent']);
    expect(r.nodes).toEqual([]);
    expect(r.distant).toEqual([]);
  });

  it('holds a hub instead of relaying through it', () => {
    // One party wired to many others, past the hub cutoff.
    // Each spoke in its own document, so they are wired to the hub alone and
    // not to each other by sharing a page.
    for (let i = 0; i < HUB_DEGREE + 4; i++) {
      insertItem(db, item(`hub${i}`));
      eventWith(`h${i}`, `hub${i}`, [['Hub Corp', 'actor'], [`Spoke ${i} Ltd`, 'beneficiary']]);
    }
    insertItem(db, item('seeditem'));
    eventWith('seed', 'seeditem', [['Seed Corp', 'actor'], ['Hub Corp', 'beneficiary']]);
    buildGraph(db);
    const seedId = resolveEntity(db, {
      name: 'Seed Corp', kind: 'organization', aliases: [], ticker: null,
      country: 'US', seenAt: '2026-08-20T12:00:00.000Z',
    }).id;
    const r = activate(db, [seedId]);
    expect(r.hubsHeld).toContain('Hub Corp');
    // The spokes are only reachable through the hub, so none should be lit.
    expect(r.distant.filter((n) => n.name.startsWith('Spoke'))).toHaveLength(0);
  });
});

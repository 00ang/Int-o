import type { DB } from './db.js';
import type { Domain, EntityRole, Tier } from './types.js';
import { TIER_WEIGHT } from './types.js';

/**
 * The association graph.
 *
 * Everything else in this system asks whether two records join on a shared
 * party inside a date window. That finds the checkable cases and misses the
 * interesting ones, because a join can only see what already sits in the same
 * row. The graph exists to see further: parties become nodes, the events they
 * share become weighted edges, and a question can then travel.
 *
 * Two rules keep it honest, and they are the rules the detectors already follow.
 *
 * An edge records CO-OCCURRENCE, not relationship. Two parties named in one
 * filing get an edge whether they are conspirators, counterparties, or
 * strangers who happened onto the same page. The weight says how firmly and
 * how often they co-occur. It never says why.
 *
 * And structural proximity is not evidence. A node lighting up three hops away
 * means the map has a path to it. That is a reason to look and nothing more,
 * which is why every path is kept: so a person can walk it and throw it out.
 */

/**
 * How much a party's role in an event says about their involvement.
 *
 * A mentioned party is background. Naming Congress in a press release should
 * not wire Congress to everything that release touches. Actors and
 * beneficiaries are what the rest of the system cares about, so they carry
 * the edge.
 */
export const ROLE_WEIGHT: Record<EntityRole, number> = {
  actor: 1.0,
  beneficiary: 1.0,
  counterparty: 0.9,
  target: 0.8,
  regulator: 0.55,
  mentioned: 0.25,
};

/** Half-life in days for how much an old co-occurrence still counts. */
export const RECENCY_HALF_LIFE_DAYS = 540;

export function recencyFactor(occurredAt: string, now = new Date()): number {
  const days = (now.getTime() - new Date(occurredAt).getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return 1;
  return Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
}

/**
 * What one shared event contributes to an edge.
 *
 * Multiplicative on purpose. A pair is only strongly wired when both parties
 * matter to the event, the source is worth something, and it happened recently
 * enough to still be true. Any one of those being weak should pull the whole
 * contribution down rather than be averaged away.
 */
export function edgeContribution(opts: {
  roleA: EntityRole;
  roleB: EntityRole;
  tier: Tier;
  occurredAt: string;
  now?: Date;
}): number {
  return (
    (ROLE_WEIGHT[opts.roleA] ?? 0.25) *
    (ROLE_WEIGHT[opts.roleB] ?? 0.25) *
    (TIER_WEIGHT[opts.tier] ?? 0.5) *
    recencyFactor(opts.occurredAt, opts.now)
  );
}

/**
 * How strongly each kind of shared context wires two parties.
 *
 * Appearing in one event together is the strongest claim the corpus can make:
 * a single dated assertion names them both. Appearing in different events of
 * the same document is weaker but real - an editor put them on one page.
 * Appearing in one storyline is weaker still, and it is the one that gives the
 * graph any reach at all: without it the map is a pile of two- and three-party
 * cliques with no bridges, and energy has nowhere to travel.
 */
export const CONTEXT_WEIGHT = {
  event: 1.0,
  item: 0.55,
  thread: 0.3,
} as const;

export interface BuildResult {
  edges: number;
  entityDomains: number;
  eventsRead: number;
  eventPairs: number;
  itemPairs: number;
  threadPairs: number;
}

/**
 * Rebuild the graph from the events on file.
 *
 * A full rebuild rather than an incremental update: the weights depend on
 * recency, so every edge changes as time passes anyway, and a rebuild over a
 * corpus this size takes a few hundred milliseconds. Correctness over
 * cleverness.
 */
export function buildGraph(db: DB, opts: { now?: Date } = {}): BuildResult {
  const now = opts.now ?? new Date();

  const rows = db.prepare(`
    SELECT ee.event_id, ee.entity_id, ee.role, e.occurred_at, e.domains, s.tier
      FROM event_entities ee
      JOIN events e ON e.id = ee.event_id
      JOIN items i  ON i.id = e.item_id
      JOIN sources s ON s.id = i.source_id
  `).all() as Array<{
    event_id: string; entity_id: string; role: EntityRole;
    occurred_at: string; domains: string; tier: Tier;
  }>;

  const byEvent = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byEvent.get(r.event_id);
    if (list) list.push(r);
    else byEvent.set(r.event_id, [r]);
  }

  const edges = new Map<string, {
    a: string; b: string; w: number; n: number; first: string; last: string;
  }>();
  const domains = new Map<string, { entity: string; domain: string; w: number }>();

  for (const members of byEvent.values()) {
    const first = members[0];
    if (!first) continue;

    // Party to topic, so a subject can seed activation without naming anyone.
    let evDomains: Domain[] = [];
    try {
      evDomains = JSON.parse(first.domains ?? '[]') as Domain[];
    } catch {
      evDomains = [];
    }
    for (const m of members) {
      const rw = (ROLE_WEIGHT[m.role] ?? 0.25) * recencyFactor(m.occurred_at, now);
      for (const d of evDomains) {
        const key = `${m.entity_id} ${d}`;
        const prev = domains.get(key);
        if (prev) prev.w += rw;
        else domains.set(key, { entity: m.entity_id, domain: d, w: rw });
      }
    }

    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const m1 = members[i]!;
        const m2 = members[j]!;
        if (m1.entity_id === m2.entity_id) continue;
        const [a, b] = m1.entity_id < m2.entity_id
          ? [m1.entity_id, m2.entity_id]
          : [m2.entity_id, m1.entity_id];
        const w = edgeContribution({
          roleA: m1.role, roleB: m2.role, tier: m1.tier, occurredAt: m1.occurred_at, now,
        });
        const key = `${a} ${b}`;
        const prev = edges.get(key);
        if (prev) {
          prev.w += w;
          prev.n += 1;
          if (m1.occurred_at < prev.first) prev.first = m1.occurred_at;
          if (m1.occurred_at > prev.last) prev.last = m1.occurred_at;
        } else {
          edges.set(key, { a, b, w, n: 1, first: m1.occurred_at, last: m1.occurred_at });
        }
      }
    }
  }

  const eventPairs = edges.size;

  /**
   * Wire parties that share a wider context than one event.
   *
   * Run after the event pass so a pair already joined by a shared event is
   * strengthened rather than double counted at the weaker rate.
   */
  const addContext = (
    groups: Map<string, Array<{ entity_id: string; role: EntityRole; occurred_at: string; tier: Tier }>>,
    factor: number,
  ) => {
    for (const members of groups.values()) {
      // A single sprawling group would wire everything in it to everything
      // else; past a point that is a topic, not an association.
      if (members.length < 2 || members.length > 14) continue;
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const m1 = members[i]!;
          const m2 = members[j]!;
          if (m1.entity_id === m2.entity_id) continue;
          const [a, b] = m1.entity_id < m2.entity_id
            ? [m1.entity_id, m2.entity_id]
            : [m2.entity_id, m1.entity_id];
          const w = factor * edgeContribution({
            roleA: m1.role, roleB: m2.role, tier: m1.tier, occurredAt: m1.occurred_at, now,
          });
          const key = `${a} ${b}`;
          const prev = edges.get(key);
          if (prev) {
            prev.w += w;
          } else {
            edges.set(key, { a, b, w, n: 0, first: m1.occurred_at, last: m1.occurred_at });
          }
        }
      }
    }
  };

  const itemRows = db.prepare(`
    SELECT e.item_id AS gid, ee.entity_id, ee.role, e.occurred_at, s.tier
      FROM event_entities ee
      JOIN events e ON e.id = ee.event_id
      JOIN items i ON i.id = e.item_id
      JOIN sources s ON s.id = i.source_id
     WHERE ee.role != 'mentioned'
  `).all() as Array<{ gid: string; entity_id: string; role: EntityRole; occurred_at: string; tier: Tier }>;
  const byItem = new Map<string, typeof itemRows>();
  for (const r of itemRows) {
    const l = byItem.get(r.gid);
    if (l) l.push(r); else byItem.set(r.gid, [r]);
  }
  const beforeItem = edges.size;
  addContext(byItem, CONTEXT_WEIGHT.item);
  const itemPairs = edges.size - beforeItem;

  const threadRows = db.prepare(`
    SELECT te.thread_id AS gid, ee.entity_id, ee.role, e.occurred_at, s.tier
      FROM thread_events te
      JOIN events e ON e.id = te.event_id
      JOIN event_entities ee ON ee.event_id = e.id
      JOIN items i ON i.id = e.item_id
      JOIN sources s ON s.id = i.source_id
     WHERE ee.role != 'mentioned'
  `).all() as Array<{ gid: string; entity_id: string; role: EntityRole; occurred_at: string; tier: Tier }>;
  const byThread = new Map<string, typeof threadRows>();
  for (const r of threadRows) {
    const l = byThread.get(r.gid);
    if (l) l.push(r); else byThread.set(r.gid, [r]);
  }
  const beforeThread = edges.size;
  addContext(byThread, CONTEXT_WEIGHT.thread);
  const threadPairs = edges.size - beforeThread;

  const tx = db.transaction(() => {
    db.exec('DELETE FROM graph_edges; DELETE FROM entity_domains;');
    const ins = db.prepare(
      `INSERT INTO graph_edges (a_id, b_id, weight, event_count, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const e of edges.values()) ins.run(e.a, e.b, e.w, e.n, e.first, e.last);
    const insD = db.prepare(
      'INSERT INTO entity_domains (entity_id, domain, weight) VALUES (?, ?, ?)',
    );
    for (const d of domains.values()) insD.run(d.entity, d.domain, d.w);
  });
  tx();

  return {
    edges: edges.size,
    entityDomains: domains.size,
    eventsRead: byEvent.size,
    eventPairs, itemPairs, threadPairs,
  };
}

export interface Neighbor {
  id: string;
  weight: number;
  eventCount: number;
}

/** Everything wired to one node, strongest first. */
export function neighbors(db: DB, entityId: string, limit = 40): Neighbor[] {
  return db.prepare(`
    SELECT CASE WHEN a_id = @id THEN b_id ELSE a_id END AS id,
           weight, event_count AS eventCount
      FROM graph_edges
     WHERE a_id = @id OR b_id = @id
     ORDER BY weight DESC LIMIT @limit
  `).all({ id: entityId, limit }) as Neighbor[];
}

/** Parties most associated with a topic. Lets a subject seed activation. */
export function entitiesForDomain(db: DB, domain: string, limit = 25): Neighbor[] {
  return db.prepare(`
    SELECT entity_id AS id, weight, 0 AS eventCount
      FROM entity_domains WHERE domain = @domain
     ORDER BY weight DESC LIMIT @limit
  `).all({ domain, limit }) as Neighbor[];
}

/** The events that put an edge there. The reason a path is walkable. */
export function edgeEvidence(db: DB, aId: string, bId: string, limit = 6) {
  return db.prepare(`
    SELECT e.id, e.summary, e.occurred_at AS occurredAt, e.type,
           i.id AS itemId, i.title AS itemTitle, s.name AS source
      FROM events e
      JOIN event_entities ea ON ea.event_id = e.id AND ea.entity_id = @a
      JOIN event_entities eb ON eb.event_id = e.id AND eb.entity_id = @b
      JOIN items i ON i.id = e.item_id
      JOIN sources s ON s.id = i.source_id
     ORDER BY e.occurred_at DESC LIMIT @limit
  `).all({ a: aId, b: bId, limit }) as Array<{
    id: string; summary: string; occurredAt: string; type: string;
    itemId: string; itemTitle: string; source: string;
  }>;
}

export function graphStats(db: DB) {
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    edges: one('SELECT COUNT(*) c FROM graph_edges'),
    nodes: one(
      `SELECT COUNT(*) c FROM (
         SELECT a_id AS id FROM graph_edges UNION SELECT b_id FROM graph_edges)`,
    ),
    domainLinks: one('SELECT COUNT(*) c FROM entity_domains'),
  };
}

import type { DB } from '../core/db.js';
import { entitiesForDomain, neighbors } from '../core/graph.js';
import { getEntity } from '../core/store.js';

/**
 * Spreading activation over the association graph.
 *
 * A seed carries energy. Energy travels along edges, split in proportion to
 * edge weight and cut by a decay at every hop, until it falls under a
 * threshold or runs out of hops. Whatever is still lit at the end is what the
 * corpus associates with the seed.
 *
 * The point is the far half. A node one hop out is a party named alongside the
 * seed, which a join already finds and which nobody needs a graph for. A node
 * lit at two or three hops was reached through intermediaries - it never
 * appeared beside the seed anywhere - and that is the shape no query over
 * events can return.
 *
 * WHAT ACTIVATION IS NOT. It is not evidence, not correlation, and not a
 * finding. It says the map has a weighted path, and a weighted path through a
 * co-occurrence graph is exactly as innocent as co-occurrence. Two parties can
 * light each other up through nothing more than a shared regulator and a busy
 * week. That is why every activated node carries the path that lit it and the
 * events on that path: so the reason is inspectable and can be dismissed.
 */

/** Energy kept at each hop. Below about 0.35 the far field never lights. */
export const DEFAULT_DECAY = 0.5;
/** Energy under this is noise and stops travelling. */
export const DEFAULT_THRESHOLD = 0.008;
export const DEFAULT_HOPS = 3;

/**
 * Nodes wired to almost everything conduct energy without meaning anything.
 *
 * "United States" sits on a path between any two parties in a corpus of
 * American government records, so letting energy through it lights the whole
 * map from any seed. Hubs still receive energy and still appear in the result;
 * they simply stop relaying it onward.
 *
 * Degree alone does not catch them in a sparse graph, so two other classes are
 * held as well.
 */
export const HUB_DEGREE = 18;

/**
 * Kinds specific enough to be worth relaying through.
 *
 * A country or a place is a container, not a party: everything in a corpus of
 * American records touches the United States, and routing through it says only
 * that both ends are American. They still light up and are still reported -
 * they just cannot be the reason something else lit.
 */
export const RELAY_KINDS = new Set([
  'person', 'company', 'organization', 'government-body', 'policy',
]);

/**
 * Parties the extractor recorded because the source declined to name one.
 *
 * "an unnamed private company" is a real and useful thing to have captured -
 * it is the shape of the gap - but it is not an identity, and wiring energy
 * through it would join every story that withheld a name to every other one.
 */
export const PLACEHOLDER_NAME =
  /\b(unnamed|unidentified|undisclosed|anonymous|unspecified|former)\s|^(an?\s+|the\s+)?(u\.?s\.?\s+|senior\s+|government\s+)*(official|source|spokesperson|representative|aide|insider|company|agency)s?$/i;

/**
 * How much sharing the item's subject amplifies a node once energy reaches it.
 *
 * The topic works on the far end rather than the near end. Seeding from a
 * subject fires the map from whoever is globally prominent in it; boosting on
 * arrival instead means a party has to be reachable through the story's own
 * parties AND work in the same subject before it stands out. That is what
 * makes a topic and a name fire together rather than compete.
 */
export const DOMAIN_BOOST = 0.35;

export function conducts(name: string, kind: string): boolean {
  return RELAY_KINDS.has(kind) && !PLACEHOLDER_NAME.test(name);
}

/**
 * Degree at which a node starts losing conductance.
 *
 * The hard hub cutoff only catches the extremes, and the damage is done well
 * before that. "United States Government" sits between a diplomatic cable and
 * an AI-lab funding round; both are genuinely wired to it, and neither has
 * anything to do with the other.
 */
export const SPECIFICITY_PIVOT = 6;

/**
 * How much of its energy a node passes on, by how specific it is.
 *
 * A party connected to everything says little by connecting two more things,
 * so energy through it is attenuated in proportion to its degree. This is the
 * same instinct as weighting a rare term above a common one: a path through a
 * party with three associates is informative, and the same path through one
 * with forty is a fact about the corpus rather than about the story.
 *
 * Smooth rather than a threshold, so a node does not flip between conducting
 * perfectly and not at all over one extra edge.
 */
export function conductance(degree: number): number {
  if (degree <= SPECIFICITY_PIVOT) return 1;
  return SPECIFICITY_PIVOT / degree;
}

export interface ActivationStep {
  from: string;
  to: string;
  weight: number;
}

export interface ActivatedNode {
  id: string;
  name: string;
  kind: string;
  energy: number;
  /** Fewest hops from any seed. 1 is a direct co-occurrence. */
  hops: number;
  /** How many of the item's topics this party is also associated with. */
  sharedTopics: number;
  /** The route energy took to get here, seed first. */
  path: string[];
  pathNames: string[];
}

export interface ActivationResult {
  seeds: string[];
  seedNames: string[];
  nodes: ActivatedNode[];
  /** Lit at two hops or more: reached only through an intermediary. */
  distant: ActivatedNode[];
  edgesWalked: number;
  hubsHeld: string[];
}

export interface ActivateOptions {
  decay?: number;
  threshold?: number;
  hops?: number;
  /** Topics the item is about. Nodes working in them are amplified on arrival. */
  domains?: string[];
  maxNodes?: number;
}

function degree(db: DB, id: string): number {
  return (db.prepare(
    'SELECT COUNT(*) c FROM graph_edges WHERE a_id = ? OR b_id = ?',
  ).get(id, id) as { c: number }).c;
}

/**
 * Fire the network from a set of seed parties.
 *
 * Breadth-first by hop so the shortest route to a node is the one recorded,
 * which makes `hops` mean what it says and keeps the stored path the simplest
 * explanation rather than whichever one arrived last.
 */
export function activate(
  db: DB,
  seedIds: string[],
  opts: ActivateOptions = {},
): ActivationResult {
  const decay = opts.decay ?? DEFAULT_DECAY;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxHops = opts.hops ?? DEFAULT_HOPS;
  const maxNodes = opts.maxNodes ?? 60;

  // Only the story's own parties seed. A topic is not a starting point - the
  // top parties of "politics" are whoever is globally prominent, and seeding
  // them fires the map from prominence instead of from the story.
  const seedEnergy = new Map<string, number>();
  for (const id of seedIds) seedEnergy.set(id, 1);
  const seeds = new Set(seedEnergy.keys());

  // The topic acts on the far end instead: a node that shares the subject the
  // item is about is amplified once energy reaches it. That is what makes a
  // topic and a party fire together rather than competing.
  const topicOf = new Map<string, number>();
  for (const d of opts.domains ?? []) {
    for (const e of entitiesForDomain(db, d, 60)) {
      topicOf.set(e.id, (topicOf.get(e.id) ?? 0) + 1);
    }
  }

  interface State { energy: number; hops: number; path: string[] }
  const state = new Map<string, State>();
  for (const [s, e] of seedEnergy) state.set(s, { energy: e, hops: 0, path: [s] });

  const hubsHeld = new Set<string>();
  let edgesWalked = 0;
  let frontier = [...seeds];

  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const from of frontier) {
      const cur = state.get(from);
      if (!cur || cur.energy < threshold) continue;

      // A hub receives but does not relay. Everything routes through it
      // otherwise, and the map lights up uniformly and says nothing. Seeds are
      // exempt: the item named them, so the first hop out of them is the
      // question being asked, not a coincidence of topology.
      const fromDegree = degree(db, from);
      if (!seeds.has(from)) {
        const ent = getEntity(db, from);
        if (!ent || !conducts(ent.name, ent.kind) || fromDegree > HUB_DEGREE) {
          hubsHeld.add(from);
          continue;
        }
      }
      // Attenuation applies to seeds too. A generic institution the item
      // happened to name is a poor place to route a question through, whether
      // or not the item named it.
      const pass = conductance(fromDegree);

      const ns = neighbors(db, from, 25);
      // Normalise against the strongest edge, not the sum of all of them.
      // Dividing a fixed budget among every neighbour makes energy vanish by
      // the second hop purely because a node is well connected - a party with
      // twenty associates would pass on a twentieth of what a party with one
      // does, which measures popularity rather than association. Against the
      // maximum, a strong link stays strong however many others exist, and
      // weak ones still die out on their own.
      const strongest = ns.reduce((m, n) => Math.max(m, n.weight), 0);
      if (strongest <= 0) continue;

      for (const n of ns) {
        edgesWalked++;
        const share = (n.weight / strongest) * cur.energy * decay * pass;
        if (share < threshold) continue;
        const prev = state.get(n.id);
        if (prev === undefined) {
          state.set(n.id, { energy: share, hops: hop, path: [...cur.path, n.id] });
          next.push(n.id);
        } else {
          // Energy accumulates from every route, but the recorded path stays
          // the shortest one found - the simplest available explanation.
          prev.energy += share;
          if (hop < prev.hops) {
            prev.hops = hop;
            prev.path = [...cur.path, n.id];
          }
        }
      }
    }
    frontier = next;
  }

  const nodes: ActivatedNode[] = [];
  for (const [id, s] of state) {
    if (seeds.has(id)) continue;
    if (s.energy < threshold) continue;
    const ent = getEntity(db, id);
    if (!ent) continue;
    const shared = topicOf.get(id) ?? 0;
    nodes.push({
      id,
      name: ent.name,
      kind: ent.kind,
      energy: s.energy * (1 + DOMAIN_BOOST * Math.min(shared, 3)),
      sharedTopics: shared,
      hops: s.hops,
      path: s.path,
      pathNames: s.path.map((p) => getEntity(db, p)?.name ?? '?'),
    });
  }
  nodes.sort((a, b) => b.energy - a.energy);
  const kept = nodes.slice(0, maxNodes);

  return {
    seeds: [...seeds],
    seedNames: [...seeds].map((s) => getEntity(db, s)?.name ?? '?'),
    nodes: kept,
    distant: kept.filter((n) => n.hops >= 2),
    edgesWalked,
    hubsHeld: [...hubsHeld].map((h) => getEntity(db, h)?.name ?? h),
  };
}

/**
 * Fire the network from an item, using the parties and topics it carries.
 *
 * This is the operation the reading queue wants: something arrived, so light
 * the map from it and see what else is standing.
 */
export function activateFromItem(
  db: DB,
  itemId: string,
  opts: ActivateOptions = {},
): ActivationResult {
  // Seed only from parties specific enough to mean something. Seeding from
  // "United States" asks "what else is American", which is not a question.
  const rows = (db.prepare(`
    SELECT DISTINCT ee.entity_id AS id, en.name, en.kind
      FROM events e
      JOIN event_entities ee ON ee.event_id = e.id
      JOIN entities en ON en.id = ee.entity_id
     WHERE e.item_id = @id AND ee.role != 'mentioned'
  `).all({ id: itemId }) as Array<{ id: string; name: string; kind: string }>)
    .filter((r) => conducts(r.name, r.kind));

  const domainRows = db.prepare(
    'SELECT domains FROM events WHERE item_id = @id',
  ).all({ id: itemId }) as Array<{ domains: string }>;
  const domains = new Set<string>();
  for (const r of domainRows) {
    try {
      for (const d of JSON.parse(r.domains ?? '[]') as string[]) domains.add(d);
    } catch { /* a malformed row should not stop the firing */ }
  }

  return activate(db, rows.map((r) => r.id), { ...opts, domains: [...domains] });
}

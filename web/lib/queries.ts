import { db } from './db';

/**
 * Reads for the document views.
 *
 * These are shaped for rendering rather than for the pipeline, which is why
 * they live here rather than in the engine's store: the CLI wants domain
 * objects, a page wants a row it can print.
 */
export type Verdict = 'notable' | 'worth-a-look' | 'mundane';

export interface QueueRow {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
  verdict: Verdict;
  topic: string;
  reason: string;
  angle: string | null;
  source: string;
  tier: string;
  extracted: number;
}

const QUEUE_SELECT = `
  SELECT i.id, i.title, i.url, i.published_at AS publishedAt,
         i.triage_verdict AS verdict, i.triage_topic AS topic,
         i.triage_reason AS reason, i.triage_angle AS angle,
         s.name AS source, s.tier AS tier,
         (i.extracted_at IS NOT NULL) AS extracted
    FROM items i JOIN sources s ON s.id = i.source_id`;

export function queue(opts: { verdict?: Verdict; tier?: string; q?: string; limit?: number } = {}): QueueRow[] {
  const where = ["i.triage_verdict IS NOT NULL", "i.triage_verdict != 'mundane'"];
  const params: Record<string, unknown> = { limit: opts.limit ?? 200 };
  if (opts.verdict) { where.push('i.triage_verdict = @verdict'); params.verdict = opts.verdict; }
  if (opts.tier) { where.push('s.tier = @tier'); params.tier = opts.tier; }
  if (opts.q) {
    where.push('(i.title LIKE @q OR i.triage_topic LIKE @q OR i.triage_angle LIKE @q)');
    params.q = `%${opts.q}%`;
  }
  return db().prepare(`${QUEUE_SELECT} WHERE ${where.join(' AND ')}
      ORDER BY CASE i.triage_verdict WHEN 'notable' THEN 2 ELSE 1 END DESC, i.published_at DESC
      LIMIT @limit`).all(params) as QueueRow[];
}

export function item(id: string): QueueRow | null {
  return (db().prepare(`${QUEUE_SELECT} WHERE i.id = @id`).get({ id }) as QueueRow) ?? null;
}

export interface EventRow {
  id: string; type: string; summary: string; occurredAt: string;
  assertion: string; parties: string;
}

export function eventsForItem(id: string): EventRow[] {
  return db().prepare(`
    SELECT e.id, e.type, e.summary, e.occurred_at AS occurredAt, e.assertion,
           COALESCE(GROUP_CONCAT(en.name || ' (' || ee.role || ')', ', '), '') AS parties
      FROM events e
      LEFT JOIN event_entities ee ON ee.event_id = e.id
      LEFT JOIN entities en ON en.id = ee.entity_id
     WHERE e.item_id = @id AND (ee.role IS NULL OR ee.role != 'mentioned')
     GROUP BY e.id ORDER BY e.occurred_at`).all({ id }) as EventRow[];
}

export interface ConnectionRow {
  id: string; kind: string; basis: string; confidence: number; lagDays: number;
  explanation: string; falsifier: string | null; fromSummary: string; toSummary: string;
}

export function connectionsForItem(id: string): ConnectionRow[] {
  return db().prepare(`
    SELECT c.id, c.kind, c.basis, c.confidence, c.lag_days AS lagDays,
           c.explanation, c.falsifier, a.summary AS fromSummary, b.summary AS toSummary
      FROM connections c
      JOIN events a ON a.id = c.from_event_id
      JOIN events b ON b.id = c.to_event_id
     WHERE a.item_id = @id OR b.item_id = @id
     ORDER BY c.confidence DESC`).all({ id }) as ConnectionRow[];
}

export function stats() {
  const one = (sql: string) => (db().prepare(sql).get() as { c: number }).c;
  return {
    items: one('SELECT COUNT(*) c FROM items'),
    judged: one("SELECT COUNT(*) c FROM items WHERE triaged_at IS NOT NULL"),
    untriaged: one('SELECT COUNT(*) c FROM items WHERE triaged_at IS NULL'),
    kept: one("SELECT COUNT(*) c FROM items WHERE triage_verdict IS NOT NULL AND triage_verdict != 'mundane'"),
    notable: one("SELECT COUNT(*) c FROM items WHERE triage_verdict = 'notable'"),
    events: one('SELECT COUNT(*) c FROM events'),
    entities: one('SELECT COUNT(*) c FROM entities'),
    connections: one('SELECT COUNT(*) c FROM connections'),
    threads: one('SELECT COUNT(*) c FROM threads'),
    sourcesLive: one('SELECT COUNT(*) c FROM sources WHERE verified = 1'),
  };
}

export interface EntityRow { id: string; name: string; kind: string; slug: string; events: number }

export function topEntities(limit = 40): EntityRow[] {
  return db().prepare(`
    SELECT en.id, en.name, en.kind, en.slug, COUNT(DISTINCT ee.event_id) AS events
      FROM entities en JOIN event_entities ee ON ee.entity_id = en.id
     GROUP BY en.id ORDER BY events DESC, en.name LIMIT @limit`).all({ limit }) as EntityRow[];
}

export function entityBySlug(slug: string): EntityRow | null {
  return (db().prepare(`
    SELECT en.id, en.name, en.kind, en.slug, COUNT(DISTINCT ee.event_id) AS events
      FROM entities en LEFT JOIN event_entities ee ON ee.entity_id = en.id
     WHERE en.slug = @slug GROUP BY en.id`).get({ slug }) as EntityRow) ?? null;
}

export function eventsForEntity(id: string) {
  return db().prepare(`
    SELECT e.id, e.type, e.summary, e.occurred_at AS occurredAt, ee.role,
           i.id AS itemId, i.title AS itemTitle, s.name AS source
      FROM event_entities ee
      JOIN events e ON e.id = ee.event_id
      JOIN items i ON i.id = e.item_id
      JOIN sources s ON s.id = i.source_id
     WHERE ee.entity_id = @id ORDER BY e.occurred_at DESC LIMIT 100`).all({ id }) as Array<{
    id: string; type: string; summary: string; occurredAt: string; role: string;
    itemId: string; itemTitle: string; source: string;
  }>;
}

export function search(q: string, limit = 40) {
  // FTS5 phrase-quoted: party names are full of characters it reads as operators.
  const phrase = `"${q.replace(/"/g, '""')}"`;
  return db().prepare(`
    SELECT i.id, i.title, i.published_at AS publishedAt, i.triage_verdict AS verdict,
           i.triage_topic AS topic, s.name AS source
      FROM items_fts f JOIN items i ON i.rowid = f.rowid JOIN sources s ON s.id = i.source_id
     WHERE items_fts MATCH @phrase ORDER BY rank LIMIT @limit`).all({ phrase, limit }) as Array<{
    id: string; title: string; publishedAt: string; verdict: string | null;
    topic: string | null; source: string;
  }>;
}

export function graphStats() {
  const one = (sql: string) => (db().prepare(sql).get() as { c: number }).c;
  const edges = one('SELECT COUNT(*) c FROM graph_edges');
  const nodes = one(
    `SELECT COUNT(*) c FROM (
       SELECT a_id AS id FROM graph_edges UNION SELECT b_id FROM graph_edges)`,
  );
  return {
    edges,
    nodes,
    domainLinks: one('SELECT COUNT(*) c FROM entity_domains'),
    // Each edge touches two parties, so the mean degree is twice the ratio.
    avgDegree: nodes === 0 ? 0 : (edges * 2) / nodes,
  };
}

/**
 * Dossiers, for the read path.
 *
 * The claim shapes are duplicated from the pipeline schema rather than imported
 * because this layer answers to the page, not to the extractor: a page needs
 * the basis mark and the confidence rendered, and nothing else. What must not
 * drift is the meaning of `basis`, which is why it is spelled out here too.
 */
export type ClaimBasis = 'corpus' | 'recalled' | 'inferred';

export interface Affiliation {
  organisation: string; role: string; period: string;
  basis: ClaimBasis; confidence: number;
}
export interface HistoryItem {
  when: string; what: string; whyItMatters: string;
  basis: ClaimBasis; confidence: number;
}
export interface Capability {
  capability: string; whatItWouldTake: string; observableIfReal: string;
  basis: ClaimBasis; confidence: number;
}
export interface WatchPoint { watchFor: string; whyItWouldMatter: string }

export interface Dossier {
  entityId: string;
  summary: string;
  affiliations: Affiliation[];
  history: HistoryItem[];
  capabilities: Capability[];
  watchPoints: WatchPoint[];
  corpusEvents: number;
  builtAt: string;
  model: string | null;
}

function parseDossier(r: Record<string, unknown>): Dossier {
  const json = <T,>(v: unknown, fallback: T): T => {
    try { return JSON.parse(String(v)) as T; } catch { return fallback; }
  };
  return {
    entityId: String(r.entity_id),
    summary: String(r.summary ?? ''),
    affiliations: json(r.affiliations, [] as Affiliation[]),
    history: json(r.history, [] as HistoryItem[]),
    capabilities: json(r.capabilities, [] as Capability[]),
    watchPoints: json(r.watch_points, [] as WatchPoint[]),
    corpusEvents: Number(r.corpus_events ?? 0),
    builtAt: String(r.built_at ?? ''),
    model: r.model == null ? null : String(r.model),
  };
}

export function dossier(entityId: string): Dossier | null {
  const r = db().prepare('SELECT * FROM entity_profiles WHERE entity_id = ?').get(entityId);
  return r ? parseDossier(r as Record<string, unknown>) : null;
}

/** Dossiers for every party named in one item. What the item record needs. */
export function dossiersForItem(itemId: string): Array<Dossier & { name: string; kind: string; slug: string }> {
  return db().prepare(`
    SELECT p.*, en.name, en.kind, en.slug
      FROM entity_profiles p
      JOIN entities en ON en.id = p.entity_id
     WHERE p.entity_id IN (
       SELECT DISTINCT ee.entity_id FROM events e
         JOIN event_entities ee ON ee.event_id = e.id
        WHERE e.item_id = @id AND ee.role != 'mentioned'
     )
  `).all({ id: itemId }).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      ...parseDossier(row),
      name: String(row.name), kind: String(row.kind), slug: String(row.slug),
    };
  });
}

/** How much of the corpus has a dossier yet. */
export function dossierCoverage() {
  const one = (sql: string) => (db().prepare(sql).get() as { c: number }).c;
  return {
    written: one('SELECT COUNT(*) c FROM entity_profiles'),
    parties: one('SELECT COUNT(DISTINCT entity_id) c FROM event_entities'),
  };
}

/** Which parties have a dossier, for marking the party list. */
export function partiesWithDossiers(): Set<string> {
  const rows = db().prepare('SELECT entity_id FROM entity_profiles').all() as Array<{ entity_id: string }>;
  return new Set(rows.map((r) => r.entity_id));
}

/**
 * Public records: the money moving, read straight from filings.
 *
 * Insider trades, congressional trades, lobbying and contract awards all
 * arrive as dataset rows and are written as events in code, so this is a list
 * of what the records state, with no model in the path. `linked` counts the
 * connections the detectors found touching the row - the ones worth opening.
 */
export type RecordKind = 'insider' | 'congress' | 'lobbying' | 'contracts';

export interface RecordRow {
  id: string;
  itemId: string;
  kind: RecordKind;
  summary: string;
  occurredAt: string;
  amount: number | null;
  tags: string;
  url: string;
  linked: number;
}

const RECORD_KIND_SQL = `
  CASE
    WHEN e.type = 'securities-trade' AND e.tags LIKE '%"form-4"%' THEN 'insider'
    WHEN e.type = 'securities-trade' AND e.tags LIKE '%"congressional-trade"%' THEN 'congress'
    WHEN e.type = 'lobbying' AND s.kind = 'lobbying' THEN 'lobbying'
    WHEN e.type = 'government-award' AND s.kind = 'usaspending' THEN 'contracts'
  END`;

export function records(opts: { kind?: RecordKind; q?: string; sort?: 'newest' | 'biggest'; limit?: number } = {}): RecordRow[] {
  const where = [`${RECORD_KIND_SQL} IS NOT NULL`];
  const params: Record<string, unknown> = { limit: opts.limit ?? 150 };
  if (opts.kind) { where.push(`${RECORD_KIND_SQL} = @kind`); params.kind = opts.kind; }
  if (opts.q) { where.push('e.summary LIKE @q'); params.q = `%${opts.q}%`; }
  const order = opts.sort === 'biggest'
    ? 'COALESCE(e.amount_value, 0) DESC, e.occurred_at DESC'
    : 'e.occurred_at DESC, COALESCE(e.amount_value, 0) DESC';
  return db().prepare(`
    SELECT e.id, e.item_id AS itemId, ${RECORD_KIND_SQL} AS kind, e.summary,
           e.occurred_at AS occurredAt, e.amount_value AS amount, e.tags, i.url,
           (SELECT COUNT(*) FROM connections c
             WHERE c.from_event_id = e.id OR c.to_event_id = e.id) AS linked
      FROM events e
      JOIN items i ON i.id = e.item_id
      JOIN sources s ON s.id = i.source_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${order}
     LIMIT @limit`).all(params) as RecordRow[];
}

export function recordCounts(): Record<RecordKind, number> {
  const rows = db().prepare(`
    SELECT ${RECORD_KIND_SQL} AS kind, COUNT(*) AS n
      FROM events e JOIN items i ON i.id = e.item_id JOIN sources s ON s.id = i.source_id
     WHERE ${RECORD_KIND_SQL} IS NOT NULL
     GROUP BY 1`).all() as Array<{ kind: RecordKind; n: number }>;
  const out: Record<RecordKind, number> = { insider: 0, congress: 0, lobbying: 0, contracts: 0 };
  for (const r of rows) out[r.kind] = r.n;
  return out;
}

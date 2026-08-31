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

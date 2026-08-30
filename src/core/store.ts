import type { DB } from './db.js';
import {
  rowToBrief, rowToConnection, rowToEntity, rowToEvent, rowToForecast, rowToItem,
  rowToSource, rowToThread,
} from './db.js';
import { slugifyEntity, stableId } from './ids.js';
import type {
  Brief, Connection, Entity, EntityKind, Event, EventEntity, Forecast, Item, Source, Thread,
} from './types.js';

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export function upsertSource(db: DB, s: Source): void {
  db.prepare(
    `INSERT INTO sources (id, name, kind, url, tier, domains, origin, lean,
                          interval_minutes, verified, notes, enabled)
     VALUES (@id, @name, @kind, @url, @tier, @domains, @origin, @lean,
             @intervalMinutes, @verified, @notes, @enabled)
     ON CONFLICT(id) DO UPDATE SET
       name = @name, kind = @kind, url = @url, tier = @tier, domains = @domains,
       origin = @origin, lean = @lean, interval_minutes = @intervalMinutes,
       verified = @verified, notes = @notes, enabled = @enabled`,
  ).run({
    ...s,
    domains: JSON.stringify(s.domains),
    lean: s.lean ?? null,
    notes: s.notes ?? null,
    verified: s.verified ? 1 : 0,
    enabled: s.enabled ? 1 : 0,
  });
}

export function listSources(db: DB, opts: { enabledOnly?: boolean } = {}): Source[] {
  const sql = opts.enabledOnly
    ? 'SELECT * FROM sources WHERE enabled = 1 ORDER BY tier, name'
    : 'SELECT * FROM sources ORDER BY tier, name';
  return db.prepare(sql).all().map(rowToSource);
}

export function getSource(db: DB, id: string): Source | null {
  const r = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  return r ? rowToSource(r as any) : null;
}

/**
 * Sources whose polling interval has elapsed. Failing sources back off
 * exponentially (capped at 24x) so one dead feed does not burn the whole run.
 */
export function sourcesDueForFetch(db: DB, at = new Date()): Source[] {
  const rows = db
    .prepare('SELECT * FROM sources WHERE enabled = 1')
    .all() as Record<string, any>[];
  return rows
    .filter((r) => {
      if (!r.last_fetched_at) return true;
      const backoff = Math.min(2 ** (r.consecutive_failures ?? 0), 24);
      const dueAt = new Date(r.last_fetched_at).getTime() + r.interval_minutes * 60_000 * backoff;
      return at.getTime() >= dueAt;
    })
    .map(rowToSource);
}

export function recordFetch(db: DB, sourceId: string, error: string | null): void {
  db.prepare(
    `UPDATE sources
        SET last_fetched_at = ?,
            last_error = ?,
            consecutive_failures = CASE WHEN ? IS NULL THEN 0 ELSE consecutive_failures + 1 END
      WHERE id = ?`,
  ).run(nowIso(), error, error, sourceId);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** Returns true when the item was new. Feeds re-serve their window constantly. */
export function insertItem(db: DB, item: Item): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO items
         (id, source_id, external_id, url, title, summary, body, author,
          published_at, fetched_at, raw, extracted_at, extraction_error)
       VALUES (@id, @sourceId, @externalId, @url, @title, @summary, @body, @author,
               @publishedAt, @fetchedAt, @raw, @extractedAt, @extractionError)`,
    )
    .run({ ...item, raw: item.raw ? JSON.stringify(item.raw) : null });
  return res.changes > 0;
}

export function getItem(db: DB, id: string): Item | null {
  const r = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  return r ? rowToItem(r as any) : null;
}

/** The extraction queue. Oldest first so threads build in chronological order. */
export function itemsAwaitingExtraction(db: DB, limit: number): Item[] {
  return db
    .prepare(
      `SELECT * FROM items
        WHERE extracted_at IS NULL AND extraction_error IS NULL
        ORDER BY published_at ASC
        LIMIT ?`,
    )
    .all(limit)
    .map(rowToItem);
}

export function markItemExtracted(db: DB, itemId: string, error: string | null): void {
  db.prepare('UPDATE items SET extracted_at = ?, extraction_error = ? WHERE id = ?')
    .run(nowIso(), error, itemId);
}

export function itemsSince(db: DB, sinceIso: string): Item[] {
  return db
    .prepare('SELECT * FROM items WHERE published_at >= ? ORDER BY published_at DESC')
    .all(sinceIso)
    .map(rowToItem);
}

export function searchItems(db: DB, query: string, limit = 25): Item[] {
  return db
    .prepare(
      `SELECT i.* FROM items_fts f
         JOIN items i ON i.rowid = f.rowid
        WHERE items_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(query, limit)
    .map(rowToItem);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * Resolve a surface form to a canonical entity, creating one if needed.
 *
 * Matching is by (slug, kind). Ticker and CIK are merged in opportunistically:
 * a press mention that arrives with no ticker will later gain one from an SEC
 * filing, and that is what lets coverage of "Lockheed" join to a Form 4.
 */
export function resolveEntity(
  db: DB,
  input: {
    name: string;
    kind: EntityKind;
    aliases?: string[];
    ticker?: string | null;
    cik?: string | null;
    country?: string | null;
    description?: string | null;
    seenAt?: string;
  },
): Entity {
  const slug = slugifyEntity(input.name);
  const seenAt = input.seenAt ?? nowIso();
  const id = stableId('ent', input.kind, slug);

  const existing = db.prepare('SELECT * FROM entities WHERE slug = ? AND kind = ?')
    .get(slug, input.kind) as Record<string, any> | undefined;

  if (existing) {
    const aliases = new Set<string>(JSON.parse(existing.aliases || '[]'));
    for (const a of input.aliases ?? []) aliases.add(a);
    if (input.name !== existing.name) aliases.add(input.name);
    db.prepare(
      `UPDATE entities
          SET aliases = ?,
              ticker = COALESCE(ticker, ?),
              cik = COALESCE(cik, ?),
              country = COALESCE(country, ?),
              description = COALESCE(description, ?),
              last_seen_at = MAX(last_seen_at, ?),
              first_seen_at = MIN(first_seen_at, ?),
              mention_count = mention_count + 1
        WHERE id = ?`,
    ).run(
      JSON.stringify([...aliases]),
      input.ticker ?? null, input.cik ?? null, input.country ?? null,
      input.description ?? null, seenAt, seenAt, existing.id,
    );
    return rowToEntity(
      db.prepare('SELECT * FROM entities WHERE id = ?').get(existing.id) as any,
    );
  }

  db.prepare(
    `INSERT INTO entities
       (id, kind, name, slug, aliases, ticker, cik, country, description,
        first_seen_at, last_seen_at, mention_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    id, input.kind, input.name, slug, JSON.stringify(input.aliases ?? []),
    input.ticker ?? null, input.cik ?? null, input.country ?? null,
    input.description ?? null, seenAt, seenAt,
  );
  return rowToEntity(db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as any);
}

export function getEntity(db: DB, id: string): Entity | null {
  const r = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  return r ? rowToEntity(r as any) : null;
}

export function findEntityByName(db: DB, name: string, kind?: EntityKind): Entity | null {
  const slug = slugifyEntity(name);
  const r = kind
    ? db.prepare('SELECT * FROM entities WHERE slug = ? AND kind = ?').get(slug, kind)
    : db.prepare('SELECT * FROM entities WHERE slug = ? ORDER BY mention_count DESC').get(slug);
  return r ? rowToEntity(r as any) : null;
}

export function findEntityByTicker(db: DB, ticker: string): Entity | null {
  const r = db
    .prepare('SELECT * FROM entities WHERE ticker = ? ORDER BY mention_count DESC')
    .get(ticker.toUpperCase());
  return r ? rowToEntity(r as any) : null;
}

export function topEntities(db: DB, limit = 25): Entity[] {
  return db
    .prepare('SELECT * FROM entities ORDER BY mention_count DESC LIMIT ?')
    .all(limit)
    .map(rowToEntity);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function insertEvent(db: DB, event: Event): void {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO events
         (id, item_id, type, summary, occurred_at, occurred_at_inferred, domains,
          amount_value, amount_currency, tags, assertion, created_at)
       VALUES (@id, @itemId, @type, @summary, @occurredAt, @occurredAtInferred, @domains,
               @amountValue, @amountCurrency, @tags, @assertion, @createdAt)`,
    ).run({
      id: event.id,
      itemId: event.itemId,
      type: event.type,
      summary: event.summary,
      occurredAt: event.occurredAt,
      occurredAtInferred: event.occurredAtInferred ? 1 : 0,
      domains: JSON.stringify(event.domains),
      amountValue: event.amount?.value ?? null,
      amountCurrency: event.amount?.currency ?? null,
      tags: JSON.stringify(event.tags),
      assertion: event.assertion,
      createdAt: event.createdAt,
    });

    const link = db.prepare(
      `INSERT OR REPLACE INTO event_entities (event_id, entity_id, role, surface_form)
       VALUES (?, ?, ?, ?)`,
    );
    for (const e of event.entities) link.run(event.id, e.entityId, e.role, e.surfaceForm);
  });
  tx();
}

export function loadEventEntities(db: DB, eventId: string): EventEntity[] {
  return (
    db.prepare('SELECT entity_id, role, surface_form FROM event_entities WHERE event_id = ?')
      .all(eventId) as Record<string, any>[]
  ).map((r) => ({ entityId: r.entity_id, role: r.role, surfaceForm: r.surface_form }));
}

/** Load an event with its entity links populated. */
export function getEvent(db: DB, id: string): Event | null {
  const r = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  if (!r) return null;
  const ev = rowToEvent(r as any);
  ev.entities = loadEventEntities(db, id);
  return ev;
}

function hydrate(db: DB, rows: unknown[]): Event[] {
  return rows.map((r) => {
    const ev = rowToEvent(r as any);
    ev.entities = loadEventEntities(db, ev.id);
    return ev;
  });
}

export function eventsSince(db: DB, sinceIso: string, limit = 1000): Event[] {
  return hydrate(
    db,
    db.prepare('SELECT * FROM events WHERE occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?')
      .all(sinceIso, limit),
  );
}

export function eventsByType(db: DB, type: string, sinceIso?: string): Event[] {
  const rows = sinceIso
    ? db.prepare('SELECT * FROM events WHERE type = ? AND occurred_at >= ? ORDER BY occurred_at DESC')
      .all(type, sinceIso)
    : db.prepare('SELECT * FROM events WHERE type = ? ORDER BY occurred_at DESC').all(type);
  return hydrate(db, rows);
}

export function eventsForEntity(db: DB, entityId: string, limit = 200): Event[] {
  return hydrate(
    db,
    db.prepare(
      `SELECT e.* FROM events e
         JOIN event_entities ee ON ee.event_id = e.id
        WHERE ee.entity_id = ?
        ORDER BY e.occurred_at DESC
        LIMIT ?`,
    ).all(entityId, limit),
  );
}

/** Events sharing at least one entity with the given event, within a time window. */
export function eventsSharingEntities(
  db: DB,
  eventId: string,
  windowDays: number,
  limit = 100,
): Event[] {
  return hydrate(
    db,
    db.prepare(
      `SELECT DISTINCT e.* FROM events e
         JOIN event_entities ee ON ee.event_id = e.id
        WHERE ee.entity_id IN (SELECT entity_id FROM event_entities WHERE event_id = @id)
          AND e.id != @id
          AND ABS(julianday(e.occurred_at) -
                  julianday((SELECT occurred_at FROM events WHERE id = @id))) <= @window
        ORDER BY e.occurred_at DESC
        LIMIT @limit`,
    ).all({ id: eventId, window: windowDays, limit }),
  );
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export function insertConnection(db: DB, c: Connection): void {
  db.prepare(
    `INSERT INTO connections
       (id, kind, basis, from_event_id, to_event_id, explanation, falsifier,
        confidence, lag_days, shared_entity_ids, produced_by, created_at, verdict)
     VALUES (@id, @kind, @basis, @fromEventId, @toEventId, @explanation, @falsifier,
             @confidence, @lagDays, @sharedEntityIds, @producedBy, @createdAt, @verdict)
     ON CONFLICT(from_event_id, to_event_id, kind, produced_by) DO UPDATE SET
       explanation = @explanation, falsifier = @falsifier, confidence = @confidence,
       lag_days = @lagDays, shared_entity_ids = @sharedEntityIds, basis = @basis`,
  ).run({ ...c, sharedEntityIds: JSON.stringify(c.sharedEntityIds) });
}

export function connectionsSince(db: DB, sinceIso: string, minConfidence = 0): Connection[] {
  return db
    .prepare(
      `SELECT c.* FROM connections c
         JOIN events e ON e.id = c.from_event_id
        WHERE c.created_at >= ? AND c.confidence >= ?
        ORDER BY c.basis = 'deterministic' DESC, c.confidence DESC`,
    )
    .all(sinceIso, minConfidence)
    .map(rowToConnection);
}

export function connectionsForEvent(db: DB, eventId: string): Connection[] {
  return db
    .prepare(
      `SELECT * FROM connections
        WHERE from_event_id = ? OR to_event_id = ?
        ORDER BY basis = 'deterministic' DESC, confidence DESC`,
    )
    .all(eventId, eventId)
    .map(rowToConnection);
}

export function setConnectionVerdict(db: DB, id: string, verdict: Connection['verdict']): void {
  db.prepare('UPDATE connections SET verdict = ? WHERE id = ?').run(verdict, id);
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export function upsertThread(db: DB, t: Thread): void {
  db.prepare(
    `INSERT INTO threads
       (id, title, summary, open_questions, domains, core_entity_ids, status,
        started_at, last_event_at, event_count, created_at, updated_at)
     VALUES (@id, @title, @summary, @openQuestions, @domains, @coreEntityIds, @status,
             @startedAt, @lastEventAt, @eventCount, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       title = @title, summary = @summary, open_questions = @openQuestions,
       domains = @domains, core_entity_ids = @coreEntityIds, status = @status,
       last_event_at = @lastEventAt, event_count = @eventCount, updated_at = @updatedAt`,
  ).run({
    ...t,
    openQuestions: JSON.stringify(t.openQuestions),
    domains: JSON.stringify(t.domains),
    coreEntityIds: JSON.stringify(t.coreEntityIds),
  });
}

export function addEventToThread(db: DB, threadId: string, eventId: string, reason: string): void {
  const tx = db.transaction(() => {
    const res = db
      .prepare('INSERT OR IGNORE INTO thread_events (thread_id, event_id, reason, added_at) VALUES (?, ?, ?, ?)')
      .run(threadId, eventId, reason, nowIso());
    if (res.changes > 0) {
      db.prepare(
        `UPDATE threads
            SET event_count = (SELECT COUNT(*) FROM thread_events WHERE thread_id = ?),
                last_event_at = MAX(last_event_at,
                  COALESCE((SELECT occurred_at FROM events WHERE id = ?), last_event_at)),
                updated_at = ?
          WHERE id = ?`,
      ).run(threadId, eventId, nowIso(), threadId);
    }
  });
  tx();
}

export function getThread(db: DB, id: string): Thread | null {
  const r = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  return r ? rowToThread(r as any) : null;
}

export function listThreads(db: DB, status?: Thread['status'], limit = 50): Thread[] {
  const rows = status
    ? db.prepare('SELECT * FROM threads WHERE status = ? ORDER BY last_event_at DESC LIMIT ?')
      .all(status, limit)
    : db.prepare('SELECT * FROM threads ORDER BY last_event_at DESC LIMIT ?').all(limit);
  return rows.map(rowToThread);
}

export function threadEvents(db: DB, threadId: string): Event[] {
  return hydrate(
    db,
    db.prepare(
      `SELECT e.* FROM events e
         JOIN thread_events te ON te.event_id = e.id
        WHERE te.thread_id = ?
        ORDER BY e.occurred_at ASC`,
    ).all(threadId),
  );
}

export function threadsForEntity(db: DB, entityId: string): Thread[] {
  return db
    .prepare(
      `SELECT DISTINCT t.* FROM threads t
         JOIN thread_events te ON te.thread_id = t.id
         JOIN event_entities ee ON ee.event_id = te.event_id
        WHERE ee.entity_id = ?
        ORDER BY t.last_event_at DESC`,
    )
    .all(entityId)
    .map(rowToThread);
}

/** Threads not touched in `days`, so the CLI can retire them. */
export function staleThreads(db: DB, days: number): Thread[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return db
    .prepare("SELECT * FROM threads WHERE status = 'active' AND last_event_at < ?")
    .all(cutoff)
    .map(rowToThread);
}

// ---------------------------------------------------------------------------
// Forecasts and briefs
// ---------------------------------------------------------------------------

export function insertForecast(db: DB, f: Forecast): void {
  db.prepare(
    `INSERT OR REPLACE INTO forecasts
       (id, thread_id, question, resolution_criteria, resolves_at, probability,
        reference_class, market_probability, market_url, evidence_event_ids,
        reasoning, created_at, resolved_at, outcome, brier_score)
     VALUES (@id, @threadId, @question, @resolutionCriteria, @resolvesAt, @probability,
             @referenceClass, @marketProbability, @marketUrl, @evidenceEventIds,
             @reasoning, @createdAt, @resolvedAt, @outcome, @brierScore)`,
  ).run({ ...f, evidenceEventIds: JSON.stringify(f.evidenceEventIds) });
}

export function openForecasts(db: DB): Forecast[] {
  return db
    .prepare('SELECT * FROM forecasts WHERE resolved_at IS NULL ORDER BY resolves_at ASC')
    .all()
    .map(rowToForecast);
}

/**
 * Resolve a forecast and score it. Brier is (p - outcome)^2, lower is better;
 * scoring every call is the only thing that separates forecasting from opining.
 */
export function resolveForecast(
  db: DB,
  id: string,
  outcome: 'yes' | 'no' | 'ambiguous',
): number | null {
  const f = db.prepare('SELECT * FROM forecasts WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (!f) return null;
  const brier = outcome === 'ambiguous' ? null : (f.probability - (outcome === 'yes' ? 1 : 0)) ** 2;
  db.prepare('UPDATE forecasts SET resolved_at = ?, outcome = ?, brier_score = ? WHERE id = ?')
    .run(nowIso(), outcome, brier, id);
  return brier;
}

/** Mean Brier score over resolved forecasts. 0.25 is what guessing 50% gets you. */
export function calibration(db: DB): { count: number; meanBrier: number | null } {
  const r = db
    .prepare('SELECT COUNT(*) n, AVG(brier_score) avg FROM forecasts WHERE brier_score IS NOT NULL')
    .get() as Record<string, any>;
  return { count: r.n, meanBrier: r.avg };
}

export function insertBrief(db: DB, b: Brief): void {
  db.prepare(
    `INSERT OR REPLACE INTO briefs
       (id, for_date, window_hours, sections, markdown, item_count, event_count,
        connection_count, created_at)
     VALUES (@id, @forDate, @windowHours, @sections, @markdown, @itemCount, @eventCount,
             @connectionCount, @createdAt)`,
  ).run({ ...b, sections: JSON.stringify(b.sections) });
}

export function latestBrief(db: DB): Brief | null {
  const r = db.prepare('SELECT * FROM briefs ORDER BY for_date DESC, created_at DESC LIMIT 1').get();
  return r ? rowToBrief(r as any) : null;
}

export function getBriefForDate(db: DB, forDate: string): Brief | null {
  const r = db.prepare('SELECT * FROM briefs WHERE for_date = ? ORDER BY created_at DESC LIMIT 1')
    .get(forDate);
  return r ? rowToBrief(r as any) : null;
}

export function counts(db: DB): Record<string, number> {
  const one = (t: string) =>
    (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as any).n as number;
  return {
    sources: one('sources'),
    items: one('items'),
    entities: one('entities'),
    events: one('events'),
    connections: one('connections'),
    threads: one('threads'),
    forecasts: one('forecasts'),
  };
}

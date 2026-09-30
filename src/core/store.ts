import type { DB } from './db.js';
import {
  rowToBrief, rowToConnection, rowToEntity, rowToEvent, rowToForecast, rowToItem,
  rowToSource, rowToThread,
} from './db.js';
import { slugifyEntity, stableId } from './ids.js';
import { STRUCTURED_SOURCE_KINDS } from './types.js';
import type {
  Brief, Connection, Entity, EntityKind, Event, EventEntity, Forecast, Item, Source, Thread,
} from './types.js';

const nowIso = () => new Date().toISOString();

/**
 * Structured-record source kinds as an SQL list. Constants, not user input, so
 * inlining them is safe - and it keeps the model queues from ever picking up a
 * dataset row, including rows written before insert kept their triage state.
 */
const STRUCTURED_KINDS_SQL = STRUCTURED_SOURCE_KINDS.map((k) => `'${k}'`).join(', ');

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
      // The triage columns are written here too. A structured record arrives
      // already judged, and dropping that on insert is what sent every imported
      // trade and market snapshot through a model call it was built to skip.
      `INSERT OR IGNORE INTO items
         (id, source_id, external_id, url, title, summary, body, author,
          published_at, fetched_at, raw, extracted_at, extraction_error,
          triaged_at, triage_verdict, triage_topic, triage_reason, triage_angle)
       VALUES (@id, @sourceId, @externalId, @url, @title, @summary, @body, @author,
               @publishedAt, @fetchedAt, @raw, @extractedAt, @extractionError,
               @triagedAt, @triageVerdict, @triageTopic, @triageReason, @triageAngle)`,
    )
    .run({
      ...item,
      raw: item.raw ? JSON.stringify(item.raw) : null,
      triagedAt: item.triagedAt ?? null,
      triageVerdict: item.triageVerdict ?? null,
      triageTopic: item.triageTopic ?? null,
      triageReason: item.triageReason ?? null,
      triageAngle: item.triageAngle ?? null,
    });
  return res.changes > 0;
}

export function getItem(db: DB, id: string): Item | null {
  const r = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  return r ? rowToItem(r as any) : null;
}

/**
 * The triage queue: everything fetched but not yet judged, newest first.
 *
 * This is the widest queue in the system - every item passes through it - which
 * is why triage runs batched on a cheap model.
 */
/**
 * Congressional PTR filings on file, newest first.
 *
 * The House index adapter stores the Clerk's own row on `items.raw`, so the
 * document id and filing year are already here - there is no second index to
 * fetch before the filings themselves can be read. Only type `P` filings carry
 * transactions; the annual and amendment types are a different form.
 */
export function ptrFilings(
  db: DB,
  opts: { year?: string; limit?: number } = {},
): Array<{ docId: string; year: string; filer: string; filingDate: string }> {
  const rows = db.prepare(
    `SELECT raw FROM items
      WHERE source_id = 'house-disclosures' AND raw IS NOT NULL
      ORDER BY published_at DESC LIMIT @scan`,
  ).all({ scan: (opts.limit ?? 25) * 6 }) as Array<{ raw: string }>;

  const out: Array<{ docId: string; year: string; filer: string; filingDate: string }> = [];
  for (const r of rows) {
    let j: Record<string, string>;
    try { j = JSON.parse(r.raw); } catch { continue; }
    if (j.filingType !== 'P' || !j.docId) continue;
    if (opts.year && j.year !== opts.year) continue;
    const name = [j.prefix, j.first, j.last, j.suffix].filter(Boolean).join(' ').trim();
    out.push({
      docId: j.docId,
      year: j.year ?? String(new Date().getFullYear()),
      filer: name,
      filingDate: j.filingDate ?? '',
    });
    if (out.length >= (opts.limit ?? 25)) break;
  }
  return out;
}

export function itemsAwaitingTriage(db: DB, limit: number): Item[] {
  return db
    .prepare(
      `SELECT * FROM items
        WHERE triaged_at IS NULL
          AND source_id NOT IN (SELECT id FROM sources WHERE kind IN (${STRUCTURED_KINDS_SQL}))
        ORDER BY published_at DESC
        LIMIT ?`,
    )
    .all(limit)
    .map(rowToItem);
}

export function saveTriage(
  db: DB,
  itemId: string,
  verdict: string,
  topic: string,
  reason: string,
  angle: string | null,
): void {
  db.prepare(
    `UPDATE items
        SET triaged_at = ?, triage_verdict = ?, triage_topic = ?,
            triage_reason = ?, triage_angle = ?
      WHERE id = ?`,
  ).run(nowIso(), verdict, topic, reason, angle, itemId);
}

/**
 * The reading queue: what survived triage, best first.
 *
 * This is the list a person actually looks at, and the thing `investigate` is
 * pointed at. Mundane items are excluded rather than ranked last - the point of
 * triage is that they never take up attention again.
 */
export function triagedQueue(
  db: DB,
  opts: { limit?: number; verdict?: string; withAngle?: boolean } = {},
): Item[] {
  const where = ["triage_verdict IS NOT NULL", "triage_verdict != 'mundane'"];
  const params: unknown[] = [];
  if (opts.verdict) {
    where.push('triage_verdict = ?');
    params.push(opts.verdict);
  }
  if (opts.withAngle) where.push('triage_angle IS NOT NULL');
  params.push(opts.limit ?? 50);
  return db
    .prepare(
      `SELECT * FROM items
        WHERE ${where.join(' AND ')}
        ORDER BY CASE triage_verdict WHEN 'notable' THEN 2 WHEN 'worth-a-look' THEN 1 ELSE 0 END DESC,
                 published_at DESC
        LIMIT ?`,
    )
    .all(...params)
    .map(rowToItem);
}

/**
 * The extraction queue.
 *
 * Gated on triage: an item is only worth the cost of structured extraction once
 * something has decided it is worth reading. This is the change that stops the
 * pipeline spending its budget on routine regulatory housekeeping.
 */
export function itemsAwaitingExtraction(db: DB, limit: number): Item[] {
  return db
    .prepare(
      // Newest first, and best first: the point is to follow what is happening
      // now, and the corpus reaches back decades on some primary sources.
      `SELECT * FROM items
        WHERE extracted_at IS NULL AND extraction_error IS NULL
          AND triage_verdict IS NOT NULL AND triage_verdict != 'mundane'
          AND source_id NOT IN (SELECT id FROM sources WHERE kind IN (${STRUCTURED_KINDS_SQL}))
        ORDER BY CASE triage_verdict WHEN 'notable' THEN 2 WHEN 'worth-a-look' THEN 1 ELSE 0 END DESC,
                 published_at DESC
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

/** Kinds a source can only guess between, and which therefore resolve as one. */
const SIBLING_KIND: Partial<Record<EntityKind, EntityKind>> = {
  company: 'organization',
  organization: 'company',
};

/** A name written entirely in capitals, as registries and filings do. */
export const isShouting = (name: string): boolean => /[A-Z]/.test(name) && name === name.toUpperCase();

/**
 * Resolve a surface form to a canonical entity, creating one if needed.
 *
 * Matching is by (slug, kind), then by ticker within the kind. Ticker and CIK
 * are merged in opportunistically:
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
  const ticker = input.ticker?.trim().toUpperCase() || null;

  // A ticker is a better identity than a spelling: "NVIDIA Corporation" in a
  // disclosure and "Nvidia" in a wire story are one issuer, and only the ticker
  // says so. The name match comes first so an exact spelling always wins.
  const existing = (db.prepare('SELECT * FROM entities WHERE slug = ? AND kind = ?')
    .get(slug, input.kind)
    ?? (ticker
      ? db.prepare(
        'SELECT * FROM entities WHERE ticker = ? AND kind = ? ORDER BY mention_count DESC LIMIT 1',
      ).get(ticker, input.kind)
      : undefined)
    // Whether a name is a company or an organisation is a guess made from how
    // each source writes it - a lobbying client with no "Inc." reads as an
    // association - and the same name under both kinds is one party far more
    // often than two. Guessing differently must not split it.
    ?? (SIBLING_KIND[input.kind]
      ? db.prepare('SELECT * FROM entities WHERE slug = ? AND kind = ?').get(slug, SIBLING_KIND[input.kind])
      : undefined)) as Record<string, any> | undefined;

  if (existing) {
    const aliases = new Set<string>(JSON.parse(existing.aliases || '[]'));
    for (const a of input.aliases ?? []) aliases.add(a);
    // Registries write names in capitals. When a later source spells the same
    // party normally, show that spelling and keep the capitals as an alias.
    // Only on a name match, so the display name never drifts from the slug.
    const name = existing.slug === slug && isShouting(existing.name) && !isShouting(input.name)
      ? input.name
      : existing.name;
    if (input.name !== name) aliases.add(input.name);
    if (existing.name !== name) aliases.add(existing.name);
    db.prepare(
      `UPDATE entities
          SET name = ?,
              aliases = ?,
              ticker = COALESCE(ticker, ?),
              cik = COALESCE(cik, ?),
              country = COALESCE(country, ?),
              description = COALESCE(description, ?),
              last_seen_at = MAX(last_seen_at, ?),
              first_seen_at = MIN(first_seen_at, ?),
              mention_count = mention_count + 1
        WHERE id = ?`,
    ).run(
      name,
      JSON.stringify([...aliases]),
      ticker, input.cik ?? null, input.country ?? null,
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
    ticker, input.cik ?? null, input.country ?? null,
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

/** Find a party by slug, or by a loose name match when the slug is not exact. */
export function findEntityBySlug(db: DB, slug: string): Entity | null {
  const exact = db.prepare('SELECT * FROM entities WHERE slug = ?').get(slugifyEntity(slug));
  if (exact) return rowToEntity(exact as any);
  // Fall back to matching every word given, in any order. Names on file carry
  // artefacts from their source - the House index yields "Richard Dean Dr
  // McCormick" because the honorific column lands mid-name - so requiring the
  // query to be a contiguous substring makes a party unreachable by their
  // actual name.
  const words = slugifyEntity(slug).split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return null;
  const loose = db.prepare(
    `SELECT * FROM entities
      WHERE ${words.map(() => 'slug LIKE ?').join(' AND ')}
      ORDER BY mention_count DESC LIMIT 1`,
  ).get(...words.map((w) => `%${w}%`));
  return loose ? rowToEntity(loose as any) : null;
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

/** Lobbying events, biggest money first within the window, optionally only the revolving door. */
export function lobbyingEvents(
  db: DB,
  opts: { sinceIso?: string; revolvingOnly?: boolean; client?: string; limit?: number } = {},
): Event[] {
  const where = ["e.type = 'lobbying'"];
  const params: unknown[] = [];
  if (opts.sinceIso) { where.push('e.occurred_at >= ?'); params.push(opts.sinceIso); }
  if (opts.revolvingOnly) where.push(`e.tags LIKE '%"revolving-door"%'`);
  if (opts.client) {
    where.push(`EXISTS (
      SELECT 1 FROM event_entities ee JOIN entities ent ON ent.id = ee.entity_id
       WHERE ee.event_id = e.id AND ee.role = 'beneficiary' AND ent.slug LIKE ?)`);
    params.push(`%${slugifyEntity(opts.client)}%`);
  }
  params.push(opts.limit ?? 40);
  return hydrate(db, db.prepare(
    `SELECT e.* FROM events e WHERE ${where.join(' AND ')}
      ORDER BY e.occurred_at DESC, COALESCE(e.amount_value, 0) DESC LIMIT ?`,
  ).all(...params));
}

export function eventsByType(db: DB, type: string, sinceIso?: string): Event[] {
  const rows = sinceIso
    ? db.prepare('SELECT * FROM events WHERE type = ? AND occurred_at >= ? ORDER BY occurred_at DESC')
      .all(type, sinceIso)
    : db.prepare('SELECT * FROM events WHERE type = ? ORDER BY occurred_at DESC').all(type);
  return hydrate(db, rows);
}

/**
 * Disclosed trades, newest first.
 *
 * Tags are JSON text rather than a table, so membership is a LIKE over the
 * encoded form. That is the same trade-off the rest of the schema makes, and
 * at this corpus size the scan is cheaper than the join table would be.
 */
export function tradeEvents(
  db: DB,
  opts: {
    lateOnly?: boolean; congressionalOnly?: boolean; insiderOnly?: boolean; buysOnly?: boolean;
    filer?: string; limit?: number;
  } = {},
): Event[] {
  const where = ["e.type = 'securities-trade'"];
  const params: unknown[] = [];
  if (opts.lateOnly) where.push(`e.tags LIKE '%"late-filing"%'`);
  if (opts.congressionalOnly) where.push(`e.tags LIKE '%"congressional-trade"%'`);
  if (opts.insiderOnly) where.push(`e.tags LIKE '%"form-4"%'`);
  // An insider's open-market purchase is the rare, voluntary signal; sales
  // are mostly diversification and tax.
  if (opts.buysOnly) where.push(`(e.tags LIKE '%"code:P"%' OR e.tags LIKE '%"action:purchase"%')`);
  if (opts.filer) {
    where.push(`EXISTS (
      SELECT 1 FROM event_entities ee JOIN entities ent ON ent.id = ee.entity_id
       WHERE ee.event_id = e.id AND ee.role = 'actor' AND ent.slug = ?)`);
    params.push(slugifyEntity(opts.filer));
  }
  params.push(opts.limit ?? 50);
  return hydrate(
    db,
    db.prepare(
      `SELECT e.* FROM events e
        WHERE ${where.join(' AND ')}
        ORDER BY e.occurred_at DESC
        LIMIT ?`,
    ).all(...params),
  );
}

/** Every event extracted from one item. The unit an investigation starts from. */
export function eventsForItem(db: DB, itemId: string): Event[] {
  return hydrate(
    db,
    db.prepare('SELECT * FROM events WHERE item_id = ? ORDER BY occurred_at ASC').all(itemId),
  );
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

export function getForecast(db: DB, id: string): Forecast | null {
  const r = db.prepare('SELECT * FROM forecasts WHERE id = ?').get(id);
  return r ? rowToForecast(r as any) : null;
}

/**
 * Forecasts by state. `due` is the one that matters operationally: an unresolved
 * forecast past its date is the whole scoring loop stalled, and nothing else
 * surfaces it.
 */
export function listForecasts(
  db: DB,
  opts: { status?: 'open' | 'resolved' | 'due' | 'all'; at?: Date; limit?: number } = {},
): Forecast[] {
  const { status = 'all', limit = 200 } = opts;
  const at = (opts.at ?? new Date()).toISOString();
  const sql = {
    open: 'SELECT * FROM forecasts WHERE resolved_at IS NULL ORDER BY resolves_at ASC LIMIT ?',
    due: 'SELECT * FROM forecasts WHERE resolved_at IS NULL AND resolves_at <= ? ORDER BY resolves_at ASC LIMIT ?',
    resolved: 'SELECT * FROM forecasts WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT ?',
    all: 'SELECT * FROM forecasts ORDER BY resolves_at ASC LIMIT ?',
  }[status];
  const rows = status === 'due' ? db.prepare(sql).all(at, limit) : db.prepare(sql).all(limit);
  return rows.map(rowToForecast);
}

/**
 * Record the crowd price beside our estimate.
 *
 * Beside, never blended in. Averaging the two would erase the only thing the
 * anchor is for: knowing where we disagreed, and later who was right.
 */
export function setForecastMarket(
  db: DB,
  id: string,
  marketProbability: number | null,
  marketUrl: string | null,
): void {
  db.prepare('UPDATE forecasts SET market_probability = ?, market_url = ? WHERE id = ?')
    .run(marketProbability, marketUrl, id);
}

/** Items from the given sources, newest first. Used to read market snapshots back. */
export function marketItems(db: DB, sourceIds: string[], limit = 2000): Item[] {
  if (sourceIds.length === 0) return [];
  return db
    .prepare(
      `SELECT * FROM items
        WHERE source_id IN (${sourceIds.map(() => '?').join(',')})
        ORDER BY fetched_at DESC
        LIMIT ?`,
    )
    .all(...sourceIds, limit)
    .map(rowToItem);
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

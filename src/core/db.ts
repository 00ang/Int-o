import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Brief, Connection, Entity, Event, Forecast, Item, Source, Thread,
} from './types.js';

export type DB = Database.Database;

/**
 * Schema.
 *
 * Two conventions run throughout:
 *
 * 1. Array and object fields are stored as JSON text. This is a single-user
 *    corpus in the low millions of rows at worst; the join tables that would
 *    buy us relational querying would cost more in complexity than they return.
 *    The exception is event_entities, which is a real table because every
 *    detector queries it by entity.
 *
 * 2. Ids for anything derived from a source are content-addressed (see
 *    stableId), so `INSERT OR IGNORE` makes re-ingestion idempotent. Feeds
 *    re-serve their whole window on every poll and we poll often.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  url              TEXT NOT NULL,
  tier             TEXT NOT NULL,
  domains          TEXT NOT NULL DEFAULT '[]',
  origin           TEXT NOT NULL DEFAULT '',
  lean             TEXT,
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  verified         INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_fetched_at  TEXT,
  last_error       TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id               TEXT PRIMARY KEY,
  source_id        TEXT NOT NULL REFERENCES sources(id),
  external_id      TEXT NOT NULL,
  url              TEXT NOT NULL,
  title            TEXT NOT NULL,
  summary          TEXT,
  body             TEXT,
  author           TEXT,
  published_at     TEXT NOT NULL,
  fetched_at       TEXT NOT NULL,
  raw              TEXT,
  extracted_at     TEXT,
  extraction_error TEXT,
  triaged_at       TEXT,
  triage_verdict   TEXT,
  triage_topic     TEXT,
  triage_reason    TEXT,
  triage_angle     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS items_source_external ON items(source_id, external_id);
CREATE INDEX IF NOT EXISTS items_published ON items(published_at DESC);
-- Drives the extraction queue: "everything not yet processed, oldest first".
CREATE INDEX IF NOT EXISTS items_unextracted ON items(extracted_at) WHERE extracted_at IS NULL;

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  aliases       TEXT NOT NULL DEFAULT '[]',
  ticker        TEXT,
  cik           TEXT,
  country       TEXT,
  description   TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS entities_slug_kind ON entities(slug, kind);
CREATE INDEX IF NOT EXISTS entities_ticker ON entities(ticker) WHERE ticker IS NOT NULL;
CREATE INDEX IF NOT EXISTS entities_cik ON entities(cik) WHERE cik IS NOT NULL;

CREATE TABLE IF NOT EXISTS events (
  id                   TEXT PRIMARY KEY,
  item_id              TEXT NOT NULL REFERENCES items(id),
  type                 TEXT NOT NULL,
  summary              TEXT NOT NULL,
  occurred_at          TEXT NOT NULL,
  occurred_at_inferred INTEGER NOT NULL DEFAULT 0,
  domains              TEXT NOT NULL DEFAULT '[]',
  amount_value         REAL,
  amount_currency      TEXT,
  tags                 TEXT NOT NULL DEFAULT '[]',
  assertion            TEXT NOT NULL DEFAULT 'reported',
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_occurred ON events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_type_occurred ON events(type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_item ON events(item_id);

CREATE TABLE IF NOT EXISTS event_entities (
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_id    TEXT NOT NULL REFERENCES entities(id),
  role         TEXT NOT NULL,
  surface_form TEXT NOT NULL,
  PRIMARY KEY (event_id, entity_id, role)
);
CREATE INDEX IF NOT EXISTS event_entities_entity ON event_entities(entity_id);

CREATE TABLE IF NOT EXISTS connections (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  basis             TEXT NOT NULL,
  from_event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  to_event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  explanation       TEXT NOT NULL,
  falsifier         TEXT,
  confidence        REAL NOT NULL,
  lag_days          REAL NOT NULL,
  shared_entity_ids TEXT NOT NULL DEFAULT '[]',
  produced_by       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  verdict           TEXT NOT NULL DEFAULT 'unreviewed'
);
-- One link per (pair, kind, detector); re-running a detector updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS connections_pair
  ON connections(from_event_id, to_event_id, kind, produced_by);
CREATE INDEX IF NOT EXISTS connections_from ON connections(from_event_id);
CREATE INDEX IF NOT EXISTS connections_to ON connections(to_event_id);
CREATE INDEX IF NOT EXISTS connections_rank ON connections(basis, confidence DESC);

CREATE TABLE IF NOT EXISTS graph_edges (
  a_id        TEXT NOT NULL REFERENCES entities(id),
  b_id        TEXT NOT NULL REFERENCES entities(id),
  weight      REAL NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  first_seen  TEXT,
  last_seen   TEXT,
  PRIMARY KEY (a_id, b_id)
);
CREATE INDEX IF NOT EXISTS graph_edges_a ON graph_edges(a_id, weight DESC);
CREATE INDEX IF NOT EXISTS graph_edges_b ON graph_edges(b_id, weight DESC);

CREATE TABLE IF NOT EXISTS entity_domains (
  entity_id   TEXT NOT NULL REFERENCES entities(id),
  domain      TEXT NOT NULL,
  weight      REAL NOT NULL,
  PRIMARY KEY (entity_id, domain)
);
CREATE INDEX IF NOT EXISTS entity_domains_d ON entity_domains(domain, weight DESC);

CREATE TABLE IF NOT EXISTS threads (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',
  open_questions  TEXT NOT NULL DEFAULT '[]',
  domains         TEXT NOT NULL DEFAULT '[]',
  core_entity_ids TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'active',
  started_at      TEXT NOT NULL,
  last_event_at   TEXT NOT NULL,
  event_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_active ON threads(status, last_event_at DESC);

CREATE TABLE IF NOT EXISTS thread_events (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  reason    TEXT NOT NULL DEFAULT '',
  added_at  TEXT NOT NULL,
  PRIMARY KEY (thread_id, event_id)
);
CREATE INDEX IF NOT EXISTS thread_events_event ON thread_events(event_id);

CREATE TABLE IF NOT EXISTS forecasts (
  id                  TEXT PRIMARY KEY,
  thread_id           TEXT REFERENCES threads(id) ON DELETE SET NULL,
  question            TEXT NOT NULL,
  resolution_criteria TEXT NOT NULL,
  resolves_at         TEXT NOT NULL,
  probability         REAL NOT NULL,
  reference_class     TEXT,
  market_probability  REAL,
  market_url          TEXT,
  evidence_event_ids  TEXT NOT NULL DEFAULT '[]',
  reasoning           TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  resolved_at         TEXT,
  outcome             TEXT,
  brier_score         REAL
);
CREATE INDEX IF NOT EXISTS forecasts_open ON forecasts(resolves_at) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS briefs (
  id               TEXT PRIMARY KEY,
  for_date         TEXT NOT NULL,
  window_hours     INTEGER NOT NULL,
  sections         TEXT NOT NULL DEFAULT '[]',
  markdown         TEXT NOT NULL DEFAULT '',
  item_count       INTEGER NOT NULL DEFAULT 0,
  event_count      INTEGER NOT NULL DEFAULT 0,
  connection_count INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS briefs_date ON briefs(for_date DESC);

-- Full-text search over titles and bodies. Kept in sync by triggers so callers
-- never have to remember to update it.
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, summary, body, content='items', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS items_fts_ins AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, summary, body)
  VALUES (new.rowid, new.title, new.summary, new.body);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_del AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, summary, body)
  VALUES ('delete', old.rowid, old.title, old.summary, old.body);
END;
CREATE TRIGGER IF NOT EXISTS items_fts_upd AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, summary, body)
  VALUES ('delete', old.rowid, old.title, old.summary, old.body);
  INSERT INTO items_fts(rowid, title, summary, body)
  VALUES (new.rowid, new.title, new.summary, new.body);
END;
`;

/**
 * Columns added after a database may already exist in the wild.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that is already
 * there, so a new column in SCHEMA never reaches an existing corpus. Rather
 * than carry a migration framework for a single-user SQLite file, we add
 * columns idempotently on open: cheap, ordered, and safe to run every time.
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'items', column: 'triaged_at', ddl: 'TEXT' },
  { table: 'items', column: 'triage_verdict', ddl: 'TEXT' },
  { table: 'items', column: 'triage_topic', ddl: 'TEXT' },
  { table: 'items', column: 'triage_reason', ddl: 'TEXT' },
  { table: 'items', column: 'triage_angle', ddl: 'TEXT' },
];

/**
 * Indexes over columns that ADDED_COLUMNS may have just created.
 *
 * These cannot live in SCHEMA: on an existing database `CREATE TABLE IF NOT
 * EXISTS` is a no-op, so the index would be asked to reference a column that
 * does not exist yet and the whole schema exec would fail. Tables first,
 * columns second, indexes over those columns last.
 */
const POST_MIGRATION_INDEXES = `
-- Drives the triage queue, which every item passes through before extraction.
CREATE INDEX IF NOT EXISTS items_untriaged ON items(triaged_at) WHERE triaged_at IS NULL;
-- Drives the reading queue: what survived triage, best first.
CREATE INDEX IF NOT EXISTS items_triage_verdict ON items(triage_verdict, published_at DESC);
`;

function addMissingColumns(db: DB): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const present = db
      .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
      .get(table, column);
    if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  addMissingColumns(db);
  db.exec(POST_MIGRATION_INDEXES);
  return db;
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping
//
// SQLite gives back snake_case scalars and JSON strings; the rest of the
// codebase works in the domain types. All of that translation lives here.
// ---------------------------------------------------------------------------

const json = <T,>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string' || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

type Row = Record<string, any>;

export const rowToSource = (r: any): Source => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  url: r.url,
  tier: r.tier,
  domains: json(r.domains, []),
  origin: r.origin,
  lean: r.lean ?? undefined,
  intervalMinutes: r.interval_minutes,
  verified: !!r.verified,
  notes: r.notes ?? undefined,
  enabled: !!r.enabled,
});

export const rowToItem = (r: any): Item => ({
  id: r.id,
  sourceId: r.source_id,
  externalId: r.external_id,
  url: r.url,
  title: r.title,
  summary: r.summary,
  body: r.body,
  author: r.author,
  publishedAt: r.published_at,
  fetchedAt: r.fetched_at,
  raw: json(r.raw, null as Record<string, unknown> | null),
  extractedAt: r.extracted_at,
  extractionError: r.extraction_error,
  triagedAt: r.triaged_at ?? null,
  triageVerdict: r.triage_verdict ?? null,
  triageTopic: r.triage_topic ?? null,
  triageReason: r.triage_reason ?? null,
  triageAngle: r.triage_angle ?? null,
});

export const rowToEntity = (r: any): Entity => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  slug: r.slug,
  aliases: json(r.aliases, [] as string[]),
  ticker: r.ticker,
  cik: r.cik,
  country: r.country,
  description: r.description,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  mentionCount: r.mention_count,
});

export const rowToEvent = (r: any): Event => ({
  id: r.id,
  itemId: r.item_id,
  type: r.type,
  summary: r.summary,
  occurredAt: r.occurred_at,
  occurredAtInferred: !!r.occurred_at_inferred,
  domains: json(r.domains, []),
  entities: [], // filled by loadEventEntities where callers need them
  amount: r.amount_value == null ? null : { value: r.amount_value, currency: r.amount_currency },
  tags: json(r.tags, [] as string[]),
  assertion: r.assertion,
  createdAt: r.created_at,
});

export const rowToConnection = (r: any): Connection => ({
  id: r.id,
  kind: r.kind,
  basis: r.basis,
  fromEventId: r.from_event_id,
  toEventId: r.to_event_id,
  explanation: r.explanation,
  falsifier: r.falsifier,
  confidence: r.confidence,
  lagDays: r.lag_days,
  sharedEntityIds: json(r.shared_entity_ids, [] as string[]),
  producedBy: r.produced_by,
  createdAt: r.created_at,
  verdict: r.verdict,
});

export const rowToThread = (r: any): Thread => ({
  id: r.id,
  title: r.title,
  summary: r.summary,
  openQuestions: json(r.open_questions, [] as string[]),
  domains: json(r.domains, []),
  coreEntityIds: json(r.core_entity_ids, [] as string[]),
  status: r.status,
  startedAt: r.started_at,
  lastEventAt: r.last_event_at,
  eventCount: r.event_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const rowToForecast = (r: any): Forecast => ({
  id: r.id,
  threadId: r.thread_id,
  question: r.question,
  resolutionCriteria: r.resolution_criteria,
  resolvesAt: r.resolves_at,
  probability: r.probability,
  referenceClass: r.reference_class,
  marketProbability: r.market_probability,
  marketUrl: r.market_url,
  evidenceEventIds: json(r.evidence_event_ids, [] as string[]),
  reasoning: r.reasoning,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
  outcome: r.outcome,
  brierScore: r.brier_score,
});

export const rowToBrief = (r: any): Brief => ({
  id: r.id,
  forDate: r.for_date,
  windowHours: r.window_hours,
  sections: json(r.sections, []),
  markdown: r.markdown,
  itemCount: r.item_count,
  eventCount: r.event_count,
  connectionCount: r.connection_count,
  createdAt: r.created_at,
});

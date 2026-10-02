import type { DB } from '../core/db.js';
import {
  connectionsForEvent, eventsForItem, getEntity, getEvent, getItem, getSource, getThread,
  threadEvents,
} from '../core/store.js';
import type { Connection, EntityKind, Event, Item, Thread } from '../core/types.js';

/**
 * The claim-level fact ledger.
 *
 * A writer working from this corpus needs one thing before a sentence: what
 * may this sentence rest on, and how firmly. The ledger answers that for one
 * subject - an item or a storyline - as a numbered list of claims, each with
 * the standing its source gives it, the source itself, and where one exists
 * the observation that would show it wrong.
 *
 * Everything here is read from what is already on file. No model is involved
 * in building a ledger, so it costs nothing and cannot say anything the
 * database does not. The standing of a row is a property of the record behind
 * it - a filing, a newsroom's report, a detector's join, a model's proposal -
 * and the usage rule that goes with each standing is fixed in code. That is
 * what lets a brief written from the ledger be checked against it.
 */

export type LedgerStanding =
  /** A filing or official record states it. May be stated, citing the record. */
  | 'record'
  /** A newsroom asserts it as verified fact. Attribute it to the outlet. */
  | 'reported'
  /** A party to a dispute claims it. Attribute it to that party. */
  | 'alleged'
  /** Analysis presented as such. Say whose. */
  | 'speculated'
  /** Two records joined on a party and a date window, in code. State both records and the gap. */
  | 'pattern'
  /** The same party in two sources, close in time. Nothing more. */
  | 'overlap'
  /** A model's proposal. A question to pose, never a finding, and it travels with its falsifier. */
  | 'hypothesis'
  /** A dossier claim the model recalled or inferred. Not on record here. */
  | 'background';

/**
 * What a writer may do with a row of each standing. Fixed here so the rule a
 * brief is checked against is the same one the ledger prints.
 */
export const USAGE_RULE: Record<LedgerStanding, string> = {
  record: 'May be stated as fact, citing the record.',
  reported: 'Attribute to the outlet. It is their assertion, not a document.',
  alleged: 'Attribute to the party making the claim. Do not state it.',
  speculated: 'Analysis. Say whose, and that it is analysis.',
  pattern: 'State both records and the interval between them. Do not state intent, coordination or cause.',
  overlap: 'Says only that two sources concern the same party. Do not build on it.',
  hypothesis: 'Pose as a question, never as a finding, and carry its falsifier.',
  background: 'Recalled by a model, not on record here. Verify independently or leave it out.',
};

/** Standings a sentence may rest on and still be written in the indicative. */
export const STATEABLE: ReadonlySet<LedgerStanding> = new Set<LedgerStanding>(['record', 'pattern']);

export interface LedgerRow {
  /** Position in the ledger, from 1. What a brief cites. */
  ref: number;
  kind: 'event' | 'connection' | 'background';
  standing: LedgerStanding;
  /** The claim, as the record supports it. */
  claim: string;
  /** YYYY-MM-DD when the record carries a date. */
  date: string | null;
  source: string | null;
  tier: string | null;
  url: string | null;
  /** What would show it wrong. Every connection carries one; records do not need one. */
  falsifier: string | null;
  /** Set on connections and background claims; a record carries none. */
  confidence: number | null;
  /** Ids this row was read from, so it can be walked back. */
  eventIds: string[];
  connectionId: string | null;
  entityId: string | null;
}

export interface Ledger {
  subject: { kind: 'item' | 'thread'; id: string; title: string };
  rows: LedgerRow[];
  /** Connections you judged coincidence or wrong, left off rather than listed. */
  struck: number;
  builtAt: string;
}

const PLAYER_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>([
  'person', 'organization', 'government-body', 'company', 'financial-instrument',
]);

const day = (iso: string) => iso.slice(0, 10);
const isWeb = (url: string) => /^https?:\/\//.test(url);

const EVENT_STANDING: Record<Event['assertion'], LedgerStanding> = {
  documented: 'record',
  reported: 'reported',
  alleged: 'alleged',
  speculated: 'speculated',
};

const CONNECTION_STANDING: Record<Connection['basis'], LedgerStanding> = {
  deterministic: 'pattern',
  'entity-overlap': 'overlap',
  hypothesis: 'hypothesis',
};

interface DossierClaim {
  text: string;
  basis: 'corpus' | 'recalled' | 'inferred';
  confidence: number;
}

/** Affiliations and prior episodes from a dossier. Capabilities are possibilities, not claims, and stay out. */
function dossierClaims(db: DB, entityId: string): DossierClaim[] {
  const r = db.prepare('SELECT affiliations, history FROM entity_profiles WHERE entity_id = ?')
    .get(entityId) as { affiliations: string; history: string } | undefined;
  if (!r) return [];
  const json = <T,>(v: string, fallback: T): T => { try { return JSON.parse(v) as T; } catch { return fallback; } };
  const name = getEntity(db, entityId)?.name ?? 'This party';
  const out: DossierClaim[] = [];
  for (const a of json<Array<{ organisation: string; role: string; period: string; basis: DossierClaim['basis']; confidence: number }>>(r.affiliations, [])) {
    out.push({ text: `${name}: ${a.role} at ${a.organisation} (${a.period}).`, basis: a.basis, confidence: a.confidence });
  }
  for (const h of json<Array<{ when: string; what: string; basis: DossierClaim['basis']; confidence: number }>>(r.history, [])) {
    out.push({ text: `${h.when}: ${h.what}`, basis: h.basis, confidence: h.confidence });
  }
  return out;
}

function eventRow(db: DB, e: Event): Omit<LedgerRow, 'ref'> {
  const item = getItem(db, e.itemId);
  const source = item ? getSource(db, item.sourceId) : null;
  return {
    kind: 'event',
    standing: EVENT_STANDING[e.assertion] ?? 'reported',
    claim: e.summary,
    date: day(e.occurredAt),
    source: source?.name ?? item?.sourceId ?? null,
    tier: source?.tier ?? null,
    url: item && isWeb(item.url) ? item.url : null,
    falsifier: null,
    confidence: null,
    eventIds: [e.id],
    connectionId: null,
    entityId: null,
  };
}

function connectionRow(c: Connection, from: Event, to: Event): Omit<LedgerRow, 'ref'> {
  const gap = Math.round(Math.abs(c.lagDays));
  return {
    kind: 'connection',
    standing: CONNECTION_STANDING[c.basis],
    claim: `${c.explanation} (${day(from.occurredAt)} then ${day(to.occurredAt)}, ${gap} day${gap === 1 ? '' : 's'} apart.)`,
    date: day(to.occurredAt),
    source: c.basis === 'hypothesis' ? 'model proposal' : c.basis === 'deterministic' ? `detector ${c.producedBy}` : 'entity overlap',
    tier: null,
    url: null,
    falsifier: c.falsifier,
    confidence: c.confidence,
    eventIds: [c.fromEventId, c.toEventId],
    connectionId: c.id,
    entityId: null,
  };
}

/**
 * Build the ledger from a set of events that make up one subject.
 *
 * Events come first in time order, then the connections touching them with
 * the far end of each pulled in as its own row - a writer must cite both
 * halves of a pattern - then background on the players. Refs are assigned
 * last so they are dense and in reading order.
 */
function ledgerFromEvents(
  db: DB,
  subject: Ledger['subject'],
  events: Event[],
): Ledger {
  const byId = new Map<string, Event>();
  for (const e of events) byId.set(e.id, e);

  // Connections from any of the subject's events, strongest first, skipping
  // those already judged a coincidence or wrong. The far end of each is added
  // to the event set so the row it rests on is in the ledger too.
  const seen = new Set<string>();
  const conns: Connection[] = [];
  let struck = 0;
  for (const e of events) {
    for (const c of connectionsForEvent(db, e.id)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.verdict === 'wrong' || c.verdict === 'coincidence') { struck++; continue; }
      conns.push(c);
    }
  }
  const rank = (c: Connection) => (c.basis === 'deterministic' ? 2 : c.basis === 'hypothesis' ? 1 : 0);
  conns.sort((a, b) => rank(b) - rank(a) || b.confidence - a.confidence);

  for (const c of conns) {
    for (const id of [c.fromEventId, c.toEventId]) {
      if (!byId.has(id)) {
        const ev = getEvent(db, id);
        if (ev) byId.set(id, ev);
      }
    }
  }

  const allEvents = [...byId.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const rows: Omit<LedgerRow, 'ref'>[] = allEvents.map((e) => eventRow(db, e));

  for (const c of conns) {
    const from = byId.get(c.fromEventId);
    const to = byId.get(c.toEventId);
    if (from && to) rows.push(connectionRow(c, from, to));
  }

  // Background on the players the subject's own events name. Players only:
  // countries and places are backdrop, and a dossier is never written on them.
  const players = new Set<string>();
  for (const e of events) {
    for (const en of e.entities) {
      if (en.role === 'mentioned' || players.has(en.entityId)) continue;
      const ent = getEntity(db, en.entityId);
      if (ent && PLAYER_KINDS.has(ent.kind)) players.add(en.entityId);
    }
  }
  for (const entityId of players) {
    for (const claim of dossierClaims(db, entityId)) {
      // A claim a record here supports is already a row above; what the ledger
      // needs from a dossier is exactly what is not on record.
      if (claim.basis === 'corpus') continue;
      rows.push({
        kind: 'background',
        standing: 'background',
        claim: claim.text,
        date: null,
        source: `dossier, ${claim.basis}`,
        tier: null,
        url: null,
        falsifier: null,
        confidence: claim.confidence,
        eventIds: [],
        connectionId: null,
        entityId,
      });
    }
  }

  return {
    subject,
    rows: rows.map((r, i) => ({ ref: i + 1, ...r })),
    struck,
    builtAt: new Date().toISOString(),
  };
}

/** The subject an id names: a storyline, or an item. */
export function resolveSubject(db: DB, id: string): { thread: Thread } | { item: Item } | null {
  const thread = getThread(db, id);
  if (thread) return { thread };
  const item = getItem(db, id);
  if (item) return { item };
  return null;
}

/** Build the ledger for an item or a storyline. Null when the id names neither. */
export function buildLedger(db: DB, id: string): Ledger | null {
  const subject = resolveSubject(db, id);
  if (!subject) return null;
  if ('thread' in subject) {
    const t = subject.thread;
    return ledgerFromEvents(db, { kind: 'thread', id: t.id, title: t.title }, threadEvents(db, t.id));
  }
  const it = subject.item;
  const title = it.triageTopic && it.triageTopic !== 'structured record' ? it.triageTopic : it.title;
  return ledgerFromEvents(db, { kind: 'item', id: it.id, title }, eventsForItem(db, it.id));
}

/** Rows a sentence may rest on in the indicative. */
export const stateableRows = (l: Ledger) => l.rows.filter((r) => STATEABLE.has(r.standing));

/** Counts by standing, for ranking and for saying what a ledger is made of. */
export function tally(l: Ledger): Record<LedgerStanding, number> {
  const t: Record<LedgerStanding, number> = {
    record: 0, reported: 0, alleged: 0, speculated: 0, pattern: 0, overlap: 0, hypothesis: 0, background: 0,
  };
  for (const r of l.rows) t[r.standing]++;
  return t;
}

/** Distinct sources behind the ledger's records, and how many are primary. */
export function sourceSpread(l: Ledger): { sources: number; primary: number } {
  const names = new Set<string>();
  const primary = new Set<string>();
  for (const r of l.rows) {
    if (r.kind !== 'event' || !r.source) continue;
    names.add(r.source);
    if (r.tier === 'primary') primary.add(r.source);
  }
  return { sources: names.size, primary: primary.size };
}

const cell = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** Markdown table. Every row keeps its standing, its source and what would show it wrong. */
export function renderLedgerMarkdown(l: Ledger): string {
  const lines: string[] = [
    `# Ledger - ${l.subject.title}`,
    '',
    `_${l.rows.length} claims on file for this ${l.subject.kind}. Standing is a property of the record, not a judgement about the claim._`,
    '',
    '| # | Date | Standing | Claim | Source | Would be wrong if |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of l.rows) {
    const source = r.url ? `[${cell(r.source)}](${r.url})` : cell(r.source);
    const conf = r.confidence === null ? '' : ` (${r.confidence.toFixed(2)})`;
    lines.push(`| ${r.ref} | ${r.date ?? ''} | ${r.standing}${conf} | ${cell(r.claim)} | ${source} | ${cell(r.falsifier)} |`);
  }
  lines.push('', '## How each standing may be used', '');
  const t = tally(l);
  for (const [standing, rule] of Object.entries(USAGE_RULE) as Array<[LedgerStanding, string]>) {
    if (t[standing] > 0) lines.push(`- **${standing}** (${t[standing]}): ${rule}`);
  }
  if (l.struck > 0) {
    lines.push('', `_${l.struck} connection${l.struck === 1 ? '' : 's'} you judged coincidence or wrong ${l.struck === 1 ? 'is' : 'are'} left off._`);
  }
  return lines.join('\n');
}

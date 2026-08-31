import { basename } from 'node:path';
import type { DB } from '../core/db.js';
import { stableId } from '../core/ids.js';
import { insertEvent, insertItem, resolveEntity, upsertSource } from '../core/store.js';
import { structuredRecordTriage } from '../core/types.js';
import type {
  Domain, Event, EventEntity, Item, Source, Tier,
} from '../core/types.js';

/**
 * Import congressional (or any) disclosed trades from a file.
 *
 * WHY THIS EXISTS
 *
 * The House Clerk's disclosure index tells you *who* filed a periodic
 * transaction report and *when*. It does not tell you the ticker, the
 * direction or the size - those are in per-filing PDFs, many of them scans
 * without a text layer. So `src/sources/stock-act.ts` can only produce "member
 * filed a PTR" items, and `trade-then-award` has nothing to join on.
 *
 * This closes that gap from the other end. Whatever parsed the PDFs - a
 * community dataset, a vendor API, your own script - hand the result to this
 * and it becomes `securities-trade` events with a resolved company entity, at
 * which point every existing detector works on congressional trades exactly as
 * it already works on SEC Form 4.
 *
 * WHAT IT WILL NOT DO
 *
 * It does not invent precision the disclosure does not have. Disclosed amounts
 * are bands ("$1,001 - $15,000"), so the event carries the band's *lower*
 * bound and both ends land in tags. A midpoint would read as a measurement and
 * it is not one.
 *
 * THE DISCLOSURE LAG
 *
 * The interval between executing a trade and filing it is the one number here
 * that is a hard fact rather than an inference, and the STOCK Act gives it a
 * bright line: a periodic transaction report is due within 45 days of the
 * transaction. So every imported trade carries `disclosure-lag:<n>`, and one
 * past that line carries `late-filing`. That is checkable, and it is the
 * cheapest real signal in the whole dataset.
 */

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

/**
 * The public congressional-trade datasets each name their columns differently,
 * and none of them is canonical. Rather than make the user write a mapping
 * file, recognise the shapes that actually exist: house-stock-watcher,
 * senate-stock-watcher, the common vendor exports, and hand-rolled CSVs.
 */
export type TradeField =
  | 'filer' | 'transactionDate' | 'disclosureDate' | 'ticker' | 'asset'
  | 'assetType' | 'action' | 'amount' | 'owner' | 'district' | 'chamber' | 'url';

const COLUMN_ALIASES: Record<TradeField, string[]> = {
  filer: [
    'representative', 'senator', 'member', 'member_name', 'filer', 'filer_name',
    'name', 'official', 'politician', 'person',
  ],
  // `date` alone means the transaction in every dataset that uses it.
  transactionDate: [
    'transaction_date', 'trade_date', 'transactiondate', 'tx_date', 'txn_date',
    'executed_at', 'date',
  ],
  disclosureDate: [
    'disclosure_date', 'filing_date', 'disclosed_at', 'report_date', 'ptr_date',
    'filed_date', 'disclosure',
  ],
  ticker: ['ticker', 'symbol', 'ticker_symbol', 'asset_ticker', 'security_ticker'],
  asset: [
    'asset_description', 'asset', 'asset_name', 'security', 'security_name',
    'issuer', 'company', 'description',
  ],
  assetType: ['asset_type', 'type_of_asset', 'security_type', 'instrument_type'],
  // `type` is the transaction direction in both stock-watcher datasets, which
  // is the overwhelmingly common case; asset kind is always `asset_type`.
  action: ['type', 'transaction_type', 'transaction', 'action', 'txn_type', 'order_type', 'side'],
  amount: ['amount', 'amount_range', 'range', 'value', 'amount_usd', 'size'],
  owner: ['owner', 'ownership', 'owner_type', 'held_by'],
  district: ['district', 'state_district', 'state', 'office', 'constituency'],
  chamber: ['chamber', 'house_senate', 'body'],
  url: ['ptr_link', 'link', 'url', 'source_url', 'document_url', 'disclosure_url', 'pdf_url'],
};

/** Column headers are compared with case, spaces and punctuation flattened. */
export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Map a row's own keys onto our fields.
 *
 * Earlier aliases win, so a dataset carrying both `representative` and `name`
 * uses the specific one. A field already claimed is never overwritten.
 */
export function mapColumns(headers: string[]): Partial<Record<TradeField, string>> {
  const normalized = new Map<string, string>();
  for (const h of headers) {
    const n = normalizeHeader(h);
    if (!normalized.has(n)) normalized.set(n, h);
  }
  const out: Partial<Record<TradeField, string>> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [TradeField, string[]][]) {
    for (const alias of aliases) {
      const original = normalized.get(alias);
      if (original !== undefined) { out[field] = original; break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 CSV reader.
 *
 * Written out rather than pulled in because the one thing that actually
 * matters - a quoted field containing a comma or a newline - is a dozen lines,
 * and asset descriptions contain commas constantly.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') { quoted = true; continue; }
    if (c === ',') { endField(); continue; }
    if (c === '\r') continue;
    if (c === '\n') { endRow(); continue; }
    field += c;
  }
  if (field !== '' || row.length > 0) endRow();

  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ---------------------------------------------------------------------------
// Field normalisation
// ---------------------------------------------------------------------------

export interface AmountRange {
  min: number;
  /** Null for an open-ended band: "Over $50,000,000", or a truncated range. */
  max: number | null;
}

/**
 * Parse a disclosed amount band.
 *
 * Congressional disclosures report ranges, not figures, and the published
 * datasets carry them as printed - including truncated ones like "$1,001 -"
 * where the upper bound was lost in parsing. Both shapes are handled; neither
 * is guessed at.
 */
export function parseAmountRange(raw: string | null | undefined): AmountRange | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || /^(--+|n\/?a|none|unknown|undetermined)$/i.test(s)) return null;

  const numbers = [...s.matchAll(/\$?\s*([\d][\d,]*(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]!.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
  if (numbers.length === 0) return null;

  const min = numbers[0]!;
  if (numbers.length >= 2) {
    const max = numbers[1]!;
    return max >= min ? { min, max } : { min: max, max: min };
  }
  // One number. An "over"/"at least" phrasing or a dangling separator means the
  // band is open at the top; anything else is an exact figure.
  const openEnded = /(\bover\b|\bmore than\b|\bat least\b|\bexceed)/i.test(s) || /[-–—+]\s*$/.test(s);
  return { min, max: openEnded ? null : min };
}

const MIN_PLAUSIBLE_YEAR = 1990;

/**
 * Parse a disclosure date to an ISO instant at midday UTC.
 *
 * Midday because these are calendar dates with no time, and anchoring at
 * midnight makes a timezone shift move the day. Implausible years are rejected
 * rather than accepted: the public House dataset contains typo'd years like
 * `0009-06-09`, and a trade dated 9 AD would sail through every detector's
 * date window as a match against everything.
 */
export function parseTradeDate(raw: string | null | undefined, now = new Date()): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || /^(--+|n\/?a|none|unknown)$/i.test(s)) return null;

  let y: number | undefined;
  let m: number | undefined;
  let d: number | undefined;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (iso) {
    [, y, m, d] = iso.map(Number) as [number, number, number, number];
  } else if (us) {
    const [, mm, dd, yy] = us.map(Number) as [number, number, number, number];
    m = mm; d = dd;
    y = yy < 100 ? 2000 + yy : yy;
  } else {
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) return null;
    y = parsed.getUTCFullYear(); m = parsed.getUTCMonth() + 1; d = parsed.getUTCDate();
  }

  if (y === undefined || m === undefined || d === undefined) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (y < MIN_PLAUSIBLE_YEAR || y > now.getUTCFullYear() + 1) return null;

  const at = new Date(Date.UTC(y, m - 1, d, 12));
  // Rejects impossible days that Date would roll forward (Feb 30 → Mar 2).
  if (at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return at.toISOString();
}

/** Uppercase symbol, or null when the row has no tradeable ticker. */
export function normalizeTicker(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/^\$/, '').toUpperCase();
  if (!s || /^(--+|N\/?A|NONE|UNKNOWN)$/.test(s)) return null;
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(s)) return null;
  return s;
}

export type TradeAction = 'purchase' | 'sale' | 'exchange' | 'other';

/** Collapse the many spellings of direction. Covers `sale_full`, `Sale (Partial)`, `P`, `S`. */
export function normalizeAction(raw: string | null | undefined): TradeAction {
  // Underscores are word characters, so `sale_full` has no word boundary after
  // "sale" - and `sale_full` is exactly how the House dataset spells it.
  const s = (raw ?? '').trim().toLowerCase().replace(/[_/]+/g, ' ');
  if (!s) return 'other';
  if (/^p$/.test(s) || /purchas|\bbuy\b|bought|acquisit/.test(s)) return 'purchase';
  if (/^s$/.test(s) || /\bsale\b|\bsell\b|\bsold\b|dispos/.test(s)) return 'sale';
  if (/exchang/.test(s)) return 'exchange';
  return 'other';
}

const HONORIFICS = /^(hon\.?|mr\.?|mrs\.?|ms\.?|dr\.?|rep\.?|sen\.?|representative|senator)\s+/i;
const NAME_SUFFIX = /^(jr|sr|ii|iii|iv|v|md|phd|esq|dds)\.?$/i;

/**
 * Clean a filer name to "First Last".
 *
 * Datasets carry "Hon. Dana Whitfield", "Whitfield, Dana" and plain
 * "Dana Whitfield" interchangeably. Getting these to one form is what lets a
 * member's trades accumulate on one entity instead of three - and the
 * "Last, First" flip is skipped when the tail is a generational suffix, so
 * "Whitfield, Jr." does not become "Jr. Whitfield".
 */
export function cleanFilerName(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ');
  while (HONORIFICS.test(s)) s = s.replace(HONORIFICS, '');
  const comma = s.split(',');
  if (comma.length === 2) {
    const [last, rest] = [comma[0]!.trim(), comma[1]!.trim()];
    if (last && rest && !NAME_SUFFIX.test(rest)) s = `${rest} ${last}`;
  }
  return s.trim();
}

export type Chamber = 'house' | 'senate' | 'other';

/** Days the STOCK Act allows between a transaction and its periodic report. */
export const STOCK_ACT_FILING_DEADLINE_DAYS = 45;

export interface TradeRecord {
  filer: string;
  chamber: Chamber;
  ticker: string | null;
  assetName: string | null;
  assetType: string | null;
  action: TradeAction;
  /** Direction exactly as the source spelled it. `sale_partial` vs `sale_full` matters. */
  rawAction: string | null;
  /** ISO instant the trade executed. */
  transactedAt: string;
  /** ISO instant it was disclosed, when the data carries one. */
  disclosedAt: string | null;
  /** Whole days from execution to disclosure. Null without a disclosure date. */
  disclosureLagDays: number | null;
  amount: AmountRange | null;
  owner: string | null;
  district: string | null;
  url: string | null;
}

export interface SkippedRow {
  reason: string;
  row: Record<string, string>;
}

const DAY_MS = 86_400_000;

/**
 * Turn one raw row into a TradeRecord, or say why it cannot be one.
 *
 * A row without a filer or without a usable transaction date is dropped rather
 * than defaulted. An undated trade cannot enter a lag calculation or a
 * detector window, and inventing today's date for it would put a fabricated
 * event into the corpus.
 */
export function normalizeRow(
  raw: Record<string, string>,
  cols: Partial<Record<TradeField, string>>,
  opts: { chamber?: Chamber; now?: Date } = {},
): TradeRecord | { skipped: string } {
  const now = opts.now ?? new Date();
  const get = (f: TradeField): string | null => {
    const key = cols[f];
    if (key === undefined) return null;
    const v = raw[key];
    return v === undefined || v.trim() === '' ? null : v.trim();
  };

  const filerRaw = get('filer');
  if (!filerRaw) return { skipped: 'no filer name' };
  const filer = cleanFilerName(filerRaw);
  if (!filer) return { skipped: 'no filer name' };

  const transactedAt = parseTradeDate(get('transactionDate'), now);
  if (!transactedAt) {
    return { skipped: get('transactionDate') ? 'unparseable transaction date' : 'no transaction date' };
  }

  const disclosedAt = parseTradeDate(get('disclosureDate'), now);
  const disclosureLagDays = disclosedAt === null
    ? null
    : Math.round((Date.parse(disclosedAt) - Date.parse(transactedAt)) / DAY_MS);

  let chamber: Chamber = opts.chamber ?? 'other';
  if (!opts.chamber) {
    const declared = (get('chamber') ?? '').toLowerCase();
    if (/senate|sen\b/.test(declared)) chamber = 'senate';
    else if (/house|rep\b/.test(declared)) chamber = 'house';
    // No chamber column: the filer column name itself says which body it is.
    else if (cols.filer !== undefined) {
      const n = normalizeHeader(cols.filer);
      if (n === 'senator') chamber = 'senate';
      else if (n === 'representative') chamber = 'house';
    }
  }

  const rawAction = get('action');
  return {
    filer,
    chamber,
    ticker: normalizeTicker(get('ticker')),
    assetName: get('asset'),
    assetType: get('assetType'),
    action: normalizeAction(rawAction),
    rawAction,
    transactedAt,
    disclosedAt,
    disclosureLagDays,
    amount: parseAmountRange(get('amount')),
    owner: get('owner'),
    district: get('district'),
    url: get('url'),
  };
}

export interface ParsedTrades {
  trades: TradeRecord[];
  skipped: SkippedRow[];
  /** Which of our fields the file actually supplied. */
  columns: Partial<Record<TradeField, string>>;
}

/**
 * Read a trade file. CSV or JSON, decided by content rather than extension so
 * a `.txt` export still works.
 *
 * JSON may be an array of objects or an object wrapping one under `data`,
 * `trades`, `transactions` or `results` - the shapes the public datasets and
 * the common APIs actually return.
 */
export function parseTradeFile(
  text: string,
  opts: { chamber?: Chamber; now?: Date } = {},
): ParsedTrades {
  const trimmed = text.trim();
  let rows: Record<string, string>[];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed: unknown = JSON.parse(trimmed);
    const arr = Array.isArray(parsed)
      ? parsed
      : ['data', 'trades', 'transactions', 'results', 'items']
        .map((k) => (parsed as Record<string, unknown>)[k])
        .find(Array.isArray);
    if (!Array.isArray(arr)) {
      throw new Error('JSON must be an array of trades, or an object with a data/trades/transactions array');
    }
    rows = arr.map((r) => {
      const out: Record<string, string> = {};
      if (r && typeof r === 'object') {
        for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
          if (v !== null && v !== undefined && typeof v !== 'object') out[k] = String(v);
        }
      }
      return out;
    });
  } else {
    rows = parseCsv(trimmed);
  }

  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columns = mapColumns(headers);

  const trades: TradeRecord[] = [];
  const skipped: SkippedRow[] = [];
  for (const row of rows) {
    const result = normalizeRow(row, columns, opts);
    if ('skipped' in result) skipped.push({ reason: result.skipped, row });
    else trades.push(result);
  }
  return { trades, skipped, columns };
}

// ---------------------------------------------------------------------------
// Trade -> Item + Event
// ---------------------------------------------------------------------------

const TITLE: Record<Chamber, string> = { house: 'Rep. ', senate: 'Sen. ', other: '' };

const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

function amountPhrase(a: AmountRange | null): string {
  if (!a) return '';
  if (a.max === null) return ` worth over ${usd(a.min)}`;
  if (a.max === a.min) return ` worth ${usd(a.min)}`;
  return ` worth ${usd(a.min)}–${usd(a.max)}`;
}

function actionPhrase(t: TradeRecord): string {
  switch (t.action) {
    case 'purchase': return 'a purchase of';
    case 'sale': return 'a sale of';
    case 'exchange': return 'an exchange involving';
    default: return 'a transaction in';
  }
}

/**
 * Human-readable name for what was traded.
 *
 * Some datasets already append the ticker to the description ("Berkshire
 * Hathaway Inc. (BRK.B)"), so strip a trailing parenthetical that repeats it
 * before adding one - otherwise it prints twice.
 */
export function assetLabel(t: TradeRecord): string {
  const name = t.assetName?.replace(/\s+/g, ' ').trim();
  if (!name) return t.ticker || 'an undisclosed asset';
  if (!t.ticker) return name;
  const escaped = t.ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const base = name.replace(new RegExp(`\\s*\\(${escaped}\\)\\s*$`, 'i'), '').trim();
  return `${base || t.ticker} (${t.ticker})`;
}

/**
 * The natural key for a trade. Two imports of the same disclosure - from the
 * same dataset re-downloaded, or from two datasets carrying the same filing -
 * must land on one row, so the id is derived from what identifies the trade
 * rather than from anything about the file it arrived in.
 */
export function tradeExternalId(t: TradeRecord): string {
  return stableId(
    'trade',
    t.filer.toLowerCase(),
    t.chamber,
    t.ticker ?? (t.assetName ?? '').toLowerCase(),
    t.transactedAt.slice(0, 10),
    t.action,
    t.rawAction ?? '',
    t.amount ? `${t.amount.min}-${t.amount.max ?? ''}` : '',
    (t.owner ?? '').toLowerCase(),
  );
}

export function tradeSummary(t: TradeRecord): string {
  const who = `${TITLE[t.chamber]}${t.filer}`;
  const ownerNote = t.owner && !/^self$/i.test(t.owner) ? ` (${t.owner.toLowerCase()})` : '';
  const executed = `, executed ${t.transactedAt.slice(0, 10)}`;
  const filed = t.disclosureLagDays === null
    ? ''
    : t.disclosureLagDays < 0
      ? ' and dated before the transaction it reports'
      : ` and filed ${t.disclosureLagDays} day${t.disclosureLagDays === 1 ? '' : 's'} later`;
  return `${who}${ownerNote} disclosed ${actionPhrase(t)} ${assetLabel(t)}${amountPhrase(t.amount)}${executed}${filed}.`;
}

export function tradeTags(t: TradeRecord): string[] {
  const tags = [`action:${t.action}`];
  if (t.chamber !== 'other') {
    tags.push('congressional-trade', `chamber:${t.chamber}`);
  }
  if (t.rawAction && t.rawAction.toLowerCase() !== t.action) {
    tags.push(`raw-action:${t.rawAction.toLowerCase().replace(/\s+/g, '-')}`);
  }
  if (t.ticker) tags.push(`ticker:${t.ticker}`); else tags.push('no-ticker');
  if (t.assetType) tags.push(`asset-type:${t.assetType.toLowerCase().replace(/\s+/g, '-')}`);
  if (t.owner) tags.push(`owner:${t.owner.toLowerCase().replace(/\s+/g, '-')}`);
  if (t.amount) {
    tags.push(`amount-min:${t.amount.min}`);
    if (t.amount.max !== null) tags.push(`amount-max:${t.amount.max}`);
    else tags.push('amount-open-ended');
  }
  if (t.disclosureLagDays !== null) {
    tags.push(`disclosure-lag:${t.disclosureLagDays}`);
    if (t.disclosureLagDays > STOCK_ACT_FILING_DEADLINE_DAYS) tags.push('late-filing');
    // A report dated before the trade it reports is a data error somewhere.
    // Flag it rather than silently treating it as a very prompt filing.
    if (t.disclosureLagDays < 0) tags.push('disclosure-date-precedes-trade');
  }
  return tags;
}

/** Securities whose issuer is worth resolving as a joinable company entity. */
const SECURITY_ASSET_TYPE = /stock|equity|share|bond|option|security|securities|fund|etf|adr|note/i;

/**
 * Should this row produce a company entity?
 *
 * A ticker is proof enough. Without one, only asset types that name an issuer
 * qualify: "Rental property, Austin TX" is a real disclosure and a terrible
 * company, and creating an entity for it would pollute every entity-overlap
 * join downstream.
 */
export function shouldResolveIssuer(t: TradeRecord): boolean {
  if (t.ticker) return true;
  if (!t.assetName) return false;
  return t.assetType !== null && SECURITY_ASSET_TYPE.test(t.assetType);
}

/** Issuer name without the ticker parenthetical some datasets append. */
export function issuerName(t: TradeRecord): string {
  const name = t.assetName?.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();
  return name || t.ticker || '';
}

export function tradeToItem(t: TradeRecord, source: Source, fetchedAt = new Date().toISOString()): Item {
  const externalId = tradeExternalId(t);
  const body = [
    `Filer: ${TITLE[t.chamber]}${t.filer}`,
    t.chamber !== 'other' ? `Chamber: ${t.chamber === 'house' ? 'US House of Representatives' : 'US Senate'}` : null,
    t.district ? `District/state: ${t.district}` : null,
    `Asset: ${assetLabel(t)}`,
    t.assetType ? `Asset type: ${t.assetType}` : null,
    `Transaction: ${t.rawAction ?? t.action}`,
    `Transaction date: ${t.transactedAt.slice(0, 10)}`,
    t.disclosedAt ? `Disclosure date: ${t.disclosedAt.slice(0, 10)}` : null,
    t.disclosureLagDays !== null ? `Disclosure lag: ${t.disclosureLagDays} days` : null,
    t.disclosureLagDays !== null && t.disclosureLagDays > STOCK_ACT_FILING_DEADLINE_DAYS
      ? `Filed past the ${STOCK_ACT_FILING_DEADLINE_DAYS}-day STOCK Act deadline.`
      : null,
    t.amount
      ? `Disclosed amount: ${t.amount.max === null ? `over ${usd(t.amount.min)}` : `${usd(t.amount.min)} - ${usd(t.amount.max)}`}`
      : null,
    t.owner ? `Owner: ${t.owner}` : null,
    'Imported from a file; amounts are disclosed bands, not exact figures.',
  ].filter(Boolean).join('\n');

  return {
    id: stableId('item', source.id, externalId),
    sourceId: source.id,
    externalId,
    url: t.url ?? source.url,
    title: tradeSummary(t),
    summary: tradeSummary(t),
    body,
    author: t.filer,
    // The item is the disclosure, so it is "published" when it was filed.
    publishedAt: t.disclosedAt ?? t.transactedAt,
    fetchedAt,
    raw: { ...t, amount: t.amount } as unknown as Record<string, unknown>,
    // Already structured. Sending it to the LLM extractor would cost money to
    // re-derive fields we parsed exactly.
    extractedAt: fetchedAt,
    ...structuredRecordTriage(fetchedAt),
    extractionError: null,
  };
}

export interface ImportOptions {
  sourceId?: string;
  sourceName?: string;
  tier?: Tier;
  chamber?: Chamber;
  /** Where the data came from, recorded on the source row. */
  origin?: string;
  now?: Date;
}

export interface ImportResult {
  parsed: number;
  skipped: SkippedRow[];
  itemsInserted: number;
  eventsWritten: number;
  lateFilings: number;
  withoutTicker: number;
  columns: Partial<Record<TradeField, string>>;
  sourceId: string;
}

const DEFAULT_SOURCE_ID = 'imported-trades';

/**
 * The source row an import writes under.
 *
 * `kind: 'import'` keeps it out of `ingest` and `sources:check` - there is no
 * endpoint to poll and nothing to probe - and `verified: false` is honest:
 * nothing here was confirmed against a live host, because no host was involved.
 */
export function importSource(opts: ImportOptions & { file?: string }): Source {
  const id = opts.sourceId ?? DEFAULT_SOURCE_ID;
  const domains: Domain[] = ['politics', 'markets'];
  return {
    id,
    name: opts.sourceName ?? (opts.file ? `Imported trades (${basename(opts.file)})` : 'Imported trades'),
    kind: 'import',
    url: opts.file ? `file://${opts.file}` : 'file://imported',
    tier: opts.tier ?? 'primary',
    domains,
    origin: opts.origin ?? 'US',
    intervalMinutes: 1440,
    verified: false,
    notes: 'Trade disclosures imported from a file. Not fetchable; re-run import:trades to update.',
    enabled: false,
  };
}

/**
 * Write trades into the corpus as `securities-trade` events.
 *
 * The filer is the `actor` and the issuer is the `target`, which is exactly
 * the shape `trade-then-award` already looks for - so importing trades makes
 * that detector fire on congressional disclosures with no change to the rules.
 */
export function importTrades(
  db: DB,
  trades: TradeRecord[],
  opts: ImportOptions & { file?: string } = {},
): Omit<ImportResult, 'parsed' | 'skipped' | 'columns'> {
  const source = importSource(opts);
  upsertSource(db, source);
  const now = (opts.now ?? new Date()).toISOString();

  let itemsInserted = 0;
  let eventsWritten = 0;
  let lateFilings = 0;
  let withoutTicker = 0;

  const tx = db.transaction((batch: TradeRecord[]) => {
    for (const t of batch) {
      const item = tradeToItem(t, source, now);
      if (insertItem(db, item)) itemsInserted++;

      const entities: EventEntity[] = [];
      const person = resolveEntity(db, {
        name: t.filer,
        kind: 'person',
        country: 'US',
        description: t.chamber === 'other'
          ? null
          : `Member of the US ${t.chamber === 'house' ? 'House of Representatives' : 'Senate'}${t.district ? ` (${t.district})` : ''}`,
        seenAt: t.transactedAt,
      });
      entities.push({ entityId: person.id, role: 'actor', surfaceForm: t.filer });

      if (shouldResolveIssuer(t)) {
        const issuer = resolveEntity(db, {
          name: issuerName(t),
          kind: 'company',
          ticker: t.ticker,
          aliases: t.ticker ? [t.ticker] : [],
          seenAt: t.transactedAt,
        });
        entities.push({
          entityId: issuer.id,
          role: 'target',
          surfaceForm: t.ticker ?? issuerName(t),
        });
      } else {
        withoutTicker++;
      }

      const event: Event = {
        id: stableId('evt', item.id, 'trade'),
        itemId: item.id,
        type: 'securities-trade',
        summary: tradeSummary(t),
        // The trade date, not the filing date. Every detector window is
        // measured from when the thing happened.
        occurredAt: t.transactedAt,
        occurredAtInferred: false,
        domains: t.chamber === 'other' ? ['markets'] : ['politics', 'markets'],
        entities,
        // The band's lower bound. Never the midpoint - a midpoint reads as a
        // measurement, and a disclosed range is not one.
        amount: t.amount ? { value: t.amount.min, currency: 'USD' } : null,
        tags: tradeTags(t),
        assertion: 'documented',
        createdAt: now,
      };
      insertEvent(db, event);
      eventsWritten++;
      if (t.disclosureLagDays !== null && t.disclosureLagDays > STOCK_ACT_FILING_DEADLINE_DAYS) {
        lateFilings++;
      }
    }
  });
  tx(trades);

  return { itemsInserted, eventsWritten, lateFilings, withoutTicker, sourceId: source.id };
}

/** Parse a file and write it in one call. */
export function importTradeFile(
  db: DB,
  text: string,
  opts: ImportOptions & { file?: string; limit?: number } = {},
): ImportResult {
  const parsed = parseTradeFile(text, { chamber: opts.chamber, now: opts.now });
  const trades = opts.limit ? parsed.trades.slice(0, opts.limit) : parsed.trades;
  const written = importTrades(db, trades, opts);
  return {
    parsed: parsed.trades.length,
    skipped: parsed.skipped,
    columns: parsed.columns,
    ...written,
  };
}

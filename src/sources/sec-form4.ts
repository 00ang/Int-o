import { XMLParser } from 'fast-xml-parser';
import type { Config } from '../core/config.js';
import { fetchText } from '../core/http.js';
import { stableId } from '../core/ids.js';
import { structuredRecordTriage } from '../core/types.js';
import type { Item, Source } from '../core/types.js';
import { parseFeed } from './rss.js';
import { parseEdgarTitle } from './sec-edgar.js';

/**
 * SEC Form 4: what company insiders bought and sold.
 *
 * The EDGAR "current filings" feed says only that an insider filed. The trade
 * itself - which security, how many shares, at what price, whether it was an
 * open-market purchase or a stock grant - lives in the ownership XML inside the
 * filing, so each new filing is fetched once and read in code. The complete
 * submission text file carries that XML inline, which makes it one request per
 * filing rather than an index lookup and then a document.
 *
 * Only open-market purchases (P) and sales (S) become events. Everything else a
 * Form 4 reports - grants, option exercises, shares withheld for tax, gifts - is
 * compensation mechanics, and a detector that treated a scheduled grant as a
 * decision to buy would find a "pattern" in every payroll. Those codes are kept
 * on the record, counted, and left there.
 *
 * Amendments (4/A) are skipped: they restate a filing already read, and reading
 * both would count one trade twice.
 */

const xml = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

const arrayify = <T,>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

/** Form 4 wraps most values as <x><value>..</value><footnoteId/></x>. */
function val(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === 'string' || typeof node === 'number') {
    const s = String(node).trim();
    return s || null;
  }
  if (typeof node === 'object' && 'value' in (node as Record<string, unknown>)) {
    return val((node as Record<string, unknown>).value);
  }
  return null;
}

const flag = (node: unknown): boolean => /^(1|true)$/i.test(val(node) ?? '');

const num = (node: unknown): number | null => {
  const s = val(node);
  if (s === null) return null;
  const n = Number(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export type InsiderCode = 'P' | 'S';

export interface InsiderTrade {
  date: string;
  code: InsiderCode;
  shares: number;
  /** Shares times price, summed across the rows of the day. Null when no price was given. */
  value: number | null;
  avgPrice: number | null;
  security: string;
  indirect: boolean;
}

export interface InsiderOwner {
  cik: string | null;
  /** As filed: EDGAR writes people surname first, often in capitals. */
  filedName: string;
  name: string;
  isCompany: boolean;
  role: string | null;
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
}

export interface Form4Filing {
  accession: string;
  periodOfReport: string | null;
  issuer: { cik: string | null; name: string; ticker: string | null };
  owners: InsiderOwner[];
  /** The filer ticked the box saying these trades ran under a 10b5-1 plan. */
  tenb51: boolean;
  trades: InsiderTrade[];
  /** Transaction codes present but not turned into events (A, M, F, G ...). */
  otherCodes: string[];
}

const COMPANY_WORDS = /\b(inc|corp|corporation|llc|l\.l\.c|lp|l\.p|ltd|limited|fund|trust|holdings?|capital|partners|group|management|advisors|advisers|investments?|associates|company|plc|foundation|bank|financial|ventures|equity|master|n\.v|s\.a|ag|gmbh)\b\.?/i;
const SUFFIX = /^(jr|sr|ii|iii|iv|v|md|phd|esq)\.?$/i;

const shouting = (s: string) => /[A-Z]/.test(s) && s === s.toUpperCase();
const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, (_, pre: string, c: string) => pre + c.toUpperCase());

/**
 * A reporting owner's name as a person would write it.
 *
 * EDGAR files people as "SURNAME FIRST MIDDLE", and firms as themselves. A
 * name that reads like a firm is left in its order; a person's is turned round
 * so the same senator, CEO or director written "Jane Q. Doe" in a news story
 * lands on the same party. Capitals are softened only when the whole name is in
 * capitals, so "McDonald" written properly stays as written.
 */
export function ownerName(filed: string): { name: string; isCompany: boolean } {
  const raw = filed.replace(/\s+/g, ' ').trim();
  if (COMPANY_WORDS.test(raw)) return { name: shouting(raw) ? titleCase(raw) : raw, isCompany: true };
  const parts = raw.replace(/,/g, ' ').split(' ').filter(Boolean);
  if (parts.length < 2) return { name: shouting(raw) ? titleCase(raw) : raw, isCompany: false };
  const suffixes: string[] = [];
  while (parts.length > 2 && SUFFIX.test(parts[parts.length - 1]!)) suffixes.unshift(parts.pop()!);
  const [surname, ...given] = parts;
  const person = [...given, surname, ...suffixes].join(' ');
  return { name: shouting(person) ? titleCase(person) : person, isCompany: false };
}

function roleOf(rel: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const title = val(rel.officerTitle);
  if (flag(rel.isOfficer)) parts.push(title ?? 'officer');
  if (flag(rel.isDirector)) parts.push('director');
  if (flag(rel.isTenPercentOwner)) parts.push('10% owner');
  const other = val(rel.otherText);
  if (flag(rel.isOther) && other) parts.push(other);
  return parts.length ? parts.join(', ') : null;
}

/** The ownership XML out of a full submission file, or the XML itself. */
export function ownershipXml(text: string): string | null {
  const m = text.match(/<ownershipDocument[\s>][\s\S]*?<\/ownershipDocument>/);
  return m ? m[0] : null;
}

export function parseForm4(text: string, accession: string): Form4Filing | null {
  const doc = ownershipXml(text);
  if (!doc) return null;
  const root = (xml.parse(doc) as { ownershipDocument?: Record<string, any> }).ownershipDocument;
  if (!root) return null;
  if (val(root.documentType) && val(root.documentType) !== '4') return null;

  const issuerNode = root.issuer ?? {};
  const issuerName = val(issuerNode.issuerName);
  if (!issuerName) return null;
  const ticker = val(issuerNode.issuerTradingSymbol);

  const owners: InsiderOwner[] = arrayify(root.reportingOwner).flatMap((o: Record<string, any>) => {
    const filedName = val(o.reportingOwnerId?.rptOwnerName);
    if (!filedName) return [];
    const rel = (o.reportingOwnerRelationship ?? {}) as Record<string, unknown>;
    const { name, isCompany } = ownerName(filedName);
    return [{
      cik: val(o.reportingOwnerId?.rptOwnerCik),
      filedName,
      name,
      isCompany,
      role: roleOf(rel),
      isDirector: flag(rel.isDirector),
      isOfficer: flag(rel.isOfficer),
      isTenPercentOwner: flag(rel.isTenPercentOwner),
    }];
  });
  if (owners.length === 0) return null;

  // One event per day and direction: a sale filled in twenty lots at twenty
  // prices is one decision, not twenty.
  const byDay = new Map<string, InsiderTrade & { priced: number }>();
  const otherCodes = new Set<string>();
  for (const t of arrayify(root.nonDerivativeTable?.nonDerivativeTransaction) as Record<string, any>[]) {
    const code = val(t.transactionCoding?.transactionCode)?.toUpperCase();
    if (!code) continue;
    if (code !== 'P' && code !== 'S') { otherCodes.add(code); continue; }
    const date = val(t.transactionDate)?.slice(0, 10);
    const shares = num(t.transactionAmounts?.transactionShares);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !shares) continue;
    const price = num(t.transactionAmounts?.transactionPricePerShare);
    const key = `${date}|${code}`;
    const cur = byDay.get(key) ?? {
      date, code, shares: 0, value: null, avgPrice: null,
      security: val(t.securityTitle) ?? 'common stock', indirect: false, priced: 0,
    };
    cur.shares += shares;
    if (price !== null && price > 0) {
      cur.value = (cur.value ?? 0) + shares * price;
      cur.priced += shares;
    }
    if (val(t.ownershipNature?.directOrIndirectOwnership)?.toUpperCase() === 'I') cur.indirect = true;
    byDay.set(key, cur);
  }
  for (const t of arrayify(root.derivativeTable?.derivativeTransaction) as Record<string, any>[]) {
    const code = val(t.transactionCoding?.transactionCode)?.toUpperCase();
    if (code) otherCodes.add(code);
  }

  const trades: InsiderTrade[] = [...byDay.values()].map(({ priced, ...t }) => ({
    ...t,
    value: t.value === null ? null : Math.round(t.value),
    avgPrice: t.value !== null && priced > 0 ? Math.round((t.value / priced) * 100) / 100 : null,
  })).sort((a, b) => a.date.localeCompare(b.date));

  return {
    accession,
    periodOfReport: val(root.periodOfReport),
    issuer: { cik: val(issuerNode.issuerCik), name: issuerName, ticker: ticker ? ticker.toUpperCase() : null },
    owners,
    tenb51: flag(root.aff10b5One),
    trades,
    otherCodes: [...otherCodes].sort(),
  };
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** "Jane Doe (Chief Financial Officer)", or the first two when several filed together. */
export function ownersLabel(owners: InsiderOwner[]): string {
  const one = (o: InsiderOwner) => `${o.name}${o.role ? ` (${o.role})` : ''}`;
  if (owners.length <= 2) return owners.map(one).join(' and ');
  return `${one(owners[0]!)} and ${owners.length - 1} others`;
}

export function form4Title(f: Form4Filing): string {
  const issuer = f.issuer.ticker ?? f.issuer.name;
  const who = ownersLabel(f.owners);
  if (f.trades.length === 0) {
    return `${who} filed a Form 4 for ${f.issuer.name} with no open-market trade`;
  }
  const total = (code: InsiderCode) => f.trades.filter((t) => t.code === code)
    .reduce((n, t) => n + (t.value ?? 0), 0);
  const moves: string[] = [];
  if (f.trades.some((t) => t.code === 'P')) moves.push(`bought ${total('P') ? usd(total('P')) : 'shares'}`);
  if (f.trades.some((t) => t.code === 'S')) moves.push(`sold ${total('S') ? usd(total('S')) : 'shares'}`);
  return `${who} ${moves.join(' and ')} of ${issuer}`;
}

/** The accession number from a filing index URL, as EDGAR formats it. */
export function accessionFromUrl(url: string): string | null {
  return url.match(/(\d{10}-\d{2}-\d{6})(?:-index\.html?|\.txt)?$/)?.[1] ?? null;
}

/** The complete submission file sits next to the index page. */
export const submissionUrl = (indexUrl: string): string =>
  indexUrl.replace(/-index\.html?$/, '.txt');

export function form4Item(
  f: Form4Filing,
  source: Source,
  indexUrl: string,
  filedAt: string,
  fetchedAt = new Date().toISOString(),
): Item {
  const body = [
    `Issuer: ${f.issuer.name}${f.issuer.ticker ? ` (${f.issuer.ticker})` : ''}`,
    ...f.owners.map((o) => `Reporting owner: ${o.name}${o.role ? `, ${o.role}` : ''}`),
    ...f.trades.map((t) =>
      `${t.date}: ${t.code === 'P' ? 'bought' : 'sold'} ${t.shares.toLocaleString('en-US')} shares` +
      `${t.avgPrice ? ` at about $${t.avgPrice.toFixed(2)}` : ''}${t.value ? ` (${usd(t.value)})` : ''}` +
      `${t.indirect ? ', held indirectly' : ''}`),
    f.tenb51 ? 'Reported as made under a Rule 10b5-1 trading plan.' : '',
    f.otherCodes.length ? `Other transaction codes on the filing, not treated as trades: ${f.otherCodes.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  return {
    id: stableId('item', source.id, f.accession),
    sourceId: source.id,
    externalId: f.accession,
    url: indexUrl,
    title: form4Title(f),
    summary: null,
    body,
    author: f.owners[0]?.name ?? null,
    publishedAt: filedAt,
    fetchedAt,
    raw: f as unknown as Record<string, unknown>,
    // A dataset row: its events are written in code at ingest.
    extractedAt: fetchedAt,
    ...structuredRecordTriage(fetchedAt),
    extractionError: null,
  };
}

export interface FetchOptions {
  /** Filings already on file are not fetched again. */
  isKnown?: (externalId: string) => boolean;
  /** Most new filings read in one poll. Each is one request to EDGAR. */
  limit?: number;
}

export async function fetchForm4(
  source: Source,
  cfg: Config,
  opts: FetchOptions = {},
): Promise<Item[]> {
  const fetchedAt = new Date().toISOString();
  // Each filing appears twice in the feed, once for the insider and once for
  // the company. Keyed on accession number, it is read once.
  const filings = new Map<string, { url: string; filedAt: string }>();
  for (const entry of parseFeed(await fetchText(source.url, cfg), source, fetchedAt)) {
    const accession = accessionFromUrl(entry.url);
    const form = parseEdgarTitle(entry.title).formType;
    if (!accession || (form && form !== '4')) continue;
    if (!filings.has(accession)) filings.set(accession, { url: entry.url, filedAt: entry.publishedAt });
  }

  const fresh = [...filings].filter(([acc]) => !opts.isKnown?.(acc)).slice(0, opts.limit ?? 60);
  const items: Item[] = [];
  let failures = 0;
  let lastError = '';
  for (const [accession, f] of fresh) {
    try {
      const parsed = parseForm4(await fetchText(submissionUrl(f.url), cfg), accession);
      if (parsed) items.push(form4Item(parsed, source, f.url, f.filedAt, fetchedAt));
    } catch (err) {
      failures++;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  // One unreadable filing is a filing; every one of them is the adapter broken.
  if (fresh.length > 0 && failures === fresh.length) {
    throw new Error(`could not read any of ${fresh.length} Form 4 filings: ${lastError}`);
  }
  return items;
}

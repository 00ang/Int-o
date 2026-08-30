import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/core/db.js';
import {
  findEntityByName, findEntityByTicker, insertEvent, insertItem, resolveEntity, tradeEvents,
  upsertSource,
} from '../src/core/store.js';
import type { Event, Item, Source } from '../src/core/types.js';
import { runAllPairRules } from '../src/pipeline/detectors/deterministic.js';
import {
  assetLabel, cleanFilerName, importTradeFile, issuerName, mapColumns, normalizeAction, normalizeTicker,
  parseAmountRange, parseCsv, parseTradeDate, parseTradeFile, shouldResolveIssuer,
  tradeExternalId, tradeSummary, tradeTags, type TradeRecord,
} from '../src/pipeline/import-trades.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(join(here, 'fixtures', n), 'utf8');

// A fixed "now" so year-plausibility checks do not drift with the wall clock.
const NOW = new Date('2026-08-30T00:00:00.000Z');

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('CSV reading', () => {
  it('keeps commas inside quoted fields', () => {
    const rows = parseCsv('a,b\n"one, two",three\n');
    expect(rows).toEqual([{ a: 'one, two', b: 'three' }]);
  });

  it('unescapes doubled quotes', () => {
    const rows = parseCsv('a\n"he said ""hi"""\n');
    expect(rows[0]!.a).toBe('he said "hi"');
  });

  it('keeps newlines inside quoted fields', () => {
    const rows = parseCsv('a,b\n"line1\nline2",x\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.a).toBe('line1\nline2');
  });

  it('drops blank lines and pads short rows', () => {
    const rows = parseCsv('a,b,c\n1,2\n\n4,5,6\n');
    expect(rows).toEqual([
      { a: '1', b: '2', c: '' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('strips a UTF-8 BOM off the first header', () => {
    expect(parseCsv('﻿a,b\n1,2\n')[0]).toEqual({ a: '1', b: '2' });
  });
});

describe('column mapping', () => {
  it('recognises the house-stock-watcher shape', () => {
    const cols = mapColumns(['representative', 'transaction_date', 'disclosure_date', 'ticker', 'amount', 'type']);
    expect(cols.filer).toBe('representative');
    expect(cols.transactionDate).toBe('transaction_date');
    expect(cols.disclosureDate).toBe('disclosure_date');
    expect(cols.action).toBe('type');
  });

  it('recognises the senate-stock-watcher shape and keeps type and asset_type apart', () => {
    const cols = mapColumns(['senator', 'transaction_date', 'ticker', 'asset_type', 'type']);
    expect(cols.filer).toBe('senator');
    expect(cols.action).toBe('type');
    expect(cols.assetType).toBe('asset_type');
  });

  it('matches headers regardless of case, spaces and punctuation', () => {
    const cols = mapColumns(['Transaction Date', 'Ticker Symbol', 'Member Name']);
    expect(cols.transactionDate).toBe('Transaction Date');
    expect(cols.ticker).toBe('Ticker Symbol');
    expect(cols.filer).toBe('Member Name');
  });

  it('prefers the more specific alias when a file carries both', () => {
    expect(mapColumns(['name', 'representative']).filer).toBe('representative');
  });
});

describe('amount ranges', () => {
  it('parses a two-ended band', () => {
    expect(parseAmountRange('$1,001 - $15,000')).toEqual({ min: 1001, max: 15000 });
  });

  it('leaves a truncated band open at the top rather than guessing', () => {
    expect(parseAmountRange('$1,001 -')).toEqual({ min: 1001, max: null });
  });

  it('treats "Over $X" as open-ended', () => {
    expect(parseAmountRange('Over $50,000,000')).toEqual({ min: 50_000_000, max: null });
  });

  it('treats a lone figure as exact', () => {
    expect(parseAmountRange('$15,000')).toEqual({ min: 15000, max: 15000 });
  });

  it('orders a reversed band', () => {
    expect(parseAmountRange('$15,000 - $1,001')).toEqual({ min: 1001, max: 15000 });
  });

  it('returns null for placeholders', () => {
    for (const s of ['', '--', 'N/A', 'none', 'Unknown']) {
      expect(parseAmountRange(s)).toBeNull();
    }
  });
});

describe('dates', () => {
  it('parses ISO and US forms to the same instant', () => {
    expect(parseTradeDate('2026-06-02', NOW)).toBe('2026-06-02T12:00:00.000Z');
    expect(parseTradeDate('06/02/2026', NOW)).toBe('2026-06-02T12:00:00.000Z');
  });

  it('expands a two-digit year into this century', () => {
    expect(parseTradeDate('6/2/26', NOW)).toBe('2026-06-02T12:00:00.000Z');
  });

  it('anchors at midday so a timezone shift cannot move the day', () => {
    expect(parseTradeDate('2026-06-02', NOW)!).toContain('T12:00:00');
  });

  it("rejects the House dataset's typo'd years instead of dating a trade to 9 AD", () => {
    expect(parseTradeDate('0009-06-09', NOW)).toBeNull();
  });

  it('rejects dates beyond next year', () => {
    expect(parseTradeDate('2031-01-01', NOW)).toBeNull();
  });

  it('rejects impossible days rather than rolling them forward', () => {
    expect(parseTradeDate('2026-02-30', NOW)).toBeNull();
  });

  it('returns null for placeholders and gibberish', () => {
    for (const s of ['', '--', 'N/A', 'not a date']) expect(parseTradeDate(s, NOW)).toBeNull();
  });
});

describe('field normalisation', () => {
  it('collapses the spellings of direction', () => {
    expect(normalizeAction('purchase')).toBe('purchase');
    expect(normalizeAction('P')).toBe('purchase');
    expect(normalizeAction('sale_full')).toBe('sale');
    expect(normalizeAction('Sale (Partial)')).toBe('sale');
    expect(normalizeAction('exchange')).toBe('exchange');
    expect(normalizeAction('')).toBe('other');
  });

  it('normalises tickers and rejects non-tickers', () => {
    expect(normalizeTicker('$brk.b')).toBe('BRK.B');
    expect(normalizeTicker(' aapl ')).toBe('AAPL');
    expect(normalizeTicker('--')).toBeNull();
    expect(normalizeTicker('N/A')).toBeNull();
    expect(normalizeTicker('Rental property in Travis County')).toBeNull();
  });

  it('reduces filer names to one form so a member accumulates on one entity', () => {
    expect(cleanFilerName('Hon. Dana Whitfield')).toBe('Dana Whitfield');
    expect(cleanFilerName('Whitfield, Dana')).toBe('Dana Whitfield');
    expect(cleanFilerName('  Dana   Whitfield ')).toBe('Dana Whitfield');
    expect(cleanFilerName('Rep. Dana Whitfield')).toBe('Dana Whitfield');
  });

  it('does not flip a generational suffix into a first name', () => {
    expect(cleanFilerName('Gorman, Jr.')).toBe('Gorman, Jr.');
  });
});

describe('parsing a house-shaped JSON file', () => {
  const parsed = parseTradeFile(fixture('house-trades.json'), { now: NOW });

  it('infers the chamber from the filer column name', () => {
    expect(parsed.trades.every((t) => t.chamber === 'house')).toBe(true);
  });

  it('drops rows it cannot date or attribute, and says why', () => {
    expect(parsed.skipped.map((s) => s.reason).sort()).toEqual([
      'no filer name',
      'unparseable transaction date',
    ]);
  });

  it('computes the disclosure lag from the transaction date', () => {
    const t = parsed.trades[0]!;
    expect(t.transactedAt.slice(0, 10)).toBe('2026-06-02');
    expect(t.disclosedAt!.slice(0, 10)).toBe('2026-07-14');
    expect(t.disclosureLagDays).toBe(42);
  });

  it('flags a filing past the 45-day deadline', () => {
    // Same trade date, filed 2026-08-20: 79 days.
    const late = parsed.trades[1]!;
    expect(late.disclosureLagDays).toBe(79);
    expect(tradeTags(late)).toContain('late-filing');
  });

  it('does not flag a filing inside the deadline', () => {
    expect(tradeTags(parsed.trades[0]!)).not.toContain('late-filing');
  });

  it('reaches the same filer entity from "Hon. X" and "X, Y" spellings', () => {
    expect(parsed.trades[0]!.filer).toBe('Dana Whitfield');
    expect(parsed.trades[1]!.filer).toBe('Dana Whitfield');
  });

  it('keeps the source spelling of the direction alongside the collapsed one', () => {
    expect(parsed.trades[1]!.action).toBe('sale');
    expect(tradeTags(parsed.trades[1]!)).toContain('raw-action:sale_partial');
  });
});

describe('parsing a senate-shaped CSV', () => {
  const parsed = parseTradeFile(fixture('senate-trades.csv'), { now: NOW });

  it('infers the senate chamber', () => {
    expect(parsed.trades.every((t) => t.chamber === 'senate')).toBe(true);
  });

  it('reads a quoted asset description containing a comma', () => {
    expect(parsed.trades[0]!.assetName).toBe('Helix Dynamics, Inc.');
  });

  it('does not print the ticker twice when the description already carries it', () => {
    const brk = parsed.trades[2]!;
    expect(brk.assetName).toBe('Berkshire Hathaway Inc. (BRK.B)');
    expect(assetLabel(brk)).toBe('Berkshire Hathaway Inc. (BRK.B)');
  });

  it('names the issuer entity without the ticker parenthetical', () => {
    expect(issuerName(parsed.trades[2]!)).toBe('Berkshire Hathaway Inc.');
  });

  it('flags a disclosure dated before the trade rather than calling it prompt', () => {
    const backwards = parsed.trades[1]!;
    expect(backwards.disclosureLagDays).toBe(-4);
    const tags = tradeTags(backwards);
    expect(tags).toContain('disclosure-date-precedes-trade');
    expect(tags).not.toContain('late-filing');
  });

  it('records the owner, which is what separates a member from their spouse', () => {
    expect(tradeTags(parsed.trades[2]!)).toContain('owner:spouse');
  });
});

describe('issuer resolution', () => {
  const trade = (over: Partial<TradeRecord>): TradeRecord => ({
    filer: 'Dana Whitfield', chamber: 'house', ticker: null, assetName: null,
    assetType: null, action: 'purchase', rawAction: 'purchase',
    transactedAt: '2026-06-02T12:00:00.000Z', disclosedAt: null,
    disclosureLagDays: null, amount: null, owner: null, district: null, url: null,
    ...over,
  });

  it('resolves an issuer whenever there is a ticker', () => {
    expect(shouldResolveIssuer(trade({ ticker: 'MRDN' }))).toBe(true);
  });

  it('resolves an issuer for a tickerless security', () => {
    expect(shouldResolveIssuer(trade({ assetName: 'Ames GO bond', assetType: 'Municipal Security' })))
      .toBe(true);
  });

  it('refuses to make a company out of real estate', () => {
    expect(shouldResolveIssuer(trade({
      assetName: 'Rental property, Travis County TX', assetType: 'Real Estate',
    }))).toBe(false);
  });

  it('refuses when the asset type is unstated and there is no ticker', () => {
    expect(shouldResolveIssuer(trade({ assetName: 'Something' }))).toBe(false);
  });
});

describe('summaries', () => {
  const t: TradeRecord = {
    filer: 'Dana Whitfield', chamber: 'house', ticker: 'MRDN',
    assetName: 'Meridian Aerospace Corp', assetType: 'Stock', action: 'purchase',
    rawAction: 'purchase', transactedAt: '2026-06-02T12:00:00.000Z',
    disclosedAt: '2026-08-20T12:00:00.000Z', disclosureLagDays: 79,
    amount: { min: 15001, max: 50000 }, owner: 'spouse', district: 'TX07', url: null,
  };

  it('names the filer, the asset, the band and the lag in one sentence', () => {
    expect(tradeSummary(t)).toBe(
      'Rep. Dana Whitfield (spouse) disclosed a purchase of Meridian Aerospace Corp (MRDN) ' +
      'worth $15,001–$50,000, executed 2026-06-02 and filed 79 days later.',
    );
  });

  it('says "over" for an open-ended band instead of inventing a ceiling', () => {
    expect(tradeSummary({ ...t, amount: { min: 50_000_000, max: null } }))
      .toContain('worth over $50,000,000');
  });

  it('omits the owner note when the member holds it themselves', () => {
    expect(tradeSummary({ ...t, owner: 'self' })).not.toContain('(self)');
  });

  it('says nothing about filing when no disclosure date was supplied', () => {
    const summary = tradeSummary({ ...t, disclosedAt: null, disclosureLagDays: null });
    expect(summary).toContain('executed 2026-06-02.');
    expect(summary).not.toContain('filed');
  });
});

describe('amount handling', () => {
  it('carries the lower bound, never the midpoint', () => {
    const { trades } = parseTradeFile(fixture('house-trades.json'), { now: NOW });
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    const ev = tradeEvents(db, { limit: 50 })
      .find((e) => e.summary.includes('$15,001'))!;
    expect(ev.amount).toEqual({ value: 15001, currency: 'USD' });
    expect(trades[0]!.amount).toEqual({ min: 15001, max: 50000 });
  });

  it('puts both ends of the band in tags so nothing is lost', () => {
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    const ev = tradeEvents(db, { limit: 50 }).find((e) => e.summary.includes('$15,001'))!;
    expect(ev.tags).toContain('amount-min:15001');
    expect(ev.tags).toContain('amount-max:50000');
  });

  it('marks an open-ended band rather than fabricating a maximum', () => {
    const t = parseTradeFile(fixture('house-trades.json'), { now: NOW })
      .trades.find((x) => x.amount?.max === null)!;
    expect(tradeTags(t)).toContain('amount-open-ended');
    expect(tradeTags(t).some((x) => x.startsWith('amount-max:'))).toBe(false);
  });
});

describe('importing into the corpus', () => {
  it('writes items and events and reports what it did', () => {
    const r = importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    expect(r.parsed).toBe(3);
    expect(r.skipped).toHaveLength(2);
    expect(r.itemsInserted).toBe(3);
    expect(r.eventsWritten).toBe(3);
    expect(r.lateFilings).toBe(1);
    expect(r.withoutTicker).toBe(1);
  });

  it('is idempotent: importing the same file twice adds nothing', () => {
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    const again = importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    expect(again.itemsInserted).toBe(0);
    expect(tradeEvents(db, { limit: 100 })).toHaveLength(3);
  });

  it('derives the trade id from the trade, not the file it arrived in', () => {
    const [a] = parseTradeFile(fixture('house-trades.json'), { now: NOW }).trades;
    expect(tradeExternalId(a!)).toBe(tradeExternalId({ ...a! }));
    // A different direction is a different trade.
    expect(tradeExternalId({ ...a!, action: 'sale' })).not.toBe(tradeExternalId(a!));
  });

  it('resolves the filer as an actor and the issuer as a target', () => {
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    const ev = tradeEvents(db, { limit: 50 }).find((e) => e.summary.includes('Meridian'))!;
    const person = findEntityByName(db, 'Dana Whitfield', 'person')!;
    const company = findEntityByTicker(db, 'MRDN')!;
    expect(ev.entities).toContainEqual({
      entityId: person.id, role: 'actor', surfaceForm: 'Dana Whitfield',
    });
    expect(ev.entities).toContainEqual({
      entityId: company.id, role: 'target', surfaceForm: 'MRDN',
    });
  });

  it('lands both spellings of a member on one entity', () => {
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    const person = findEntityByName(db, 'Dana Whitfield', 'person')!;
    expect(person.mentionCount).toBe(2);
  });

  it('dates the event to the trade, not to the filing', () => {
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    const ev = tradeEvents(db, { limit: 50 }).find((e) => e.summary.includes('$15,001'))!;
    expect(ev.occurredAt.slice(0, 10)).toBe('2026-06-02');
  });

  it('records trades as documented, since a filing is a primary record', () => {
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    expect(tradeEvents(db, { limit: 50 }).every((e) => e.assertion === 'documented')).toBe(true);
  });

  it('marks imported items extracted so they never reach the paid extractor', () => {
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    const pending = db
      .prepare('SELECT COUNT(*) n FROM items WHERE extracted_at IS NULL')
      .get() as { n: number };
    expect(pending.n).toBe(0);
  });

  it('files everything under an import-kind source that ingest will not poll', () => {
    const r = importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(r.sourceId) as Record<string, unknown>;
    expect(src.kind).toBe('import');
    expect(src.enabled).toBe(0);
    expect(src.verified).toBe(0);
  });

  it('merges two datasets covering the same trade into one row', () => {
    const csv = [
      'representative,transaction_date,disclosure_date,ticker,asset_description,type,amount,owner',
      'Hon. Dana Whitfield,2026-06-02,07/14/2026,MRDN,Meridian Aerospace Corp,purchase,"$15,001 - $50,000",self',
    ].join('\n');
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    const second = importTradeFile(db, csv, { now: NOW, chamber: 'house' });
    expect(second.parsed).toBe(1);
    expect(second.itemsInserted).toBe(0);
  });

  it('honours an explicit chamber over the inferred one', () => {
    importTradeFile(db, fixture('house-trades.json'), { now: NOW, chamber: 'other' });
    const ev = tradeEvents(db, { limit: 50 })[0]!;
    expect(ev.tags).not.toContain('congressional-trade');
    expect(ev.summary.startsWith('Rep.')).toBe(false);
  });

  it('respects a row limit', () => {
    const r = importTradeFile(db, fixture('house-trades.json'), { now: NOW, limit: 1 });
    expect(r.eventsWritten).toBe(1);
  });
});

describe('browsing imported trades', () => {
  beforeEach(() => {
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    importTradeFile(db, fixture('senate-trades.csv'), { now: NOW, sourceId: 'senate-import' });
  });

  it('returns only late filings when asked', () => {
    const late = tradeEvents(db, { lateOnly: true, limit: 50 });
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((e) => e.tags.includes('late-filing'))).toBe(true);
  });

  it('filters to one filer', () => {
    const rows = tradeEvents(db, { filer: 'Dana Whitfield', limit: 50 });
    expect(rows).toHaveLength(2);
    expect(rows.every((e) => e.summary.includes('Dana Whitfield'))).toBe(true);
  });

  it('returns trades newest first', () => {
    const rows = tradeEvents(db, { limit: 50 }).map((e) => e.occurredAt);
    expect([...rows].sort().reverse()).toEqual(rows);
  });
});

describe('the point of all this: trade-then-award now fires on congressional trades', () => {
  it('links an imported disclosure to a later award to the same company', () => {
    // An award to the company the member bought into, 20 days after the trade.
    upsertSource(db, {
      id: 'awards', name: 'USASpending', kind: 'usaspending',
      url: 'https://api.usaspending.gov', tier: 'primary', domains: ['defense'],
      origin: 'US', intervalMinutes: 1440, verified: true, enabled: true,
    } satisfies Source);
    const awardItem: Item = {
      id: 'award-1', sourceId: 'awards', externalId: 'award-1',
      url: 'https://api.usaspending.gov/award/1', title: 'Army awards Meridian Aerospace',
      summary: null, body: null, author: null,
      publishedAt: '2026-06-22T12:00:00.000Z', fetchedAt: '2026-06-22T12:00:00.000Z',
      raw: null, extractedAt: '2026-06-22T12:00:00.000Z', extractionError: null,
    };
    insertItem(db, awardItem);

    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    const company = findEntityByTicker(db, 'MRDN')!;

    const award: Event = {
      id: 'award-ev-1', itemId: 'award-1', type: 'government-award',
      summary: 'The US Army awarded Meridian Aerospace Corp a sustainment contract.',
      occurredAt: '2026-06-22T12:00:00.000Z', occurredAtInferred: false,
      domains: ['defense'],
      entities: [{ entityId: company.id, role: 'beneficiary', surfaceForm: 'Meridian Aerospace' }],
      amount: { value: 412_000_000, currency: 'USD' }, tags: [],
      assertion: 'documented', createdAt: '2026-06-22T12:00:00.000Z',
    };
    insertEvent(db, award);

    const found = runAllPairRules(db, '2026-01-01T00:00:00.000Z')
      .filter((c) => c.producedBy === 'trade-then-award');

    expect(found.length).toBeGreaterThan(0);
    const link = found[0]!;
    expect(link.basis).toBe('deterministic');
    expect(link.explanation).toContain('Meridian Aerospace');
    expect(link.lagDays).toBe(20);
    expect(link.falsifier).not.toBeNull();
    expect(link.sharedEntityIds).toContain(company.id);
  });

  it('finds nothing when the member never traded the company that won', () => {
    upsertSource(db, {
      id: 'awards', name: 'USASpending', kind: 'usaspending',
      url: 'https://api.usaspending.gov', tier: 'primary', domains: ['defense'],
      origin: 'US', intervalMinutes: 1440, verified: true, enabled: true,
    } satisfies Source);
    insertItem(db, {
      id: 'award-2', sourceId: 'awards', externalId: 'award-2',
      url: 'https://api.usaspending.gov/award/2', title: 'Award',
      summary: null, body: null, author: null,
      publishedAt: '2026-06-22T12:00:00.000Z', fetchedAt: '2026-06-22T12:00:00.000Z',
      raw: null, extractedAt: '2026-06-22T12:00:00.000Z', extractionError: null,
    });
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    const other = resolveEntity(db, { name: 'Unrelated Systems Inc', kind: 'company' });
    insertEvent(db, {
      id: 'award-ev-2', itemId: 'award-2', type: 'government-award',
      summary: 'An award to a company nobody disclosed a position in.',
      occurredAt: '2026-06-22T12:00:00.000Z', occurredAtInferred: false,
      domains: ['defense'],
      entities: [{ entityId: other.id, role: 'beneficiary', surfaceForm: 'Unrelated Systems' }],
      amount: null, tags: [], assertion: 'documented',
      createdAt: '2026-06-22T12:00:00.000Z',
    });

    const found = runAllPairRules(db, '2026-01-01T00:00:00.000Z')
      .filter((c) => c.producedBy === 'trade-then-award');
    expect(found).toHaveLength(0);
  });
});

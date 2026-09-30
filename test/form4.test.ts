import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import { openDb, type DB } from '../src/core/db.js';
import {
  eventsForItem, insertItem, itemsAwaitingTriage, upsertSource,
} from '../src/core/store.js';
import type { Source } from '../src/core/types.js';
import { runAllPairRules } from '../src/pipeline/detectors/deterministic.js';
import { writeRecordEvents } from '../src/pipeline/records.js';
import {
  accessionFromUrl, fetchForm4, form4Item, form4Title, ownerName, parseForm4, submissionUrl,
} from '../src/sources/sec-form4.js';
import { parseAwards } from '../src/sources/usaspending.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(join(here, 'fixtures', n), 'utf8');

const SOURCE: Source = {
  id: 'sec-edgar-form4', name: 'SEC Form 4', kind: 'sec-form4',
  url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&output=atom',
  tier: 'primary', domains: ['markets'], origin: 'US', intervalMinutes: 120, verified: true, enabled: true,
};
const ACC = '0001127602-26-031417';
const INDEX = `https://www.sec.gov/Archives/edgar/data/1905511/000112760226031417/${ACC}-index.htm`;

describe('reading a Form 4', () => {
  const f = parseForm4(fixture('form4-submission.txt'), ACC)!;

  it('reads the issuer and the insider, with the name the right way round', () => {
    expect(f.issuer).toEqual({ cik: '0001771234', name: 'Meridian Aerospace Corp', ticker: 'MRDN' });
    expect(f.owners).toHaveLength(1);
    expect(f.owners[0]).toMatchObject({
      filedName: 'WHITFIELD DANA R', name: 'Dana R Whitfield', isCompany: false,
      role: 'Chief Financial Officer, director', isOfficer: true, isDirector: true,
    });
  });

  it('folds a purchase filled in two lots into one trade, with the weighted price', () => {
    const buy = f.trades.find((t) => t.code === 'P')!;
    expect(buy).toMatchObject({ date: '2026-09-24', shares: 10_000, value: 413_000, avgPrice: 41.3, indirect: false });
  });

  it('keeps an indirect sale as a sale, flagged indirect', () => {
    const sale = f.trades.find((t) => t.code === 'S')!;
    expect(sale).toMatchObject({ date: '2026-09-25', shares: 2_500, value: 107_500, indirect: true });
  });

  it('does not treat a grant or an option exercise as a trade, but records that they were there', () => {
    expect(f.trades.map((t) => t.code)).toEqual(['P', 'S']);
    expect(f.otherCodes).toEqual(['A', 'M']);
  });

  it('reads the 10b5-1 box', () => {
    expect(f.tenb51).toBe(false);
    const planned = fixture('form4-submission.txt').replace('<aff10b5One>0</aff10b5One>', '<aff10b5One>1</aff10b5One>');
    expect(parseForm4(planned, ACC)!.tenb51).toBe(true);
  });

  it('skips an amendment, which restates a filing already read', () => {
    const amended = fixture('form4-submission.txt').replace('<documentType>4</documentType>', '<documentType>4/A</documentType>');
    expect(parseForm4(amended, ACC)).toBeNull();
  });

  it('returns null for a submission with no ownership document', () => {
    expect(parseForm4('<SEC-DOCUMENT>nothing here</SEC-DOCUMENT>', ACC)).toBeNull();
  });

  it('titles the filing by what moved', () => {
    expect(form4Title(f)).toBe('Dana R Whitfield (Chief Financial Officer, director) bought $413,000 and sold $107,500 of MRDN');
  });
});

describe('insider names', () => {
  it.each([
    ['WHITFIELD DANA R', 'Dana R Whitfield', false],
    ['Musk Elon', 'Elon Musk', false],
    ['SMITH JOHN R JR', 'John R Smith Jr', false],
    ['McDonald Ronald', 'Ronald McDonald', false],
    ['BERKSHIRE HATHAWAY INC', 'Berkshire Hathaway Inc', true],
    ['Vanguard Capital Partners LP', 'Vanguard Capital Partners LP', true],
  ])('%s', (filed, name, isCompany) => {
    expect(ownerName(filed)).toEqual({ name, isCompany });
  });
});

describe('EDGAR URLs', () => {
  it('reads the accession number from an index page', () => {
    expect(accessionFromUrl(INDEX)).toBe(ACC);
  });
  it('finds the full submission next to the index', () => {
    expect(submissionUrl(INDEX)).toBe(`https://www.sec.gov/Archives/edgar/data/1905511/000112760226031417/${ACC}.txt`);
  });
});

describe('fetching', () => {
  const cfg = loadConfig({ hostDelayMs: 0 });
  let requested: string[];

  beforeEach(() => {
    requested = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      const body = url.endsWith('.txt') ? fixture('form4-submission.txt') : fixture('form4-feed.atom');
      return new Response(body, { status: 200 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads each filing once, skipping the duplicate entry and the amendment', async () => {
    const items = await fetchForm4(SOURCE, cfg);
    expect(items).toHaveLength(1);
    expect(items[0]!.externalId).toBe(ACC);
    expect(requested.filter((u) => u.endsWith('.txt'))).toEqual([submissionUrl(INDEX)]);
  });

  it('does not fetch a filing already on file', async () => {
    const items = await fetchForm4(SOURCE, cfg, { isKnown: (acc) => acc === ACC });
    expect(items).toHaveLength(0);
    expect(requested.filter((u) => u.endsWith('.txt'))).toHaveLength(0);
  });
});

describe('insider trades become events without a model', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    upsertSource(db, SOURCE);
  });

  function ingest(): string {
    const item = form4Item(parseForm4(fixture('form4-submission.txt'), ACC)!, SOURCE, INDEX, '2026-09-29T20:15:02.000Z');
    insertItem(db, item);
    writeRecordEvents(db, item, 'sec-form4');
    return item.id;
  }

  it('writes one documented trade event per day and direction', () => {
    const events = eventsForItem(db, ingest());
    expect(events).toHaveLength(2);
    const buy = events.find((e) => e.tags.includes('code:P'))!;
    expect(buy.type).toBe('securities-trade');
    expect(buy.assertion).toBe('documented');
    expect(buy.occurredAt).toBe('2026-09-24T12:00:00.000Z');
    expect(buy.amount).toEqual({ value: 413_000, currency: 'USD' });
    expect(buy.summary).toBe(
      'Dana R Whitfield (Chief Financial Officer, director) bought 10,000 shares of Meridian Aerospace Corp (MRDN) at about $41.30, $413,000 in all.',
    );
    expect(buy.tags).toEqual(expect.arrayContaining(['form-4', 'insider-trade', 'officer', 'director', 'MRDN']));
    expect(buy.entities.map((e) => e.role).sort()).toEqual(['actor', 'target']);
  });

  it('never sends the filing to triage', () => {
    ingest();
    expect(itemsAwaitingTriage(db, 100)).toHaveLength(0);
  });

  it('joins an insider purchase to a later contract to the same company', () => {
    ingest();
    const awards: Source = { ...SOURCE, id: 'usaspending-awards', kind: 'usaspending' };
    upsertSource(db, awards);
    for (const it of parseAwards({ results: [{
      'Award ID': 'W58RGZ-26-C-0099', 'Recipient Name': 'MERIDIAN AEROSPACE CORP',
      'Award Amount': 250_000_000, 'Awarding Agency': 'Department of Defense',
      'Awarding Sub Agency': 'Department of the Army', 'Base Obligation Date': '2026-10-09',
    }] }, awards)) {
      insertItem(db, it);
      writeRecordEvents(db, it, 'usaspending');
    }
    const links = runAllPairRules(db, '2026-01-01T00:00:00.000Z')
      .filter((c) => c.producedBy === 'trade-then-award');
    // The purchase 15 days before, and the sale the day after it, 14 days before.
    expect(links.map((l) => l.lagDays).sort()).toEqual([14, 15]);
  });
});

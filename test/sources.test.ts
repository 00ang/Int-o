import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFeed } from '../src/sources/rss.js';
import { parseEdgarFeed, parseEdgarTitle } from '../src/sources/sec-edgar.js';
import { parseFederalRegister } from '../src/sources/federal-register.js';
import { parseAwards } from '../src/sources/usaspending.js';
import { parseDisclosureIndex, readZipEntry } from '../src/sources/stock-act.js';
import { parseKalshi, parsePolymarket } from '../src/sources/prediction-markets.js';
import type { Source } from '../src/core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(join(here, 'fixtures', n), 'utf8');

const src = (over: Partial<Source> = {}): Source => ({
  id: 'test-source', name: 'Test', kind: 'rss', url: 'https://example.org/feed',
  tier: 'wire', domains: ['politics'], origin: 'US', intervalMinutes: 60,
  verified: true, enabled: true, ...over,
});

describe('RSS parsing', () => {
  const items = parseFeed(fixture('rss2.xml'), src());

  it('extracts items and collapses duplicate guids', () => {
    // Three <item> elements, two distinct guids.
    expect(items).toHaveLength(2);
  });

  it('strips markup from descriptions', () => {
    expect(items[0]!.summary).toBe('The Treasury Department designated three firms.');
  });

  it('prefers content:encoded as the body when it adds detail', () => {
    expect(items[0]!.body).toContain('freeze US assets');
  });

  it('leaves body null when the feed carries only a summary', () => {
    expect(items[1]!.body).toBeNull();
  });

  it('parses dates to ISO instants', () => {
    expect(items[0]!.publishedAt).toBe('2026-08-27T09:14:00.000Z');
  });

  it('captures the author', () => {
    expect(items[0]!.author).toBe('A. Reporter');
  });

  it('is idempotent: the same feed yields the same ids', () => {
    expect(parseFeed(fixture('rss2.xml'), src()).map((i) => i.id))
      .toEqual(items.map((i) => i.id));
  });
});

describe('Atom parsing', () => {
  it('resolves rel=alternate hrefs rather than link objects', () => {
    const items = parseFeed(fixture('atom.xml'), src({ kind: 'sec-edgar' }));
    expect(items).toHaveLength(2);
    expect(items[0]!.url).toContain('sec.gov/Archives');
  });
});

describe('EDGAR title parsing', () => {
  it('pulls form type, filer and zero-padded CIK', () => {
    expect(parseEdgarTitle('4 - SMITH JANE Q (0001234567) (Reporting)')).toEqual({
      formType: '4', filerName: 'SMITH JANE Q', cik: '0001234567', filerRole: 'Reporting',
    });
  });

  it('pads short CIKs to ten digits so joins line up', () => {
    expect(parseEdgarTitle('8-K - ACME CORP (998877) (Filer)').cik).toBe('0000998877');
  });

  it('degrades gracefully on an unexpected title', () => {
    expect(parseEdgarTitle('something else entirely').formType).toBeNull();
  });

  it('surfaces parsed identity in the body for extraction', () => {
    const items = parseEdgarFeed(fixture('atom.xml'), src({ kind: 'sec-edgar' }));
    expect(items[1]!.body).toContain('VERTEX DEFENSE SYSTEMS INC');
    expect(items[1]!.body).toContain('CIK: 0000998877');
  });
});

describe('Federal Register parsing', () => {
  const payload = {
    results: [{
      document_number: '2026-18422',
      title: 'Beef Import Tariff-Rate Quota Adjustment',
      abstract: 'This rule adjusts the tariff-rate quota for imported beef.',
      publication_date: '2026-08-25',
      html_url: 'https://www.federalregister.gov/d/2026-18422',
      type: 'Rule',
      agencies: [{ name: 'Agricultural Marketing Service' }],
      significant: true,
      effective_on: '2026-09-15',
    }],
  };

  it('maps documents and folds structure into the body', () => {
    const items = parseFederalRegister(payload, src({ kind: 'federal-register' }));
    expect(items).toHaveLength(1);
    expect(items[0]!.externalId).toBe('2026-18422');
    expect(items[0]!.body).toContain('Issuing agency: Agricultural Marketing Service');
    expect(items[0]!.body).toContain('Effective: 2026-09-15');
    expect(items[0]!.body).toContain('significant');
  });

  it('preserves the raw payload for later re-parsing', () => {
    const items = parseFederalRegister(payload, src({ kind: 'federal-register' }));
    expect(items[0]!.raw).toMatchObject({ document_number: '2026-18422' });
  });
});

describe('USASpending award parsing', () => {
  it('renders an award into a titled item with the amount', () => {
    const items = parseAwards({
      results: [{
        'Award ID': 'W58RGZ-26-C-0042',
        generated_internal_id: 'CONT_AWD_1',
        'Recipient Name': 'VERTEX DEFENSE SYSTEMS INC',
        'Award Amount': 412_000_000,
        'Awarding Agency': 'Department of Defense',
        'Awarding Sub Agency': 'Department of the Army',
        'Start Date': '2026-08-26',
        Description: 'Rotary wing sustainment',
        'Contract Award Type': 'Definitive Contract',
      }],
    }, src({ kind: 'usaspending' }));

    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('VERTEX DEFENSE SYSTEMS INC');
    expect(items[0]!.title).toContain('412,000,000');
    expect(items[0]!.url).toBe('https://www.usaspending.gov/award/CONT_AWD_1');
  });

  it('skips rows missing a recipient or award id', () => {
    expect(parseAwards({ results: [{ 'Award Amount': 1 }] }, src())).toHaveLength(0);
  });
});

describe('STOCK Act disclosure index', () => {
  const INDEX = [
    'Prefix\tLast\tFirst\tSuffix\tFilingType\tStateDst\tYear\tFilingDate\tDocID',
    'Hon.\tDoe\tJane\t\tP\tCA12\t2026\t8/24/2026\t20260001',
    '\tRoe\tRichard\t\tO\tTX07\t2026\t8/20/2026\t20260002',
  ].join('\n');

  it('parses tab-delimited rows', () => {
    const rows = parseDisclosureIndex(INDEX);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ last: 'Doe', filingType: 'P', docId: '20260001' });
  });

  it('returns nothing for a header-only file', () => {
    expect(parseDisclosureIndex('a\tb\tc')).toHaveLength(0);
  });
});

describe('minimal ZIP reader', () => {
  it('reads a deflated entry back out of a real archive', async () => {
    // Build a genuine zip with node's own deflate so the test exercises the
    // same code path the House endpoint will.
    const { deflateRawSync, crc32 } = await import('node:zlib');
    const name = Buffer.from('2026FD.txt');
    const content = Buffer.from('Prefix\tLast\nHon.\tDoe\n');
    const deflated = deflateRawSync(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(typeof crc32 === 'function' ? crc32(content) : 0, 14);
    header.writeUInt32LE(deflated.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    const zip = Buffer.concat([header, name, deflated]);
    const out = readZipEntry(zip, (n) => n.endsWith('.txt'));
    expect(out?.toString('utf8')).toBe(content.toString('utf8'));
  });

  it('returns null when no entry matches', () => {
    expect(readZipEntry(Buffer.from('not a zip at all'), () => true)).toBeNull();
  });
});

describe('prediction market parsing', () => {
  it('decodes Polymarket JSON-encoded outcome prices', () => {
    const snaps = parsePolymarket([
      { id: '1', question: 'Will X happen?', outcomePrices: '["0.62","0.38"]', slug: 'x', volumeNum: 1000 },
    ]);
    expect(snaps[0]!.probability).toBeCloseTo(0.62);
    expect(snaps[0]!.url).toBe('https://polymarket.com/event/x');
  });

  it('leaves probability null rather than guessing on malformed prices', () => {
    const snaps = parsePolymarket([{ id: '2', question: 'Q', outcomePrices: 'not json' }]);
    expect(snaps[0]!.probability).toBeNull();
  });

  it('normalises Kalshi cents to a probability', () => {
    const snaps = parseKalshi({ markets: [{ ticker: 'T', title: 'Q', last_price: 47 }] });
    expect(snaps[0]!.probability).toBeCloseTo(0.47);
  });
});

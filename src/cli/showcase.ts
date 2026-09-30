import type { DB } from '../core/db.js';
import { buildGraph } from '../core/graph.js';
import { insertConnection, insertItem, saveTriage, upsertSource } from '../core/store.js';
import type { Item, Source } from '../core/types.js';
import { runAllPairRules } from '../pipeline/detectors/deterministic.js';
import { importTrades, type TradeRecord } from '../pipeline/import-trades.js';
import { writeRecordEvents } from '../pipeline/records.js';
import { lobbyingItem, parseLobbyingFiling } from '../sources/lobbying.js';
import { form4Item, type Form4Filing } from '../sources/sec-form4.js';
import { parseAwards } from '../sources/usaspending.js';
import { seedDemo } from './demo.js';

/**
 * A corpus to click around in: `all-int web --demo`.
 *
 * Everything the web app shows, with nothing fetched and nothing billed: a
 * reading queue with angles, insider trades, a congressional trade filed late,
 * lobbying with a former Senate staffer among the lobbyists, new contracts, and
 * the connections the detectors find between them. The records go through the
 * same parsers and event writers the live sources use, so what this shows is
 * what a real ingest produces.
 *
 * EVERY NAME HERE IS INVENTED. Companies, people, firms and tickers are
 * fictional so that nothing on screen can be mistaken for a claim about anyone.
 */

const day = (offset: number): Date => new Date(Date.now() + offset * 86_400_000);
const iso = (offset: number) => day(offset).toISOString();
const ymd = (offset: number) => iso(offset).slice(0, 10);

const demoSource = (id: string, name: string, kind: Source['kind'], tier: Source['tier'] = 'primary'): Source => ({
  id, name, kind, url: `https://example.invalid/${id}`, tier, domains: ['politics'], origin: 'US',
  intervalMinutes: 1440, verified: false, enabled: false, notes: 'Synthetic demo source.',
});

function newsItem(id: string, title: string, offset: number): Item {
  return {
    id, sourceId: 'demo-wire', externalId: id, url: `https://example.invalid/${id}`,
    title, summary: title, body: null, author: null, publishedAt: iso(offset),
    fetchedAt: iso(0), raw: null, extractedAt: null, extractionError: null,
    triagedAt: null, triageVerdict: null, triageTopic: null, triageReason: null, triageAngle: null,
  };
}

function form4(accession: string, f: Omit<Form4Filing, 'accession' | 'periodOfReport' | 'otherCodes'>): Form4Filing {
  return { accession, periodOfReport: f.trades[0]?.date ?? null, otherCodes: [], ...f };
}

function insider(name: string, role: string, isDirector = false) {
  return {
    cik: null, filedName: name.split(' ').reverse().join(' ').toUpperCase(), name, isCompany: false,
    role, isDirector, isOfficer: !isDirector, isTenPercentOwner: false,
  };
}

/** The quarter that began at least two months ago, so its lobbying precedes the demo's awards. */
function reportingQuarter(): { year: number; q: 1 | 2 | 3 | 4; period: string } {
  const d = day(-60);
  const q = (Math.floor(d.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  return { year: d.getUTCFullYear(), q, period: ['first', 'second', 'third', 'fourth'][q - 1] + '_quarter' };
}

export function seedShowcase(db: DB): { items: number; events: number; connections: number } {
  seedDemo(db);

  const form4Src = demoSource('demo-form4', 'SEC Form 4 (demo)', 'sec-form4');
  const ldaSrc = demoSource('demo-lda', 'Senate lobbying disclosures (demo)', 'lobbying');
  const awardSrc = demoSource('demo-usaspending', 'USASpending awards (demo)', 'usaspending');
  for (const s of [form4Src, ldaSrc, awardSrc]) upsertSource(db, s);

  const record = (item: Item, kind: string) => {
    if (insertItem(db, item)) writeRecordEvents(db, item, kind);
  };

  // --- Insider trades ------------------------------------------------------
  const filings: Array<[Form4Filing, number]> = [
    [form4('0009999901-26-000101', {
      issuer: { cik: null, name: 'Meridian Aerospace Corp', ticker: 'MRDN' },
      owners: [insider('Priya Raman', 'Chief Executive Officer')],
      tenb51: false,
      trades: [{ date: ymd(-16), code: 'P', shares: 20_000, value: 764_000, avgPrice: 38.2, security: 'Common Stock', indirect: false }],
    }), -14],
    [form4('0009999901-26-000102', {
      issuer: { cik: null, name: 'Cattleman United Processing', ticker: 'CTLU' },
      owners: [insider('Marisol Ortega', 'Chief Financial Officer')],
      tenb51: false,
      trades: [{ date: ymd(-33), code: 'P', shares: 8_000, value: 432_800, avgPrice: 54.1, security: 'Common Stock', indirect: false }],
    }), -31],
    [form4('0009999901-26-000103', {
      issuer: { cik: null, name: 'Helix Dynamics, Inc.', ticker: 'HLXD' },
      owners: [insider('Owen Castellanos', 'director', true)],
      tenb51: true,
      trades: [{ date: ymd(-6), code: 'S', shares: 50_000, value: 6_100_000, avgPrice: 122, security: 'Common Stock', indirect: false }],
    }), -4],
  ];
  for (const [f, filed] of filings) {
    record(form4Item(f, form4Src, `https://example.invalid/form4/${f.accession}`, iso(filed)), 'sec-form4');
  }

  // --- Lobbying ------------------------------------------------------------
  const rq = reportingQuarter();
  const lobbying: Record<string, unknown>[] = [
    {
      filing_uuid: 'demo-lda-0001', filing_document_url: 'https://example.invalid/lda/demo-lda-0001', filing_type: `Q${rq.q}`, filing_year: rq.year, filing_period: rq.period,
      filing_period_display: `Q${rq.q} ${rq.year}`, income: '120000.00', dt_posted: iso(-2),
      registrant: { name: 'Capitol Bridge Strategies LLC' },
      client: { name: 'Meridian Aerospace Corp', general_description: 'Rotorcraft sustainment' },
      lobbying_activities: [{
        general_issue_code: 'DEF', general_issue_code_display: 'Defense',
        description: 'Rotary wing sustainment provisions in the annual defense authorization bill',
        lobbyists: [
          { lobbyist: { first_name: 'Carla', last_name: 'Nguyen' }, covered_position: 'Chief of Staff, Sen. Harold Pike' },
          { lobbyist: { first_name: 'Tom', last_name: 'Baker' }, covered_position: 'N/A' },
        ],
        government_entities: [{ name: 'SENATE' }, { name: 'Defense - Dept of (DOD)' }, { name: 'Army - Dept of the' }],
      }],
    },
    {
      filing_uuid: 'demo-lda-0002', filing_document_url: 'https://example.invalid/lda/demo-lda-0002', filing_type: `Q${rq.q}`, filing_year: rq.year, filing_period: rq.period,
      income: null, expenses: '640000.00', dt_posted: iso(-3),
      registrant: { name: 'Cattleman United Processing' },
      client: { name: 'Cattleman United Processing', general_description: 'Beef processing' },
      lobbying_activities: [{
        general_issue_code: 'AGR', general_issue_code_display: 'Agriculture',
        description: 'Tariff-rate quota for imported beef; USDA market access rules',
        lobbyists: [{ lobbyist: { first_name: 'Hank', last_name: 'Duval' }, covered_position: 'Deputy Under Secretary, USDA Marketing and Regulatory Programs' }],
        government_entities: [{ name: 'Agriculture - Dept of (USDA)' }, { name: 'HOUSE OF REPRESENTATIVES' }],
      }],
    },
    {
      filing_uuid: 'demo-lda-0003', filing_document_url: 'https://example.invalid/lda/demo-lda-0003', filing_type: 'RR', filing_year: day(0).getUTCFullYear(), dt_posted: iso(-1),
      registrant: { name: 'Keystone Policy Group LLC' },
      client: { name: 'Helix Dynamics, Inc.', general_description: 'Semiconductors' },
      lobbying_activities: [{
        general_issue_code: 'TRD', general_issue_code_display: 'Trade (Domestic & Foreign)',
        description: 'Export controls on radiation-hardened semiconductors',
        lobbyists: [], government_entities: [{ name: 'Commerce - Dept of (DOC)' }],
      }],
    },
  ];
  for (const raw of lobbying) {
    const f = parseLobbyingFiling(raw);
    if (f) record(lobbyingItem(f, ldaSrc, iso(0)), 'lobbying');
  }

  // --- Contracts -----------------------------------------------------------
  const awards = parseAwards({ results: [
    {
      'Award ID': 'N00019-26-C-DEMO1', generated_internal_id: 'DEMO_AWD_1', 'Recipient Name': 'MERIDIAN AEROSPACE CORP',
      'Award Amount': 97_500_000, 'Awarding Agency': 'Department of Defense', 'Awarding Sub Agency': 'Department of the Navy',
      'Base Obligation Date': ymd(-3), Description: 'MH-60 DEPOT SUSTAINMENT', 'Contract Award Type': 'Definitive Contract',
    },
    {
      'Award ID': 'HQ0147-26-C-DEMO2', generated_internal_id: 'DEMO_AWD_2', 'Recipient Name': 'HELIX DYNAMICS INC',
      'Award Amount': 45_000_000, 'Awarding Agency': 'Department of Defense', 'Awarding Sub Agency': 'Missile Defense Agency',
      'Base Obligation Date': ymd(-2), Description: 'RADIATION-HARDENED PROCESSORS', 'Contract Award Type': 'Definitive Contract',
    },
  ] }, awardSrc, iso(0));
  for (const a of awards) record({ ...a, url: `https://example.invalid/award/${a.externalId}` }, 'usaspending');

  // --- Congressional trades ------------------------------------------------
  const congress: TradeRecord[] = [
    {
      filer: 'Marcus Reyes', chamber: 'house', district: 'OH03', ticker: 'MRDN', assetName: 'Meridian Aerospace Corp',
      assetType: 'Stock', action: 'purchase', rawAction: 'P', transactedAt: iso(-25), disclosedAt: iso(-2),
      disclosureLagDays: 23, amount: { min: 15_001, max: 50_000 }, owner: 'self',
    } as TradeRecord,
    {
      filer: 'Alicia Brandt', chamber: 'senate', district: null, ticker: 'HLXD', assetName: 'Helix Dynamics, Inc.',
      assetType: 'Stock', action: 'sale', rawAction: 'S', transactedAt: iso(-80), disclosedAt: iso(-10),
      disclosureLagDays: 70, amount: { min: 50_001, max: 100_000 }, owner: 'spouse',
    } as TradeRecord,
  ];
  importTrades(db, congress, { now: day(0) });

  // --- News, as triage would leave it --------------------------------------
  const news: Array<[Item, 'notable' | 'worth-a-look', string, string, string]> = [
    [newsItem('demo-n1', 'Senate panel advances rotorcraft sustainment language in defense bill', -12),
      'worth-a-look', 'Rotorcraft provision in the defense bill',
      'A narrow provision whose beneficiaries the piece does not name.',
      'Which contractors’ lobbyists worked the provision, and who on the committee staff they used to work for'],
    [newsItem('demo-n2', 'Chipmaker director sells $6.1M in stock days before missile-defense award', -1),
      'notable', 'Director sale ahead of a defense award',
      'The sale is reported as planned; the timing against the award is what the piece does not address.',
      'When the 10b5-1 plan was adopted, relative to when the award was first expected'],
  ];
  for (const [item, verdict, topic, reason, angle] of news) {
    if (insertItem(db, item)) saveTriage(db, item.id, verdict, topic, reason, angle);
  }
  // The two news items the base demo seeds, given the verdicts triage would give them.
  saveTriage(db, 'demo-i2', 'notable', 'Army contract lands weeks after insider buying',
    'Two insiders and a member of Congress bought in before the award; the release mentions none of it.',
    'When the Army opened the solicitation, relative to the first purchase');
  saveTriage(db, 'demo-i3', 'worth-a-look', 'Beef import quota raised',
    'A rule presented as consumer relief whose named gainers are domestic processors.',
    'Which processors asked USDA for the change, and when');
  saveTriage(db, 'demo-i1', 'mundane', 'structured record',
    'A dataset row rather than a news item; consumed directly by the detectors.', null);
  saveTriage(db, 'demo-i4', 'worth-a-look', 'Record margin after a beef quota change',
    'The margin follows a rule that eased this processor’s input costs.',
    'Whether Cattleman United lobbied USDA on the quota before the rule');

  // --- Connections and the map ---------------------------------------------
  const found = runAllPairRules(db, iso(-400));
  for (const c of found) insertConnection(db, c);
  buildGraph(db);

  const n = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    items: n('SELECT COUNT(*) AS c FROM items'),
    events: n('SELECT COUNT(*) AS c FROM events'),
    connections: found.length,
  };
}

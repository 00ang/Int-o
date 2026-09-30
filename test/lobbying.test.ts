import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import { openDb, type DB } from '../src/core/db.js';
import {
  eventsForItem, insertEvent, insertItem, itemsAwaitingTriage, resolveEntity, upsertSource,
} from '../src/core/store.js';
import type { Source } from '../src/core/types.js';
import { runAllPairRules } from '../src/pipeline/detectors/deterministic.js';
import { partyKind, writeRecordEvents } from '../src/pipeline/records.js';
import {
  agencyName, buildLobbyingQuery, fetchLobbying, keepFromPage, lobbyingDate, lobbyingItem,
  parseLobbyingFiling, revolvingDoor, targetsOf,
} from '../src/sources/lobbying.js';
import { parseAwards } from '../src/sources/usaspending.js';

const here = dirname(fileURLToPath(import.meta.url));
const page = JSON.parse(readFileSync(join(here, 'fixtures', 'lda-filings.json'), 'utf8')) as {
  results: Record<string, unknown>[];
};
const SINCE = '2026-09-25T00:00:00.000Z';

const SOURCE: Source = {
  id: 'senate-lda', name: 'Senate LDA', kind: 'lobbying', url: 'https://lda.senate.gov/api/v1/filings/',
  tier: 'primary', domains: ['politics'], origin: 'US', intervalMinutes: 720, verified: true, enabled: true,
};

const firmReport = () => parseLobbyingFiling(page.results[0]!)!;

describe('reading a filing', () => {
  it('reads the client, the firm, the money and the period', () => {
    expect(firmReport()).toMatchObject({
      filingType: 'Q3', filingYear: 2026, income: 120_000, expenses: null,
      client: 'MERIDIAN AEROSPACE CORP', registrant: 'CAPITOL BRIDGE STRATEGIES LLC', inHouse: false,
    });
  });

  it('reads an in-house filing, where the organisation lobbies for itself', () => {
    expect(parseLobbyingFiling(page.results[1]!)).toMatchObject({ inHouse: true, expenses: 3_450_000 });
  });

  it('finds the revolving door once, ignoring "N/A" in the field', () => {
    expect(revolvingDoor(firmReport())).toEqual([
      { name: 'Carla Nguyen', coveredPosition: 'Chief of Staff, Sen. Harold Pike (2019-2024)' },
    ]);
  });

  it('names agencies the way award records do, and sets the two chambers aside', () => {
    expect(targetsOf(firmReport())).toEqual({
      agencies: ['Department of Defense', 'Department of the Army'], congress: true,
    });
    expect(agencyName('Commerce - Dept of (DOC)')).toBe('Department of Commerce');
    expect(agencyName('Federal Communications Commission (FCC)')).toBe('Federal Communications Commission (FCC)');
  });

  it('dates a quarterly report by the start of its quarter, and a registration by posting', () => {
    expect(lobbyingDate(firmReport())).toBe('2026-07-01T12:00:00.000Z');
    expect(lobbyingDate(parseLobbyingFiling(page.results[4]!)!).slice(0, 10)).toBe('2026-09-27');
  });

  it('drops an amendment, which restates a filing already read', () => {
    expect(parseLobbyingFiling(page.results[3]!)).toBeNull();
  });
});

describe('every filter is applied again, because the API ignores ones it does not know', () => {
  it('keeps reports in the window above the floor, and nothing else', () => {
    const { filings, pastWindow } = keepFromPage(page.results, SINCE, 'report');
    expect(filings.map((f) => f.client)).toEqual(['MERIDIAN AEROSPACE CORP', 'HELIX DYNAMICS, INC.']);
    // The July filing is older than the window, which is where reading stops.
    expect(pastWindow).toBe(true);
  });

  it('keeps only registrations from the registration query', () => {
    const { filings } = keepFromPage(page.results, SINCE, 'registration');
    expect(filings.map((f) => f.filingType)).toEqual(['RR']);
  });

  it('asks for the right things', () => {
    const report = new URL(buildLobbyingQuery('2026-09-25', 'report'));
    expect(report.searchParams.get('filing_dt_posted_after')).toBe('2026-09-25');
    expect(report.searchParams.get('ordering')).toBe('-dt_posted');
    expect(report.searchParams.get('filing_amount_reported_min')).toBe('20000');
    expect(new URL(buildLobbyingQuery('2026-09-25', 'registration')).searchParams.get('filing_type')).toBe('RR');
  });
});

describe('fetching', () => {
  const requests: Array<{ url: string; auth: string | null }> = [];
  beforeEach(() => {
    requests.length = 0;
    vi.useFakeTimers({ now: new Date('2026-09-29T18:00:00Z'), toFake: ['Date'] });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization ?? null });
      return new Response(JSON.stringify(page), { status: 200 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('reads reports and registrations, stopping where the window ends', async () => {
    const items = await fetchLobbying(SOURCE, loadConfig({ hostDelayMs: 0, ldaApiKey: null }), { spacingMs: 0 });
    // One page per query: each reached past the window, so neither followed `next`.
    expect(requests).toHaveLength(2);
    expect(items.map((i) => i.title).sort()).toEqual([
      'CAPITOL BRIDGE STRATEGIES LLC registered to lobby for NATIONAL ASSOCIATION OF ROTORCRAFT OPERATORS',
      'HELIX DYNAMICS, INC. spent $3,450,000 lobbying, Q3 2026',
      'MERIDIAN AEROSPACE CORP paid CAPITOL BRIDGE STRATEGIES LLC $120,000 to lobby, Q3 2026',
    ]);
  });

  it('sends the key when there is one', async () => {
    await fetchLobbying(SOURCE, loadConfig({ hostDelayMs: 0, ldaApiKey: 'k123' }), { spacingMs: 0 });
    expect(requests.every((r) => r.auth === 'Token k123')).toBe(true);
  });
});

describe('lobbying becomes events without a model', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    upsertSource(db, SOURCE);
  });

  function ingest(i: number): string {
    const item = lobbyingItem(parseLobbyingFiling(page.results[i]!)!, SOURCE, '2026-09-29T18:00:00.000Z');
    insertItem(db, item);
    writeRecordEvents(db, item, 'lobbying');
    return item.id;
  }

  it('writes one documented lobbying event naming the money, the agencies and the revolving door', () => {
    const [event] = eventsForItem(db, ingest(0));
    expect(event!.type).toBe('lobbying');
    expect(event!.assertion).toBe('documented');
    expect(event!.amount).toEqual({ value: 120_000, currency: 'USD' });
    expect(event!.summary).toBe(
      'MERIDIAN AEROSPACE CORP paid CAPITOL BRIDGE STRATEGIES LLC $120,000 to lobby Congress, ' +
      'Department of Defense and Department of the Army in Q3 2026 on H.R. 8070, National Defense ' +
      'Authorization Act for FY2027, provisions on rotary wing sustainment contracting; its lobbyists ' +
      'include Carla Nguyen, formerly Chief of Staff, Sen. Harold Pike (2019-2024).',
    );
    expect(event!.tags).toEqual(expect.arrayContaining(['lda', 'lobbying-report', 'revolving-door', 'issue:DEF']));
    expect(event!.domains).toContain('defense');
    const roles = event!.entities.map((e) => e.role).sort();
    // Client, firm, two agencies, one former official.
    expect(roles).toEqual(['actor', 'actor', 'beneficiary', 'target', 'target']);
  });

  it('writes an in-house filing with no firm', () => {
    const [event] = eventsForItem(db, ingest(1));
    expect(event!.summary).toMatch(/^HELIX DYNAMICS, INC\. spent \$3,450,000 lobbying Department of Commerce in Q3 2026 on export controls/);
    expect(event!.tags).toContain('in-house');
  });

  it('never sends the filing to triage', () => {
    ingest(0);
    expect(itemsAwaitingTriage(db, 100)).toHaveLength(0);
  });

  it('tells a company from an association', () => {
    expect(partyKind('MERIDIAN AEROSPACE CORP')).toBe('company');
    expect(partyKind('CAPITOL BRIDGE STRATEGIES LLC')).toBe('company');
    expect(partyKind('NATIONAL ASSOCIATION OF ROTORCRAFT OPERATORS')).toBe('organization');
  });

  it('links lobbying to a later contract to the client', () => {
    ingest(0);
    const awards: Source = { ...SOURCE, id: 'usaspending-awards', kind: 'usaspending' };
    upsertSource(db, awards);
    for (const it of parseAwards({ results: [{
      'Award ID': 'W58RGZ-26-C-0101', 'Recipient Name': 'MERIDIAN AEROSPACE CORP',
      'Award Amount': 90_000_000, 'Awarding Agency': 'Department of Defense',
      'Awarding Sub Agency': 'Department of the Army', 'Base Obligation Date': '2026-08-15',
    }] }, awards)) {
      insertItem(db, it);
      writeRecordEvents(db, it, 'usaspending');
    }
    const links = runAllPairRules(db, '2026-01-01T00:00:00.000Z')
      .filter((c) => c.producedBy === 'lobbying-then-award');
    expect(links).toHaveLength(1);
    expect(links[0]!.lagDays).toBe(45);
    expect(links[0]!.explanation).toContain('MERIDIAN AEROSPACE CORP was paying for federal lobbying');
    expect(links[0]!.falsifier).toBeTruthy();
  });

  it('links lobbying to a later policy naming the client as a beneficiary, and not otherwise', () => {
    ingest(0);
    const client = resolveEntity(db, { name: 'MERIDIAN AEROSPACE CORP', kind: 'company' });
    const other = resolveEntity(db, { name: 'Unrelated Rotor Works Inc', kind: 'company' });
    const fr: Source = { ...SOURCE, id: 'federal-register', kind: 'federal-register' };
    upsertSource(db, fr);
    for (const [id, ent] of [['p1', client.id], ['p2', other.id]] as const) {
      insertItem(db, {
        id, sourceId: fr.id, externalId: id, url: 'https://www.federalregister.gov/x', title: 'Rule',
        summary: null, body: null, author: null, publishedAt: '2026-09-01T12:00:00.000Z',
        fetchedAt: '2026-09-01T12:00:00.000Z', raw: null, extractedAt: '2026-09-01T12:00:00.000Z',
        extractionError: null, triagedAt: null, triageVerdict: null, triageTopic: null,
        triageReason: null, triageAngle: null,
      });
      insertEvent(db, {
        id: `ev-${id}`, itemId: id, type: 'policy-action', summary: 'The Army changed a rule.',
        occurredAt: '2026-09-01T12:00:00.000Z', occurredAtInferred: false, domains: ['defense'],
        entities: [{ entityId: ent, role: 'beneficiary', surfaceForm: 'x' }],
        amount: null, tags: [], assertion: 'documented', createdAt: '2026-09-01T12:00:00.000Z',
      });
    }
    const links = runAllPairRules(db, '2026-01-01T00:00:00.000Z')
      .filter((c) => c.producedBy === 'lobbying-then-policy');
    expect(links).toHaveLength(1);
    expect(links[0]!.toEventId).toBe('ev-p1');
  });
});

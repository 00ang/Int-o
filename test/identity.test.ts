import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/core/db.js';
import {
  eventsForEntity, findEntityByTicker, insertEvent, insertItem, resolveEntity, upsertSource,
} from '../src/core/store.js';
import type { Event, Source } from '../src/core/types.js';
import { consolidateCompanies } from '../src/pipeline/consolidate.js';
import { runAllPairRules } from '../src/pipeline/detectors/deterministic.js';
import { importTrades, issuerName, stripSecurityClass } from '../src/pipeline/import-trades.js';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); });

describe('issuer names drop the class of security', () => {
  it.each([
    ['Applied Materials, Inc. - Common Stock (AMAT)', 'Applied Materials, Inc.'],
    ['W.W. Grainger, Inc. Common Stock (GWW)', 'W.W. Grainger, Inc.'],
    ['Alphabet Inc. - Class A Common Stock (GOOGL)', 'Alphabet Inc.'],
    ['Alphabet Inc. Class C', 'Alphabet Inc.'],
    ['Energy Transfer LP Common Units (ET)', 'Energy Transfer LP'],
    ['Shell plc Sponsored ADR', 'Shell plc'],
    ['Taiwan Semiconductor Manufacturing Company Ltd. American Depositary Shares', 'Taiwan Semiconductor Manufacturing Company Ltd.'],
    ['Lockheed Martin Corporation (LMT) [ST]', 'Lockheed Martin Corporation'],
  ])('%s', (raw, clean) => {
    expect(stripSecurityClass(raw)).toBe(clean);
  });

  it('leaves a fund whose name merely contains "Shares" alone', () => {
    expect(stripSecurityClass('iShares Core S&P 500 ETF')).toBe('iShares Core S&P 500 ETF');
  });

  it('falls back to the ticker when nothing is left', () => {
    expect(issuerName({ assetName: 'Common Stock', ticker: 'XYZ' } as never)).toBe('XYZ');
  });
});

describe('companies resolve by ticker', () => {
  it('lands a differently spelled company with the same ticker on one party', () => {
    const a = resolveEntity(db, { name: 'NVIDIA Corporation', kind: 'company', ticker: 'NVDA' });
    const b = resolveEntity(db, { name: 'Nvidia', kind: 'company', ticker: 'nvda' });
    expect(b.id).toBe(a.id);
    expect(b.aliases).toContain('Nvidia');
  });

  it('shows the normal spelling once a source writes one, keeping the capitals as an alias', () => {
    const a = resolveEntity(db, { name: 'LOCKHEED MARTIN CORP', kind: 'company' });
    const b = resolveEntity(db, { name: 'Lockheed Martin', kind: 'company' });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe('Lockheed Martin');
    expect(b.aliases).toContain('LOCKHEED MARTIN CORP');
    // And a later all-caps sighting does not take it back.
    expect(resolveEntity(db, { name: 'LOCKHEED MARTIN CORPORATION', kind: 'company' }).name)
      .toBe('Lockheed Martin');
  });

  it('does not cross kinds on a shared ticker', () => {
    const a = resolveEntity(db, { name: 'NVIDIA Corporation', kind: 'company', ticker: 'NVDA' });
    const b = resolveEntity(db, { name: 'NVDA call options', kind: 'financial-instrument', ticker: 'NVDA' });
    expect(b.id).not.toBe(a.id);
  });
});

const AWARDS: Source = {
  id: 'awards', name: 'USASpending', kind: 'usaspending', url: 'https://api.usaspending.gov',
  tier: 'primary', domains: ['defense'], origin: 'US', intervalMinutes: 1440, verified: true, enabled: true,
};

function awardTo(entityId: string, day: string): void {
  upsertSource(db, AWARDS);
  insertItem(db, {
    id: `award-${day}`, sourceId: 'awards', externalId: `award-${day}`,
    url: 'https://www.usaspending.gov/award/x', title: 'Award', summary: null, body: null, author: null,
    publishedAt: `${day}T12:00:00.000Z`, fetchedAt: `${day}T12:00:00.000Z`, raw: null,
    extractedAt: `${day}T12:00:00.000Z`, extractionError: null,
    triagedAt: null, triageVerdict: null, triageTopic: null, triageReason: null, triageAngle: null,
  });
  const ev: Event = {
    id: `award-ev-${day}`, itemId: `award-${day}`, type: 'government-award',
    summary: 'The Army awarded Applied Materials a contract.',
    occurredAt: `${day}T12:00:00.000Z`, occurredAtInferred: false, domains: ['defense'],
    entities: [{ entityId, role: 'beneficiary', surfaceForm: 'APPLIED MATERIALS INC' }],
    amount: null, tags: [], assertion: 'documented', createdAt: `${day}T12:00:00.000Z`,
  };
  insertEvent(db, ev);
}

describe('entities:merge repairs a corpus split before this fix', () => {
  it('merges a suffixed issuer into the clean company, and the detector then fires', () => {
    // How a PTR trade resolved before: the class of security in the name.
    const split = resolveEntity(db, { name: 'Applied Materials, Inc. - Common Stock', kind: 'company', ticker: 'AMAT' });
    importTrades(db, [{
      filer: 'Dana Whitfield', chamber: 'house', district: 'TX07', ticker: null,
      assetName: 'placeholder', assetType: null, action: 'purchase', rawAction: 'P',
      transactedAt: '2026-06-02T12:00:00.000Z', disclosedAt: '2026-06-20T12:00:00.000Z',
      disclosureLagDays: 18, amount: { min: 1001, max: 15000 }, owner: 'self',
    } as never]);
    // Point that trade at the split party, as the old resolution would have.
    const tradeEvent = db.prepare("SELECT id FROM events WHERE type = 'securities-trade'").get() as { id: string };
    db.prepare("INSERT INTO event_entities (event_id, entity_id, role, surface_form) VALUES (?, ?, 'target', 'AMAT')")
      .run(tradeEvent.id, split.id);

    const clean = resolveEntity(db, { name: 'APPLIED MATERIALS INC', kind: 'company' });
    expect(clean.id).not.toBe(split.id);
    awardTo(clean.id, '2026-06-22');

    const before = runAllPairRules(db, '2026-01-01T00:00:00.000Z')
      .filter((c) => c.producedBy === 'trade-then-award');
    expect(before).toHaveLength(0);

    const r = consolidateCompanies(db);
    expect(r.merged).toHaveLength(1);

    const survivor = findEntityByTicker(db, 'AMAT')!;
    expect(survivor.name).toBe('Applied Materials, Inc.');
    expect(eventsForEntity(db, survivor.id).map((e) => e.type).sort())
      .toEqual(['government-award', 'securities-trade']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM entities WHERE id = ?').get(split.id)).toEqual({ n: 0 });

    const after = runAllPairRules(db, '2026-01-01T00:00:00.000Z')
      .filter((c) => c.producedBy === 'trade-then-award');
    expect(after.length).toBeGreaterThan(0);
  });

  it('renames a suffixed company in place when it has no twin', () => {
    const e = resolveEntity(db, { name: 'STERIS plc - Ordinary Shares', kind: 'company', ticker: 'STE' });
    const r = consolidateCompanies(db);
    expect(r.renamed).toBe(1);
    const row = db.prepare('SELECT name, aliases FROM entities WHERE id = ?').get(e.id) as { name: string; aliases: string };
    expect(row.name).toBe('STERIS plc');
    expect(JSON.parse(row.aliases)).toContain('STERIS plc - Ordinary Shares');
  });

  it('merges two companies that share a ticker', () => {
    // Written directly, the way a corpus from before ticker matching holds them.
    db.prepare(
      `INSERT INTO entities (id, kind, name, slug, aliases, ticker, first_seen_at, last_seen_at, mention_count)
       VALUES ('e1', 'company', 'Alphabet Inc.', 'alphabet', '[]', 'GOOGL', '2026-01-01', '2026-01-01', 5),
              ('e2', 'company', 'Google', 'google', '[]', 'GOOGL', '2026-01-01', '2026-01-02', 2)`,
    ).run();
    const r = consolidateCompanies(db);
    expect(r.merged).toEqual([{ kept: 'Alphabet Inc.', absorbed: 'Google', reason: 'ticker' }]);
    const row = db.prepare("SELECT mention_count, aliases FROM entities WHERE id = 'e1'").get() as { mention_count: number; aliases: string };
    expect(row.mention_count).toBe(7);
    expect(JSON.parse(row.aliases)).toContain('Google');
  });

  it('is a no-op the second time', () => {
    resolveEntity(db, { name: 'STERIS plc - Ordinary Shares', kind: 'company', ticker: 'STE' });
    consolidateCompanies(db);
    expect(consolidateCompanies(db)).toEqual({ renamed: 0, merged: [] });
  });
});

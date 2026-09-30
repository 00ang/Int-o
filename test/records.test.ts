import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/core/db.js';
import {
  eventsForItem, insertItem, itemsAwaitingExtraction, itemsAwaitingTriage, upsertSource,
} from '../src/core/store.js';
import type { Source } from '../src/core/types.js';
import { runAllPairRules } from '../src/pipeline/detectors/deterministic.js';
import { importTradeFile } from '../src/pipeline/import-trades.js';
import { writeRecordEvents } from '../src/pipeline/records.js';
import { buildAwardSearchBody, parseAwards } from '../src/sources/usaspending.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(join(here, 'fixtures', n), 'utf8');
const NOW = new Date('2026-08-30T00:00:00.000Z');

const AWARDS: Source = {
  id: 'usaspending-awards', name: 'USASpending', kind: 'usaspending',
  url: 'https://api.usaspending.gov/api/v2/search/spending_by_award/', tier: 'primary',
  domains: ['defense'], origin: 'US', intervalMinutes: 1440, verified: true, enabled: true,
};

const row = (over: Record<string, unknown> = {}) => ({
  'Award ID': 'W58RGZ-26-C-0042',
  generated_internal_id: 'CONT_AWD_1',
  'Recipient Name': 'MERIDIAN AEROSPACE CORP',
  'Award Amount': 412_000_000,
  'Awarding Agency': 'Department of Defense',
  'Awarding Sub Agency': 'Department of the Army',
  'Start Date': '2019-03-01',
  'Base Obligation Date': '2026-06-22',
  Description: 'ROTARY WING SUSTAINMENT',
  'Contract Award Type': 'Definitive Contract',
  ...over,
});

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  upsertSource(db, AWARDS);
});

function ingestAwards(rows: Record<string, unknown>[]): number {
  let events = 0;
  for (const it of parseAwards({ results: rows }, AWARDS, '2026-06-25T00:00:00.000Z')) {
    if (insertItem(db, it)) events += writeRecordEvents(db, it, AWARDS.kind);
  }
  return events;
}

describe('the award search', () => {
  it('asks for awards signed in the window, not old ones touched in it', () => {
    const body = buildAwardSearchBody('2026-06-18', '2026-06-25');
    expect(body.filters.time_period[0]).toMatchObject({ date_type: 'new_awards_only' });
    expect(body.fields).toContain('Base Obligation Date');
  });
});

describe('awards become events without a model', () => {
  it('dates the item by when the award was signed, not its performance start', () => {
    const [item] = parseAwards({ results: [row()] }, AWARDS);
    expect(item!.publishedAt.slice(0, 10)).toBe('2026-06-22');
  });

  it('writes a documented government-award event naming agency and recipient', () => {
    expect(ingestAwards([row()])).toBe(1);
    const [event] = eventsForItem(db, parseAwards({ results: [row()] }, AWARDS)[0]!.id);
    expect(event!.type).toBe('government-award');
    expect(event!.assertion).toBe('documented');
    expect(event!.occurredAt.slice(0, 10)).toBe('2026-06-22');
    expect(event!.occurredAtInferred).toBe(false);
    expect(event!.amount).toEqual({ value: 412_000_000, currency: 'USD' });
    expect(event!.domains).toContain('defense');
    expect(event!.summary).toBe(
      'Department of the Army awarded MERIDIAN AEROSPACE CORP a $412,000,000 contract for rotary wing sustainment.',
    );
    expect(event!.entities.map((e) => e.role).sort()).toEqual(['actor', 'beneficiary']);
  });

  it('marks a row with no signature date as inferred rather than passing it as fact', () => {
    ingestAwards([row({ 'Base Obligation Date': undefined })]);
    const [event] = eventsForItem(db, parseAwards({ results: [row()] }, AWARDS)[0]!.id);
    expect(event!.occurredAtInferred).toBe(true);
  });

  it('writes nothing for a re-served row', () => {
    expect(ingestAwards([row()])).toBe(1);
    expect(ingestAwards([row()])).toBe(0);
  });
});

describe('structured records skip every model stage', () => {
  it('keeps award rows out of triage and extraction', () => {
    ingestAwards([row()]);
    expect(itemsAwaitingTriage(db, 100)).toHaveLength(0);
    expect(itemsAwaitingExtraction(db, 100)).toHaveLength(0);
  });

  it('keeps imported trades out of triage, which insert used to drop on the floor', () => {
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    expect(itemsAwaitingTriage(db, 100)).toHaveLength(0);
  });

  it('keeps structured rows out even when an older insert left them untriaged', () => {
    ingestAwards([row()]);
    db.prepare('UPDATE items SET triaged_at = NULL, triage_verdict = NULL').run();
    expect(itemsAwaitingTriage(db, 100)).toHaveLength(0);
  });
});

describe('end to end: a congressional trade meets a contract award by name alone', () => {
  it('fires trade-then-award with no entity ids passed by hand', () => {
    // The fixture has a member buying MRDN on 2026-06-02; the award is signed
    // 20 days later to the same company, spelled the way USASpending spells it.
    importTradeFile(db, fixture('house-trades.json'), { now: NOW });
    ingestAwards([row()]);

    const links = runAllPairRules(db, '2026-01-01T00:00:00.000Z')
      .filter((c) => c.producedBy === 'trade-then-award');
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]!.lagDays).toBe(20);
  });
});

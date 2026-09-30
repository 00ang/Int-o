import { describe, expect, it } from 'vitest';
import { seedShowcase } from '../src/cli/showcase.js';
import { openDb } from '../src/core/db.js';
import { itemsAwaitingExtraction, itemsAwaitingTriage, resolveEntity } from '../src/core/store.js';
import { buildCard } from '../src/pipeline/card.js';
import { consolidateCompanies } from '../src/pipeline/consolidate.js';
import { clauseCase } from '../src/pipeline/records.js';

describe('the demo corpus behind `all-int web --demo`', () => {
  const db = openDb(':memory:');
  const r = seedShowcase(db);
  const kinds = (db.prepare('SELECT DISTINCT produced_by AS k FROM connections').all() as { k: string }[])
    .map((x) => x.k).sort();

  it('produces a connection of every record-driven kind', () => {
    expect(kinds).toEqual(expect.arrayContaining([
      'insider-then-news', 'lobbying-then-award', 'lobbying-then-policy', 'trade-then-award',
    ]));
    expect(r.connections).toBeGreaterThanOrEqual(10);
  });

  it('has nothing left for triage, and only the two news stories waiting on Investigate', () => {
    expect(itemsAwaitingTriage(db, 100)).toHaveLength(0);
    expect(itemsAwaitingExtraction(db, 100).map((i) => i.id).sort()).toEqual(['demo-n1', 'demo-n2']);
  });

  it('has a reading queue with angles', () => {
    const n = (db.prepare("SELECT COUNT(*) AS c FROM items WHERE triage_angle IS NOT NULL").get() as { c: number }).c;
    expect(n).toBeGreaterThanOrEqual(4);
  });

  it('makes a card for a record without any placeholder link', () => {
    const award = db.prepare("SELECT id FROM items WHERE external_id = 'N00019-26-C-DEMO1'").get() as { id: string };
    const card = buildCard(db, award.id)!;
    expect(card).toContain('lobbying');
    expect(card).not.toContain('file://');
    expect(card).not.toMatch(/\n\n\n/);
  });
});

describe('contract descriptions read as a clause, names intact', () => {
  it.each([
    ['MH-60 DEPOT SUSTAINMENT', 'MH-60 depot sustainment'],
    ['IT SERVICES FOR THE USAF', 'IT services for the USAF'],
    ['RADIATION-HARDENED PROCESSORS', 'radiation-hardened processors'],
    ['Already written normally', 'Already written normally'],
  ])('%s', (raw, out) => expect(clauseCase(raw)).toBe(out));
});

describe('a company and an organisation with one name are one party', () => {
  it('resolves an association-looking spelling onto the company already on file', () => {
    const db = openDb(':memory:');
    const c = resolveEntity(db, { name: 'Cattleman United Processing', kind: 'company' });
    expect(resolveEntity(db, { name: 'CATTLEMAN UNITED PROCESSING', kind: 'organization' }).id).toBe(c.id);
  });

  it('merges a pair already split, keeping the company', () => {
    const db = openDb(':memory:');
    db.prepare(
      `INSERT INTO entities (id, kind, name, slug, aliases, first_seen_at, last_seen_at, mention_count)
       VALUES ('c', 'company', 'Cattleman United Processing', 'cattleman united processing', '[]', '2026-01-01', '2026-01-01', 1),
              ('o', 'organization', 'CATTLEMAN UNITED PROCESSING', 'cattleman united processing', '[]', '2026-01-01', '2026-01-01', 1)`,
    ).run();
    expect(consolidateCompanies(db).merged).toHaveLength(1);
    expect(db.prepare("SELECT kind FROM entities").all()).toEqual([{ kind: 'company' }]);
  });
});

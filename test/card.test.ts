import { beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/cli/demo.js';
import { openDb, type DB } from '../src/core/db.js';
import { insertConnection, setConnectionVerdict } from '../src/core/store.js';
import type { Connection } from '../src/core/types.js';
import { buildCard } from '../src/pipeline/card.js';
import { runAllPairRules } from '../src/pipeline/detectors/deterministic.js';

let db: DB;
let link: Connection;
let awardItemId: string;

beforeEach(() => {
  db = openDb(':memory:');
  seedDemo(db);
  const found = runAllPairRules(db, new Date(Date.now() - 365 * 86_400_000).toISOString());
  for (const c of found) insertConnection(db, c);
  link = found.find((c) => c.producedBy === 'trade-then-award')!;
  awardItemId = (db.prepare('SELECT item_id FROM events WHERE id = ?').get(link.toEventId) as { item_id: string }).item_id;
  db.prepare(
    `UPDATE items SET triaged_at = '2026-09-22', triage_verdict = 'notable',
            triage_topic = 'Contract after an insider buy', triage_reason = 'The timing does work.',
            triage_angle = 'When the solicitation opened' WHERE id = ?`,
  ).run(awardItemId);
});

describe('the text card', () => {
  it('carries the angle, the event, the link and what would show it wrong', () => {
    const card = buildCard(db, awardItemId)!;
    expect(card).toContain('CONTRACT AFTER AN INSIDER BUY');
    expect(card).toContain('The angle: When the solicitation opened');
    expect(card).toContain('What happened');
    expect(card).toContain('[public records]');
    expect(card).toContain('Would be wrong if:');
    // The other half of the link, with its own source, so a friend can check it.
    expect(card).toMatch(/Linked to, \d{4}-\d{2}-\d{2}: .+ https?:\/\//);
  });

  it('is plain text, not markdown', () => {
    const card = buildCard(db, awardItemId)!;
    expect(card).not.toMatch(/\*\*|^#/m);
  });

  it('labels a model proposal as a guess', () => {
    insertConnection(db, {
      ...link, id: 'hyp-1', basis: 'hypothesis', producedBy: 'llm', confidence: 0.3,
      explanation: 'A proposed mechanism.', falsifier: 'A specific observation.',
    });
    expect(buildCard(db, awardItemId)).toContain("[model's guess, unverified] A proposed mechanism.");
  });

  it('leaves out a link you already judged wrong', () => {
    setConnectionVerdict(db, link.id, 'wrong');
    expect(buildCard(db, awardItemId)).not.toContain('[public records]');
  });

  it('returns null for an item that does not exist', () => {
    expect(buildCard(db, 'item_nope')).toBeNull();
  });
});

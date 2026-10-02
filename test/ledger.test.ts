import { beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/cli/demo.js';
import { seedShowcase } from '../src/cli/showcase.js';
import { openDb, type DB } from '../src/core/db.js';
import {
  addEventToThread, insertConnection, insertItem, saveTriage, setConnectionVerdict, upsertThread,
} from '../src/core/store.js';
import type { Connection } from '../src/core/types.js';
import { UNTRIAGED } from '../src/core/types.js';
import { runAllPairRules } from '../src/pipeline/detectors/deterministic.js';
import {
  buildLedger, renderLedgerMarkdown, sourceSpread, stateableRows, tally, USAGE_RULE,
} from '../src/pipeline/ledger.js';
import { saveProfile } from '../src/pipeline/profile.js';
import { scoreLedger, suggestTopics } from '../src/pipeline/topics.js';

let db: DB;
let tradeThenAward: Connection;
let awardItemId: string;

beforeEach(() => {
  db = openDb(':memory:');
  seedDemo(db);
  const found = runAllPairRules(db, new Date(Date.now() - 365 * 86_400_000).toISOString());
  for (const c of found) insertConnection(db, c);
  tradeThenAward = found.find((c) => c.producedBy === 'trade-then-award')!;
  awardItemId = (db.prepare('SELECT item_id FROM events WHERE id = ?').get(tradeThenAward.toEventId) as { item_id: string }).item_id;
  saveTriage(db, awardItemId, 'notable', 'Contract after an insider buy', 'The timing does work.', 'When the solicitation opened');
});

describe('the ledger', () => {
  it('lists the item\'s records, the pattern joining them, and the far end of the join', () => {
    const l = buildLedger(db, awardItemId)!;
    expect(l.subject).toEqual({ kind: 'item', id: awardItemId, title: 'Contract after an insider buy' });
    const standings = l.rows.map((r) => r.standing);
    // Both halves of the pattern are rows a writer can cite, not just the item's own event.
    expect(standings.filter((s) => s === 'record')).toHaveLength(2);
    expect(standings).toContain('pattern');
    const pattern = l.rows.find((r) => r.standing === 'pattern')!;
    expect(pattern.falsifier).toContain('Meridian Aerospace');
    expect(pattern.eventIds).toEqual([tradeThenAward.fromEventId, tradeThenAward.toEventId]);
    expect(pattern.confidence).toBeCloseTo(tradeThenAward.confidence);
  });

  it('numbers rows densely from one, records first in time order', () => {
    const l = buildLedger(db, awardItemId)!;
    expect(l.rows.map((r) => r.ref)).toEqual(l.rows.map((_, i) => i + 1));
    const dates = l.rows.filter((r) => r.kind === 'event').map((r) => r.date!);
    expect([...dates].sort()).toEqual(dates);
  });

  it('gives a model proposal the hypothesis standing and keeps its falsifier', () => {
    insertConnection(db, {
      ...tradeThenAward, id: 'hyp-1', basis: 'hypothesis', producedBy: 'llm', confidence: 0.3,
      explanation: 'A proposed mechanism.', falsifier: 'A specific observation.',
    });
    const row = buildLedger(db, awardItemId)!.rows.find((r) => r.connectionId === 'hyp-1')!;
    expect(row.standing).toBe('hypothesis');
    expect(row.source).toBe('model proposal');
    expect(row.falsifier).toBe('A specific observation.');
    // A proposal is not something a sentence may rest on in the indicative.
    expect(stateableRows(buildLedger(db, awardItemId)!).map((r) => r.ref)).not.toContain(row.ref);
  });

  it('leaves off a connection you judged wrong, and counts it', () => {
    setConnectionVerdict(db, tradeThenAward.id, 'coincidence');
    const l = buildLedger(db, awardItemId)!;
    expect(l.rows.filter((r) => r.kind === 'connection')).toHaveLength(0);
    expect(l.struck).toBe(1);
    // With the join gone, the trade on the far end is no longer part of this subject.
    expect(l.rows.filter((r) => r.kind === 'event')).toHaveLength(1);
  });

  it('carries recalled dossier claims as background, and drops the ones a record here already supports', () => {
    const company = (db.prepare("SELECT id FROM entities WHERE ticker = 'MRDN'").get() as { id: string }).id;
    saveProfile(db, company, {
      summary: 'A fictional contractor.',
      affiliations: [{ organisation: 'Rotorcraft Industry Council', role: 'member', period: 'since 2019', basis: 'recalled', confidence: 0.4 }],
      history: [
        { when: '2024', what: 'Meridian Aerospace Corp won a sustainment contract.', whyItMatters: 'x', basis: 'corpus', confidence: 0.9 },
        { when: '2021', what: 'Meridian Aerospace Corp settled a pricing dispute with the Army.', whyItMatters: 'x', basis: 'recalled', confidence: 0.3 },
      ],
      capabilities: [{ capability: 'Could bid on the follow-on.', whatItWouldTake: 'x', observableIfReal: 'x', basis: 'inferred', confidence: 0.5 }],
      watchPoints: [], thin: false,
    }, 'test');
    const rows = buildLedger(db, awardItemId)!.rows.filter((r) => r.kind === 'background');
    expect(rows.map((r) => r.claim)).toEqual([
      'Meridian Aerospace Corp: member at Rotorcraft Industry Council (since 2019).',
      '2021: Meridian Aerospace Corp settled a pricing dispute with the Army.',
    ]);
    expect(rows.every((r) => r.standing === 'background' && r.entityId === company)).toBe(true);
    expect(rows[0]!.source).toBe('dossier, recalled');
  });

  it('builds a ledger for a storyline from its events', () => {
    const now = new Date().toISOString();
    upsertThread(db, {
      id: 'thr_1', title: 'Meridian and the Army', summary: '', openQuestions: ['Who solicited the award'],
      domains: ['defense'], coreEntityIds: [], status: 'active', startedAt: now, lastEventAt: now,
      eventCount: 0, createdAt: now, updatedAt: now,
    });
    addEventToThread(db, 'thr_1', tradeThenAward.toEventId, 'the award');
    const l = buildLedger(db, 'thr_1')!;
    expect(l.subject.kind).toBe('thread');
    expect(l.subject.title).toBe('Meridian and the Army');
    expect(l.rows.some((r) => r.standing === 'pattern')).toBe(true);
  });

  it('returns null for an id that names neither', () => {
    expect(buildLedger(db, 'nothing-here')).toBeNull();
  });

  it('renders markdown with a standing, a source link and a falsifier on every pattern', () => {
    const md = renderLedgerMarkdown(buildLedger(db, awardItemId)!);
    expect(md).toContain('| # | Date | Standing | Claim | Source | Would be wrong if |');
    expect(md).toMatch(/\| record \| .+ \| \[.+\]\(https:\/\/example\.invalid\/.+\) \|/);
    expect(md).toContain('| pattern (0.');
    expect(md).toContain(`- **record** (2): ${USAGE_RULE.record}`);
    expect(md).toContain(`- **pattern** (1): ${USAGE_RULE.pattern}`);
    expect(md).not.toContain('hypothesis');
  });

  it('tallies standings and counts independent sources', () => {
    const l = buildLedger(db, awardItemId)!;
    expect(tally(l)).toMatchObject({ record: 2, pattern: 1, hypothesis: 0, background: 0 });
    expect(sourceSpread(l)).toEqual({ sources: 2, primary: 2 });
  });
});

describe('topic suggestions', () => {
  it('ranks the subject with patterns in the records above a lone report', () => {
    insertItem(db, {
      id: 'lone', sourceId: 'demo-wire', externalId: 'lone', url: 'https://example.invalid/lone',
      title: 'An outlet reports a thing', summary: null, body: null, author: null,
      publishedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), raw: null,
      extractedAt: new Date().toISOString(), extractionError: null, ...UNTRIAGED,
    });
    saveTriage(db, 'lone', 'notable', 'A lone report', 'Big, but one outlet.', null);
    db.prepare(`INSERT INTO events (id, item_id, type, summary, occurred_at, domains, tags, assertion, created_at)
                VALUES ('e-lone', 'lone', 'statement', 'Someone said something.', ?, '[]', '[]', 'reported', ?)`)
      .run(new Date().toISOString(), new Date().toISOString());

    const topics = suggestTopics(db, { minScore: 0 });
    expect(topics[0]!.subject.id).toBe(awardItemId);
    const lone = topics.find((t) => t.subject.id === 'lone')!;
    expect(lone.score).toBeLessThan(topics[0]!.score);
    expect(lone.gaps).toEqual(expect.arrayContaining([
      'no pattern in the records: a story, not a join',
      'nothing documented; every claim is reported or weaker',
      'single source',
      'no primary record',
    ]));
    // The default floor drops it: there is nothing in it to stand a sentence on.
    expect(suggestTopics(db).map((t) => t.subject.id)).not.toContain('lone');
  });

  it('says what each suggestion was ranked on, and opens with what is already on file', () => {
    const [top] = suggestTopics(db);
    expect(top!.basis).toMatchObject({ patterns: 1, records: 2, sources: 2, primarySources: 2 });
    expect(top!.pitch).toMatch(/^1 pattern in the records, 2 documented, 2 sources \(2 primary\), moved \d+d ago\.$/);
    expect(top!.angle).toBe('When the solicitation opened');
    expect(top!.gaps).toEqual(['no dossier on the players']);
  });

  it('skips a retained item that has no events yet', () => {
    const fresh = openDb(':memory:');
    seedShowcase(fresh);
    const ids = suggestTopics(fresh, { minScore: 0 }).map((t) => t.subject.id);
    // The two news stories in the showcase are waiting on extraction.
    expect(ids).not.toContain('demo-n1');
    expect(ids).not.toContain('demo-n2');
    expect(ids).toContain('demo-i2');
  });

  it('includes active storylines and does not list the same subject twice', () => {
    const now = new Date().toISOString();
    upsertThread(db, {
      id: 'thr_1', title: 'Meridian and the Army', summary: '', openQuestions: ['Who solicited the award'],
      domains: ['defense'], coreEntityIds: [], status: 'active', startedAt: now, lastEventAt: now,
      eventCount: 0, createdAt: now, updatedAt: now,
    });
    addEventToThread(db, 'thr_1', tradeThenAward.toEventId, 'the award');
    const topics = suggestTopics(db);
    const thread = topics.find((t) => t.subject.kind === 'thread')!;
    expect(thread.subject.id).toBe('thr_1');
    expect(thread.angle).toBe('Who solicited the award');
    expect(new Set(topics.map((t) => t.subject.id)).size).toBe(topics.length);
  });

  it('gives no recency credit to a subject that stopped moving', () => {
    const l = buildLedger(db, awardItemId)!;
    const fresh = scoreLedger(l, new Date());
    const stale = scoreLedger(l, new Date(Date.now() + 60 * 86_400_000));
    expect(stale.score).toBeLessThan(fresh.score);
    expect(stale.basis.ageDays).toBeGreaterThan(fresh.basis.ageDays);
  });
});

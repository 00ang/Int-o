import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemo } from '../src/cli/demo.js';
import { loadConfig } from '../src/core/config.js';
import { openDb, type DB } from '../src/core/db.js';
import { insertConnection, saveTriage } from '../src/core/store.js';
import type { Connection } from '../src/core/types.js';
import { runAllPairRules } from '../src/pipeline/detectors/deterministic.js';
import { buildLedger, type Ledger } from '../src/pipeline/ledger.js';
import {
  buildWriterBrief, guardsFor, registerViolations, renderWriterBrief, validateProse,
  type WriterProse,
} from '../src/pipeline/writer-brief.js';

const structured = vi.fn();
vi.mock('../src/core/llm.js', () => ({
  structured: (...args: unknown[]) => structured(...args),
  prose: vi.fn(),
}));

let db: DB;
let link: Connection;
let itemId: string;
let ledger: Ledger;

beforeEach(() => {
  structured.mockReset();
  db = openDb(':memory:');
  seedDemo(db);
  const found = runAllPairRules(db, new Date(Date.now() - 365 * 86_400_000).toISOString());
  for (const c of found) insertConnection(db, c);
  link = found.find((c) => c.producedBy === 'trade-then-award')!;
  itemId = (db.prepare('SELECT item_id FROM events WHERE id = ?').get(link.toEventId) as { item_id: string }).item_id;
  saveTriage(db, itemId, 'notable', 'Contract after an insider buy', 'The timing does work.', 'When the solicitation opened');
  insertConnection(db, {
    ...link, id: 'hyp-1', basis: 'hypothesis', producedBy: 'llm', confidence: 0.3,
    explanation: 'The purchase anticipated the award.', falsifier: 'The solicitation was public before the purchase.',
  });
  ledger = buildLedger(db, itemId)!;
});

const ref = (standing: string) => ledger.rows.find((r) => r.standing === standing)!.ref;

describe('holding the prose to the ledger', () => {
  it('strikes a line that cites nothing in the ledger', () => {
    const v = validateProse({
      lede: { text: 'The Army awarded the contract.', refs: [ref('record')] },
      established: [
        { text: 'The filing was made.', refs: [ref('record')] },
        { text: 'The company is based in Ohio.', refs: [99] },
      ],
      open: [],
      shape: ['The award', 'The filings'],
    }, ledger);
    expect(v.struck).toBe(1);
    expect(v.prose.established.map((l) => l.text)).toEqual(['The filing was made.']);
  });

  it('moves a line offered as established to open when it rests only on a hypothesis', () => {
    const v = validateProse({
      lede: { text: 'The Army awarded the contract.', refs: [ref('record')] },
      established: [{ text: 'The purchase anticipated the award.', refs: [ref('hypothesis')] }],
      open: [],
      shape: [],
    }, ledger);
    expect(v.demoted).toBe(1);
    expect(v.prose.established).toHaveLength(0);
    expect(v.prose.open.map((l) => l.text)).toEqual(['The purchase anticipated the award.']);
  });

  it('lets a line stand when any of its refs is a record or a pattern', () => {
    const v = validateProse({
      lede: { text: 'x', refs: [ref('record')] },
      established: [{ text: 'A trade preceded an award by days.', refs: [ref('hypothesis'), ref('pattern')] }],
      open: [],
      shape: [],
    }, ledger);
    expect(v.demoted).toBe(0);
    expect(v.prose.established).toHaveLength(1);
  });

  it('replaces a lede that rests on nothing stateable with the first established line', () => {
    const v = validateProse({
      lede: { text: 'The purchase anticipated the award.', refs: [ref('hypothesis')] },
      established: [{ text: 'The Army awarded the contract.', refs: [ref('record')] }],
      open: [],
      shape: [],
    }, ledger);
    expect(v.prose.lede.text).toBe('The Army awarded the contract.');
    expect(v.prose.open[0]!.text).toBe('The purchase anticipated the award.');
    expect(v.demoted).toBe(1);
  });

  it('drops unknown refs from a line that also cites real ones, and sorts them', () => {
    const v = validateProse({
      lede: { text: 'x', refs: [ref('pattern'), 42, ref('record')] },
      established: [], open: [], shape: [],
    }, ledger);
    expect(v.prose.lede.refs).toEqual([ref('record'), ref('pattern')].sort((a, b) => a - b));
  });

  it('flags the register without rewriting it', () => {
    const v = validateProse({
      lede: { text: 'Notably, the award was a bombshell.', refs: [ref('record')] },
      established: [], open: [], shape: [],
    }, ledger);
    expect(v.flagged).toEqual([{ text: 'Notably, the award was a bombshell.', words: ['notably', 'bombshell'] }]);
    expect(v.prose.lede.text).toBe('Notably, the award was a bombshell.');
  });
});

describe('the register', () => {
  it('flags judgement, emphasis and exclamation', () => {
    expect(registerViolations('It raises questions about the award!')).toEqual(['raises questions', 'exclamation']);
    expect(registerViolations('Clearly a cover-up.')).toEqual(['clearly', 'cover-up']);
  });

  it('passes a flat sentence', () => {
    expect(registerViolations('The Army awarded Meridian Aerospace Corp a $412 million contract on 23 September.')).toEqual([]);
  });

  it('does not match inside another word', () => {
    expect(registerViolations('The corruption index was not cited.')).toEqual([]);
  });
});

describe('lines not to cross', () => {
  it('derives one from every hypothesis and pattern, carrying the falsifier', () => {
    const guards = guardsFor(ledger);
    expect(guards).toContain(
      `[${ref('hypothesis')}] is a model proposal at confidence 0.30. Pose it as a question, never as a finding. It would be wrong if: The solicitation was public before the purchase.`,
    );
    expect(guards.find((g) => g.startsWith(`[${ref('pattern')}] is a join over two records.`))).toContain('Do not state intent, coordination or cause.');
    expect(guards.at(-1)).toBe('Nothing on this ledger establishes wrongdoing by any party. Do not write that it does.');
  });

  it('says when something you judged wrong has been left off', () => {
    const guards = guardsFor({ ...ledger, struck: 2 });
    expect(guards).toContain('2 connections you judged coincidence or wrong are left off this ledger. Keep them out of the piece.');
  });

  it('collects reported rows into one attribution line', () => {
    const l = buildLedger(db, 'demo-i4')!;
    const guards = guardsFor(l);
    const reported = l.rows.filter((r) => r.standing === 'reported').map((r) => `[${r.ref}]`).join(' ');
    expect(guards).toContain(`${reported} is reported, not documented. Attribute to the outlet.`);
  });
});

describe('the brief', () => {
  it('is complete without the model: ledger and guards, nothing called', async () => {
    const b = (await buildWriterBrief(db, loadConfig(), itemId, { prose: false }))!;
    expect(structured).not.toHaveBeenCalled();
    expect(b.prose).toBeNull();
    expect(b.markdown).toContain('# Writer brief - Contract after an insider buy');
    expect(b.markdown).toContain('No prose generated');
    expect(b.markdown).toContain('## Lines not to cross');
    expect(b.markdown).toContain('## Ledger');
    expect(b.markdown).not.toContain('## Lede');
  });

  it('writes from the ledger and keeps the checks in the output', async () => {
    const out: WriterProse = {
      lede: { text: 'The US Army awarded Meridian Aerospace Corp a $412 million contract.', refs: [ref('record')] },
      established: [
        { text: 'Dana Whitfield disclosed a purchase of Meridian stock twelve days earlier.', refs: [ref('record'), ref('pattern')] },
        { text: 'The purchase anticipated the award.', refs: [ref('hypothesis')] },
        { text: 'Meridian is the market leader.', refs: [77] },
      ],
      open: [{ text: 'When was the solicitation opened? The award record would say.', refs: [ref('pattern')] }],
      shape: ['The award', 'The filing', 'The interval', 'What is not known'],
    };
    structured.mockResolvedValueOnce(out);

    const b = (await buildWriterBrief(db, loadConfig(), itemId))!;
    expect(structured).toHaveBeenCalledTimes(1);
    const call = structured.mock.calls[0]![1] as { user: string; system: string };
    // The model sees the ledger and the usage rules, nothing else.
    expect(call.user).toContain('LEDGER:');
    expect(call.user).toContain(`[${ref('hypothesis')}] hypothesis 0.30`);
    expect(call.user).toContain('USAGE RULES:');
    expect(call.system).toContain('Flat.');

    expect(b.prose!.struck).toBe(1);
    expect(b.prose!.demoted).toBe(1);
    expect(b.markdown).toContain('## Lede');
    expect(b.markdown).toContain(`The US Army awarded Meridian Aerospace Corp a $412 million contract. [${ref('record')}]`);
    expect(b.markdown).toContain('## What is open');
    expect(b.markdown).toContain(`- The purchase anticipated the award. [${ref('hypothesis')}]`);
    expect(b.markdown).not.toContain('Meridian is the market leader.');
    expect(b.markdown).toContain('1 line struck for citing nothing, 1 moved to open');
    expect(b.markdown).toContain('1. The award');
    expect(b.markdown).toContain('| # | Date | Standing | Claim | Source | Would be wrong if |');
  });

  it('does not call the model for a subject with nothing on file', async () => {
    saveTriage(db, 'demo-i1', 'worth-a-look', 'A filing', 'x', null);
    db.prepare("DELETE FROM connections").run();
    db.prepare("DELETE FROM events WHERE item_id = 'demo-i1'").run();
    const b = (await buildWriterBrief(db, loadConfig(), 'demo-i1'))!;
    expect(structured).not.toHaveBeenCalled();
    expect(b.ledger.rows).toHaveLength(0);
  });

  it('returns null for an id that names nothing', async () => {
    expect(await buildWriterBrief(db, loadConfig(), 'nope', { prose: false })).toBeNull();
  });

  it('renders a register section only when something was flagged', () => {
    const v = validateProse({
      lede: { text: 'Clearly the Army awarded it.', refs: [ref('record')] },
      established: [], open: [], shape: [],
    }, ledger);
    const md = renderWriterBrief(ledger, guardsFor(ledger), v);
    expect(md).toContain('## Register');
    expect(md).toContain('- clearly: "Clearly the Army awarded it."');
  });
});

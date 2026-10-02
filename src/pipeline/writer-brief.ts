import { z } from 'zod';
import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { structured } from '../core/llm.js';
import {
  buildLedger, renderLedgerMarkdown, STATEABLE, USAGE_RULE, type Ledger, type LedgerRow,
} from './ledger.js';

/**
 * The writer brief.
 *
 * Not an essay and not a draft. It is what a writer needs before starting one:
 * the lede the record supports, what is established, what is open, the lines
 * the material does not let you cross, and a shape. Flat on purpose - short
 * declarative sentences, no adjectives of judgement, no conclusion - because a
 * brief that already has a voice has already decided what the piece says, and
 * that decision is the writer's.
 *
 * Two halves, kept apart as they are everywhere in this system:
 *
 * The guards are code. They are derived from the ledger's standings and the
 * usage rule fixed beside each one, so the brief cannot forget to say that a
 * hypothesis is a hypothesis.
 *
 * The prose is the model's, and it is held to the ledger by construction:
 * every line carries the refs it rests on; a line citing nothing in the ledger
 * is struck; a line offered as established that rests on nothing stateable is
 * moved to the open questions. The model writes from the ledger and only the
 * ledger, and the ledger is printed underneath so the reader can check.
 */

const LineSchema = z.object({
  text: z.string().describe('One or two short declarative sentences. No judgement, no emphasis, no conclusion.'),
  refs: z.array(z.number().int()).min(1)
    .describe('Ledger row numbers this line rests on. Every line cites at least one; a line you cannot tie to a row you do not write.'),
});

export const WriterProseSchema = z.object({
  lede: LineSchema.describe('The opening the record supports. What happened, who did it, when. Nothing about what it means.'),
  established: z.array(LineSchema)
    .describe('What the record shows. Each line rests on at least one row the ledger permits to be stated: a record or a pattern. Reported claims are attributed in the sentence.'),
  open: z.array(LineSchema)
    .describe('What is not known. Each as a plain question, with the observation that would settle it, resting on the hypothesis, allegation or gap it comes from.'),
  shape: z.array(z.string()).max(6)
    .describe('Three to six section headings, in order, each naming what it covers. Headings, not sentences.'),
});

export type WriterProse = z.infer<typeof WriterProseSchema>;
export type ProseLine = z.infer<typeof LineSchema>;

const SYSTEM = `You write the brief a writer reads before writing a piece for a serious newsletter. You do not write the piece.

You are given a numbered ledger of claims about one subject. Each row carries a standing - record, reported, alleged, speculated, pattern, overlap, hypothesis, background - and the rule for using it. The ledger is the whole of what you know. Nothing from outside it goes in, including context you are sure of.

Register. Flat. Short declarative sentences in the past or present tense. Name the party, the act, the date, the amount. No adjectives of judgement, no adverbs of emphasis, no metaphor, no rhetorical question, no irony, no foreshadowing, no "notably", no "raises questions", no "it remains to be seen". Do not explain what anything means. Do not conclude. A sentence that would make a reader feel something is a sentence to cut.

Citations. Every line cites the ledger rows it rests on, by number, in refs. A line you cannot tie to a row is a line you do not write.

Standing. A line under established rests on a record or a pattern. Where you draw on a reported row, the sentence attributes it to the source named in the row. An alleged row is attributed to the party making the claim. A hypothesis is never stated; it becomes a question under open, carrying what would show it wrong. A background row is recalled by a model and is not on record here; it is a question or it is left out. A pattern is two records and an interval, and that is all it is: do not state that one caused the other, or that anyone intended anything.

Nothing in the ledger establishes wrongdoing by any party, and you do not write that it does or imply that it might.

Length. Under 250 words across all fields. The lede is one or two sentences. established has two to five lines, open has one to four, shape has three to six headings.`;

/**
 * Words the register forbids. Not a style preference: each is a judgement or
 * an emphasis smuggled into a sentence that is supposed to carry neither.
 */
export const REGISTER_FLAGS: readonly string[] = [
  'notably', 'remarkably', 'strikingly', 'crucially', 'importantly', 'interestingly',
  'clearly', 'obviously', 'undoubtedly', 'alarming', 'troubling', 'disturbing',
  'bombshell', 'explosive', 'shocking', 'stunning', 'damning', 'brazen',
  'raises questions', 'remains to be seen', 'it is worth noting', 'begs the question',
  'scandal', 'cover-up', 'corrupt',
];

/** Register violations in a line, if any. Exposed so a reader can see what was flagged. */
export function registerViolations(text: string): string[] {
  const lower = text.toLowerCase();
  const hits = REGISTER_FLAGS.filter((w) => new RegExp(`(^|[^a-z])${w.replace(/[-\s]/g, '[-\\s]')}($|[^a-z])`).test(lower));
  if (text.includes('!')) hits.push('exclamation');
  return hits;
}

export interface ValidatedProse {
  prose: WriterProse;
  /** Lines removed because they cited nothing in the ledger. */
  struck: number;
  /** Lines offered as established that rested on nothing stateable, moved to open. */
  demoted: number;
  /** Lines carrying a word the register forbids, left in and flagged. */
  flagged: Array<{ text: string; words: string[] }>;
}

/**
 * Hold the prose to the ledger.
 *
 * The schema guarantees every line arrived with refs; this checks they point
 * at rows that exist and that the line's section matches what those rows can
 * bear. Nothing is rewritten: a line either stands where it was put, moves
 * down, or goes.
 */
export function validateProse(prose: WriterProse, ledger: Ledger): ValidatedProse {
  const rows = new Map<number, LedgerRow>(ledger.rows.map((r) => [r.ref, r]));
  let struck = 0;
  let demoted = 0;
  const flagged: ValidatedProse['flagged'] = [];

  const clean = (line: ProseLine): ProseLine | null => {
    const refs = [...new Set(line.refs.filter((n) => rows.has(n)))].sort((a, b) => a - b);
    if (refs.length === 0) { struck++; return null; }
    const words = registerViolations(line.text);
    if (words.length) flagged.push({ text: line.text, words });
    return { text: line.text.trim(), refs };
  };

  const stateable = (line: ProseLine) => line.refs.some((n) => STATEABLE.has(rows.get(n)!.standing));

  const established: ProseLine[] = [];
  const open: ProseLine[] = [];
  for (const raw of prose.established) {
    const line = clean(raw);
    if (!line) continue;
    if (stateable(line)) established.push(line);
    else { demoted++; open.push(line); }
  }
  for (const raw of prose.open) {
    const line = clean(raw);
    if (line) open.push(line);
  }

  // A lede that rests on nothing is replaced by the first established line,
  // and by nothing at all when there is none. The brief says so rather than
  // inventing an opening.
  let lede = clean(prose.lede);
  if (lede && !stateable(lede)) { demoted++; open.unshift(lede); lede = null; }
  if (!lede && established.length) lede = established[0]!;

  return {
    prose: {
      lede: lede ?? { text: '', refs: [] },
      established,
      open,
      shape: prose.shape.map((s) => s.trim()).filter(Boolean).slice(0, 6),
    },
    struck,
    demoted,
    flagged,
  };
}

/**
 * The lines the material does not let a writer cross. Derived from the
 * ledger's standings, so they are the same every time for the same rows.
 */
export function guardsFor(ledger: Ledger): string[] {
  const by = (s: LedgerRow['standing']) => ledger.rows.filter((r) => r.standing === s);
  const refs = (rs: LedgerRow[]) => rs.map((r) => `[${r.ref}]`).join(' ');
  const out: string[] = [];

  for (const r of by('hypothesis')) {
    out.push(`[${r.ref}] is a model proposal at confidence ${(r.confidence ?? 0).toFixed(2)}. Pose it as a question, never as a finding.${r.falsifier ? ` It would be wrong if: ${r.falsifier}` : ''}`);
  }
  for (const r of by('pattern')) {
    out.push(`[${r.ref}] is a join over two records. State both and the interval. Do not state intent, coordination or cause.${r.falsifier ? ` It would be wrong if: ${r.falsifier}` : ''}`);
  }
  for (const r of by('alleged')) {
    out.push(`[${r.ref}] is an allegation by a party to a dispute. Attribute it to them; do not state it.`);
  }
  const reported = by('reported');
  if (reported.length) out.push(`${refs(reported)} ${reported.length === 1 ? 'is' : 'are'} reported, not documented. Attribute to the outlet.`);
  const speculated = by('speculated');
  if (speculated.length) out.push(`${refs(speculated)} ${speculated.length === 1 ? 'is' : 'are'} analysis. Say whose.`);
  const overlap = by('overlap');
  if (overlap.length) out.push(`${refs(overlap)} ${overlap.length === 1 ? 'says' : 'say'} only that two sources concern one party. Do not build on it.`);
  const background = by('background');
  if (background.length) out.push(`${refs(background)} ${background.length === 1 ? 'is' : 'are'} recalled by a model, not on record here. Verify independently or leave out.`);
  if (ledger.struck > 0) {
    out.push(`${ledger.struck} connection${ledger.struck === 1 ? '' : 's'} you judged coincidence or wrong ${ledger.struck === 1 ? 'is' : 'are'} left off this ledger. Keep ${ledger.struck === 1 ? 'it' : 'them'} out of the piece.`);
  }
  out.push('Nothing on this ledger establishes wrongdoing by any party. Do not write that it does.');
  return out;
}

export interface WriterBrief {
  ledger: Ledger;
  guards: string[];
  /** Null when prose was not requested. */
  prose: ValidatedProse | null;
  markdown: string;
}

function renderLedgerInput(ledger: Ledger): string {
  const lines = [`SUBJECT: ${ledger.subject.title}`, '', 'LEDGER:'];
  for (const r of ledger.rows) {
    lines.push(
      `[${r.ref}] ${r.standing}${r.confidence === null ? '' : ` ${r.confidence.toFixed(2)}`} | ${r.date ?? 'undated'} | ${r.claim}` +
      `${r.source ? ` | source: ${r.source}` : ''}${r.falsifier ? ` | wrong if: ${r.falsifier}` : ''}`,
    );
  }
  lines.push('', 'USAGE RULES:');
  for (const [standing, rule] of Object.entries(USAGE_RULE)) lines.push(`- ${standing}: ${rule}`);
  return lines.join('\n');
}

const cite = (line: ProseLine) => `${line.text} ${line.refs.map((n) => `[${n}]`).join('')}`;

export function renderWriterBrief(ledger: Ledger, guards: string[], prose: ValidatedProse | null): string {
  const lines: string[] = [
    `# Writer brief - ${ledger.subject.title}`,
    '',
    `_${ledger.subject.kind === 'thread' ? 'Storyline' : 'Item'}, ${ledger.rows.length} ledger rows. ` +
    (prose
      ? `Prose written from the ledger only; ${prose.struck} line${prose.struck === 1 ? '' : 's'} struck for citing nothing, ${prose.demoted} moved to open for resting on nothing stateable._`
      : 'No prose generated: the ledger and the lines not to cross are assembled in code._'),
    '',
  ];

  if (prose) {
    if (prose.prose.lede.text) lines.push('## Lede', '', cite(prose.prose.lede), '');
    if (prose.prose.established.length) {
      lines.push('## What the record shows', '', ...prose.prose.established.map((l) => `- ${cite(l)}`), '');
    }
    if (prose.prose.open.length) {
      lines.push('## What is open', '', ...prose.prose.open.map((l) => `- ${cite(l)}`), '');
    }
  }

  lines.push('## Lines not to cross', '', ...guards.map((g) => `- ${g}`), '');

  if (prose?.prose.shape.length) {
    lines.push('## Shape', '', ...prose.prose.shape.map((s, i) => `${i + 1}. ${s}`), '');
  }
  if (prose?.flagged.length) {
    lines.push(
      '## Register',
      '',
      `_${prose.flagged.length} line${prose.flagged.length === 1 ? ' carries' : 's carry'} a word the register forbids. Left in, flagged._`,
      '',
      ...prose.flagged.map((f) => `- ${f.words.join(', ')}: "${f.text}"`),
      '',
    );
  }

  // The ledger travels with the brief so every citation can be checked where it is read.
  const ledgerMd = renderLedgerMarkdown(ledger).split('\n');
  lines.push(`## Ledger`, '', ...ledgerMd.slice(ledgerMd.findIndex((l) => l.startsWith('| #'))));
  return lines.join('\n');
}

/**
 * Build the brief for an item or a storyline.
 *
 * With `prose: false` nothing is called and the result is the ledger and the
 * guards, which is a complete and useful document on its own. With prose the
 * model writes from the ledger and the result is checked against it before it
 * is rendered.
 */
export async function buildWriterBrief(
  db: DB,
  cfg: Config,
  id: string,
  opts: { prose?: boolean } = {},
): Promise<WriterBrief | null> {
  const ledger = buildLedger(db, id);
  if (!ledger) return null;
  const guards = guardsFor(ledger);

  let prose: ValidatedProse | null = null;
  if (opts.prose !== false && ledger.rows.length > 0) {
    const out = await structured<WriterProse>(cfg, {
      system: SYSTEM,
      user: renderLedgerInput(ledger),
      schema: WriterProseSchema,
      effort: 'medium',
      maxTokens: 4_000,
    });
    prose = validateProse(out, ledger);
  }

  return { ledger, guards, prose, markdown: renderWriterBrief(ledger, guards, prose) };
}

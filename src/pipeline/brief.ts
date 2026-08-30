import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { newId } from '../core/ids.js';
import { prose } from '../core/llm.js';
import {
  connectionsSince, getEntity, getEvent, getItem, getSource, insertBrief, itemsSince,
} from '../core/store.js';
import type { Brief, Connection, Event, Thread } from '../core/types.js';
import { activeThreadsSince } from './threads.js';

/**
 * The daily brief.
 *
 * Structure is assembled in code, not by the model. The model writes prose for
 * sections whose content has already been selected and grounded, which means a
 * connection cannot appear in the brief unless it exists in the database, and
 * every claim traces back to an item with a URL.
 */

const BRIEF_SYSTEM = `You write a daily intelligence brief for one well-informed reader who wants to follow ongoing situations rather than consume headlines.

Voice: direct, concrete, unhurried. No hedging filler, no "in a significant development", no throat-clearing. Name parties and numbers. Assume the reader is intelligent and busy.

You are given pre-selected material. Write only from it. Do not add events, context, or analysis from your own knowledge - if something important is missing, that is the pipeline's problem, not yours to fill in.

For each storyline given: what moved, what it means for where the storyline is going. Two to four sentences. Do not restate the storyline's whole history.

Where a connection is given as DETERMINISTIC, it was found by joining primary records - state it as a factual pattern in the data, and say plainly what it does and does not establish.

Where a connection is given as HYPOTHESIS, it was proposed by a model and is unverified - present it as a question to check, never as a finding, and include what would falsify it.

Never assert coordination or wrongdoing. Report the pattern and let the reader draw the conclusion.`;

function fmtEvent(db: DB, e: Event): string {
  const item = getItem(db, e.itemId);
  const source = item ? getSource(db, item.sourceId) : null;
  const parties = e.entities
    .filter((en) => en.role !== 'mentioned')
    .map((en) => `${getEntity(db, en.entityId)?.name ?? '?'} (${en.role})`)
    .join(', ');
  return [
    `- ${e.occurredAt.slice(0, 10)} | ${e.summary}`,
    `  type=${e.type} assertion=${e.assertion}${parties ? ` parties=${parties}` : ''}`,
    `  source=${source?.name ?? 'unknown'} (${source?.tier ?? '?'}) ${item?.url ?? ''}`,
  ].join('\n');
}

function fmtConnection(db: DB, c: Connection): string {
  const from = getEvent(db, c.fromEventId);
  const to = getEvent(db, c.toEventId);
  if (!from || !to) return '';
  const label = c.basis === 'deterministic'
    ? 'DETERMINISTIC'
    : c.basis === 'hypothesis' ? 'HYPOTHESIS' : 'ENTITY OVERLAP';
  return [
    `- [${label}] ${c.kind} (confidence ${c.confidence.toFixed(2)}, lag ${Math.round(c.lagDays)}d)`,
    `  ${c.explanation}`,
    `  A: ${from.summary} (${from.occurredAt.slice(0, 10)})`,
    `  B: ${to.summary} (${to.occurredAt.slice(0, 10)})`,
    c.falsifier ? `  would falsify: ${c.falsifier}` : '',
  ].filter(Boolean).join('\n');
}

/** Markdown assembled in code so every claim keeps its link. */
function renderMarkdown(
  db: DB,
  forDate: string,
  narrative: string,
  threads: Thread[],
  connections: Connection[],
  stats: { items: number; events: number },
): string {
  const lines: string[] = [
    `# Brief - ${forDate}`,
    '',
    `*${stats.items} items, ${stats.events} events, ${connections.length} connections.*`,
    '',
    narrative,
    '',
  ];

  const deterministic = connections.filter((c) => c.basis === 'deterministic');
  const hypotheses = connections.filter((c) => c.basis === 'hypothesis');

  if (deterministic.length) {
    lines.push('## Patterns found in primary records', '');
    lines.push(
      '_Found by joining structured records on shared parties and dates. ' +
      'A pattern here is a fact about the data, not a finding about intent._',
      '',
    );
    for (const c of deterministic.slice(0, 15)) {
      const from = getEvent(db, c.fromEventId);
      const to = getEvent(db, c.toEventId);
      if (!from || !to) continue;
      const fromItem = getItem(db, from.itemId);
      const toItem = getItem(db, to.itemId);
      lines.push(
        `**${c.explanation}**`,
        '',
        `- ${from.occurredAt.slice(0, 10)} - ${from.summary}${fromItem ? ` ([source](${fromItem.url}))` : ''}`,
        `- ${to.occurredAt.slice(0, 10)} - ${to.summary}${toItem ? ` ([source](${toItem.url}))` : ''}`,
        `- Confidence ${c.confidence.toFixed(2)} - ${c.falsifier ?? 'no falsifier recorded'}`,
        '',
      );
    }
  }

  if (hypotheses.length) {
    lines.push('## Unverified hypotheses', '');
    lines.push(
      '_Proposed by a language model from the events above. These are questions to check, ' +
      'not findings. Each carries the observation that would show it is wrong._',
      '',
    );
    for (const c of hypotheses.slice(0, 10)) {
      lines.push(
        `- **${c.explanation}** (confidence ${c.confidence.toFixed(2)})`,
        `  - Would falsify: ${c.falsifier ?? 'none given'}`,
      );
    }
    lines.push('');
  }

  if (threads.length) {
    lines.push('## Open storylines', '');
    for (const t of threads.slice(0, 20)) {
      lines.push(`### ${t.title}`, '', t.summary || '_No synthesis yet._', '');
      if (t.openQuestions.length) {
        lines.push('Watching for:', ...t.openQuestions.map((q) => `- ${q}`), '');
      }
    }
  }

  return lines.join('\n');
}

export async function buildBrief(
  db: DB,
  cfg: Config,
  opts: { windowHours?: number; forDate?: string } = {},
): Promise<Brief> {
  const windowHours = opts.windowHours ?? 24;
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const forDate = opts.forDate ?? new Date().toISOString().slice(0, 10);

  const items = itemsSince(db, since);
  const threads = activeThreadsSince(db, since);
  const connections = connectionsSince(db, since, 0.2);

  const topConnections = [
    ...connections.filter((c) => c.basis === 'deterministic').slice(0, 15),
    ...connections.filter((c) => c.basis === 'hypothesis').slice(0, 10),
  ];

  const eventCount = threads.reduce((n, t) => n + t.eventCount, 0);

  const userPrompt = [
    `DATE: ${forDate}`,
    `WINDOW: last ${windowHours} hours`,
    '',
    'STORYLINES THAT MOVED:',
    threads.length
      ? threads.slice(0, 20).map((t) =>
        `## ${t.title}\ncurrent state: ${t.summary || '(none yet)'}\nopen questions: ${t.openQuestions.join('; ') || '(none)'}`,
      ).join('\n\n')
      : '(none)',
    '',
    'CONNECTIONS:',
    topConnections.length
      ? topConnections.map((c) => fmtConnection(db, c)).filter(Boolean).join('\n')
      : '(none)',
    '',
    'Write the narrative section only. Do not write headers for the connections or ' +
    'storylines sections - those are assembled separately. Open with what actually ' +
    'matters most in this window and why.',
  ].join('\n');

  const narrative = threads.length || topConnections.length
    ? await prose(cfg, {
      system: BRIEF_SYSTEM,
      user: userPrompt,
      effort: 'high',
      maxTokens: 16_000,
    })
    : '_Nothing ingested in this window._';

  const markdown = renderMarkdown(
    db, forDate, narrative, threads, topConnections,
    { items: items.length, events: eventCount },
  );

  const brief: Brief = {
    id: newId('brf'),
    forDate,
    windowHours,
    sections: [{
      heading: 'Narrative',
      body: narrative,
      eventIds: [],
      connectionIds: topConnections.map((c) => c.id),
      threadIds: threads.map((t) => t.id),
    }],
    markdown,
    itemCount: items.length,
    eventCount,
    connectionCount: topConnections.length,
    createdAt: new Date().toISOString(),
  };

  insertBrief(db, brief);
  return brief;
}

/** Exported for tests: markdown assembly is deterministic and worth pinning. */
export const _internal = { renderMarkdown, fmtEvent, fmtConnection };

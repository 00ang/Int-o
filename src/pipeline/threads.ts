import { z } from 'zod';
import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { newId } from '../core/ids.js';
import { structured } from '../core/llm.js';
import {
  addEventToThread, eventsSince, getEntity, getThread, listThreads, staleThreads,
  threadEvents, upsertThread,
} from '../core/store.js';
import type { Domain, Event, Thread } from '../core/types.js';
import { ThreadAssignmentsSchema, ThreadSynthesisSchema } from './schema.js';

/**
 * Threads are what turn a feed into a plot.
 *
 * An event on its own is a fact. The same event as the eleventh entry in a
 * storyline you have been following for two months is information. Everything
 * here exists to maintain that second thing.
 */

const ASSIGN_SYSTEM = `You maintain a set of ongoing storylines for a personal intelligence system.

You are given the currently active storylines and a list of new events. For each event, either attach it to the storyline it continues, or start a new one.

What a storyline is: a developing situation with continuity of actors and stakes, that a reader would want to follow over weeks or months. "US-China semiconductor export controls" is a storyline. "Technology" is not - that is a category. "Nvidia reported earnings" is an event, not a storyline.

Rules:
1. Prefer attaching to an existing storyline. A proliferation of near-duplicate threads is the main failure mode here.
2. Start a new storyline only when the event genuinely begins something, or belongs to a situation none of the existing threads cover.
3. Give new storylines a specific title naming the parties and the stakes. Not "Trade tensions" but "US tariff escalation against EU steel".
4. An event can be routine news that belongs to no storyline worth tracking. Assign it a new thread only if you would genuinely want to follow it; there is no requirement to place every event.
5. reason states what this event contributes to that storyline - what moved, not what happened.`;

const SYNTH_SYSTEM = `You maintain the running summary of one ongoing storyline for a personal intelligence system.

Given the storyline's events in chronological order, write:

- summary: where things actually stand now. Written for someone who has not been following: what is happening, who is driving it, what has changed most recently, and what is at stake. Prose, no bullets, no preamble. Prefer specifics over characterisation. Aim for 150-250 words.
- openQuestions: what to watch next. Each must be concrete enough that a future event would visibly answer it. "What happens next" is useless; "whether the Commerce Department extends the licence exemption past its March expiry" is useful.

Report only what the events support. If the events are thin, say the storyline is thin rather than padding it with background you are supplying yourself.`;

function renderEvents(db: DB, events: Event[]): string {
  return events.map((e, i) => {
    const parties = e.entities
      .filter((en) => en.role !== 'mentioned')
      .map((en) => `${getEntity(db, en.entityId)?.name ?? '?'} (${en.role})`)
      .join(', ');
    return `[${i}] ${e.occurredAt.slice(0, 10)} | ${e.type} | ${e.summary}${parties ? `\n    parties: ${parties}` : ''}`;
  }).join('\n');
}

export interface ThreadResult {
  assigned: number;
  created: number;
  synthesized: number;
  retired: number;
}

/** Events already attached to some thread, so re-runs do not reassign them. */
function unassignedEvents(db: DB, sinceIso: string, limit: number): Event[] {
  const assigned = new Set(
    (db.prepare('SELECT DISTINCT event_id FROM thread_events').all() as { event_id: string }[])
      .map((r) => r.event_id),
  );
  return eventsSince(db, sinceIso).filter((e) => !assigned.has(e.id)).slice(0, limit);
}

export async function updateThreads(
  db: DB,
  cfg: Config,
  opts: { sinceDays?: number; maxEvents?: number; dormantAfterDays?: number } = {},
): Promise<ThreadResult> {
  const { sinceDays = 3, maxEvents = 60, dormantAfterDays = 21 } = opts;
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const result: ThreadResult = { assigned: 0, created: 0, synthesized: 0, retired: 0 };

  const events = unassignedEvents(db, since, maxEvents);
  if (events.length === 0) return result;

  const active = listThreads(db, 'active', 60);
  const threadList = active.length
    ? active.map((t) => `- id=${t.id} | ${t.title} | last activity ${t.lastEventAt.slice(0, 10)}`).join('\n')
    : '(none yet)';

  const out = await structured<z.infer<typeof ThreadAssignmentsSchema>>(cfg, {
    system: ASSIGN_SYSTEM,
    user: `ACTIVE STORYLINES:\n${threadList}\n\nNEW EVENTS:\n${renderEvents(db, events)}`,
    schema: ThreadAssignmentsSchema,
    effort: 'medium',
    maxTokens: 16_000,
  });

  const now = new Date().toISOString();
  const touched = new Set<string>();
  const validIds = new Set(active.map((t) => t.id));

  for (const a of out.assignments) {
    const event = events[a.eventIndex];
    if (!event) continue;

    let threadId = a.threadId;
    // A hallucinated thread id would attach the event to nothing; treat an
    // unknown id as a request for a new thread instead of dropping the event.
    if (threadId && !validIds.has(threadId)) threadId = null;

    if (!threadId) {
      if (!a.newThreadTitle?.trim()) continue;
      threadId = newId('thr');
      const domains = [...new Set(event.domains)] as Domain[];
      upsertThread(db, {
        id: threadId,
        title: a.newThreadTitle.trim(),
        summary: '',
        openQuestions: [],
        domains,
        coreEntityIds: event.entities.filter((e) => e.role !== 'mentioned').map((e) => e.entityId),
        status: 'active',
        startedAt: event.occurredAt,
        lastEventAt: event.occurredAt,
        eventCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      validIds.add(threadId);
      result.created++;
    }

    addEventToThread(db, threadId, event.id, a.reason);
    touched.add(threadId);
    result.assigned++;
  }

  for (const threadId of touched) {
    if (await synthesizeThread(db, cfg, threadId)) result.synthesized++;
  }

  // A storyline nobody has added to in three weeks is over, or paused. Marking
  // it dormant keeps the active list readable without deleting the history.
  for (const t of staleThreads(db, dormantAfterDays)) {
    upsertThread(db, { ...t, status: 'dormant', updatedAt: now });
    result.retired++;
  }

  return result;
}

/** Rewrite one thread's rolling summary and open questions. */
export async function synthesizeThread(db: DB, cfg: Config, threadId: string): Promise<boolean> {
  const thread = getThread(db, threadId);
  if (!thread) return false;
  const events = threadEvents(db, threadId);
  if (events.length === 0) return false;

  const out = await structured<z.infer<typeof ThreadSynthesisSchema>>(cfg, {
    system: SYNTH_SYSTEM,
    user: `STORYLINE: ${thread.title}\n\nEVENTS IN ORDER:\n${renderEvents(db, events)}`,
    schema: ThreadSynthesisSchema,
    effort: 'medium',
    maxTokens: 8_000,
  });

  upsertThread(db, {
    ...thread,
    summary: out.summary,
    openQuestions: out.openQuestions,
    domains: [...new Set(events.flatMap((e) => e.domains))] as Domain[],
    updatedAt: new Date().toISOString(),
  });
  return true;
}

/** Threads with activity in the window, most recently moved first. */
export function activeThreadsSince(db: DB, sinceIso: string): Thread[] {
  return listThreads(db, 'active', 200).filter((t) => t.lastEventAt >= sinceIso);
}

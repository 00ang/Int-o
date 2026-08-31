import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import {
  getEntity, getItem, eventsForItem, eventsSharingEntities, insertConnection, searchItems,
} from '../core/store.js';
import type { Connection, Event, Item } from '../core/types.js';
import { runAllPairRules } from './detectors/deterministic.js';
import { extractItem } from './extract.js';
import { generateHypotheses } from './link.js';

/**
 * Investigation: the deliberate second look.
 *
 * Triage decides what is worth attention. This is what happens when a person
 * decides one of those items is worth their time - and it only ever runs
 * because they said so. That is the whole design: the system surfaces, the
 * person chooses, and only then does anything go digging. Nothing here runs on
 * a schedule and nothing here reaches a conclusion on its own initiative.
 *
 * It is also where the detectors belong. Run across the whole corpus they are a
 * dragnet that mostly finds nothing, because two events joining on a shared
 * party inside a date window is a rare shape. Pointed at one story, asking
 * "does anything else in three thousand ingested items touch these parties",
 * they are answering a question somebody actually asked.
 *
 * "Nothing found" is a first-class result. Most investigations should end
 * there, and an investigation that always finds something is not an
 * investigation.
 */
export interface Investigation {
  item: Item;
  /** Events extracted from the item itself. */
  events: Event[];
  /** Events elsewhere in the corpus sharing a party with this story. */
  related: Event[];
  /** Other ingested items mentioning the same parties. Raw material, unextracted. */
  relatedItems: Item[];
  /** Deterministic detector hits confined to this story's events. */
  connections: Connection[];
  /** Model-proposed links, capped and each carrying a falsifier. Only with -H. */
  hypotheses: Connection[];
  /** Set when the item had to be extracted first. */
  extractedNow: boolean;
}

/**
 * An entity name as a literal FTS5 phrase.
 *
 * Party names are full of characters FTS5 reads as operators - the periods in
 * "U.S. Department of State", hyphens, ampersands - so an unquoted name is a
 * syntax error rather than a search. Double quotes make it a phrase, and the
 * internal quotes that appear in some corporate names are doubled to escape.
 */
function ftsPhrase(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Parties specific enough to be worth searching the corpus for.
 *
 * Two exclusions, both learned the hard way. Countries and places match
 * everything: searching "United States" over a corpus of American government
 * records returns the Federal Register's boilerplate, not the story's
 * counterparties. And an entity the source declined to name - "an unnamed
 * private company" - is a real and useful thing for extraction to have
 * recorded, but there is nothing to search for.
 */
const SEARCHABLE_KINDS = new Set(['person', 'company', 'organization', 'government-body']);

function principals(db: DB, events: Event[]): string[] {
  const names = new Set<string>();
  for (const e of events) {
    for (const en of e.entities) {
      if (en.role === 'mentioned') continue;
      const ent = getEntity(db, en.entityId);
      if (!ent || !SEARCHABLE_KINDS.has(ent.kind)) continue;
      if (/^(an? |the )?(unnamed|unidentified|undisclosed|anonymous)\b/i.test(ent.name)) continue;
      names.add(ent.name);
    }
  }
  return [...names];
}

export async function investigate(
  db: DB,
  cfg: Config,
  itemId: string,
  opts: { windowDays?: number; hypotheses?: boolean } = {},
): Promise<Investigation> {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`No item ${itemId}.`);

  const windowDays = opts.windowDays ?? 180;

  // An item reaching investigation has earned extraction, whether or not the
  // batch queue has got to it yet.
  let extractedNow = false;
  if (item.extractedAt === null) {
    const r = await extractItem(db, cfg, item);
    if (r.error) throw new Error(`Could not extract this item: ${r.error}`);
    extractedNow = true;
  }

  const events = eventsForItem(db, item.id);
  if (events.length === 0) {
    return {
      item, events: [], related: [], relatedItems: [], connections: [], hypotheses: [], extractedNow,
    };
  }

  // Everything in the corpus that touches the same parties inside the window.
  const relatedById = new Map<string, Event>();
  for (const e of events) {
    for (const r of eventsSharingEntities(db, e.id, windowDays)) relatedById.set(r.id, r);
  }
  const related = [...relatedById.values()];

  // The detectors, scoped. runAllPairRules is the tested path, so we run it and
  // keep only the hits that actually involve this story rather than
  // reimplementing the join with a narrower WHERE clause.
  const ours = new Set([...events, ...related].map((e) => e.id));
  const oldest = [...events, ...related]
    .map((e) => e.occurredAt)
    .sort()[0] ?? item.publishedAt;
  const connections = runAllPairRules(db, oldest)
    .filter((c) => ours.has(c.fromEventId) && ours.has(c.toEventId))
    .filter((c) => events.some((e) => e.id === c.fromEventId || e.id === c.toEventId));
  for (const c of connections) insertConnection(db, c);

  // Full-text over the corpus for the parties themselves. This is the half the
  // detectors cannot do: an item nobody has extracted yet is invisible to a
  // join over events, but it is still sitting there and still searchable.
  const relatedItems: Item[] = [];
  const seenItems = new Set<string>([item.id]);
  for (const name of principals(db, events).slice(0, 8)) {
    for (const hit of searchItems(db, ftsPhrase(name), 8)) {
      if (seenItems.has(hit.id)) continue;
      seenItems.add(hit.id);
      relatedItems.push(hit);
    }
  }

  let hypotheses: Connection[] = [];
  if (opts.hypotheses && related.length > 0) {
    hypotheses = await generateHypotheses(db, cfg, [...events, ...related].slice(0, 40));
    for (const h of hypotheses) insertConnection(db, h);
  }

  return { item, events, related, relatedItems, connections, hypotheses, extractedNow };
}

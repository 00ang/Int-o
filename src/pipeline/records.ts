import type { DB } from '../core/db.js';
import { stableId } from '../core/ids.js';
import { insertEvent, resolveEntity } from '../core/store.js';
import type { Domain, Event, EventEntity, Item } from '../core/types.js';

/**
 * Events written straight from structured records, with no model involved.
 *
 * A contract award row already names the agency, the recipient, the amount and
 * the day it was signed. Asking a model to read those back out costs an
 * extraction call per award and can only lose precision - and gating the row
 * on triage first was worse, because a routine award reads as mundane news and
 * is exactly the join material the detectors need.
 */

interface AwardRaw {
  'Award ID'?: string;
  'Recipient Name'?: string;
  'Award Amount'?: number;
  'Awarding Agency'?: string;
  'Awarding Sub Agency'?: string;
  'Start Date'?: string;
  'Base Obligation Date'?: string;
  'Description'?: string;
  'Contract Award Type'?: string;
}

const DEFENSE = /defen[cs]e|army|navy|air force|marine corps|space force|missile|darpa/i;

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** The award as an event, or null when the row lacks what an event needs. */
export function awardEvent(db: DB, item: Item): Event | null {
  const a = (item.raw ?? {}) as AwardRaw;
  const recipientName = a['Recipient Name']?.trim();
  if (!recipientName) return null;

  // The sub-agency is the office that actually awarded it; the department is
  // too broad to say anything about who decided.
  const agencyName = (a['Awarding Sub Agency'] || a['Awarding Agency'])?.trim() || null;
  const signed = a['Base Obligation Date'];

  const entities: EventEntity[] = [];
  if (agencyName) {
    const agency = resolveEntity(db, {
      name: agencyName, kind: 'government-body', country: 'US', seenAt: item.publishedAt,
    });
    entities.push({ entityId: agency.id, role: 'actor', surfaceForm: agencyName });
  }
  const recipient = resolveEntity(db, {
    name: recipientName, kind: 'company', seenAt: item.publishedAt,
  });
  entities.push({ entityId: recipient.id, role: 'beneficiary', surfaceForm: recipientName });

  const amount = a['Award Amount'] ?? null;
  // Award descriptions arrive in capitals; lowered, they read as a clause.
  const what = a.Description?.trim().toLowerCase();
  const summary =
    `${agencyName ?? 'A US government agency'} awarded ${recipientName} ` +
    `${amount ? `a ${usd(amount)} contract` : 'a contract'}` +
    `${what ? ` for ${what.length > 140 ? `${what.slice(0, 140)}...` : what}` : ''}.`;

  const domains: Domain[] = ['business'];
  if (DEFENSE.test(`${a['Awarding Agency'] ?? ''} ${a['Awarding Sub Agency'] ?? ''}`)) {
    domains.push('defense');
  }

  return {
    id: stableId('evt', item.id, 'award'),
    itemId: item.id,
    type: 'government-award',
    summary,
    occurredAt: item.publishedAt,
    // Rows fetched before the search asked for the signature date carry only a
    // performance start, which can be years off. Say so rather than pass it as fact.
    occurredAtInferred: !signed,
    domains,
    entities,
    amount: amount ? { value: amount, currency: 'USD' } : null,
    tags: [
      a['Award ID'] ? `award:${a['Award ID']}` : '',
      a['Contract Award Type'] ?? '',
      'usaspending',
    ].filter(Boolean),
    assertion: 'documented',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Write whatever events a newly inserted structured item carries.
 *
 * Called only for items that were new on this fetch, because entity resolution
 * counts mentions and a re-served row must not count twice.
 */
export function writeRecordEvents(db: DB, item: Item, sourceKind: string): number {
  if (sourceKind !== 'usaspending') return 0;
  const event = awardEvent(db, item);
  if (!event) return 0;
  insertEvent(db, event);
  return 1;
}

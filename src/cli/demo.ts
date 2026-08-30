import type { DB } from '../core/db.js';
import { insertEvent, insertItem, resolveEntity, upsertSource } from '../core/store.js';
import type { Event, EventEntity, Item, Source } from '../core/types.js';

/**
 * A synthetic corpus that exercises the connection engine without the network
 * or an API key.
 *
 * The two scenarios are the ones this system was built to catch: a disclosed
 * position ahead of public money, and a policy action ahead of a private gain.
 * Everything here is invented. The names are fictional on purpose - the point
 * is to show the machinery working, not to make a claim about anyone.
 */

const src = (id: string, name: string, tier: Source['tier']): Source => ({
  id, name, kind: 'rss', url: `https://example.invalid/${id}`, tier,
  domains: ['politics'], origin: 'US', intervalMinutes: 1440,
  verified: false, enabled: false, notes: 'Synthetic demo source.',
});

const day = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString();

function mkItem(id: string, sourceId: string, title: string, publishedAt: string): Item {
  return {
    id, sourceId, externalId: id, url: `https://example.invalid/${id}`,
    title, summary: title, body: null, author: null,
    publishedAt, fetchedAt: new Date().toISOString(), raw: null,
    extractedAt: new Date().toISOString(), extractionError: null,
  };
}

function mkEvent(
  id: string, itemId: string, type: Event['type'], summary: string,
  occurredAt: string, entities: EventEntity[], over: Partial<Event> = {},
): Event {
  return {
    id, itemId, type, summary, occurredAt, occurredAtInferred: false,
    domains: ['defense'], entities, amount: null, tags: [],
    assertion: 'documented', createdAt: new Date().toISOString(), ...over,
  };
}

export function seedDemo(db: DB): { items: number; events: number } {
  upsertSource(db, src('demo-edgar', 'SEC EDGAR (demo)', 'primary'));
  upsertSource(db, src('demo-awards', 'USASpending (demo)', 'primary'));
  upsertSource(db, src('demo-register', 'Federal Register (demo)', 'primary'));
  upsertSource(db, src('demo-wire', 'Wire service (demo)', 'wire'));

  const contractor = resolveEntity(db, {
    name: 'Meridian Aerospace Corp', kind: 'company', ticker: 'MRDN',
  });
  const insider = resolveEntity(db, { name: 'Dana Whitfield', kind: 'person' });
  const packer = resolveEntity(db, { name: 'Cattleman United Processing', kind: 'company' });
  const usda = resolveEntity(db, { name: 'US Department of Agriculture', kind: 'government-body' });

  // Scenario 1: a disclosed position, then a contract award to the same firm.
  const items: Item[] = [
    mkItem('demo-i1', 'demo-edgar', 'Form 4 filed for Meridian Aerospace Corp', day(-21)),
    mkItem('demo-i2', 'demo-awards', 'Army awards Meridian Aerospace $412M sustainment contract', day(-9)),
    // Scenario 2: a rule naming a beneficiary, then that party's gain.
    mkItem('demo-i3', 'demo-register', 'USDA adjusts beef tariff-rate quota', day(-30)),
    mkItem('demo-i4', 'demo-wire', 'Cattleman United reports record quarterly margin', day(-4)),
  ];
  for (const i of items) insertItem(db, i);

  const events: Event[] = [
    mkEvent(
      'demo-e1', 'demo-i1', 'securities-trade',
      'Dana Whitfield disclosed a purchase of Meridian Aerospace Corp stock.',
      day(-21),
      [
        { entityId: insider.id, role: 'actor', surfaceForm: 'Dana Whitfield' },
        { entityId: contractor.id, role: 'target', surfaceForm: 'MRDN' },
      ],
      { amount: { value: 250_000, currency: 'USD' } },
    ),
    mkEvent(
      'demo-e2', 'demo-i2', 'government-award',
      'The US Army awarded Meridian Aerospace Corp a $412 million sustainment contract.',
      day(-9),
      [{ entityId: contractor.id, role: 'beneficiary', surfaceForm: 'Meridian Aerospace' }],
      { amount: { value: 412_000_000, currency: 'USD' } },
    ),
    mkEvent(
      'demo-e3', 'demo-i3', 'policy-action',
      'The USDA raised the tariff-rate quota for imported beef, easing input costs for domestic processors.',
      day(-30),
      [
        { entityId: usda.id, role: 'regulator', surfaceForm: 'USDA' },
        { entityId: packer.id, role: 'beneficiary', surfaceForm: 'domestic processors' },
      ],
      { domains: ['politics', 'business'] },
    ),
    mkEvent(
      'demo-e4', 'demo-i4', 'corporate-action',
      'Cattleman United Processing reported its highest quarterly margin on record.',
      day(-4),
      [{ entityId: packer.id, role: 'actor', surfaceForm: 'Cattleman United' }],
      { domains: ['business'], assertion: 'reported' },
    ),
  ];
  for (const e of events) insertEvent(db, e);

  return { items: items.length, events: events.length };
}

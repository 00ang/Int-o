import type { DB } from '../core/db.js';
import { stableId } from '../core/ids.js';
import { insertEvent, resolveEntity } from '../core/store.js';
import type { Domain, EntityKind, Event, EventEntity, Item } from '../core/types.js';
import {
  lobbyingAmount, lobbyingDate, quarterLabel, revolvingDoor, targetsOf, type LobbyingFiling,
} from '../sources/lobbying.js';
import type { Form4Filing } from '../sources/sec-form4.js';

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

/** Short forms a contract description uses that must stay in capitals. */
const ACRONYM = /^(IT|AI|GPS|UAS|UAV|USAF|USN|USMC|NASA|FAA|DOD|C4ISR|ISR|IDIQ|R&D|MRO|HVAC|LNG|US)$/;

/**
 * Award descriptions arrive in capitals. Lowered, they read as a clause - but
 * "MH-60" and "IT" are names, and lowering them turns them into typos.
 */
export function clauseCase(text: string): string {
  if (text !== text.toUpperCase()) return text;
  return text.split(/(\s+)/).map((w) => {
    const bare = w.replace(/[^A-Za-z0-9&]/g, '');
    return /\d/.test(w) || ACRONYM.test(bare) ? w : w.toLowerCase();
  }).join('');
}

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
  const what = a.Description ? clauseCase(a.Description.trim()) : undefined;
  // The party's display name: if the corpus already knows this company by its
  // ordinary spelling, the award reads that way too.
  const summary =
    `${agencyName ?? 'A US government agency'} awarded ${recipient.name} ` +
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

// ---------------------------------------------------------------------------
// Insider trades (Form 4)
// ---------------------------------------------------------------------------

/**
 * One event per open-market trade day: the insider as actor, the company as
 * target - the shape trade-then-award and insider-then-news already join on.
 */
export function insiderEvents(db: DB, item: Item): Event[] {
  const f = item.raw as unknown as Form4Filing | null;
  if (!f?.issuer?.name || !f.trades?.length) return [];

  const issuer = resolveEntity(db, {
    name: f.issuer.name, kind: 'company', ticker: f.issuer.ticker, cik: f.issuer.cik,
    country: 'US', seenAt: item.publishedAt,
  });
  const owners = f.owners.map((o) => ({
    o,
    ent: resolveEntity(db, {
      name: o.name,
      kind: o.isCompany ? 'company' : 'person',
      aliases: o.filedName !== o.name ? [o.filedName] : [],
      cik: o.cik,
      description: o.isCompany || !o.role ? null : `${o.role}, ${f.issuer.name}`,
      seenAt: item.publishedAt,
    }),
  }));

  const who = f.owners.length <= 2
    ? f.owners.map((o) => `${o.name}${o.role ? ` (${o.role})` : ''}`).join(' and ')
    : `${f.owners[0]!.name}${f.owners[0]!.role ? ` (${f.owners[0]!.role})` : ''} and ${f.owners.length - 1} other insiders`;
  const company = `${f.issuer.name}${f.issuer.ticker ? ` (${f.issuer.ticker})` : ''}`;
  const roleTags = [
    f.owners.some((o) => o.isOfficer) ? 'officer' : '',
    f.owners.some((o) => o.isDirector) ? 'director' : '',
    f.owners.some((o) => o.isTenPercentOwner) ? '10%-owner' : '',
  ].filter(Boolean);

  return f.trades.map((t) => {
    const entities: EventEntity[] = [
      ...owners.map(({ o, ent }) => ({ entityId: ent.id, role: 'actor' as const, surfaceForm: o.filedName })),
      { entityId: issuer.id, role: 'target' as const, surfaceForm: f.issuer.name },
    ];
    const summary =
      `${who} ${t.code === 'P' ? 'bought' : 'sold'} ${t.shares.toLocaleString('en-US')} shares of ${company}` +
      `${t.avgPrice ? ` at about $${t.avgPrice.toFixed(2)}` : ''}${t.value ? `, ${usd(t.value)} in all` : ''}` +
      `${t.indirect ? ', held indirectly' : ''}` +
      `${f.tenb51 ? ', under a pre-arranged 10b5-1 trading plan' : ''}.`;
    return {
      id: stableId('evt', item.id, 'form4', t.date, t.code),
      itemId: item.id,
      type: 'securities-trade',
      summary,
      occurredAt: `${t.date}T12:00:00.000Z`,
      occurredAtInferred: false,
      domains: ['markets', 'business'],
      entities,
      amount: t.value ? { value: t.value, currency: 'USD' } : null,
      tags: [
        'form-4', 'insider-trade', `code:${t.code}`,
        ...(f.tenb51 ? ['10b5-1'] : []),
        ...roleTags,
        ...(f.issuer.ticker ? [f.issuer.ticker] : []),
      ],
      assertion: 'documented',
      createdAt: new Date().toISOString(),
    } satisfies Event;
  });
}

// ---------------------------------------------------------------------------
// Lobbying (Senate LDA)
// ---------------------------------------------------------------------------

/** Corporate form in the name: the difference between a company and an association. */
const CORPORATE = /\b(inc|incorporated|corp|corporation|co|company|llc|l\.l\.c|lp|llp|ltd|limited|plc|holdings?|technologies|n\.v|s\.a|ag|gmbh)\b\.?/i;

/**
 * Companies resolve as companies so a client joins to the same firm's
 * contracts and trades; trade associations, unions, cities and universities are
 * organisations.
 */
export const partyKind = (name: string): EntityKind => (CORPORATE.test(name) ? 'company' : 'organization');

export function lobbyingEvent(db: DB, item: Item): Event | null {
  const f = item.raw as unknown as LobbyingFiling | null;
  if (!f?.client || !f.registrant) return null;
  const seenAt = item.publishedAt;

  // The client is who the lobbying is for: the party that stands to gain,
  // and the side lobbying-then-award and lobbying-then-policy join on.
  const entities: EventEntity[] = [];
  const client = resolveEntity(db, {
    name: f.client, kind: partyKind(f.client), description: f.clientDescription, seenAt,
  });
  entities.push({ entityId: client.id, role: 'beneficiary', surfaceForm: f.client });
  let firmEntity: { name: string } | null = null;
  if (!f.inHouse) {
    const firm = resolveEntity(db, { name: f.registrant, kind: partyKind(f.registrant), seenAt });
    entities.push({ entityId: firm.id, role: 'actor', surfaceForm: f.registrant });
    firmEntity = firm;
  }
  const { agencies, congress } = targetsOf(f);
  for (const name of agencies.slice(0, 8)) {
    const body = resolveEntity(db, { name, kind: 'government-body', country: 'US', seenAt });
    entities.push({ entityId: body.id, role: 'target', surfaceForm: name });
  }
  const door = revolvingDoor(f);
  for (const l of door.slice(0, 6)) {
    const person = resolveEntity(db, {
      name: l.name, kind: 'person', description: `Lobbyist; formerly ${l.coveredPosition}`, seenAt,
    });
    entities.push({ entityId: person.id, role: 'actor', surfaceForm: l.name });
  }

  const amount = lobbyingAmount(f);
  const q = quarterLabel(f);
  const contacted = [congress ? 'Congress' : '', ...agencies.slice(0, 2)].filter(Boolean);
  const where = contacted.length
    ? ` ${contacted.length > 1 ? `${contacted.slice(0, -1).join(', ')} and ${contacted[contacted.length - 1]}` : contacted[0]}`
    : '';
  const described = f.activities.find((a) => a.description)?.description ?? null;
  // Read as a clause after "on": "export controls", but "H.R. 8070" and "FAA" as written.
  const first = described && /^[A-Z][a-z]/.test(described)
    ? described[0]!.toLowerCase() + described.slice(1)
    : described;
  const about = first
    ? ` on ${first.length > 140 ? `${first.slice(0, 140)}...` : first}`
    : f.activities.length
      ? ` on ${[...new Set(f.activities.map((a) => a.issue).filter(Boolean))].slice(0, 3).join(', ').toLowerCase()}`
      : '';
  const doorClause = door.length
    ? `; its lobbyists include ${door[0]!.name}, formerly ${door[0]!.coveredPosition}` +
      `${door.length > 1 ? `, and ${door.length - 1} more former officials` : ''}`
    : '';

  // Display names from the resolved parties, so a client the corpus already
  // knows by its ordinary spelling is not shouted in capitals here.
  const clientName = client.name;
  const firmName = firmEntity?.name ?? f.registrant;
  let lead: string;
  if (f.filingType === 'RR') {
    lead = f.inHouse
      ? `${clientName} registered to lobby${where} on its own behalf`
      : `${firmName} registered to lobby${where} for ${clientName}`;
  } else {
    const paid = amount !== null ? usd(amount) : 'an unreported sum';
    lead = f.inHouse
      ? `${clientName} spent ${paid} lobbying${where}${q ? ` in ${q}` : ''}`
      : `${clientName} paid ${firmName} ${paid} to lobby${where}${q ? ` in ${q}` : ''}`;
  }

  const domains = new Set<Domain>(['politics']);
  const codes = f.activities.map((a) => a.issueCode ?? '');
  if (codes.some((c) => /^(DEF|HOM|INT|AER)$/.test(c))) domains.add('defense');
  if (codes.some((c) => /^(ENG|FUE|NAT|UTI)$/.test(c))) domains.add('energy');
  if (codes.some((c) => /^(TAX|BUD|FIN|BAN|TRD)$/.test(c))) domains.add('business');
  if (codes.some((c) => /^(CPI|SCI|TEC|TEL|CPT)$/.test(c))) domains.add('tech');

  return {
    id: stableId('evt', item.id, 'lobbying'),
    itemId: item.id,
    type: 'lobbying',
    summary: `${lead}${about}${doorClause}.`,
    occurredAt: lobbyingDate(f),
    occurredAtInferred: false,
    domains: [...domains],
    entities,
    amount: amount !== null ? { value: amount, currency: 'USD' } : null,
    tags: [
      'lda',
      f.filingType === 'RR' ? 'lobbying-registration' : 'lobbying-report',
      ...(q ? [`period:${q.replace(' ', '-')}`] : []),
      ...(door.length ? ['revolving-door'] : []),
      ...(f.inHouse ? ['in-house'] : []),
      ...[...new Set(codes.filter(Boolean))].map((c) => `issue:${c}`),
    ],
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
  let events: Event[] = [];
  if (sourceKind === 'usaspending') events = [awardEvent(db, item)].filter((e): e is Event => !!e);
  else if (sourceKind === 'sec-form4') events = insiderEvents(db, item);
  else if (sourceKind === 'lobbying') events = [lobbyingEvent(db, item)].filter((e): e is Event => !!e);
  for (const e of events) insertEvent(db, e);
  return events.length;
}

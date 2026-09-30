import type { DB } from '../core/db.js';
import {
  connectionsForEvent, eventsForItem, getEntity, getEvent, getItem, getSource,
} from '../core/store.js';
import type { Connection, ConnectionBasis, EntityKind, Event } from '../core/types.js';

/**
 * A story as plain text, to paste into a group chat.
 *
 * Everything on the card is read from what is already on file - the triage
 * angle, the extracted events, the connections found and the dossiers written -
 * so making one costs nothing and cannot say anything the database does not.
 * The labels travel with it: a model's guess reads as one, and every link
 * carries what would show it wrong, so the card cannot be forwarded into
 * something firmer than it is.
 *
 * Plain text rather than markdown, because the places it gets pasted mostly do
 * not render markdown and asterisks read as noise.
 */

const BASIS_LABEL: Record<ConnectionBasis, string> = {
  deterministic: 'public records',
  'entity-overlap': 'same party, two sources',
  hypothesis: "model's guess, unverified",
};

const ASSERTION_LABEL: Record<string, string> = {
  documented: 'on the record',
  reported: 'reported',
  alleged: 'alleged',
  speculated: 'speculation',
};

/** Parties worth naming. Countries and places are backdrop, not players. */
const PLAYER_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>([
  'person', 'organization', 'government-body', 'company', 'financial-instrument',
]);

const MAX_EVENTS = 5;
const MAX_CONNECTIONS = 5;
const MAX_PARTIES = 5;

const day = (iso: string) => iso.slice(0, 10);

/** First sentence, bounded, so one dossier cannot swallow the card. */
function firstSentence(text: string, max = 220): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  const s = m?.[1] ?? t;
  return s.length > max ? `${s.slice(0, max - 3).trimEnd()}...` : s;
}

function otherSide(db: DB, c: Connection, ownIds: Set<string>): Event | null {
  const otherId = ownIds.has(c.fromEventId) ? c.toEventId : c.fromEventId;
  return ownIds.has(otherId) ? null : getEvent(db, otherId);
}

export function buildCard(db: DB, itemId: string): string | null {
  const item = getItem(db, itemId);
  if (!item) return null;
  const source = getSource(db, item.sourceId);
  const events = eventsForItem(db, itemId);
  const ownIds = new Set(events.map((e) => e.id));

  const lines: string[] = [];
  const topic = item.triageTopic && item.triageTopic !== 'structured record' ? item.triageTopic : null;
  if (topic) lines.push(topic.toUpperCase());
  lines.push(item.title);
  lines.push(
    [source?.name ?? item.sourceId, source?.tier ? `${source.tier} source` : null, day(item.publishedAt)]
      .filter(Boolean).join(' · '),
  );
  lines.push(item.url);

  if (item.triageAngle || item.triageReason) {
    lines.push('');
    if (item.triageAngle) lines.push(`The angle: ${item.triageAngle}`);
    if (item.triageReason && item.triageVerdict !== 'mundane') lines.push(`Why it stood out: ${item.triageReason}`);
  }

  if (events.length) {
    lines.push('', 'What happened');
    for (const e of events.slice(0, MAX_EVENTS)) {
      lines.push(`• ${day(e.occurredAt)}: ${e.summary} (${ASSERTION_LABEL[e.assertion] ?? e.assertion})`);
    }
  }

  // Connections from any of this story's events, strongest first, skipping any
  // you have already judged a coincidence or wrong.
  const seen = new Set<string>();
  const conns: Connection[] = [];
  for (const e of events) {
    for (const c of connectionsForEvent(db, e.id)) {
      if (seen.has(c.id) || c.verdict === 'wrong' || c.verdict === 'coincidence') continue;
      seen.add(c.id);
      conns.push(c);
    }
  }
  const rank = (c: Connection) => (c.basis === 'deterministic' ? 2 : c.basis === 'hypothesis' ? 1 : 0);
  conns.sort((a, b) => rank(b) - rank(a) || b.confidence - a.confidence);

  if (conns.length) {
    lines.push('', 'Connections');
    for (const c of conns.slice(0, MAX_CONNECTIONS)) {
      lines.push(`• [${BASIS_LABEL[c.basis]}] ${c.explanation}${c.verdict === 'sound' ? ' (you marked this sound)' : ''}`);
      const other = otherSide(db, c, ownIds);
      if (other) {
        const otherItem = getItem(db, other.itemId);
        lines.push(`  Linked to, ${day(other.occurredAt)}: ${other.summary}${otherItem ? ` ${otherItem.url}` : ''}`);
      }
      if (c.falsifier) lines.push(`  Would be wrong if: ${c.falsifier}`);
    }
  }

  // The players, in the order the story names them, with background where a
  // dossier exists. Background is recalled, not recorded, and says so.
  const parties: string[] = [];
  const seenParty = new Set<string>();
  for (const e of events) {
    for (const en of e.entities) {
      if (en.role === 'mentioned' || seenParty.has(en.entityId)) continue;
      const ent = getEntity(db, en.entityId);
      if (!ent || !PLAYER_KINDS.has(ent.kind)) continue;
      seenParty.add(en.entityId);
      const profile = db.prepare('SELECT summary FROM entity_profiles WHERE entity_id = ?')
        .get(en.entityId) as { summary: string } | undefined;
      const about = profile?.summary
        ? `${firstSentence(profile.summary)} (background, unverified)`
        : ent.description ?? null;
      parties.push(`• ${ent.name}${ent.ticker ? ` (${ent.ticker})` : ''}${about ? `: ${about}` : ''}`);
      if (parties.length >= MAX_PARTIES) break;
    }
    if (parties.length >= MAX_PARTIES) break;
  }
  if (parties.length) lines.push('', "Who's involved", ...parties);

  lines.push('', 'via all-int · machine judgement about where to look, not a finding');
  return lines.join('\n');
}

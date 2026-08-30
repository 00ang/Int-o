import type { DB } from '../../core/db.js';
import { stableId } from '../../core/ids.js';
import { TIER_WEIGHT, type Connection, type Tier } from '../../core/types.js';
import { PAIR_RULES, type PairRule } from './rules.js';

/**
 * How firmly the underlying sources establish each side of a link.
 * A pattern joining two filings is worth more than one joining two op-eds.
 */
const ASSERTION_WEIGHT: Record<string, number> = {
  documented: 1.0,
  reported: 0.85,
  alleged: 0.5,
  speculated: 0.25,
};

interface PairRow {
  from_id: string;
  to_id: string;
  entity_id: string;
  entity_name: string;
  lag_days: number;
  from_assertion: string;
  to_assertion: string;
  from_tier: Tier;
  to_tier: Tier;
  from_summary: string;
  to_summary: string;
}

/**
 * Confidence for a deterministic link.
 *
 * Deliberately not model-authored. It is the rule's ceiling, discounted by how
 * well the sources establish each side and by how loose the timing is. A
 * pattern at the very edge of a 90-day window is much weaker evidence than the
 * same pattern three days apart, and the score should say so.
 */
export function scorePair(rule: PairRule, row: PairRow): number {
  const evidence =
    (ASSERTION_WEIGHT[row.from_assertion] ?? 0.5) * (ASSERTION_WEIGHT[row.to_assertion] ?? 0.5);
  const provenance = (TIER_WEIGHT[row.from_tier] ?? 0.5) * (TIER_WEIGHT[row.to_tier] ?? 0.5);

  // Linear decay across the window, floored so a late-but-real pattern still
  // surfaces rather than scoring to nothing.
  const span = Math.max(rule.maxLagDays - rule.minLagDays, 1);
  const tightness = 1 - Math.min(Math.max(row.lag_days - rule.minLagDays, 0) / span, 1);
  const timing = 0.5 + 0.5 * tightness;

  return Number((rule.baseConfidence * evidence * provenance * timing).toFixed(4));
}

const roleClause = (roles: string[], alias: string) =>
  roles.length ? `AND ${alias}.role IN (${roles.map(() => '?').join(',')})` : '';

/**
 * Find every event pair matching one rule.
 *
 * The join is on a shared canonical entity, which is why entity resolution
 * matters so much: if "Lockheed Martin Corp." and "Lockheed Martin" resolve to
 * two entities, this finds nothing.
 */
export function runPairRule(db: DB, rule: PairRule, sinceIso: string): Connection[] {
  const sql = `
    SELECT DISTINCT
      a.id AS from_id, b.id AS to_id,
      ent.id AS entity_id, ent.name AS entity_name,
      julianday(b.occurred_at) - julianday(a.occurred_at) AS lag_days,
      a.assertion AS from_assertion, b.assertion AS to_assertion,
      sa.tier AS from_tier, sb.tier AS to_tier,
      a.summary AS from_summary, b.summary AS to_summary
    FROM events a
    JOIN event_entities ea ON ea.event_id = a.id
    JOIN entities ent      ON ent.id = ea.entity_id
    JOIN event_entities eb ON eb.entity_id = ea.entity_id
    JOIN events b          ON b.id = eb.event_id
    JOIN items ia ON ia.id = a.item_id
    JOIN items ib ON ib.id = b.item_id
    JOIN sources sa ON sa.id = ia.source_id
    JOIN sources sb ON sb.id = ib.source_id
    WHERE a.id <> b.id
      AND a.type IN (${rule.fromTypes.map(() => '?').join(',')})
      AND b.type IN (${rule.toTypes.map(() => '?').join(',')})
      ${roleClause(rule.fromRoles, 'ea')}
      ${roleClause(rule.toRoles, 'eb')}
      AND (julianday(b.occurred_at) - julianday(a.occurred_at)) BETWEEN ? AND ?
      AND b.occurred_at >= ?
      -- Entities that appear everywhere ("United States", "Congress") join
      -- unrelated events into noise; a link needs a specific shared party.
      AND ent.kind IN ('company', 'organization', 'person', 'financial-instrument')
    ORDER BY lag_days ASC
    LIMIT 500
  `;

  const params = [
    ...rule.fromTypes, ...rule.toTypes,
    ...rule.fromRoles, ...rule.toRoles,
    rule.minLagDays, rule.maxLagDays, sinceIso,
  ];

  const rows = db.prepare(sql).all(...params) as PairRow[];
  const now = new Date().toISOString();

  return rows.map((row) => ({
    id: stableId('con', rule.id, row.from_id, row.to_id, row.entity_id),
    kind: rule.kind,
    basis: 'deterministic' as const,
    fromEventId: row.from_id,
    toEventId: row.to_id,
    explanation: rule.template(row.entity_name, row.lag_days),
    falsifier: rule.falsifier(row.entity_name),
    confidence: scorePair(rule, row),
    lagDays: Number(row.lag_days.toFixed(2)),
    sharedEntityIds: [row.entity_id],
    producedBy: rule.id,
    createdAt: now,
    verdict: 'unreviewed' as const,
  }));
}

export function runAllPairRules(db: DB, sinceIso: string): Connection[] {
  return PAIR_RULES.flatMap((rule) => runPairRule(db, rule, sinceIso));
}

/**
 * Entity-overlap links: two events close in time sharing a specific entity,
 * where no typed rule fired.
 *
 * This is recall, not insight. It exists so a storyline holds together across
 * sources, and it is scored low on purpose - it says "these concern the same
 * party", nothing more.
 */
export function runEntityOverlap(
  db: DB,
  sinceIso: string,
  opts: { windowDays?: number; maxMentions?: number; limit?: number } = {},
): Connection[] {
  const { windowDays = 7, maxMentions = 50, limit = 300 } = opts;

  const rows = db.prepare(`
    SELECT DISTINCT
      a.id AS from_id, b.id AS to_id,
      ent.id AS entity_id, ent.name AS entity_name,
      julianday(b.occurred_at) - julianday(a.occurred_at) AS lag_days,
      a.assertion AS from_assertion, b.assertion AS to_assertion,
      sa.tier AS from_tier, sb.tier AS to_tier
    FROM events a
    JOIN event_entities ea ON ea.event_id = a.id
    JOIN entities ent      ON ent.id = ea.entity_id
    JOIN event_entities eb ON eb.entity_id = ea.entity_id
    JOIN events b          ON b.id = eb.event_id
    JOIN items ia ON ia.id = a.item_id
    JOIN items ib ON ib.id = b.item_id
    JOIN sources sa ON sa.id = ia.source_id
    JOIN sources sb ON sb.id = ib.source_id
    WHERE a.id < b.id
      AND (julianday(b.occurred_at) - julianday(a.occurred_at)) BETWEEN 0 AND ?
      AND b.occurred_at >= ?
      AND ent.kind IN ('company', 'organization', 'person', 'policy')
      -- Skip entities so common they connect everything to everything.
      AND ent.mention_count <= ?
      AND ia.source_id <> ib.source_id
    ORDER BY ent.mention_count ASC, lag_days ASC
    LIMIT ?
  `).all(windowDays, sinceIso, maxMentions, limit) as PairRow[];

  const now = new Date().toISOString();
  return rows.map((row) => {
    const evidence =
      (ASSERTION_WEIGHT[row.from_assertion] ?? 0.5) * (ASSERTION_WEIGHT[row.to_assertion] ?? 0.5);
    const provenance = (TIER_WEIGHT[row.from_tier] ?? 0.5) * (TIER_WEIGHT[row.to_tier] ?? 0.5);
    return {
      id: stableId('con', 'entity-overlap', row.from_id, row.to_id, row.entity_id),
      kind: 'shared-actor' as const,
      basis: 'entity-overlap' as const,
      fromEventId: row.from_id,
      toEventId: row.to_id,
      explanation: `Both concern ${row.entity_name}, ${Math.round(row.lag_days)} days apart, reported independently.`,
      falsifier: null,
      confidence: Number((0.35 * evidence * provenance).toFixed(4)),
      lagDays: Number(row.lag_days.toFixed(2)),
      sharedEntityIds: [row.entity_id],
      producedBy: 'entity-overlap',
      createdAt: now,
      verdict: 'unreviewed' as const,
    };
  });
}

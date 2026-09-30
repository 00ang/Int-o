import type { ConnectionKind, EntityRole, EventType } from '../../core/types.js';

/**
 * Deterministic pair rules.
 *
 * Each rule says: when an event of type X involving some entity is followed
 * within a window by an event of type Y involving the SAME entity, that is a
 * link worth surfacing, and here is the mechanism it implies.
 *
 * These are the checkable half of the system. They do not use a language model
 * and they do not guess: entity identity comes from resolution, the time window
 * is arithmetic, and the pattern is either present in the data or it is not.
 * Whether it is *meaningful* is a judgement the brief leaves to the reader, and
 * the `verdict` column exists to record that judgement.
 */
export interface PairRule {
  id: string;
  kind: ConnectionKind;
  /** Event types that can open the pattern. */
  fromTypes: EventType[];
  /** Event types that can close it. */
  toTypes: EventType[];
  /** Roles the shared entity must hold in the opening event. Empty means any. */
  fromRoles: EntityRole[];
  toRoles: EntityRole[];
  /** Inclusive lag bounds in days, measured `to` minus `from`. */
  minLagDays: number;
  maxLagDays: number;
  /** Ceiling for this rule's confidence before evidence adjustments. */
  baseConfidence: number;
  /** Written into the connection, with the shared entity interpolated. */
  template: (entityName: string, lagDays: number) => string;
  falsifier: (entityName: string) => string;
}

export const PAIR_RULES: PairRule[] = [
  {
    id: 'trade-then-award',
    kind: 'trade-then-award',
    fromTypes: ['securities-trade', 'regulatory-filing'],
    toTypes: ['government-award'],
    fromRoles: [],
    toRoles: ['actor', 'beneficiary', 'counterparty'],
    // A position taken more than a quarter before an award is weak evidence of
    // anything; the same week is the interesting case.
    minLagDays: 0,
    maxLagDays: 90,
    baseConfidence: 0.8,
    template: (e, lag) =>
      `A disclosed position in ${e} preceded public money going to ${e} by ${Math.round(lag)} days.`,
    falsifier: (e) =>
      `The award was competitively solicited before the disclosed trade date, or the filer had no ` +
      `influence over the awarding agency, or the position in ${e} was part of a blind trust or ` +
      `index holding rather than a directed purchase.`,
  },
  {
    id: 'award-then-trade',
    kind: 'award-then-trade',
    fromTypes: ['government-award'],
    toTypes: ['securities-trade', 'regulatory-filing'],
    fromRoles: ['actor', 'beneficiary', 'counterparty'],
    toRoles: [],
    minLagDays: 0,
    maxLagDays: 45,
    baseConfidence: 0.65,
    template: (e, lag) =>
      `Public money went to ${e}, and a position in ${e} was disclosed ${Math.round(lag)} days later.`,
    falsifier: (e) =>
      `The trade was scheduled under a pre-existing 10b5-1 plan, or the award was public ` +
      `before the trade and already priced in.`,
  },
  {
    id: 'policy-then-beneficiary',
    kind: 'policy-then-beneficiary',
    fromTypes: ['policy-action', 'legislation'],
    toTypes: ['government-award', 'corporate-action', 'market-move'],
    // Only fires when the earlier event actually named this party as gaining.
    fromRoles: ['beneficiary'],
    toRoles: [],
    minLagDays: 0,
    maxLagDays: 120,
    baseConfidence: 0.6,
    template: (e, lag) =>
      `A policy action identifying ${e} as a beneficiary was followed ${Math.round(lag)} days later ` +
      `by a concrete gain to ${e}.`,
    falsifier: (e) =>
      `The later gain was contracted or announced before the policy action, or ${e} would have ` +
      `realised it regardless of the policy.`,
  },
  {
    id: 'lobbying-then-award',
    kind: 'lobbying-then-award',
    fromTypes: ['lobbying'],
    toTypes: ['government-award'],
    // The client: the party the lobbying was paid for.
    fromRoles: ['beneficiary'],
    toRoles: ['actor', 'beneficiary', 'counterparty'],
    // A lobbying event is dated by the start of the quarter it reports, so a
    // contract won during that quarter still reads as following it.
    minLagDays: 0,
    maxLagDays: 180,
    baseConfidence: 0.6,
    template: (e, lag) =>
      `${e} was paying for federal lobbying in a period that began ${Math.round(lag)} days before ` +
      `public money went to ${e}.`,
    falsifier: (e) =>
      `The award was solicited or promised before that lobbying began, the lobbying concerned ` +
      `issues unrelated to the award, or ${e} lobbies every quarter as a matter of course.`,
  },
  {
    id: 'lobbying-then-policy',
    kind: 'lobbying-then-policy',
    fromTypes: ['lobbying'],
    toTypes: ['policy-action', 'legislation'],
    fromRoles: ['beneficiary'],
    // Only where the later action itself names the client as gaining.
    toRoles: ['beneficiary'],
    minLagDays: 0,
    maxLagDays: 180,
    baseConfidence: 0.55,
    template: (e, lag) =>
      `${e} was paying for federal lobbying in a period that began ${Math.round(lag)} days before ` +
      `a policy action named ${e} as a beneficiary.`,
    falsifier: (e) =>
      `The policy was drafted or announced before that lobbying began, or it benefits ${e} only ` +
      `as one of many parties in its sector.`,
  },
  {
    id: 'insider-then-news',
    kind: 'insider-then-news',
    fromTypes: ['securities-trade', 'regulatory-filing'],
    toTypes: ['corporate-action', 'legal-action', 'market-move'],
    fromRoles: [],
    toRoles: [],
    minLagDays: 0,
    maxLagDays: 30,
    baseConfidence: 0.55,
    template: (e, lag) =>
      `An insider filing for ${e} preceded material news about ${e} by ${Math.round(lag)} days.`,
    falsifier: (e) =>
      `The filing was a scheduled or automatic transaction, or the later news was already public ` +
      `when the transaction was executed rather than when it was filed.`,
  },
  {
    id: 'sanction-then-trade-shift',
    kind: 'supply-chain',
    fromTypes: ['policy-action', 'diplomatic-action'],
    toTypes: ['corporate-action', 'market-move'],
    fromRoles: ['target', 'regulator', 'actor'],
    toRoles: [],
    minLagDays: 0,
    maxLagDays: 60,
    baseConfidence: 0.5,
    template: (e, lag) =>
      `A state action touching ${e} was followed ${Math.round(lag)} days later by a commercial ` +
      `move involving ${e}.`,
    falsifier: (e) =>
      `The commercial move was announced or planned before the state action, or it addressed ` +
      `something unrelated to what the action changed for ${e}.`,
  },
];

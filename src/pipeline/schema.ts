import { z } from 'zod';

/**
 * Schemas for everything the model is allowed to return.
 *
 * These are enforced by structured outputs, so the model cannot invent an event
 * type or an entity role that the rest of the pipeline does not understand.
 * Fields are nullable rather than optional: strict JSON schema requires every
 * property to be present, and "explicitly nothing" is easier to reason about
 * than "absent".
 */

export const EventTypeSchema = z.enum([
  'policy-action', 'legislation', 'regulatory-filing', 'securities-trade',
  'government-award', 'lobbying', 'corporate-action', 'legal-action', 'military-action',
  'diplomatic-action', 'market-move', 'statement', 'report', 'other',
]);

export const DomainSchema = z.enum([
  'politics', 'geopolitics', 'business', 'intl-business', 'tech', 'defense',
  'energy', 'markets', 'legal', 'macro',
]);

export const EntityKindSchema = z.enum([
  'person', 'organization', 'government-body', 'company', 'country',
  'location', 'financial-instrument', 'policy', 'event',
]);

export const EntityRoleSchema = z.enum([
  'actor', 'target', 'beneficiary', 'regulator', 'counterparty', 'mentioned',
]);

export const ExtractedEntitySchema = z.object({
  name: z.string().describe('Canonical name, expanded from any acronym.'),
  kind: EntityKindSchema,
  role: EntityRoleSchema.describe('This entity\'s role in this specific event.'),
  surfaceForm: z.string().describe('How the entity appeared in the source text.'),
  ticker: z.string().nullable().describe('Stock ticker if a public company, else null.'),
  country: z.string().nullable().describe('ISO 3166-1 alpha-2 code, else null.'),
});

export const ExtractedEventSchema = z.object({
  type: EventTypeSchema,
  summary: z.string().describe('One past-tense sentence naming who did what to whom.'),
  occurredAt: z.string().describe('When it happened as YYYY-MM-DD, not when it was reported.'),
  occurredAtInferred: z.boolean().describe('True if the date was inferred rather than stated.'),
  domains: z.array(DomainSchema),
  entities: z.array(ExtractedEntitySchema),
  amountValue: z.number().nullable().describe('Monetary amount as a plain number, else null.'),
  amountCurrency: z.string().nullable().describe('ISO 4217 code for amountValue, else null.'),
  tags: z.array(z.string()).describe('Bill numbers, tickers, treaty names, sectors, programmes.'),
  assertion: z.enum(['documented', 'reported', 'alleged', 'speculated'])
    .describe('How firmly the source establishes this.'),
});

export const ExtractionSchema = z.object({
  events: z.array(ExtractedEventSchema)
    .describe('Zero or more events. Empty when the item asserts no datable action.'),
});

export type ExtractedEvent = z.infer<typeof ExtractedEventSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;

// ---------------------------------------------------------------------------
// Connection hypotheses
// ---------------------------------------------------------------------------

export const HypothesisSchema = z.object({
  fromEventIndex: z.number().int().describe('Index into the candidate event list.'),
  toEventIndex: z.number().int(),
  kind: z.enum([
    'policy-then-beneficiary', 'supply-chain', 'shared-actor', 'contradiction',
    'escalation', 'precedent', 'causal-claim',
  ]),
  explanation: z.string().describe('The mechanism, in one or two sentences.'),
  falsifier: z.string()
    .describe('A specific observation that would show this link is not real.'),
  confidence: z.number().min(0).max(1),
});

export const HypothesesSchema = z.object({
  hypotheses: z.array(HypothesisSchema),
});

export type Hypothesis = z.infer<typeof HypothesisSchema>;

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export const ThreadAssignmentSchema = z.object({
  eventIndex: z.number().int(),
  threadId: z.string().nullable()
    .describe('Existing thread id this belongs to, or null to start a new one.'),
  newThreadTitle: z.string().nullable()
    .describe('Title when threadId is null, else null.'),
  reason: z.string().describe('Why this event belongs to that storyline.'),
});

export const ThreadAssignmentsSchema = z.object({
  assignments: z.array(ThreadAssignmentSchema),
});

export const ThreadSynthesisSchema = z.object({
  summary: z.string().describe('Where the storyline currently stands.'),
  openQuestions: z.array(z.string()).describe('What to watch for next.'),
});

// ---------------------------------------------------------------------------
// Forecasts
// ---------------------------------------------------------------------------

/**
 * A forecast the model is allowed to propose.
 *
 * Every field here exists to make the estimate scoreable later. A question
 * without a resolution criterion cannot be graded, and a forecast nobody grades
 * is an opinion with a number on it - so the schema refuses to represent one.
 */
export const ProposedForecastSchema = z.object({
  question: z.string()
    .describe('A question answerable yes or no by the resolution date. Names the specific thing that must happen.'),
  resolutionCriteria: z.string()
    .describe('What observation settles this, and where it would be seen. Specific enough that two people reading it would agree on the answer.'),
  resolvesAt: z.string()
    .describe('The date by which this resolves, YYYY-MM-DD. Must be in the future.'),
  probability: z.number().min(0.01).max(0.99)
    .describe('Your probability that the answer is yes.'),
  referenceClass: z.string()
    .describe('The class of similar past cases this rate is anchored to, and roughly how often they went yes. This is what stops the number being pulled from air.'),
  reasoning: z.string()
    .describe('What in the evidence moves this away from the base rate, in one or two sentences.'),
  evidenceEventIndexes: z.array(z.number().int())
    .describe('Indexes into the supplied event list that informed the estimate.'),
});

export const ProposedForecastsSchema = z.object({
  forecasts: z.array(ProposedForecastSchema)
    .describe('Zero or more forecasts. An empty list is correct when the storyline supports no question that can be scored.'),
});

export type ProposedForecast = z.infer<typeof ProposedForecastSchema>;

/**
 * The triage judgement.
 *
 * This is the schema for the only question the system asks about every single
 * thing it fetches: is this worth a person's attention? It is deliberately
 * small - a verdict, a topic, a reason, and at most one thread to pull on -
 * because triage is a filter, not an analysis. The analysis happens later, to
 * the few items that earn it.
 *
 * `angle` is the one field that does real work downstream. It is what
 * `investigate` starts from, and it is nullable because most of the time there
 * is genuinely nothing to pull on, and saying so is the honest answer.
 */
export const TriageVerdictSchema = z.enum(['mundane', 'worth-a-look', 'notable']);

export const TriagedItemSchema = z.object({
  index: z.number().int()
    .describe('The index of the item being judged, copied from the input. Every item gets exactly one entry.'),
  verdict: TriageVerdictSchema
    .describe('mundane: exactly what it appears to be. worth-a-look: something here does not fully add up. notable: consequential and worth reading today.'),
  topic: z.string()
    .describe('What this is about, in a few words. Written to be scanned in a list, not to summarise.'),
  reason: z.string()
    .describe('One sentence saying why it landed there. For mundane items, why it is routine.'),
  angle: z.string().nullable()
    .describe('The specific thing that would make this more than it appears - a party worth checking, a beneficiary the piece does not name, a timing worth confirming. Null when there is nothing to pull on, which is the common case.'),
});

export const TriageBatchSchema = z.object({
  items: z.array(TriagedItemSchema)
    .describe('One entry per input item, in the same order.'),
});

export type TriagedItem = z.infer<typeof TriagedItemSchema>;
export type TriageBatch = z.infer<typeof TriageBatchSchema>;

/**
 * A party's dossier.
 *
 * Every other schema in this file describes what a document asserted. This one
 * describes what is known about a party independent of any single document -
 * their background, who they have been attached to, and what they are in a
 * position to do. That is the prior a new event is read against, and without it
 * an event can only ever be an isolated fact.
 *
 * The `basis` field on every claim is what keeps this from becoming laundering.
 * Extraction is forbidden from adding context the text does not carry, and for
 * good reason. A dossier is the one place where outside knowledge is the point,
 * so each claim must say where it came from - and a claim the model is
 * asserting from training is marked as exactly that, never as a record.
 */
export const ClaimBasisSchema = z.enum([
  /** A record in this corpus supports it. Checkable here. */
  'corpus',
  /** The model asserts it from training. Plausible, unverified, may be wrong. */
  'recalled',
  /** Neither states it; it follows from the other claims. */
  'inferred',
]);

export const AffiliationSchema = z.object({
  organisation: z.string().describe('The body this party has been attached to.'),
  role: z.string().describe('What they did there. Specific, not "involved with".'),
  period: z.string().describe('Years if known, e.g. "1999-2004", "since 2021", or "date unknown".'),
  basis: ClaimBasisSchema,
  confidence: z.number().min(0.05).max(0.95)
    .describe('Never above 0.95. Background is rarely certain and must not read as if it were.'),
});

export const HistoryItemSchema = z.object({
  when: z.string().describe('Year or period. "date unknown" is acceptable and better than a guess.'),
  what: z.string().describe('What happened, in one sentence naming the parties involved.'),
  whyItMatters: z.string().describe('What this would change about how a later event involving them reads.'),
  basis: ClaimBasisSchema,
  confidence: z.number().min(0.05).max(0.95),
});

/**
 * What a party is positioned to do, whether or not they have.
 *
 * This is the possibility axis, and it is deliberately separate from history. A
 * denial is not disproof: the useful question is whether the thing denied is
 * within reach for this party, and what it would take. A capability claim must
 * name the condition that would make it real, so it stays a question rather
 * than becoming an accusation.
 */
export const CapabilitySchema = z.object({
  capability: z.string().describe('What this party could plausibly do, given what they control.'),
  whatItWouldTake: z.string()
    .describe('The specific resource, authority, approval or partner required. This is what makes it checkable.'),
  observableIfReal: z.string()
    .describe('What would appear in the public record if they were pursuing it. A filing, a hire, a permit, a supply contract.'),
  basis: ClaimBasisSchema,
  confidence: z.number().min(0.05).max(0.95),
});

export const WatchPointSchema = z.object({
  watchFor: z.string().describe('A specific future event that would be significant for this party.'),
  whyItWouldMatter: z.string().describe('What it would tell you that you do not know now.'),
});

export const ProfileSchema = z.object({
  summary: z.string()
    .describe('Two to four sentences: who or what this party is, and why anyone tracking money or power would care. No hedging filler.'),
  affiliations: z.array(AffiliationSchema)
    .describe('Bodies this party has been attached to. Empty is correct for a party you know nothing reliable about.'),
  history: z.array(HistoryItemSchema)
    .describe('Prior episodes that change how a new event involving them reads.'),
  capabilities: z.array(CapabilitySchema)
    .describe('What they are positioned to do. Empty when nothing specific can be named.'),
  watchPoints: z.array(WatchPointSchema)
    .describe('Specific things whose occurrence would be worth knowing about.'),
  /** Honest signal that the model has little to go on. */
  thin: z.boolean()
    .describe('True when you genuinely do not know much about this party. Say so rather than padding.'),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type Affiliation = z.infer<typeof AffiliationSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;

/**
 * The background track.
 *
 * Read independently of the records that connect anything. This track sees who
 * the parties are - their affiliations, prior episodes and capabilities - and
 * the subject of the story, and nothing else. It never sees the chains of
 * events the evidence track is judging.
 *
 * That separation is the whole point. A model shown records and background
 * together finds what the background primed it to find, and its agreement with
 * itself proves nothing. Kept apart, the two tracks can converge on a party for
 * different reasons, and that convergence is a real signal rather than an echo.
 */
export const BackgroundLeadSchema = z.object({
  party: z.string().describe('The party, copied exactly from the dossiers supplied.'),
  expectation: z.string()
    .describe('What this party\'s background and position would lead you to expect around this subject. Specific to them, never generic.'),
  whyTheirBackground: z.string()
    .describe('The affiliation, prior episode or capability this rests on. Name it.'),
  whatWouldConfirm: z.string().describe('A record or observation that would establish it.'),
  falsifier: z.string().describe('A specific observation that would show it is wrong. Mandatory.'),
  /**
   * Capped below the evidence track. Background is mostly recalled and
   * unverified, so a reading built on it must never outrank one built on
   * records this corpus actually holds.
   */
  confidence: z.number().min(0.01).max(0.55),
});

export const BackgroundSynthesisSchema = z.object({
  leads: z.array(BackgroundLeadSchema)
    .describe('Zero or more. Empty is correct when the dossiers say nothing bearing on this subject.'),
  surprises: z.array(z.string())
    .describe('Things about this subject that the parties\' backgrounds make unexpected, and which therefore need explaining.'),
  dismissed: z.string().describe('One sentence on what you considered and set aside.'),
});

/**
 * The reconciliation.
 *
 * Sees only the two tracks' conclusions, never their inputs, so it cannot
 * re-litigate either read - it can only compare them. Convergence is what it
 * exists to find: a party both tracks reached independently, on different
 * grounds, is the strongest thing this system can produce.
 */
export const ReconciledFindingSchema = z.object({
  party: z.string(),
  standing: z.enum([
    /** Both tracks reached it independently. The strongest available result. */
    'corroborated',
    /** Records support it; background adds nothing either way. */
    'records-only',
    /** Background suggests it; no record here supports it yet. Weakest. */
    'background-only',
    /** The tracks disagree, and the disagreement is itself worth knowing. */
    'contested',
  ]),
  finding: z.string().describe('What the combined read actually says, in one or two sentences.'),
  restsOn: z.string().describe('What it rests on, naming which track supplied what.'),
  nextCheck: z.string().describe('The single most useful thing a person could go and look at.'),
  falsifier: z.string().describe('What would show it is wrong. Mandatory.'),
  confidence: z.number().min(0.01).max(0.7)
    .describe('Never above 0.7. A corroborated finding may approach it; a background-only one must stay low.'),
});

export const ReconciliationSchema = z.object({
  findings: z.array(ReconciledFindingSchema)
    .describe('Ranked, most useful first. Empty when neither track produced anything worth carrying forward.'),
  assessment: z.string()
    .describe('Two or three sentences: what a person should take away, including if the answer is that there is nothing here.'),
});

export type BackgroundLead = z.infer<typeof BackgroundLeadSchema>;
export type BackgroundSynthesis = z.infer<typeof BackgroundSynthesisSchema>;
export type ReconciledFinding = z.infer<typeof ReconciledFindingSchema>;
export type Reconciliation = z.infer<typeof ReconciliationSchema>;

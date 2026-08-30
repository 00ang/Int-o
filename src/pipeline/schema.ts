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
  'government-award', 'corporate-action', 'legal-action', 'military-action',
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

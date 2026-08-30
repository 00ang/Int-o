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

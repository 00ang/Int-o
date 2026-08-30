/**
 * Domain model for throughline.
 *
 * The pipeline is a funnel with four narrowing stages:
 *
 *   Item      raw fetched material, exactly as the source published it
 *   Event     a structured, dated assertion extracted from one Item
 *   Connection a link between two Events, always carrying its evidence
 *   Thread    a persistent storyline that Events and Connections accumulate into
 *
 * The rule that keeps this honest: an Event never exists without an Item behind
 * it, and a Connection never exists without the Events it joins. Provenance is
 * structural, not advisory - you can always walk back from a claim in the brief
 * to the published source that supports it.
 */

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Credibility tiers. These are about *evidentiary weight*, not about whether an
 * outlet is good. A tier-1 wire report of what an official said is weaker
 * evidence than the tier-0 transcript of them saying it, even though Reuters is
 * an excellent newsroom.
 */
export type Tier =
  /** Primary records: filings, dockets, registers, transcripts, official data. */
  | 'primary'
  /** Wire services reporting verified fact. */
  | 'wire'
  /** Outlets with published standards, corrections policies, named bylines. */
  | 'outlet'
  /** Peer-reviewed, working papers, institutional research, think tanks. */
  | 'research'
  /** Aggregators, regional/secondary press, translation services. */
  | 'secondary';

/** How much a source's claims move a connection's confidence. */
export const TIER_WEIGHT: Record<Tier, number> = {
  primary: 1.0,
  wire: 0.85,
  outlet: 0.7,
  research: 0.75,
  secondary: 0.45,
};

export type Domain =
  | 'politics'
  | 'geopolitics'
  | 'business'
  | 'intl-business'
  | 'tech'
  | 'defense'
  | 'energy'
  | 'markets'
  | 'legal'
  | 'macro';

/** The shape of the payload a source returns, which picks the adapter. */
export type SourceKind =
  | 'rss'
  | 'federal-register'
  | 'usaspending'
  | 'sec-edgar'
  | 'stock-act'
  | 'prediction-market'
  | 'json-api';

export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  url: string;
  tier: Tier;
  domains: Domain[];
  /** Country/region of editorial origin. Used to detect single-perspective threads. */
  origin: string;
  /**
   * Editorial lean, recorded so the brief can flag when a storyline is carried
   * entirely by outlets that share one. Not a quality judgement and never used
   * to down-rank a source on its own.
   */
  lean?: 'left' | 'center-left' | 'center' | 'center-right' | 'right' | 'state' | 'n/a';
  /** Polling interval hint, minutes. Primary records change slowly; wires do not. */
  intervalMinutes: number;
  /** False when the URL has not been confirmed against the live host. */
  verified: boolean;
  notes?: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Items - raw material
// ---------------------------------------------------------------------------

export interface Item {
  id: string;
  sourceId: string;
  /** Stable identifier from the source (GUID, accession number, award id). */
  externalId: string;
  url: string;
  title: string;
  /** Summary or abstract as published. */
  summary: string | null;
  /** Full text when we could fetch and extract it. */
  body: string | null;
  author: string | null;
  publishedAt: string;
  fetchedAt: string;
  /** Adapter-specific structured payload, preserved verbatim. */
  raw: Record<string, unknown> | null;
  /** Set once extraction has run, successfully or not. */
  extractedAt: string | null;
  extractionError: string | null;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export type EntityKind =
  | 'person'
  | 'organization'
  | 'government-body'
  | 'company'
  | 'country'
  | 'location'
  | 'financial-instrument'
  | 'policy'
  | 'event';

export interface Entity {
  id: string;
  kind: EntityKind;
  /** Canonical display name. */
  name: string;
  /** Lowercased, punctuation-stripped key used for matching. */
  slug: string;
  /** Alternate surface forms seen in the wild, including tickers and acronyms. */
  aliases: string[];
  /** Stock ticker, when the entity is a public company. */
  ticker: string | null;
  /** SEC Central Index Key, when known. Joins press coverage to filings. */
  cik: string | null;
  /** ISO country code for state actors and companies' domicile. */
  country: string | null;
  description: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  mentionCount: number;
}

/** An entity's role in a specific event. Roles carry most of the causal signal. */
export type EntityRole =
  | 'actor'        // did the thing
  | 'target'       // had it done to them
  | 'beneficiary'  // gained from it
  | 'regulator'
  | 'counterparty'
  | 'mentioned';

export interface EventEntity {
  entityId: string;
  role: EntityRole;
  /** Surface form as it appeared in the source text. */
  surfaceForm: string;
}

// ---------------------------------------------------------------------------
// Events - structured assertions
// ---------------------------------------------------------------------------

/**
 * Event types are deliberately coarse. They exist to let detectors ask
 * "policy action followed by private gain?" without reasoning over prose.
 */
export type EventType =
  | 'policy-action'      // rule, order, sanction, tariff, appointment
  | 'legislation'
  | 'regulatory-filing'  // 10-K, 8-K, Form 4, merger notification
  | 'securities-trade'   // disclosed purchase or sale
  | 'government-award'   // contract, grant, subsidy, licence
  | 'corporate-action'   // M&A, layoffs, earnings, guidance
  | 'legal-action'       // suit, indictment, ruling, settlement
  | 'military-action'
  | 'diplomatic-action'
  | 'market-move'
  | 'statement'          // said, threatened, promised
  | 'report'             // journalism or research asserting a finding
  | 'other';

export interface MoneyAmount {
  /** Value in the smallest sensible unit of `currency`, as a number of units. */
  value: number;
  currency: string;
}

export interface Event {
  id: string;
  itemId: string;
  type: EventType;
  /** One sentence, past tense, naming who did what. */
  summary: string;
  /** When the event occurred, not when it was reported. */
  occurredAt: string;
  /** True when occurredAt was inferred rather than stated. */
  occurredAtInferred: boolean;
  domains: Domain[];
  entities: EventEntity[];
  amount: MoneyAmount | null;
  /** Free-text tags: instruments, sectors, treaty names, bill numbers. */
  tags: string[];
  /**
   * How firmly the source asserts this. Reported speech and analyst speculation
   * must not carry the same weight as a filed document.
   */
  assertion: 'documented' | 'reported' | 'alleged' | 'speculated';
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Connections - the point of the whole system
// ---------------------------------------------------------------------------

/**
 * How a connection was found. This is the most important field in the schema.
 *
 * `deterministic` links come from structured records joined on hard keys - a
 * disclosed trade in a ticker, an award to the company behind that ticker,
 * inside a date window. They are checkable and they are either right or wrong.
 *
 * `hypothesis` links are proposed by a language model. They are useful for
 * recall and they are the exact mechanism by which a tool like this turns into
 * a conspiracy generator if left unlabelled. They are stored, displayed and
 * scored separately, and they must carry a falsifier.
 */
export type ConnectionBasis =
  | 'deterministic'   // structured join over primary records
  | 'entity-overlap'  // same canonical entities, close in time
  | 'hypothesis';     // model-proposed, requires a falsifier

export type ConnectionKind =
  | 'trade-then-award'       // disclosed position precedes public money
  | 'policy-then-beneficiary'// rule change precedes private gain
  | 'award-then-trade'       // public money precedes disclosed position
  | 'lobbying-then-policy'
  | 'insider-then-news'
  | 'supply-chain'           // one action moves inputs for another
  | 'shared-actor'
  | 'contradiction'          // two sources assert incompatible facts
  | 'escalation'             // same conflict, later rung
  | 'precedent'              // historical analogue
  | 'causal-claim';          // model's proposed mechanism

export interface Connection {
  id: string;
  kind: ConnectionKind;
  basis: ConnectionBasis;
  fromEventId: string;
  toEventId: string;
  /** Plain-language statement of the link, naming the mechanism. */
  explanation: string;
  /**
   * What observation would show this link is not real. Required for every
   * hypothesis. A connection nobody can check is not an insight.
   */
  falsifier: string | null;
  /** 0-1. For deterministic links this is computed, never model-authored. */
  confidence: number;
  /** Days between the two events. Negative means `to` preceded `from`. */
  lagDays: number;
  /** Entity ids common to both events, when that is what joined them. */
  sharedEntityIds: string[];
  /** Detector that produced this, or 'llm' for hypotheses. */
  producedBy: string;
  createdAt: string;
  /** Set when you have judged the link yourself. Feeds detector tuning. */
  verdict: 'unreviewed' | 'sound' | 'coincidence' | 'wrong';
}

// ---------------------------------------------------------------------------
// Threads - the plot you follow
// ---------------------------------------------------------------------------

export interface Thread {
  id: string;
  title: string;
  /** Rolling synthesis, rewritten as events land. This is "where the plot is". */
  summary: string;
  /** What to watch for next. The forward-looking half of following a story. */
  openQuestions: string[];
  domains: Domain[];
  /** Entities that define the thread, most central first. */
  coreEntityIds: string[];
  status: 'active' | 'dormant' | 'closed';
  startedAt: string;
  lastEventAt: string;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadEvent {
  threadId: string;
  eventId: string;
  /** Why this event belongs to this thread. */
  reason: string;
  addedAt: string;
}

// ---------------------------------------------------------------------------
// Forecasts
// ---------------------------------------------------------------------------

/**
 * A forecast is only worth making if it can be scored. Every one carries a
 * resolution criterion and a date, and gets a Brier score once it resolves.
 */
export interface Forecast {
  id: string;
  threadId: string | null;
  /** Must be answerable yes/no by the resolution date. */
  question: string;
  resolutionCriteria: string;
  resolvesAt: string;
  /** Our probability, 0-1. */
  probability: number;
  /** The reference class used to anchor it. Guards against pulling numbers from air. */
  referenceClass: string | null;
  /** Live price from a matching prediction market, 0-1, when one exists. */
  marketProbability: number | null;
  marketUrl: string | null;
  /** Event ids that informed the estimate. */
  evidenceEventIds: string[];
  reasoning: string;
  createdAt: string;
  resolvedAt: string | null;
  outcome: 'yes' | 'no' | 'ambiguous' | null;
  brierScore: number | null;
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

export interface BriefSection {
  heading: string;
  body: string;
  eventIds: string[];
  connectionIds: string[];
  threadIds: string[];
}

export interface Brief {
  id: string;
  /** Date the brief covers, YYYY-MM-DD. */
  forDate: string;
  windowHours: number;
  sections: BriefSection[];
  /** Rendered markdown, cached so surfaces do not re-render. */
  markdown: string;
  itemCount: number;
  eventCount: number;
  connectionCount: number;
  createdAt: string;
}

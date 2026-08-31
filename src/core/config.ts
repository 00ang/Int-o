import { resolve } from 'node:path';

/**
 * Configuration, all from the environment.
 *
 * The contact email in the User-Agent is not decorative: SEC EDGAR and several
 * other government hosts reject or throttle traffic that does not identify
 * itself, and doing so is a condition of their access policies.
 */
export interface Config {
  dbPath: string;
  userAgent: string;
  contactEmail: string;
  anthropicApiKey: string | null;
  /** Required only by identity-linked API keys, which reject calls without it. */
  anthropicWorkspaceId: string | null;
  model: string;
  /**
   * Triage reads every item, so it runs on the cheapest model that can hold a
   * judgement. Analysis quality shows in extraction and synthesis, not here.
   */
  triageModel: string;
  /** Items judged per model call. Batching is what makes triage affordable. */
  triageBatchSize: number;
  /** Items pulled into one triage run. */
  triageBatchLimit: number;
  /** Items sent to the model per extraction run. Guards against runaway spend. */
  extractBatchLimit: number;
  requestTimeoutMs: number;
  /** Polite delay between requests to the same host. */
  hostDelayMs: number;
  congressApiKey: string | null;
  courtListenerToken: string | null;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const contactEmail = process.env.THROUGHLINE_CONTACT_EMAIL ?? 'throughline@localhost';
  return {
    dbPath: resolve(process.env.THROUGHLINE_DB ?? './data/throughline.db'),
    contactEmail,
    userAgent:
      process.env.THROUGHLINE_USER_AGENT ??
      `throughline/0.1 (personal research aggregator; ${contactEmail})`,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
    anthropicWorkspaceId: process.env.ANTHROPIC_WORKSPACE_ID ?? null,
    model: process.env.THROUGHLINE_MODEL ?? 'claude-opus-5',
    triageModel: process.env.THROUGHLINE_TRIAGE_MODEL ?? 'claude-haiku-4-5-20251001',
    triageBatchSize: Number(process.env.THROUGHLINE_TRIAGE_BATCH_SIZE ?? 12),
    triageBatchLimit: Number(process.env.THROUGHLINE_TRIAGE_LIMIT ?? 120),
    extractBatchLimit: Number(process.env.THROUGHLINE_EXTRACT_LIMIT ?? 40),
    requestTimeoutMs: Number(process.env.THROUGHLINE_TIMEOUT_MS ?? 30_000),
    hostDelayMs: Number(process.env.THROUGHLINE_HOST_DELAY_MS ?? 400),
    congressApiKey: process.env.CONGRESS_GOV_API_KEY ?? null,
    courtListenerToken: process.env.COURTLISTENER_API_TOKEN ?? null,
    ...overrides,
  };
}

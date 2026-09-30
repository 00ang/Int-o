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
  /**
   * Which backend serves model calls.
   *
   * `anthropic` bills per token against a credit balance. `claude-cli` runs the
   * same models through a Claude Code subscription instead, so it costs nothing
   * at the margin - at the price of sharing that subscription's rate limit.
   */
  llmProvider: 'anthropic' | 'claude-cli';
  /** Model alias for the CLI backend: opus, sonnet, haiku. */
  cliModel: string;
  /** Model alias the CLI backend uses for triage. */
  cliTriageModel: string;
  /** Model alias the CLI backend uses for extraction. Defaults to cliModel. */
  cliExtractModel: string;
  model: string;
  /**
   * Model for extraction, which runs once per retained item and so is where
   * most of the spend goes. Defaults to `model`; reading who did what to whom
   * out of one article is the stage that holds up best on a cheaper model.
   */
  extractModel: string;
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
  const contactEmail = process.env.ALLINT_CONTACT_EMAIL ?? 'all-int@localhost';
  return {
    dbPath: resolve(process.env.ALLINT_DB ?? './data/allint.db'),
    contactEmail,
    userAgent:
      process.env.ALLINT_USER_AGENT ??
      `all-int/0.1 (personal research aggregator; ${contactEmail})`,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
    anthropicWorkspaceId: process.env.ANTHROPIC_WORKSPACE_ID ?? null,
    llmProvider: process.env.ALLINT_LLM_PROVIDER === 'claude-cli' ? 'claude-cli' : 'anthropic',
    cliModel: process.env.ALLINT_CLI_MODEL ?? 'sonnet',
    cliTriageModel: process.env.ALLINT_CLI_TRIAGE_MODEL ?? 'haiku',
    cliExtractModel: process.env.ALLINT_CLI_EXTRACT_MODEL ?? process.env.ALLINT_CLI_MODEL ?? 'sonnet',
    model: process.env.ALLINT_MODEL ?? 'claude-opus-5-5',
    extractModel: process.env.ALLINT_EXTRACT_MODEL ?? process.env.ALLINT_MODEL ?? 'claude-opus-5-5',
    triageModel: process.env.ALLINT_TRIAGE_MODEL ?? 'claude-haiku-4-5-20251001',
    triageBatchSize: Number(process.env.ALLINT_TRIAGE_BATCH_SIZE ?? 12),
    triageBatchLimit: Number(process.env.ALLINT_TRIAGE_LIMIT ?? 120),
    extractBatchLimit: Number(process.env.ALLINT_EXTRACT_LIMIT ?? 40),
    requestTimeoutMs: Number(process.env.ALLINT_TIMEOUT_MS ?? 30_000),
    hostDelayMs: Number(process.env.ALLINT_HOST_DELAY_MS ?? 400),
    congressApiKey: process.env.CONGRESS_GOV_API_KEY ?? null,
    courtListenerToken: process.env.COURTLISTENER_API_TOKEN ?? null,
    ...overrides,
  };
}

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { ZodType } from 'zod';
import type { Config } from './config.js';
import { proseViaCli, structuredViaCli } from './llm-cli.js';

/**
 * The single place the Anthropic API is called.
 *
 * Everything model-facing goes through `structured`, which constrains the
 * response to a Zod schema. Nothing downstream ever parses free text out of a
 * model response, which is what keeps malformed output from becoming a
 * malformed event.
 */

let client: Anthropic | null = null;

export function getClient(cfg: Config): Anthropic {
  if (!client) {
    if (!cfg.anthropicApiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Extraction, linking and briefs need it; ' +
        'ingestion and search do not.',
      );
    }
    client = new Anthropic({
      apiKey: cfg.anthropicApiKey,
      // An identity-linked key is scoped to a workspace and the API rejects it
      // with a 400 until told which one the call acts in.
      ...(cfg.anthropicWorkspaceId
        ? { defaultHeaders: { 'anthropic-workspace-id': cfg.anthropicWorkspaceId } }
        : {}),
    });
  }
  return client;
}

/** Reset between tests, or after changing credentials in a long-lived process. */
export function resetClient(): void {
  client = null;
}

export interface StructuredOptions {
  /** Stable across calls, and cached - keep volatile content out of it. */
  system: string;
  user: string;
  schema: ZodType;
  maxTokens?: number;
  /**
   * Lower effort for mechanical work, higher for synthesis. `null` omits the
   * parameter entirely, which the small models require.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  /** Overrides the configured model. Triage runs on a cheaper one than analysis. */
  model?: string;
  /** Model alias when the CLI backend is in use. */
  cliModel?: string;
  /**
   * Adaptive thinking, on by default. Turn it off for mechanical classification
   * and for the small models, which do not support it.
   */
  thinking?: boolean;
}

/**
 * Server-side refusal fallback.
 *
 * The current large models decline some requests by policy, and a corpus of
 * sanctions, indictments and military actions will trip that occasionally. A
 * decline would otherwise retire the item it was reading; with this the API
 * re-runs the same request on its default substitute inside the same call.
 * Haiku is left out: it is not a model the fallback chain is defined for.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const supportsFallback = (model: string): boolean =>
  /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);

const fallbackParams = (model: string) =>
  supportsFallback(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {};

export async function structured<T>(cfg: Config, opts: StructuredOptions): Promise<T> {
  // The CLI backend runs the same models through a subscription rather than a
  // credit balance. It enforces and re-validates this same schema, so the
  // contract at this boundary is identical either way.
  if (cfg.llmProvider === 'claude-cli') {
    return structuredViaCli<T>({
      system: opts.system,
      user: opts.user,
      schema: opts.schema,
      model: opts.cliModel ?? cfg.cliModel,
      effort: opts.effort === null ? null : (opts.effort ?? 'medium'),
    });
  }
  const anthropic = getClient(cfg);
  const model = opts.model ?? cfg.model;

  const message = await anthropic.beta.messages.parse({
    model,
    max_tokens: opts.maxTokens ?? 16_000,
    ...fallbackParams(model),
    ...(opts.thinking === false ? {} : { thinking: { type: 'adaptive' as const } }),
    output_config: {
      ...(opts.effort === null ? {} : { effort: opts.effort ?? 'medium' }),
      format: betaZodOutputFormat(opts.schema),
    },
    // The instructions are identical on every call in a run, so caching them
    // turns a large repeated prefix into a cheap one.
    system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: opts.user }],
  });

  if (message.stop_reason === 'refusal') {
    throw new Error(
      `Model declined the request (${message.stop_details?.category ?? 'unspecified'}).`,
    );
  }
  if (message.parsed_output == null) {
    throw new Error('Model returned no parseable structured output.');
  }
  return message.parsed_output as T;
}

/** Free-text generation, used only where the output is prose for a human. */
export async function prose(
  cfg: Config,
  opts: { system: string; user: string; maxTokens?: number; effort?: StructuredOptions['effort'] },
): Promise<string> {
  if (cfg.llmProvider === 'claude-cli') {
    return proseViaCli({
      system: opts.system, user: opts.user, model: cfg.cliModel, effort: opts.effort ?? 'medium',
    });
  }
  const anthropic = getClient(cfg);
  const message = await anthropic.beta.messages.create({
    model: cfg.model,
    max_tokens: opts.maxTokens ?? 16_000,
    ...fallbackParams(cfg.model),
    thinking: { type: 'adaptive' },
    output_config: { effort: opts.effort ?? 'medium' },
    system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: opts.user }],
  });
  if (message.stop_reason === 'refusal') {
    throw new Error(
      `Model declined the request (${message.stop_details?.category ?? 'unspecified'}).`,
    );
  }
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

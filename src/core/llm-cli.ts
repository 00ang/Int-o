import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { z, type ZodType } from 'zod';

/**
 * The Claude Code backend.
 *
 * The API bills per token against a credit balance. The `claude` CLI runs
 * against a subscription instead, so the same models cost nothing at the
 * margin. For a personal system that wants to read a few thousand records
 * without watching a meter, that is the difference between running and not.
 *
 * WHAT IS DIFFERENT, AND IT MATTERS. The CLI enforces the schema itself
 * (`--json-schema`), as the API does, and every response is validated again
 * against the same Zod schema the API path uses; a response that fails is an
 * error, never a partial result. The contract at the boundary is identical.
 *
 * The other real difference is the limit. This shares a subscription's rate
 * limit with every interactive session, so it can refuse when the API would
 * not. Those refusals are transient by definition and the extractor already
 * knows not to retire an item over one.
 */

export interface CliOptions {
  system: string;
  user: string;
  schema: ZodType;
  /** Model alias the CLI understands: opus, sonnet, haiku. */
  model?: string;
  /** Thinking depth. Omitted, the CLI uses its own default, which is high. */
  effort?: string | null;
  timeoutMs?: number;
  /** Path to the binary. Overridable for a non-standard install. */
  bin?: string;
}

/**
 * The arguments for one bare model call.
 *
 * Left to its defaults, `claude -p` is a coding agent: its own system prompt,
 * every built-in tool's definition, the user's MCP servers and skills, a saved
 * session per call. Measured, that is about 29,000 tokens of context in front
 * of a nine-token question, spent on every triage batch and every extraction
 * against the same rate limit the reader's own sessions use. None of it is
 * needed to fill in a schema, so all of it is turned off, which brings the same
 * call to under a thousand. The effort is set to match the API path; the CLI's
 * own default is higher, and thinking is billed to the limit like anything else.
 */
export function cliArgs(opts: {
  system: string;
  model?: string;
  effort?: string | null;
  schemaJson?: string;
}): string[] {
  const args = [
    '-p',
    '--output-format', 'json',
    '--system-prompt', opts.system,
    '--tools', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.schemaJson) args.push('--json-schema', opts.schemaJson);
  return args;
}

/** What `--output-format json` returns, as far as this file reads it. */
interface CliEnvelope {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
}

/**
 * Pull the JSON object out of whatever the CLI returned.
 *
 * Models wrap JSON in fences and occasionally preface it, so the first balanced
 * object is taken rather than assuming the whole response is the payload.
 * Scanning for balance rather than regex-matching braces is what makes a nested
 * object survive.
 */
export function extractJson(text: string): string {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) s = fence[1].trim();

  const start = s.indexOf('{');
  if (start === -1) throw new Error('No JSON object in the response.');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  throw new Error('Unbalanced JSON object in the response.');
}

/**
 * The environment the CLI must run in.
 *
 * `ANTHROPIC_API_KEY` takes precedence over a claude.ai login, so a key left in
 * the environment makes the CLI refuse outright - which is the exact situation
 * this backend exists to escape, since the whole point is to stop spending
 * against that key. Anything that authenticates the API is stripped from the
 * child so the subscription is what gets used.
 */
const API_AUTH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_WORKSPACE_ID',
  'ANTHROPIC_BASE_URL',
];

export function cliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of API_AUTH_VARS) delete env[k];
  return env;
}

/** Everything the CLI wrote, or a rejection describing why it did not run. */
function runCli(bin: string, args: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Run from a neutral directory so a CLAUDE.md in whatever folder the
    // command was started from is not read into every call.
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: cliEnv(), cwd: tmpdir() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${bin}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${(err || out).trim().slice(0, 200)}`));
        return;
      }
      resolve(out);
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

/** The wording of a subscription limit, wherever the CLI reports it. */
const LIMIT_NOTICE = /hit your (session|usage) limit|rate limit|resets? at|usage limit reached/i;

/**
 * Read the JSON envelope, turning a refusal to run into an error that says why.
 *
 * A session limit reads as success at the process level: the CLI reports it in
 * the envelope and may still exit zero. Without this it would be handed to the
 * schema check and reported as malformed output - which would make a transient
 * limit look like a permanent fault in the item and retire it.
 */
export function readEnvelope(raw: string): CliEnvelope {
  let env: CliEnvelope;
  try {
    env = JSON.parse(raw.trim()) as CliEnvelope;
  } catch {
    // Not an envelope at all: most likely a bare limit notice.
    if (LIMIT_NOTICE.test(raw)) throw new Error(`claude CLI rate limit: ${raw.trim().slice(0, 160)}`);
    throw new Error(`claude CLI returned no JSON envelope: ${raw.trim().slice(0, 160)}`);
  }
  const text = String(env.result ?? '');
  if (LIMIT_NOTICE.test(text) && text.length < 400) {
    throw new Error(`claude CLI rate limit: ${text.slice(0, 160)}`);
  }
  // Reported as a failed run so it reads as transient: an error the CLI raised
  // is at least as likely to be about the service as about the item, and an
  // item retired by mistake never comes back.
  if (env.is_error) throw new Error(`claude CLI exited 1: ${text.slice(0, 200)}`);
  return env;
}

export async function structuredViaCli<T>(opts: CliOptions): Promise<T> {
  const schemaJson = JSON.stringify(
    z.toJSONSchema(opts.schema, { target: 'draft-7', io: 'output' }),
  );
  const raw = await runCli(
    opts.bin ?? 'claude',
    cliArgs({ system: opts.system, model: opts.model, effort: opts.effort, schemaJson }),
    opts.user,
    opts.timeoutMs ?? 300_000,
  );
  const env = readEnvelope(raw);

  // The CLI hands back the constrained object directly; the text is only a
  // fallback for a version that does not.
  let parsed: unknown = env.structured_output;
  if (parsed === undefined) {
    try {
      parsed = JSON.parse(extractJson(String(env.result ?? '')));
    } catch (e) {
      throw new Error(`claude CLI returned unparseable JSON: ${(e as Error).message}`);
    }
  }

  // The same guarantee the API path gets, checked here as well. Nothing
  // downstream ever sees an unvalidated shape.
  const result = opts.schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `claude CLI output failed the schema: ${result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data as T;
}

/** Free-text generation through the CLI, for the prose the brief needs. */
export async function proseViaCli(
  opts: {
    system: string; user: string; model?: string; effort?: string | null;
    bin?: string; timeoutMs?: number;
  },
): Promise<string> {
  const raw = await runCli(
    opts.bin ?? 'claude',
    cliArgs({ system: opts.system, model: opts.model, effort: opts.effort }),
    opts.user,
    opts.timeoutMs ?? 300_000,
  );
  return String(readEnvelope(raw).result ?? '').trim();
}

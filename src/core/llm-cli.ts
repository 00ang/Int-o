import { spawn } from 'node:child_process';
import { z, type ZodType } from 'zod';

/**
 * The Claude Code backend.
 *
 * The API bills per token against a credit balance. The `claude` CLI runs
 * against a subscription instead, so the same models cost nothing at the
 * margin. For a personal system that wants to read a few thousand records
 * without watching a meter, that is the difference between running and not.
 *
 * WHAT IS DIFFERENT, AND IT MATTERS. The API constrains generation to the
 * schema, so malformed output is impossible. The CLI returns text, so the
 * schema becomes a check applied afterwards rather than a guarantee applied
 * during. Nothing downstream may notice that difference: every response is
 * parsed and validated against the same Zod schema the API path uses, and a
 * response that fails is an error, never a partial result. The contract at the
 * boundary is identical; only where it is enforced has moved.
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
  timeoutMs?: number;
  /** Path to the binary. Overridable for a non-standard install. */
  bin?: string;
}

/**
 * The instruction that replaces structured outputs.
 *
 * A schema in the prompt is weaker than a schema in the decoder, so it is
 * stated as flatly as possible and the result is validated regardless. Asking
 * for bare JSON rather than a fenced block removes one whole class of parsing
 * ambiguity, though the fence is stripped anyway because models add it.
 */
function buildPrompt(opts: CliOptions): string {
  const jsonSchema = JSON.stringify(
    z.toJSONSchema(opts.schema, { target: 'draft-7', io: 'output' }),
  );
  return [
    opts.system,
    '',
    '---',
    '',
    'Respond with a single JSON object and nothing else. No prose before or after,',
    'no code fence, no explanation. It must validate against this JSON Schema:',
    '',
    jsonSchema,
    '',
    '---',
    '',
    opts.user,
  ].join('\n');
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

/** Everything the CLI wrote, or a rejection describing why it did not run. */
function runCli(bin: string, args: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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

/**
 * A session limit reads as success at the process level.
 *
 * The CLI prints the notice and exits zero, so without this the notice would be
 * handed to the JSON parser and reported as malformed output - which would make
 * a transient limit look like a permanent fault in the item and retire it.
 */
const LIMIT_NOTICE = /hit your (session|usage) limit|rate limit|resets? at|usage limit reached/i;

export async function structuredViaCli<T>(opts: CliOptions): Promise<T> {
  const bin = opts.bin ?? 'claude';
  const args = ['-p', '--output-format', 'text'];
  if (opts.model) args.push('--model', opts.model);

  const raw = await runCli(bin, args, buildPrompt(opts), opts.timeoutMs ?? 300_000);

  if (LIMIT_NOTICE.test(raw) && raw.trim().length < 400) {
    throw new Error(`claude CLI rate limit: ${raw.trim().slice(0, 160)}`);
  }

  const json = extractJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`claude CLI returned unparseable JSON: ${(e as Error).message}`);
  }

  // The same guarantee the API path gets, enforced here instead of in the
  // decoder. Nothing downstream ever sees an unvalidated shape.
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
  opts: { system: string; user: string; model?: string; bin?: string; timeoutMs?: number },
): Promise<string> {
  const args = ['-p', '--output-format', 'text'];
  if (opts.model) args.push('--model', opts.model);
  const raw = await runCli(
    opts.bin ?? 'claude', args,
    `${opts.system}\n\n---\n\n${opts.user}`,
    opts.timeoutMs ?? 300_000,
  );
  if (LIMIT_NOTICE.test(raw) && raw.trim().length < 400) {
    throw new Error(`claude CLI rate limit: ${raw.trim().slice(0, 160)}`);
  }
  return raw.trim();
}

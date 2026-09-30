import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { cliArgs, cliEnv, extractJson, readEnvelope } from '../src/core/llm-cli.js';
import { supportsFallback } from '../src/core/llm.js';
import { isTransient } from '../src/pipeline/extract.js';

describe('recovering JSON from CLI output', () => {
  it('takes a bare object', () => {
    expect(JSON.parse(extractJson('{"a":1}'))).toEqual({ a: 1 });
  });

  it('strips a code fence, which models add whatever the prompt says', () => {
    expect(JSON.parse(extractJson('```json\n{"a":1}\n```'))).toEqual({ a: 1 });
    expect(JSON.parse(extractJson('```\n{"a":1}\n```'))).toEqual({ a: 1 });
  });

  it('ignores prose before and after the object', () => {
    const out = 'Here is the result:\n{"a":1}\nLet me know if you need more.';
    expect(JSON.parse(extractJson(out))).toEqual({ a: 1 });
  });

  // Balance scanning rather than brace matching is what makes this survive.
  it('keeps a nested object whole', () => {
    const obj = { items: [{ i: 0, meta: { deep: { deeper: true } } }] };
    expect(JSON.parse(extractJson(`noise ${JSON.stringify(obj)} noise`))).toEqual(obj);
  });

  it('is not fooled by a brace inside a string', () => {
    const obj = { topic: 'a } brace in text', n: 1 };
    expect(JSON.parse(extractJson(JSON.stringify(obj)))).toEqual(obj);
  });

  it('is not fooled by an escaped quote inside a string', () => {
    const obj = { topic: 'he said "hi" }', n: 2 };
    expect(JSON.parse(extractJson(JSON.stringify(obj)))).toEqual(obj);
  });

  it('refuses rather than guessing when there is no object', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow(/No JSON object/);
  });

  it('refuses a truncated object rather than returning half of one', () => {
    expect(() => extractJson('{"a":{"b":1}')).toThrow(/Unbalanced/);
  });
});

describe('the CLI schema check', () => {
  // The API constrains generation; the CLI validates afterwards. The contract
  // at the boundary has to be identical, so a bad shape must be an error and
  // never a partial result.
  const Schema = z.object({ verdict: z.enum(['a', 'b']), n: z.number() });

  it('accepts what the schema allows', () => {
    expect(Schema.safeParse({ verdict: 'a', n: 1 }).success).toBe(true);
  });

  it('rejects an out-of-enum value rather than passing it through', () => {
    expect(Schema.safeParse({ verdict: 'c', n: 1 }).success).toBe(false);
  });

  it('rejects a missing field', () => {
    expect(Schema.safeParse({ verdict: 'a' }).success).toBe(false);
  });
});

describe('CLI failures are transient, not item faults', () => {
  // A subscription limit says nothing about the record being read. Retiring an
  // item over one is the bug that cost 35 items to an empty credit balance.
  it('treats a session limit as transient', () => {
    expect(isTransient("claude CLI rate limit: You've hit your session limit · resets 1am")).toBe(true);
    expect(isTransient('claude CLI timed out after 300s')).toBe(true);
    expect(isTransient('could not run claude: ENOENT')).toBe(true);
    expect(isTransient('claude CLI exited 1: something')).toBe(true);
  });

  // A schema violation from the CLI IS about the item, and recurs.
  it('treats a schema violation as permanent', () => {
    expect(isTransient('claude CLI output failed the schema: events.0.domains.1: invalid')).toBe(false);
  });
});

describe('the environment the CLI runs in', () => {
  // A key left in the environment overrides the claude.ai login and the CLI
  // refuses - which defeats the entire purpose of this backend, since the point
  // is to stop spending against that key.
  it('strips every API auth variable from the child environment', () => {
    const env = cliEnv({
      ANTHROPIC_API_KEY: 'sk-ant-something',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_WORKSPACE_ID: 'ws',
      ANTHROPIC_BASE_URL: 'https://example.com',
      PATH: '/usr/bin',
      ALLINT_DB: './data/allint.db',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_WORKSPACE_ID).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('leaves everything else alone, including the database path', () => {
    const env = cliEnv({ PATH: '/usr/bin', ALLINT_DB: './data/allint.db', HOME: '/Users/x' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.ALLINT_DB).toBe('./data/allint.db');
    expect(env.HOME).toBe('/Users/x');
  });

  it('does not mutate the environment it was given', () => {
    const base = { ANTHROPIC_API_KEY: 'sk-ant-x', PATH: '/usr/bin' };
    cliEnv(base);
    expect(base.ANTHROPIC_API_KEY).toBe('sk-ant-x');
  });
});

describe('a bare model call through the CLI', () => {
  // Every one of these turns off something the CLI loads by default and a
  // schema fill has no use for. Measured, the defaults were ~29k tokens of
  // context per call; with these, under a thousand.
  const args = cliArgs({ system: 'SYS', model: 'haiku', effort: 'medium', schemaJson: '{}' });

  it('replaces the coding-agent system prompt with ours', () => {
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('SYS');
  });

  it('loads no tools, MCP servers or skills, and saves no session', () => {
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--no-session-persistence');
  });

  it('asks for the JSON envelope, the schema and the effort the API path uses', () => {
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{}');
    expect(args[args.indexOf('--effort') + 1]).toBe('medium');
  });

  it('omits effort where the model takes none, and the schema for prose', () => {
    const bare = cliArgs({ system: 'SYS', model: 'haiku', effort: null });
    expect(bare).not.toContain('--effort');
    expect(bare).not.toContain('--json-schema');
  });
});

describe('reading the CLI envelope', () => {
  it('returns the constrained object', () => {
    const env = readEnvelope(JSON.stringify({ is_error: false, result: '{"a":1}', structured_output: { a: 1 } }));
    expect(env.structured_output).toEqual({ a: 1 });
  });

  it('turns a limit notice in the envelope into a transient error', () => {
    const raw = JSON.stringify({ is_error: true, result: "You've hit your session limit · resets 1am" });
    expect(() => readEnvelope(raw)).toThrow(/rate limit/);
    try { readEnvelope(raw); } catch (e) { expect(isTransient((e as Error).message)).toBe(true); }
  });

  it('turns a bare limit notice, with no envelope at all, into the same', () => {
    expect(() => readEnvelope("You've hit your usage limit")).toThrow(/rate limit/);
  });

  it('reports any other CLI error as a failed run, which does not retire the item', () => {
    try {
      readEnvelope(JSON.stringify({ is_error: true, result: 'something broke' }));
      expect.unreachable();
    } catch (e) {
      expect(isTransient((e as Error).message)).toBe(true);
    }
  });
});

describe('refusal fallback', () => {
  it('is requested for the large models and not for Haiku', () => {
    expect(supportsFallback('claude-opus-5-5')).toBe(true);
    expect(supportsFallback('claude-sonnet-5-5')).toBe(true);
    expect(supportsFallback('claude-fable-5-1')).toBe(true);
    expect(supportsFallback('claude-haiku-4-5-20251001')).toBe(false);
    expect(supportsFallback('claude-sonnet-4-6')).toBe(false);
  });
});

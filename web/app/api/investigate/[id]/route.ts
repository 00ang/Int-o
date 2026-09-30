import { NextResponse } from 'next/server';
import { openDb } from '../../../../../dist/core/db.js';
import { loadConfig } from '../../../../../dist/core/config.js';
import { investigate } from '../../../../../dist/pipeline/investigate.js';
import { getEntity } from '../../../../../dist/core/store.js';

/**
 * The one route that writes.
 *
 * It runs the same engine the CLI runs - imported from the build, not
 * reimplemented - so the web app cannot drift from the tested path. POST only:
 * this spends money, and a GET that spends money is a GET you learn to fear.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { hypotheses?: boolean } = {};
  try { body = await req.json(); } catch { /* no body is fine */ }

  const cfg = loadConfig();
  // The subscription backend needs no key; only the API backend does.
  if (cfg.llmProvider !== 'claude-cli' && !cfg.anthropicApiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not set for the web process. Set it, or set ALLINT_LLM_PROVIDER=claude-cli to use a Claude subscription.' },
      { status: 400 },
    );
  }

  const db = openDb(cfg.dbPath);
  try {
    const inv = await investigate(db, cfg, id, { hypotheses: body.hypotheses === true });
    return NextResponse.json({
      events: inv.events.length,
      related: inv.related.map((e) => ({
        occurredAt: e.occurredAt, type: e.type, summary: e.summary,
      })),
      relatedItems: inv.relatedItems.map((i) => ({
        id: i.id, title: i.title, publishedAt: i.publishedAt,
      })),
      connections: [...inv.connections, ...inv.hypotheses].map((c) => ({
        kind: c.kind, basis: c.basis, confidence: c.confidence,
        explanation: c.explanation, falsifier: c.falsifier,
        // The parties that actually joined the two events, named rather than
        // left as opaque ids the page would have to resolve again.
        parties: c.sharedEntityIds
          .map((eid) => getEntity(db, eid)?.name)
          .filter((n): n is string => Boolean(n)),
        lagDays: c.lagDays,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  } finally {
    db.close();
  }
}

import { NextResponse } from 'next/server';
import { openDb } from '../../../../../dist/core/db.js';
import { loadConfig } from '../../../../../dist/core/config.js';
import { buildGraph } from '../../../../../dist/core/graph.js';
import { activateFromItem } from '../../../../../dist/pipeline/activate.js';
import { synthesize } from '../../../../../dist/pipeline/synthesize.js';

/**
 * Fire the map from one item, and optionally have the model judge what lit up.
 *
 * The two halves are billed differently and so they are requested differently.
 * Activation is free, deterministic and repeatable; asking for an opinion about
 * it costs a model call. `judge: false` returns the structure alone, which is
 * the honest default for a page that a person may simply be reading.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { judge?: boolean; rebuild?: boolean; hops?: number } = {};
  try { body = await req.json(); } catch { /* no body is fine */ }

  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  try {
    if (body.rebuild) buildGraph(db);

    if (!body.judge) {
      const a = activateFromItem(db, id, { hops: body.hops ?? 3 });
      return NextResponse.json({
        judged: false,
        seedNames: a.seedNames,
        nodes: a.nodes.map((n) => ({
          id: n.id, name: n.name, kind: n.kind, energy: n.energy,
          hops: n.hops, path: n.path, pathNames: n.pathNames,
        })),
        distant: a.distant.length,
        hubsHeld: a.hubsHeld,
        leads: [],
        dismissed: '',
        skipped: a.seeds.length === 0
          ? 'This item has no extracted parties to fire from.'
          : null,
      });
    }

    // The subscription backend needs no key; only the API backend does.
    if (cfg.llmProvider !== 'claude-cli' && !cfg.anthropicApiKey) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEY is not set for the web process. Set it, or set ALLINT_LLM_PROVIDER=claude-cli to use a Claude subscription.' },
        { status: 400 },
      );
    }

    const r = await synthesize(db, cfg, id, { hops: body.hops ?? 3 });
    return NextResponse.json({
      judged: true,
      seedNames: r.activation.seedNames,
      nodes: r.activation.nodes.map((n) => ({
        id: n.id, name: n.name, kind: n.kind, energy: n.energy,
        hops: n.hops, path: n.path, pathNames: n.pathNames,
      })),
      distant: r.activation.distant.length,
      hubsHeld: r.activation.hubsHeld,
      leads: r.leads,
      dismissed: r.dismissed,
      skipped: r.skipped,
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

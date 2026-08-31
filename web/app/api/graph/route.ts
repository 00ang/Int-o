import { NextResponse } from 'next/server';
import { openDb } from '../../../../dist/core/db.js';
import { loadConfig } from '../../../../dist/core/config.js';
import { buildGraph, graphStats } from '../../../../dist/core/graph.js';

/**
 * The whole map, for the standing chart.
 *
 * Read-only by default. A GET returns whatever the last build produced; the
 * rebuild is a POST, because recomputing every edge is work and a page load
 * should never quietly do work.
 */
export const dynamic = 'force-dynamic';

function readGraph(dbPath: string, limit: number) {
  const db = openDb(dbPath);
  try {
    const edges = db.prepare(`
      SELECT a_id AS a, b_id AS b, weight AS w, event_count AS n
        FROM graph_edges ORDER BY weight DESC LIMIT @limit
    `).all({ limit }) as Array<{ a: string; b: string; w: number; n: number }>;

    const ids = new Set<string>();
    for (const e of edges) { ids.add(e.a); ids.add(e.b); }

    const nodes = ids.size === 0 ? [] : (db.prepare(`
      SELECT en.id, en.name, en.kind, en.slug,
             (SELECT COUNT(*) FROM graph_edges g
               WHERE g.a_id = en.id OR g.b_id = en.id) AS degree
        FROM entities en
       WHERE en.id IN (${[...ids].map(() => '?').join(',')})
    `).all(...ids) as Array<{
      id: string; name: string; kind: string; slug: string; degree: number;
    }>);

    return { nodes, edges, stats: graphStats(db) };
  } finally {
    db.close();
  }
}

export async function GET(req: Request) {
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 260);
  const cfg = loadConfig();
  try {
    return NextResponse.json(readGraph(cfg.dbPath, Math.min(limit, 900)));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}

export async function POST() {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  try {
    const r = buildGraph(db);
    db.close();
    return NextResponse.json({ rebuilt: r, ...readGraph(cfg.dbPath, 260) });
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}

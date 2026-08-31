import { NextResponse } from 'next/server';
import { openDb } from '../../../../../dist/core/db.js';
import { loadConfig } from '../../../../../dist/core/config.js';
import { edgeEvidence, neighbors } from '../../../../../dist/core/graph.js';
import { getEntity } from '../../../../../dist/core/store.js';

/**
 * One party, and why it is wired to each of its neighbours.
 *
 * The map draws edges but an edge on its own asserts nothing - the whole
 * doctrine here is that co-occurrence is not relationship. What makes a link
 * worth anything is the records behind it, so this returns them: for every
 * neighbour, the actual events naming both parties, with the item each came
 * from. That is what turns a line on a chart into something a person can walk
 * and throw out.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  try {
    const party = getEntity(db, id);
    if (!party) {
      return NextResponse.json({ error: 'No such party on file.' }, { status: 404 });
    }

    const links = neighbors(db, id, 14).map((n) => {
      const other = getEntity(db, n.id);
      return {
        id: n.id,
        name: other?.name ?? '?',
        kind: other?.kind ?? 'unknown',
        slug: other?.slug ?? '',
        weight: n.weight,
        eventCount: n.eventCount,
        // The records that put this edge on the map. An edge with none was
        // inferred from a shared document or storyline rather than from one
        // event naming both, and saying so matters.
        evidence: edgeEvidence(db, id, n.id, 3).map((e) => ({
          summary: e.summary,
          occurredAt: e.occurredAt,
          type: e.type,
          itemId: e.itemId,
          itemTitle: e.itemTitle,
          source: e.source,
        })),
      };
    });

    return NextResponse.json({
      party: { id: party.id, name: party.name, kind: party.kind, slug: party.slug },
      links,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  } finally {
    db.close();
  }
}

import type { DB } from '../core/db.js';
import { slugifyEntity } from '../core/ids.js';
import { isShouting } from '../core/store.js';
import { stripSecurityClass } from './import-trades.js';

/**
 * Merge companies that a corpus already split in two.
 *
 * Resolution now strips the class of security from disclosed issuers and
 * matches on ticker, so new material lands on one party. Material already on
 * file does not re-resolve itself: a member's trade in "Applied Materials,
 * Inc. - Common Stock" still points at a different party from the wire story
 * about Applied Materials, and every detector join between them stays silent.
 * This repairs that in place.
 *
 * Only companies are touched, and only on evidence that two rows are one
 * issuer: the same name once the class of security is removed, or the same
 * ticker. Nothing here guesses at similarity.
 */

interface EntityRow {
  id: string;
  kind: string;
  name: string;
  slug: string;
  aliases: string;
  ticker: string | null;
  cik: string | null;
  country: string | null;
  description: string | null;
  first_seen_at: string;
  last_seen_at: string;
  mention_count: number;
}

export interface ConsolidateResult {
  renamed: number;
  merged: Array<{ kept: string; absorbed: string; reason: 'name' | 'ticker' }>;
}

const replaceInJsonList = (json: string, from: string, to: string): string => {
  const ids = JSON.parse(json || '[]') as string[];
  return JSON.stringify([...new Set(ids.map((id) => (id === from ? to : id)))]);
};

/**
 * Fold `dropId` into `keepId`: every event, connection, dossier and storyline
 * that pointed at the absorbed party points at the survivor afterwards.
 *
 * Graph edges and topic weights for the absorbed party are deleted rather than
 * re-weighted; `graph:build` recomputes them from the repaired events.
 */
export function mergeEntities(db: DB, keepId: string, dropId: string): void {
  if (keepId === dropId) return;
  const keep = db.prepare('SELECT * FROM entities WHERE id = ?').get(keepId) as EntityRow | undefined;
  const drop = db.prepare('SELECT * FROM entities WHERE id = ?').get(dropId) as EntityRow | undefined;
  if (!keep || !drop) return;

  db.transaction(() => {
    // An event can name both halves; the primary key then collides, and the
    // survivor's row already says what the absorbed one did.
    db.prepare('UPDATE OR IGNORE event_entities SET entity_id = ? WHERE entity_id = ?').run(keepId, dropId);
    db.prepare('DELETE FROM event_entities WHERE entity_id = ?').run(dropId);

    const conns = db.prepare(
      'SELECT id, shared_entity_ids FROM connections WHERE shared_entity_ids LIKE ?',
    ).all(`%${dropId}%`) as Array<{ id: string; shared_entity_ids: string }>;
    const setShared = db.prepare('UPDATE connections SET shared_entity_ids = ? WHERE id = ?');
    for (const c of conns) setShared.run(replaceInJsonList(c.shared_entity_ids, dropId, keepId), c.id);

    const threads = db.prepare(
      'SELECT id, core_entity_ids FROM threads WHERE core_entity_ids LIKE ?',
    ).all(`%${dropId}%`) as Array<{ id: string; core_entity_ids: string }>;
    const setCore = db.prepare('UPDATE threads SET core_entity_ids = ? WHERE id = ?');
    for (const t of threads) setCore.run(replaceInJsonList(t.core_entity_ids, dropId, keepId), t.id);

    // Keep the survivor's dossier; inherit the absorbed one only if it had none.
    db.prepare(
      `UPDATE entity_profiles SET entity_id = ?
        WHERE entity_id = ? AND NOT EXISTS (SELECT 1 FROM entity_profiles WHERE entity_id = ?)`,
    ).run(keepId, dropId, keepId);
    db.prepare('DELETE FROM entity_profiles WHERE entity_id = ?').run(dropId);

    db.prepare('DELETE FROM graph_edges WHERE a_id = ? OR b_id = ?').run(dropId, dropId);
    db.prepare('DELETE FROM entity_domains WHERE entity_id = ?').run(dropId);

    const aliases = new Set<string>([
      ...JSON.parse(keep.aliases || '[]') as string[],
      ...JSON.parse(drop.aliases || '[]') as string[],
      drop.name,
    ]);
    aliases.delete(keep.name);
    db.prepare(
      `UPDATE entities
          SET aliases = ?,
              ticker = COALESCE(ticker, ?),
              cik = COALESCE(cik, ?),
              country = COALESCE(country, ?),
              description = COALESCE(description, ?),
              first_seen_at = MIN(first_seen_at, ?),
              last_seen_at = MAX(last_seen_at, ?),
              mention_count = mention_count + ?
        WHERE id = ?`,
    ).run(
      JSON.stringify([...aliases]), drop.ticker, drop.cik, drop.country, drop.description,
      drop.first_seen_at, drop.last_seen_at, drop.mention_count, keepId,
    );
    db.prepare('DELETE FROM entities WHERE id = ?').run(dropId);
  })();
}

/** The better-attested of two rows survives, so its name is the one shown. */
const survivor = (a: EntityRow, b: EntityRow): [EntityRow, EntityRow] =>
  a.mention_count >= b.mention_count ? [a, b] : [b, a];

export function consolidateCompanies(db: DB): ConsolidateResult {
  const result: ConsolidateResult = { renamed: 0, merged: [] };
  const load = () => db.prepare("SELECT * FROM entities WHERE kind = 'company'").all() as EntityRow[];

  // 1. Names carrying a class of security: rename in place, or fold into the
  //    company already on file under the clean name.
  for (const e of load()) {
    const clean = stripSecurityClass(e.name);
    if (!clean || clean === e.name) continue;
    const slug = slugifyEntity(clean);
    if (!slug) continue;
    const twin = db.prepare(
      "SELECT * FROM entities WHERE kind = 'company' AND slug = ? AND id != ?",
    ).get(slug, e.id) as EntityRow | undefined;
    if (twin) {
      const [keep, drop] = survivor(twin, e);
      mergeEntities(db, keep.id, drop.id);
      if (keep.id === twin.id && isShouting(twin.name) && !isShouting(clean)) {
        // Same issuer, same slug: show the spelling that is not in capitals.
        const kept = db.prepare('SELECT aliases FROM entities WHERE id = ?').get(twin.id) as { aliases: string };
        const aliases = new Set<string>(JSON.parse(kept.aliases || '[]') as string[]);
        aliases.add(twin.name);
        aliases.delete(clean);
        db.prepare('UPDATE entities SET name = ?, aliases = ? WHERE id = ?')
          .run(clean, JSON.stringify([...aliases]), twin.id);
      }
      if (keep.id === e.id) {
        // The survivor still carries the suffixed spelling; the clean one is
        // now free, since its old holder was just absorbed.
        const kept = db.prepare('SELECT aliases FROM entities WHERE id = ?').get(e.id) as { aliases: string };
        const aliases = new Set<string>(JSON.parse(kept.aliases || '[]') as string[]);
        aliases.add(e.name);
        aliases.delete(clean);
        db.prepare('UPDATE entities SET name = ?, slug = ?, aliases = ? WHERE id = ?')
          .run(clean, slug, JSON.stringify([...aliases]), e.id);
      }
      result.merged.push({ kept: clean, absorbed: e.name, reason: 'name' });
    } else {
      const aliases = new Set<string>(JSON.parse(e.aliases || '[]') as string[]);
      aliases.add(e.name);
      db.prepare('UPDATE entities SET name = ?, slug = ?, aliases = ? WHERE id = ?')
        .run(clean, slug, JSON.stringify([...aliases]), e.id);
      result.renamed++;
    }
  }

  // 2. The same name as a company and as an organisation: one party, kept as
  //    the company, since that is the kind contracts and trades resolve to.
  const pairs = db.prepare(
    `SELECT c.id AS companyId, o.id AS orgId, c.name AS companyName, o.name AS orgName
       FROM entities c JOIN entities o ON o.slug = c.slug
      WHERE c.kind = 'company' AND o.kind = 'organization'`,
  ).all() as Array<{ companyId: string; orgId: string; companyName: string; orgName: string }>;
  for (const p of pairs) {
    mergeEntities(db, p.companyId, p.orgId);
    result.merged.push({ kept: p.companyName, absorbed: p.orgName, reason: 'name' });
  }

  // 3. One ticker, several rows: one issuer.
  const groups = db.prepare(
    `SELECT ticker FROM entities WHERE kind = 'company' AND ticker IS NOT NULL
      GROUP BY ticker HAVING COUNT(*) > 1`,
  ).all() as Array<{ ticker: string }>;
  for (const { ticker } of groups) {
    const rows = db.prepare(
      "SELECT * FROM entities WHERE kind = 'company' AND ticker = ? ORDER BY mention_count DESC",
    ).all(ticker) as EntityRow[];
    const [keep, ...rest] = rows;
    for (const drop of rest) {
      mergeEntities(db, keep!.id, drop.id);
      result.merged.push({ kept: keep!.name, absorbed: drop.name, reason: 'ticker' });
    }
  }

  return result;
}

import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { structured } from '../core/llm.js';
import { getEntity, eventsForEntity } from '../core/store.js';
import { neighbors } from '../core/graph.js';
import { type Profile, ProfileSchema } from './schema.js';

/**
 * Party dossiers.
 *
 * The rest of this system is built on a rule: extraction may not add context
 * the text does not carry. That rule is what makes the events trustworthy, and
 * it is also why a party is nothing but a name with a mention count. An event
 * involving a name has no weight; the same event involving a party you know
 * spent a decade on a particular board is information.
 *
 * This is the one stage where outside knowledge is the point rather than the
 * hazard. So it carries the provenance discipline instead of abandoning it:
 * every claim says whether a record in this corpus supports it, whether the
 * model is recalling it from training, or whether it follows from the rest.
 * A recalled claim is plausible and unverified and is labelled as exactly that,
 * so nothing downstream can mistake it for a filing.
 *
 * The capability section is the possibility axis. A denial is not disproof, and
 * the useful question about a denied thing is whether it is within reach for
 * this party and what it would take. Each capability must therefore name the
 * condition required and the trace it would leave in the public record - which
 * keeps it a question a person can go and check rather than an allegation.
 */

const SYSTEM = `You write background dossiers on parties in an intelligence corpus - people, companies, agencies, organisations.

The purpose is narrow and specific. Someone is reading a news event involving this party and needs to know what they are already looking at: who this party is, what they have been attached to, what they have done before, and what they are positioned to do. Background is what turns an isolated event into a signal.

The reader is an investor, an operator, a financier or an analyst. They care about money, authority, access and capability. They do not need a biography; they need the parts that would change how a new event involving this party reads.

PROVENANCE IS MANDATORY. Every claim carries a basis:
- corpus: a record in the supplied events supports it.
- recalled: you are asserting it from training. Plausible, unverified, possibly wrong or out of date. Most background will be this, and that is fine - but it must be marked, never dressed up as a record.
- inferred: neither states it, and it follows from the other claims.

Rules:

1. If you do not reliably know who this party is, set thin to true and return almost nothing. A padded dossier is worse than an empty one, because everything downstream will treat it as knowledge. Obscure companies, minor officials and parties the source declined to name should usually come back thin.
2. Never invent a date, a role or a relationship to fill a field. "date unknown" is a correct answer.
3. Confidence is capped at 0.95 and should usually be well below it. Recalled background about private individuals, small companies and recent appointments is often wrong.
4. affiliations and history are for things that change how a later event reads. A party's founding date rarely does. A decade on the board of a counterparty does.
5. capabilities is about what they could do, not what they have done. Name what it would take and what it would look like in the public record if they were pursuing it. This is how a possibility stays checkable instead of becoming an accusation.
6. You are describing position and capability, never wrongdoing. Do not assert, imply or hint that any party has done anything improper. "Was a member of X" and "controls the approval Y requires" are facts about position. "Used X to obtain Y" is an allegation and is out of bounds.
7. For a living private individual, keep to their public professional record. No family details unless the relationship is itself a matter of public business record - a named board seat, a disclosed shareholding, a documented transaction.
8. Write plainly. No "notably", no "it is worth noting", no throat-clearing.`;

function renderContext(db: DB, entityId: string): string {
  const ent = getEntity(db, entityId);
  if (!ent) return '';

  const events = eventsForEntity(db, entityId, 25);
  const near = neighbors(db, entityId, 12)
    .map((n) => getEntity(db, n.id)?.name)
    .filter(Boolean);

  const lines = [
    `PARTY: ${ent.name}`,
    `KIND: ${ent.kind}`,
    ent.ticker ? `TICKER: ${ent.ticker}` : '',
    ent.country ? `COUNTRY: ${ent.country}` : '',
    ent.aliases.length > 0 ? `ALSO WRITTEN AS: ${ent.aliases.slice(0, 6).join(', ')}` : '',
    '',
    `WHAT THIS CORPUS HAS ON THEM (${events.length} events):`,
    ...events.slice(0, 25).map(
      (e) => `  ${e.occurredAt.slice(0, 10)} [${e.type}] ${e.summary}`,
    ),
  ];
  if (near.length > 0) {
    lines.push('', `PARTIES THEY APPEAR WITH: ${near.join(', ')}`);
  }
  return lines.filter(Boolean).join('\n');
}

export interface ProfileResult {
  entityId: string;
  name: string;
  thin: boolean;
  claims: number;
  error: string | null;
}

export async function profileEntity(
  db: DB,
  cfg: Config,
  entityId: string,
): Promise<ProfileResult> {
  const ent = getEntity(db, entityId);
  if (!ent) throw new Error(`No entity ${entityId}.`);

  const out: ProfileResult = {
    entityId, name: ent.name, thin: false, claims: 0, error: null,
  };

  try {
    const p = await structured<Profile>(cfg, {
      system: SYSTEM,
      user: renderContext(db, entityId),
      schema: ProfileSchema,
      // Background is recall plus judgement about what matters. Worth the room.
      effort: 'high',
      maxTokens: 12_000,
    });

    saveProfile(db, entityId, p, cfg.llmProvider === 'claude-cli' ? cfg.cliModel : cfg.model);
    out.thin = p.thin;
    out.claims = p.affiliations.length + p.history.length + p.capabilities.length;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

export function saveProfile(db: DB, entityId: string, p: Profile, model: string): void {
  const events = (db.prepare(
    'SELECT COUNT(*) c FROM event_entities WHERE entity_id = ?',
  ).get(entityId) as { c: number }).c;

  db.prepare(`
    INSERT INTO entity_profiles
      (entity_id, summary, affiliations, history, capabilities, watch_points,
       corpus_events, built_at, model)
    VALUES (@id, @summary, @affiliations, @history, @capabilities, @watchPoints,
            @corpusEvents, @builtAt, @model)
    ON CONFLICT(entity_id) DO UPDATE SET
      summary = @summary, affiliations = @affiliations, history = @history,
      capabilities = @capabilities, watch_points = @watchPoints,
      corpus_events = @corpusEvents, built_at = @builtAt, model = @model
  `).run({
    id: entityId,
    summary: p.summary,
    affiliations: JSON.stringify(p.affiliations),
    history: JSON.stringify(p.history),
    capabilities: JSON.stringify(p.capabilities),
    watchPoints: JSON.stringify(p.watchPoints),
    corpusEvents: events,
    builtAt: new Date().toISOString(),
    model,
  });
}

/**
 * Parties worth a dossier, most consequential first.
 *
 * Ordered by how much of the corpus runs through them, because a dossier is
 * only worth its cost on a party whose next appearance you will actually read.
 * A one-mention company is not that party.
 */
export function entitiesNeedingProfile(
  db: DB,
  opts: { limit?: number; minEvents?: number; rebuild?: boolean } = {},
): Array<{ id: string; name: string; events: number }> {
  const where = ['ee.entity_id IS NOT NULL'];
  if (!opts.rebuild) where.push('p.entity_id IS NULL');
  return db.prepare(`
    SELECT en.id, en.name, COUNT(DISTINCT ee.event_id) AS events
      FROM entities en
      JOIN event_entities ee ON ee.entity_id = en.id
      LEFT JOIN entity_profiles p ON p.entity_id = en.id
     WHERE ${where.join(' AND ')}
     GROUP BY en.id
    HAVING events >= @minEvents
     ORDER BY events DESC, en.name
     LIMIT @limit
  `).all({
    minEvents: opts.minEvents ?? 2,
    limit: opts.limit ?? 25,
  }) as Array<{ id: string; name: string; events: number }>;
}

export function getProfile(db: DB, entityId: string): (Profile & {
  builtAt: string; model: string | null; corpusEvents: number;
}) | null {
  const r = db.prepare(
    'SELECT * FROM entity_profiles WHERE entity_id = ?',
  ).get(entityId) as Record<string, unknown> | undefined;
  if (!r) return null;
  const json = <T,>(v: unknown, fallback: T): T => {
    try { return JSON.parse(String(v)) as T; } catch { return fallback; }
  };
  return {
    summary: String(r.summary ?? ''),
    affiliations: json(r.affiliations, []),
    history: json(r.history, []),
    capabilities: json(r.capabilities, []),
    watchPoints: json(r.watch_points, []),
    thin: false,
    builtAt: String(r.built_at ?? ''),
    model: r.model === null || r.model === undefined ? null : String(r.model),
    corpusEvents: Number(r.corpus_events ?? 0),
  };
}

export async function buildProfiles(
  db: DB,
  cfg: Config,
  opts: {
    limit?: number; minEvents?: number; rebuild?: boolean;
    onProgress?: (r: ProfileResult) => void;
  } = {},
): Promise<ProfileResult[]> {
  const targets = entitiesNeedingProfile(db, opts);
  const results: ProfileResult[] = [];
  let consecutiveErrors = 0;
  for (const t of targets) {
    const r = await profileEntity(db, cfg, t.id);
    results.push(r);
    opts.onProgress?.(r);
    // The same reasoning as extraction: once the backend is refusing, the rest
    // of the batch will refuse too and there is nothing to learn by continuing.
    consecutiveErrors = r.error ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= 3) break;
  }
  return results;
}

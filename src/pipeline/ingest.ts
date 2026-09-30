import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { insertItem, listSources, recordFetch, sourcesDueForFetch, upsertSource } from '../core/store.js';
import type { Item, Source } from '../core/types.js';
import { fetchFederalRegister } from '../sources/federal-register.js';
import { fetchPredictionMarket } from '../sources/prediction-markets.js';
import { REGISTRY } from '../sources/registry.js';
import { fetchRss } from '../sources/rss.js';
import { fetchEdgar } from '../sources/sec-edgar.js';
import { fetchForm4 } from '../sources/sec-form4.js';
import { fetchLobbying } from '../sources/lobbying.js';
import { fetchStockAct } from '../sources/stock-act.js';
import { fetchAwards } from '../sources/usaspending.js';
import { writeRecordEvents } from './records.js';

/** Load the shipped registry into the database, preserving enable/verify state. */
export function seedSources(db: DB): number {
  const existing = new Map(listSources(db).map((s) => [s.id, s]));
  for (const s of REGISTRY) {
    const prior = existing.get(s.id);
    upsertSource(db, prior ? { ...s, verified: prior.verified, enabled: prior.enabled } : s);
  }
  return REGISTRY.length;
}

export interface FetchSourceOptions {
  /** Adapters that fetch per record skip the ones already on file. */
  isKnown?: (externalId: string) => boolean;
  /** A reachability check, not a read: fetch as little as proves the source answers. */
  probe?: boolean;
}

export async function fetchSource(
  source: Source,
  cfg: Config,
  opts: FetchSourceOptions = {},
): Promise<Item[]> {
  switch (source.kind) {
    case 'rss': return fetchRss(source, cfg);
    case 'federal-register': return fetchFederalRegister(source, cfg);
    case 'usaspending': return fetchAwards(source, cfg);
    case 'sec-edgar': return fetchEdgar(source, cfg);
    case 'sec-form4': return fetchForm4(source, cfg, { isKnown: opts.isKnown, limit: opts.probe ? 2 : 60 });
    // A probe looks back two weeks: a quiet weekend with nothing posted must
    // not read as a dead source and get it disabled.
    case 'lobbying': return fetchLobbying(source, cfg, opts.probe ? { maxPages: 1, sinceDays: 14 } : {});
    case 'stock-act': return fetchStockAct(source, cfg);
    case 'prediction-market': return fetchPredictionMarket(source, cfg);
    case 'import':
      // Written by `import:trades`. There is no endpoint behind it; re-running
      // the import is how it gets new material.
      throw new Error(`Source ${source.id} is import-only; run 'all-int import:trades <file>'`);
    case 'json-api':
      // Congress.gov and CourtListener each need their own key handling; until
      // those adapters exist, say so rather than silently skipping.
      throw new Error(`Source ${source.id} has kind 'json-api' with no adapter yet`);
    default: {
      const never: never = source.kind;
      throw new Error(`Unhandled source kind: ${String(never)}`);
    }
  }
}

export interface IngestResult {
  sourceId: string;
  fetched: number;
  inserted: number;
  /** Events written in code from structured rows, with no model call. */
  events: number;
  error: string | null;
}

/**
 * Poll every due source.
 *
 * Sources are fetched sequentially rather than in parallel. This is a personal
 * tool polling public endpoints, several of which publish explicit rate limits;
 * being a well-behaved client matters more than finishing the run faster.
 */
export async function ingest(
  db: DB,
  cfg: Config,
  opts: { sourceIds?: string[]; all?: boolean; onProgress?: (r: IngestResult) => void } = {},
): Promise<IngestResult[]> {
  // Keep the database's source list in step with the shipped registry, so a
  // source added or re-typed in an upgrade is polled without a manual init.
  seedSources(db);

  let due: Source[];
  if (opts.sourceIds?.length) {
    const wanted = new Set(opts.sourceIds);
    due = listSources(db).filter((s) => wanted.has(s.id));
  } else {
    due = opts.all ? listSources(db, { enabledOnly: true }) : sourcesDueForFetch(db);
  }
  // Import-only sources have nothing to poll, and naming one explicitly with
  // -s should not manufacture a failure.
  due = due.filter((s) => s.kind !== 'import');

  const results: IngestResult[] = [];
  for (const source of due) {
    const result: IngestResult = {
      sourceId: source.id, fetched: 0, inserted: 0, events: 0, error: null,
    };
    try {
      const known = db.prepare('SELECT 1 FROM items WHERE source_id = ? AND external_id = ?');
      const items = await fetchSource(source, cfg, {
        isKnown: (externalId) => known.get(source.id, externalId) !== undefined,
      });
      result.fetched = items.length;
      const tx = db.transaction((batch: Item[]) => {
        for (const it of batch) {
          if (!insertItem(db, it)) continue;
          result.inserted++;
          result.events += writeRecordEvents(db, it, source.kind);
        }
      });
      tx(items);
      recordFetch(db, source.id, null);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      recordFetch(db, source.id, result.error);
    }
    results.push(result);
    opts.onProgress?.(result);
  }
  return results;
}

export interface SourceCheck {
  sourceId: string;
  name: string;
  ok: boolean;
  itemCount: number;
  detail: string;
}

/**
 * Probe every source and report which ones actually answer.
 *
 * This exists because the registry's URLs were written without network access
 * to confirm them. Run it once on a machine with open egress, then act on what
 * it prints: `--fix` marks the working ones verified and disables the rest.
 */
export async function checkSources(
  db: DB,
  cfg: Config,
  opts: { fix?: boolean; onProgress?: (c: SourceCheck) => void } = {},
): Promise<SourceCheck[]> {
  const out: SourceCheck[] = [];
  for (const source of listSources(db)) {
    // Nothing to probe and nothing to disable: an import source's material
    // arrives by hand, so leave it exactly as it is.
    if (source.kind === 'import') continue;
    const check: SourceCheck = {
      sourceId: source.id, name: source.name, ok: false, itemCount: 0, detail: '',
    };
    try {
      const items = await fetchSource(source, cfg, { probe: true });
      check.itemCount = items.length;
      // A feed that parses to zero items is reachable but useless to us.
      check.ok = items.length > 0;
      check.detail = items.length > 0 ? `${items.length} items` : 'reachable but parsed 0 items';
    } catch (err) {
      check.detail = err instanceof Error ? err.message : String(err);
    }
    if (opts.fix) {
      upsertSource(db, { ...source, verified: check.ok, enabled: check.ok });
    }
    out.push(check);
    opts.onProgress?.(check);
  }
  return out;
}

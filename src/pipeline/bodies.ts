import type { Config } from '../core/config.js';
import type { DB } from '../core/db.js';
import { politeFetch } from '../core/http.js';
import type { Item } from '../core/types.js';

/**
 * Fetching article bodies.
 *
 * Feeds ship a headline and a blurb. The corpus was 2,577 items of headline
 * against 534 with real text, which means triage was judging what a story might
 * be hiding from its headline, and extraction was pulling parties and roles out
 * of one sentence. Everything downstream inherited that: thin events, a sparse
 * graph, and angles that read as vague because there was nothing underneath
 * them to be specific about.
 *
 * This is deliberately not a general web scraper. It reads the article text out
 * of the HTML a publisher already served us the link to, keeps it if it is
 * plausibly an article, and gives up quietly otherwise. A body we cannot get is
 * a body we do not have; it is never a reason to guess.
 */

/** Tags whose contents are never article text. */
const STRIP_BLOCKS =
  /<(script|style|noscript|svg|form|nav|aside|header|footer|figure|figcaption|iframe|button|select)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Containers publishers actually use for the article body.
 *
 * Tried in order and the first that yields enough text wins. This is a
 * heuristic over the handful of conventions that dominate news HTML, not a
 * parser: when none matches we fall back to the whole document, and when that
 * does not look like prose either we keep nothing.
 */
const CONTAINERS = [
  /<article\b[^>]*>([\s\S]*?)<\/article>/i,
  /<main\b[^>]*>([\s\S]*?)<\/main>/i,
  /<div\b[^>]*(?:id|class)="[^"]*(?:article-body|articleBody|story-body|post-content|entry-content|c-article)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  /<div\b[^>]*itemprop="articleBody"[^>]*>([\s\S]*?)<\/div>/i,
];

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', hellip: '…', eacute: 'é',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * Pull readable text out of an HTML document.
 *
 * Paragraphs are joined with blank lines so the extractor sees structure rather
 * than one run-on string, which matters because it is asked to date and
 * attribute individual assertions.
 */
export function articleText(html: string): string {
  let doc = html.replace(STRIP_BLOCKS, ' ');

  let scope = doc;
  for (const re of CONTAINERS) {
    const m = doc.match(re);
    if (m?.[1] && m[1].length > 400) { scope = m[1]; break; }
  }

  // Prefer explicit paragraphs; they are what a publisher marks up as prose.
  const paras = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => decodeEntities((m[1] ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 40);

  const text = paras.length >= 2
    ? paras.join('\n\n')
    : decodeEntities(scope.replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim();

  return text;
}

/**
 * Does this look like an article rather than a consent wall or an error page?
 *
 * The failure mode worth guarding is not an empty body, it is a plausible one:
 * a cookie banner or a paywall notice is several hundred characters of real
 * words, and storing it would be worse than storing nothing because everything
 * downstream would treat it as the article.
 */
export function looksLikeArticle(text: string, existingSummary: string | null): boolean {
  if (text.length < 600) return false;
  const words = text.split(/\s+/).length;
  if (words < 120) return false;
  if (/enable javascript|cookies? (policy|settings|consent)|subscribe to (continue|read)|you have reached your|are you a robot|access denied|403 forbidden/i.test(text.slice(0, 700))) {
    return false;
  }
  // A body no longer than the blurb we already hold is not worth a row.
  if (existingSummary && text.length < existingSummary.length * 1.4) return false;
  return true;
}

export interface BodyResult {
  itemId: string;
  /** The article text, when we got one worth keeping. */
  text: string | null;
  chars: number;
  reason: string | null;
}

/**
 * Longest body we will store.
 *
 * The extractor already truncates its prompt, but an unbounded column means one
 * pathological page can dominate a database dump and every backup of it.
 */
export const MAX_BODY_CHARS = 40_000;

export interface BodyRunResult {
  attempted: number;
  fetched: number;
  skipped: Record<string, number>;
}

/** Items worth fetching: retained by triage, no real body yet. */
export function itemsNeedingBody(db: DB, limit: number): Item[] {
  return db.prepare(`
    SELECT i.* FROM items i
      JOIN sources s ON s.id = i.source_id
     WHERE (i.body IS NULL OR LENGTH(i.body) < 600)
       AND i.url LIKE 'http%'
       AND s.kind = 'rss'
       AND i.triage_verdict IS NOT NULL AND i.triage_verdict != 'mundane'
     ORDER BY CASE i.triage_verdict WHEN 'notable' THEN 2 ELSE 1 END DESC,
              i.published_at DESC
     LIMIT @limit
  `).all({ limit }) as Item[];
}

const fail = (itemId: string, reason: string): BodyResult =>
  ({ itemId, text: null, chars: 0, reason });

/** The class of failure, for a tally that is worth reading. */
export function skipClass(reason: string | null): string {
  if (!reason) return 'unknown';
  const status = reason.match(/HTTP (\d{3})/);
  if (status) {
    return status[1] === '403' || status[1] === '401'
      ? 'blocked or paywalled'
      : `HTTP ${status[1]}`;
  }
  if (/no article text/.test(reason)) return 'no article text found';
  if (/not html/.test(reason)) return 'not an HTML page';
  return 'fetch failed';
}

/** Fetch one article. One request per item, and the text comes back with it. */
export async function fetchBody(cfg: Config, item: Item): Promise<BodyResult> {
  try {
    const res = await politeFetch(item.url, cfg, { retries: 1 });
    if (!res.ok) return fail(item.id, `HTTP ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(ct)) return fail(item.id, 'not html');

    const text = articleText(await res.text()).slice(0, MAX_BODY_CHARS);
    if (!looksLikeArticle(text, item.summary)) return fail(item.id, 'no article text');

    return { itemId: item.id, text, chars: text.length, reason: null };
  } catch (e) {
    return fail(item.id, e instanceof Error ? e.message.slice(0, 60) : 'failed');
  }
}

export async function fetchBodies(
  db: DB,
  cfg: Config,
  opts: { limit?: number; onProgress?: (r: BodyResult, item: Item) => void } = {},
): Promise<BodyRunResult> {
  const items = itemsNeedingBody(db, opts.limit ?? 40);
  const result: BodyRunResult = { attempted: items.length, fetched: 0, skipped: {} };
  const save = db.prepare('UPDATE items SET body = ? WHERE id = ?');

  for (const item of items) {
    const r = await fetchBody(cfg, item);
    if (r.text !== null) {
      save.run(r.text, item.id);
      result.fetched++;
      // A body that arrives after extraction has already run is only useful if
      // the item goes back through it, so reopen it for re-extraction.
      db.prepare(
        'UPDATE items SET extracted_at = NULL, extraction_error = NULL WHERE id = ? AND extracted_at IS NOT NULL',
      ).run(item.id);
    } else {
      // Group by the class of failure, not the message. A reason carrying the
      // URL makes every skip unique and the tally useless.
      result.skipped[skipClass(r.reason)] = (result.skipped[skipClass(r.reason)] ?? 0) + 1;
    }
    opts.onProgress?.(r, item);
  }
  return result;
}

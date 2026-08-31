import { XMLParser } from 'fast-xml-parser';
import * as cheerio from 'cheerio';
import type { Config } from '../core/config.js';
import { fetchText } from '../core/http.js';
import { stableId } from '../core/ids.js';
import { UNTRIAGED } from '../core/types.js';
import type { Item, Source } from '../core/types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // Feeds routinely wrap HTML in CDATA; keep it as text and strip tags later.
  cdataPropName: '__cdata',
});

/** Feed entries arrive as an object when there is one and an array when many. */
const arrayify = <T,>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** Pull usable text out of a node that might be a string, CDATA, or {#text}. */
function text(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if ('__cdata' in o) return text(o.__cdata);
    if ('#text' in o) return text(o['#text']);
  }
  return '';
}

/** Strip markup and collapse whitespace, so summaries are readable as text. */
export function htmlToText(html: string): string {
  if (!html) return '';
  if (!/[<&]/.test(html)) return html.replace(/\s+/g, ' ').trim();
  const $ = cheerio.load(html);
  $('script, style, nav, aside, form, noscript').remove();
  return $.root().text().replace(/\s+/g, ' ').trim();
}

/**
 * Atom links are an array of typed rel/href pairs; RSS links are a bare string.
 * Prefer rel="alternate" and fall back to the first href we can find.
 */
function pickLink(entry: Record<string, any>): string {
  const raw = entry.link ?? entry.url ?? entry['@_href'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  const links = arrayify(raw as any);
  const alt = links.find((l: any) => l?.['@_rel'] === 'alternate' && l['@_href']);
  const any = links.find((l: any) => l?.['@_href']);
  const chosen = (alt ?? any)?.['@_href'] ?? text(raw);
  if (chosen) return String(chosen).trim();
  // RDF feeds (Deutsche Welle, some others) put the URL only in the guid.
  const guid = text(entry.guid);
  return /^https?:/.test(guid) ? guid : '';
}

function pickDate(entry: Record<string, any>): string {
  const candidates = [
    entry.pubDate, entry.published, entry.updated, entry['dc:date'],
    entry.date, entry.issued, entry['prism:publicationDate'],
  ];
  for (const c of candidates) {
    const s = text(c);
    if (!s) continue;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  // Undated entries would otherwise sort to 1970 and never surface.
  return new Date().toISOString();
}

/**
 * Parse an RSS 2.0, Atom or RDF feed into items.
 *
 * Exported separately from the fetch so it can be tested against recorded
 * fixtures without touching the network.
 */
export function parseFeed(xml: string, source: Source, fetchedAt = new Date().toISOString()): Item[] {
  const doc = parser.parse(xml) as Record<string, any>;

  const channel = doc?.rss?.channel ?? doc?.['rdf:RDF'] ?? doc?.feed ?? doc?.channel;
  if (!channel) return [];

  const entries: Record<string, any>[] = [
    ...arrayify(channel.item),
    ...arrayify(channel.entry),
    ...arrayify(doc?.feed?.entry),
  ];

  const seen = new Set<string>();
  const items: Item[] = [];

  for (const e of entries) {
    const title = htmlToText(text(e.title));
    const url = pickLink(e);
    if (!title && !url) continue;

    // Prefer the source's own identifier so re-polls collapse onto one row.
    const externalId = text(e.guid) || text(e.id) || url || title;
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    const summaryRaw =
      text(e.description) || text(e.summary) || text(e['itunes:summary']) || '';
    // content:encoded is the full article when a feed is generous enough to ship it.
    const bodyRaw = text(e['content:encoded']) || text(e.content) || '';

    const summary = htmlToText(summaryRaw);
    const body = htmlToText(bodyRaw);

    items.push({
      id: stableId('item', source.id, externalId),
      sourceId: source.id,
      externalId,
      url,
      title,
      summary: summary || null,
      // Only keep body when it adds something beyond the summary.
      body: body && body.length > summary.length ? body : null,
      author:
        htmlToText(text(e.author?.name ?? e.author ?? e['dc:creator'])) || null,
      publishedAt: pickDate(e),
      fetchedAt,
      raw: null,
      extractedAt: null,
      ...UNTRIAGED,
      extractionError: null,
    });
  }

  return items;
}

export async function fetchRss(source: Source, cfg: Config): Promise<Item[]> {
  const xml = await fetchText(source.url, cfg);
  return parseFeed(xml, source);
}

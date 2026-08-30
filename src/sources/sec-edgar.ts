import type { Config } from '../core/config.js';
import { fetchText } from '../core/http.js';
import type { Item, Source } from '../core/types.js';
import { parseFeed } from './rss.js';

/**
 * SEC EDGAR.
 *
 * EDGAR's "getcurrent" browse endpoint serves an Atom feed of the newest
 * filings, so parsing reuses the RSS adapter. What this file adds is pulling
 * the CIK and the form type out of EDGAR's title convention, because those are
 * the keys that let a filing join to press coverage of the same company.
 *
 * SEC access policy requires a User-Agent naming a real contact; set
 * THROUGHLINE_CONTACT_EMAIL or requests will be throttled or refused.
 */

/** EDGAR titles look like: "4 - Doe John (0001234567) (Reporting)". */
const TITLE_RE = /^([A-Z0-9/-]+)\s+-\s+(.+?)\s+\((\d{4,10})\)(?:\s+\((.+?)\))?/;

export interface EdgarMeta {
  formType: string | null;
  filerName: string | null;
  cik: string | null;
  filerRole: string | null;
}

export function parseEdgarTitle(title: string): EdgarMeta {
  const m = TITLE_RE.exec(title.trim());
  if (!m) return { formType: null, filerName: null, cik: null, filerRole: null };
  return {
    formType: m[1] ?? null,
    filerName: m[2] ?? null,
    // CIKs are canonically zero-padded to 10 digits; pad so joins line up.
    cik: m[3] ? m[3].padStart(10, '0') : null,
    filerRole: m[4] ?? null,
  };
}

export function parseEdgarFeed(
  xml: string,
  source: Source,
  fetchedAt = new Date().toISOString(),
): Item[] {
  return parseFeed(xml, source, fetchedAt).map((item) => {
    const meta = parseEdgarTitle(item.title);
    return {
      ...item,
      // Hand the extractor the parsed identity rather than the terse title.
      body: [
        meta.formType ? `Form type: ${meta.formType}` : '',
        meta.filerName ? `Filer: ${meta.filerName}` : '',
        meta.cik ? `CIK: ${meta.cik}` : '',
        meta.filerRole ? `Filer role: ${meta.filerRole}` : '',
        item.summary ?? '',
      ].filter(Boolean).join('\n') || item.body,
      raw: { ...meta } as unknown as Record<string, unknown>,
    };
  });
}

export async function fetchEdgar(source: Source, cfg: Config): Promise<Item[]> {
  return parseEdgarFeed(await fetchText(source.url, cfg), source);
}

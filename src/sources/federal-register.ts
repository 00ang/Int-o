import type { Config } from '../core/config.js';
import { fetchJson } from '../core/http.js';
import { stableId } from '../core/ids.js';
import { UNTRIAGED } from '../core/types.js';
import type { Item, Source } from '../core/types.js';

/**
 * Federal Register API.
 *
 * Free, no key, well documented. Every rule, proposed rule, notice and
 * presidential document, with the agencies and (for rules) the regulated
 * entities attached as structured fields - which is why this is worth a
 * dedicated adapter rather than reading the RSS.
 */

interface FRDoc {
  document_number: string;
  title: string;
  abstract: string | null;
  publication_date: string;
  html_url: string;
  type: string;
  agencies?: { name?: string; raw_name?: string }[];
  docket_ids?: string[];
  regulation_id_numbers?: string[];
  significant?: boolean;
  effective_on?: string | null;
}

const FIELDS = [
  'document_number', 'title', 'abstract', 'publication_date', 'html_url', 'type',
  'agencies', 'docket_ids', 'regulation_id_numbers', 'significant', 'effective_on',
];

export function buildFederalRegisterUrl(base: string, sinceDate: string, perPage = 100): string {
  const u = new URL(base);
  for (const f of FIELDS) u.searchParams.append('fields[]', f);
  u.searchParams.set('per_page', String(perPage));
  u.searchParams.set('order', 'newest');
  u.searchParams.set('conditions[publication_date][gte]', sinceDate);
  return u.toString();
}

export function parseFederalRegister(
  payload: { results?: FRDoc[] },
  source: Source,
  fetchedAt = new Date().toISOString(),
): Item[] {
  return (payload.results ?? []).map((d) => {
    const agencies = (d.agencies ?? [])
      .map((a) => a.name ?? a.raw_name)
      .filter((n): n is string => !!n);
    return {
      id: stableId('item', source.id, d.document_number),
      sourceId: source.id,
      externalId: d.document_number,
      url: d.html_url,
      title: d.title,
      summary: d.abstract,
      // Give the extractor the structured facts in prose so it does not have to
      // guess the issuing body from the title.
      body: [
        `Document type: ${d.type}`,
        agencies.length ? `Issuing agency: ${agencies.join('; ')}` : '',
        d.effective_on ? `Effective: ${d.effective_on}` : '',
        d.significant ? 'Flagged significant under EO 12866.' : '',
        d.docket_ids?.length ? `Docket: ${d.docket_ids.join(', ')}` : '',
        d.abstract ?? '',
      ].filter(Boolean).join('\n'),
      author: agencies[0] ?? null,
      publishedAt: new Date(`${d.publication_date}T12:00:00Z`).toISOString(),
      fetchedAt,
      raw: d as unknown as Record<string, unknown>,
      extractedAt: null,
      ...UNTRIAGED,
      extractionError: null,
    };
  });
}

export async function fetchFederalRegister(
  source: Source,
  cfg: Config,
  sinceDays = 3,
): Promise<Item[]> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const payload = await fetchJson<{ results?: FRDoc[] }>(
    buildFederalRegisterUrl(source.url, since),
    cfg,
  );
  return parseFederalRegister(payload, source);
}

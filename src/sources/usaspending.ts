import type { Config } from '../core/config.js';
import { politeFetch } from '../core/http.js';
import { stableId } from '../core/ids.js';
import { UNTRIAGED } from '../core/types.js';
import type { Item, Source } from '../core/types.js';

/**
 * USASpending award search.
 *
 * This is the other half of the trade-then-award detector. It is a POST API
 * over a JSON body rather than a feed, so it gets its own adapter.
 *
 * Award types A-D are definitive contracts and delivery orders; IDVs and
 * grants are excluded here because an indefinite-delivery vehicle is a ceiling,
 * not money actually obligated, and treating it as a payday inflates every
 * signal built on top of it.
 */

interface AwardRow {
  'Award ID'?: string;
  generated_internal_id?: string;
  'Recipient Name'?: string;
  'Award Amount'?: number;
  'Awarding Agency'?: string;
  'Awarding Sub Agency'?: string;
  'Start Date'?: string;
  'Description'?: string;
  'Contract Award Type'?: string;
}

export function buildAwardSearchBody(sinceDate: string, untilDate: string, minAmount = 10_000_000) {
  return {
    filters: {
      time_period: [{ start_date: sinceDate, end_date: untilDate }],
      award_type_codes: ['A', 'B', 'C', 'D'],
      award_amounts: [{ lower_bound: minAmount }],
    },
    fields: [
      'Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency',
      'Awarding Sub Agency', 'Start Date', 'Description', 'Contract Award Type',
    ],
    sort: 'Award Amount',
    order: 'desc',
    limit: 100,
    page: 1,
  };
}

export function parseAwards(
  payload: { results?: AwardRow[] },
  source: Source,
  fetchedAt = new Date().toISOString(),
): Item[] {
  return (payload.results ?? []).flatMap((a) => {
    const recipient = a['Recipient Name'];
    const awardId = a['Award ID'] ?? a.generated_internal_id;
    if (!recipient || !awardId) return [];

    const amount = a['Award Amount'] ?? 0;
    const agency = [a['Awarding Agency'], a['Awarding Sub Agency']]
      .filter(Boolean).join(' / ');
    const start = a['Start Date'] ?? new Date().toISOString().slice(0, 10);

    return [{
      id: stableId('item', source.id, awardId),
      sourceId: source.id,
      externalId: awardId,
      url: a.generated_internal_id
        ? `https://www.usaspending.gov/award/${a.generated_internal_id}`
        : 'https://www.usaspending.gov/search',
      title: `${agency || 'US government'} awarded ${recipient} $${amount.toLocaleString('en-US')}`,
      summary: a.Description ?? null,
      body: [
        `Recipient: ${recipient}`,
        `Awarding agency: ${agency}`,
        `Obligated amount: USD ${amount.toLocaleString('en-US')}`,
        `Award type: ${a['Contract Award Type'] ?? 'unspecified'}`,
        `Period of performance start: ${start}`,
        a.Description ? `Description: ${a.Description}` : '',
      ].filter(Boolean).join('\n'),
      author: agency || null,
      publishedAt: new Date(`${start}T12:00:00Z`).toISOString(),
      fetchedAt,
      raw: a as unknown as Record<string, unknown>,
      extractedAt: null,
      ...UNTRIAGED,
      extractionError: null,
    }];
  });
}

export async function fetchAwards(
  source: Source,
  cfg: Config,
  sinceDays = 7,
): Promise<Item[]> {
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const res = await politeFetch(source.url, cfg, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildAwardSearchBody(since, until)),
  });
  return parseAwards(await res.json() as { results?: AwardRow[] }, source);
}

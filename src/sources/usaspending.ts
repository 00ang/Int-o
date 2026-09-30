import type { Config } from '../core/config.js';
import { politeFetch } from '../core/http.js';
import { stableId } from '../core/ids.js';
import { structuredRecordTriage } from '../core/types.js';
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
 *
 * NEW AWARDS ONLY, DATED BY SIGNATURE. Left to its default, the award search
 * matches any award with a transaction in the window, and sorting by amount
 * then fills all hundred rows with decades-old programmes whose lifetime value
 * dwarfs anything signed this week. Dated by their period of performance, those
 * landed in 1978-2018 and could never meet a 2025-26 trade inside a detector
 * window - which is why trade-then-award had never fired. `new_awards_only`
 * keeps awards whose base transaction was signed in the window, and the Base
 * Obligation Date is when the money was committed, so that is the date used.
 */

interface AwardRow {
  'Award ID'?: string;
  generated_internal_id?: string;
  'Recipient Name'?: string;
  'Award Amount'?: number;
  'Awarding Agency'?: string;
  'Awarding Sub Agency'?: string;
  'Start Date'?: string;
  /** When the base award was signed: the day the money was committed. */
  'Base Obligation Date'?: string;
  'Last Modified Date'?: string;
  'Description'?: string;
  'Contract Award Type'?: string;
}

export function buildAwardSearchBody(sinceDate: string, untilDate: string, minAmount = 10_000_000) {
  return {
    filters: {
      time_period: [{ start_date: sinceDate, end_date: untilDate, date_type: 'new_awards_only' }],
      award_type_codes: ['A', 'B', 'C', 'D'],
      award_amounts: [{ lower_bound: minAmount }],
    },
    fields: [
      'Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency',
      'Awarding Sub Agency', 'Start Date', 'Base Obligation Date', 'Last Modified Date',
      'Description', 'Contract Award Type',
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
    const signed = a['Base Obligation Date'] ?? a['Start Date'] ?? fetchedAt.slice(0, 10);

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
        a['Base Obligation Date'] ? `Signed: ${a['Base Obligation Date'].slice(0, 10)}` : '',
        a['Start Date'] ? `Period of performance start: ${a['Start Date']}` : '',
        a.Description ? `Description: ${a.Description}` : '',
      ].filter(Boolean).join('\n'),
      author: agency || null,
      publishedAt: new Date(`${signed.slice(0, 10)}T12:00:00Z`).toISOString(),
      fetchedAt,
      raw: a as unknown as Record<string, unknown>,
      // A dataset row, not an article: its event is written in code at ingest
      // (see pipeline/records.ts), so neither triage nor extraction reads it.
      extractedAt: fetchedAt,
      ...structuredRecordTriage(fetchedAt),
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

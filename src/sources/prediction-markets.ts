import type { Config } from '../core/config.js';
import { fetchJson } from '../core/http.js';
import { stableId } from '../core/ids.js';
import type { Item, Source } from '../core/types.js';

/**
 * Prediction markets.
 *
 * These are not news. They are stored as items so that forecasting can anchor
 * to a crowd price instead of a number the model made up, and so the brief can
 * say "the market moved 14 points on this" - which is often the story.
 */

export interface MarketSnapshot {
  externalId: string;
  question: string;
  probability: number | null;
  url: string;
  closesAt: string | null;
  volume: number | null;
  venue: string;
}

/** Polymarket gamma: outcomePrices is a JSON-encoded string array of prices. */
export function parsePolymarket(payload: unknown): MarketSnapshot[] {
  const rows = Array.isArray(payload) ? payload : [];
  return rows.flatMap((m: any) => {
    if (!m?.question) return [];
    let probability: number | null = null;
    try {
      const prices = typeof m.outcomePrices === 'string'
        ? JSON.parse(m.outcomePrices)
        : m.outcomePrices;
      const first = Array.isArray(prices) ? Number(prices[0]) : NaN;
      if (Number.isFinite(first)) probability = first;
    } catch { /* leave null rather than guess */ }
    return [{
      externalId: String(m.id ?? m.conditionId ?? m.slug),
      question: String(m.question),
      probability,
      url: m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
      closesAt: m.endDate ?? null,
      volume: Number(m.volumeNum ?? m.volume) || null,
      venue: 'polymarket',
    }];
  });
}

/** Kalshi quotes cents (0-100); normalise to a probability. */
export function parseKalshi(payload: any): MarketSnapshot[] {
  return (payload?.markets ?? []).flatMap((m: any) => {
    if (!m?.ticker) return [];
    const cents = Number(m.last_price ?? m.yes_bid);
    return [{
      externalId: String(m.ticker),
      question: String(m.title ?? m.subtitle ?? m.ticker),
      probability: Number.isFinite(cents) ? cents / 100 : null,
      url: `https://kalshi.com/markets/${m.event_ticker ?? m.ticker}`,
      closesAt: m.close_time ?? null,
      volume: Number(m.volume) || null,
      venue: 'kalshi',
    }];
  });
}

export function parseMetaculus(payload: any): MarketSnapshot[] {
  return (payload?.results ?? []).flatMap((q: any) => {
    if (!q?.title) return [];
    const p = q.community_prediction?.full?.q2 ?? q.question?.aggregations?.recency_weighted?.latest?.centers?.[0];
    return [{
      externalId: String(q.id),
      question: String(q.title),
      probability: typeof p === 'number' ? p : null,
      url: `https://www.metaculus.com${q.page_url ?? `/questions/${q.id}/`}`,
      closesAt: q.close_time ?? null,
      volume: null,
      venue: 'metaculus',
    }];
  });
}

export function snapshotsToItems(
  snaps: MarketSnapshot[],
  source: Source,
  fetchedAt = new Date().toISOString(),
): Item[] {
  return snaps.map((s) => ({
    id: stableId('item', source.id, s.externalId),
    sourceId: source.id,
    externalId: s.externalId,
    url: s.url,
    title: s.question,
    summary: s.probability == null
      ? `${s.venue} market, no current price`
      : `${s.venue} market at ${(s.probability * 100).toFixed(1)}%`,
    body: [
      `Venue: ${s.venue}`,
      s.probability == null ? '' : `Implied probability: ${(s.probability * 100).toFixed(1)}%`,
      s.closesAt ? `Closes: ${s.closesAt}` : '',
      s.volume ? `Volume: ${s.volume.toLocaleString('en-US')}` : '',
    ].filter(Boolean).join('\n'),
    author: s.venue,
    publishedAt: fetchedAt,
    fetchedAt,
    raw: s as unknown as Record<string, unknown>,
    // Markets are reference data, not assertions about the world, so they are
    // never sent to the extractor.
    extractedAt: fetchedAt,
    extractionError: null,
  }));
}

export async function fetchPredictionMarket(source: Source, cfg: Config): Promise<Item[]> {
  if (source.id === 'polymarket') {
    const u = new URL(source.url);
    u.searchParams.set('closed', 'false');
    u.searchParams.set('limit', '200');
    u.searchParams.set('order', 'volumeNum');
    u.searchParams.set('ascending', 'false');
    return snapshotsToItems(parsePolymarket(await fetchJson(u.toString(), cfg)), source);
  }
  if (source.id === 'kalshi') {
    const u = new URL(source.url);
    u.searchParams.set('status', 'open');
    u.searchParams.set('limit', '200');
    return snapshotsToItems(parseKalshi(await fetchJson(u.toString(), cfg)), source);
  }
  if (source.id === 'metaculus') {
    const u = new URL(source.url);
    u.searchParams.set('status', 'open');
    u.searchParams.set('limit', '100');
    u.searchParams.set('order_by', '-activity');
    return snapshotsToItems(parseMetaculus(await fetchJson(u.toString(), cfg)), source);
  }
  throw new Error(`No prediction-market adapter for source ${source.id}`);
}

import type { Config } from './config.js';

const lastRequestByHost = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch with a declared identity, a timeout, per-host rate limiting and
 * bounded retries.
 *
 * Retries only on 429, 5xx and network faults. A 404 or a 403 means the feed
 * moved or is blocking us, and hammering it helps nobody.
 */
export async function politeFetch(
  url: string,
  cfg: Config,
  init: RequestInit & { retries?: number } = {},
): Promise<Response> {
  const { retries = 2, ...rest } = init;
  const host = new URL(url).host;

  for (let attempt = 0; ; attempt++) {
    const since = Date.now() - (lastRequestByHost.get(host) ?? 0);
    if (since < cfg.hostDelayMs) await sleep(cfg.hostDelayMs - since);
    lastRequestByHost.set(host, Date.now());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
    try {
      const res = await fetch(url, {
        ...rest,
        signal: controller.signal,
        headers: {
          'User-Agent': cfg.userAgent,
          Accept: 'application/json, application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          ...(rest.headers ?? {}),
        },
      });
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt * 1000);
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(2 ** attempt * 1000);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function fetchText(url: string, cfg: Config, init?: RequestInit): Promise<string> {
  return (await politeFetch(url, cfg, init)).text();
}

export async function fetchJson<T = unknown>(
  url: string,
  cfg: Config,
  init?: RequestInit,
): Promise<T> {
  return (await politeFetch(url, cfg, init)).json() as Promise<T>;
}

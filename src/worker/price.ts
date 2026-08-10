/**
 * GET /api/price -> what the five coins are worth in dollars.
 *
 * The thin shell around src/lib/pricekit.ts. Everything interesting about this
 * endpoint is in one sentence: the answer does not depend on who asked, so
 * every visitor is served the same cached table and the upstream hears from
 * this Worker once a minute rather than once a visitor.
 *
 * That is the difference between a fiat number costing nothing and a fiat
 * number being a per-person heartbeat to a third party. It is also why the
 * response carries no visitor-derived anything: no address, no amount, no
 * balance. The page multiplies locally.
 */

import {
  coingeckoUrl,
  krakenUrl,
  parseCoinGecko,
  parseKraken,
  usable,
  type PriceTable,
  type Prices,
} from '../lib/pricekit';

/** How long one table is good for. A minute is far inside the drift of an
 *  indicative price and collapses a busy minute into a single upstream call. */
export const PRICE_TTL_SECONDS = 60;

/** The upstream must not be able to hold a request open forever. */
const UPSTREAM_TIMEOUT_MS = 4000;

async function readJson(url: string): Promise<unknown> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: stop.signal,
      headers: { accept: 'application/json' },
      // A price service has no business setting a cookie or bouncing this
      // somewhere else; the same rule the other proxies here follow.
      redirect: 'manual',
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask Kraken, then CoinGecko. Whichever answers with something usable wins. */
export async function readPrices(now: number): Promise<PriceTable | null> {
  const sources: { name: string; url: string; parse: (j: unknown) => Prices }[] = [
    { name: 'Kraken', url: krakenUrl(), parse: parseKraken },
    { name: 'CoinGecko', url: coingeckoUrl(), parse: parseCoinGecko },
  ];
  for (const source of sources) {
    const json = await readJson(source.url);
    if (json === null) continue;
    const usd = source.parse(json);
    if (usable(usd)) return { usd, source: source.name, at: now };
  }
  return null;
}

/**
 * The endpoint.
 *
 * `caches.default` is what makes this one request for the whole site: the
 * first visitor of the minute pays for the upstream call and everybody else is
 * served the copy at the edge. When both upstreams are down it answers 503
 * with a body the page knows to treat as "no fiat today", because a missing
 * price must never be able to break a page whose actual job is swapping.
 */
export async function priceApi(request: Request, now: number): Promise<Response> {
  const cache = typeof caches !== 'undefined' ? caches.default : undefined;
  const key = new Request(new URL('/api/price', request.url).toString(), { method: 'GET' });

  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }

  const table = await readPrices(now);
  if (!table) {
    // Not cached: a failing upstream should be retried by the next visitor,
    // not pinned in front of everybody for a minute.
    return new Response(JSON.stringify({ error: 'No price source answered.' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const response = new Response(JSON.stringify(table), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${PRICE_TTL_SECONDS}`,
    },
  });
  if (cache) await cache.put(key, response.clone());
  return response;
}

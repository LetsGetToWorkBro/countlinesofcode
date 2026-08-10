/**
 * What a coin is worth in dollars, and the rules for not lying about it.
 *
 * This exists so the swap ticket and the two wallets can print "about USD 72"
 * beside an amount, which is the one number people actually think in. It is
 * built to give away as little as printing that number can possibly cost.
 *
 * The shape is the whole privacy argument. A price table is *the same for
 * every visitor*: there is no address in the question and no amount, and the
 * answer for one person is the answer for everybody. So the Worker fetches one
 * table for the whole site and caches it at the edge, the browser asks this
 * origin (which it is already talking to), and the multiplication happens in
 * the page. The exchange never sees a balance because a balance is never sent;
 * the upstream cannot even count visitors, because it hears from Cloudflare
 * once a minute no matter how many people are looking.
 *
 * Two upstreams, both keyless: Kraken first, CoinGecko if Kraken is having a
 * day. Monero is why the obvious third choice is missing, Coinbase having
 * delisted it.
 *
 * DOM-free and fetch-free, so it unit tests under Node; the Worker moves the
 * bytes.
 */

/** The tickers anything on this site can be priced in. Lowercase, matching
 *  the `ticker` field of swapkit's coin table. */
export const PRICED = ['xmr', 'btc', 'eth', 'usdt', 'usdc'] as const;

export type PricedTicker = (typeof PRICED)[number];

/** Dollars per unit, per ticker. Partial: an upstream that only knows four of
 *  the five is worth more than nothing. */
export type Prices = Partial<Record<PricedTicker, number>>;

export interface PriceTable {
  usd: Prices;
  /** Which upstream answered, named on the page so the number has a source. */
  source: string;
  /** When it was read, so the page can say how old it is. */
  at: number;
}

/**
 * Is this a number we are willing to print beside somebody's money?
 *
 * A price arrives as a string from a public API and goes on screen next to an
 * amount. The failure that matters is not a missing price, which shows as
 * nothing; it is a *wrong* price presented with the same confidence as a right
 * one. So anything not finite, not positive, or outside a range no real quote
 * for these five assets has ever been in is refused rather than shown. The
 * ceiling is deliberately loose: it is there to catch a parse landing on the
 * wrong field, not to have an opinion about the market.
 */
export function plausible(value: unknown): value is number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 10_000_000;
}

function keep(into: Prices, ticker: PricedTicker, raw: unknown): void {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (plausible(n)) into[ticker] = n as number;
}

// ---------------------------------------------------------------------------
// Kraken. One request, all five, no key.

const KRAKEN_PAIRS = 'XMRUSD,XBTUSD,ETHUSD,USDTZUSD,USDCUSD';

export function krakenUrl(): string {
  return `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIRS}`;
}

/**
 * Kraken answers with its own asset names rather than the ones asked for:
 * XMRUSD comes back as XXMRZUSD, XBTUSD as XXBTZUSD. Matching on a substring
 * of the key rather than an exact name is what keeps that from mattering, and
 * it survives Kraken renaming the wrapper again, which it has done before.
 */
export function parseKraken(json: unknown): Prices {
  const j = (json ?? {}) as Record<string, unknown>;
  const result = j['result'];
  if (!result || typeof result !== 'object') return {};
  const out: Prices = {};
  for (const [pair, value] of Object.entries(result as Record<string, unknown>)) {
    const last = (value as Record<string, unknown> | null)?.['c'];
    const price = Array.isArray(last) ? last[0] : undefined;
    const name = pair.toUpperCase();
    // USDT and USDC are checked first: "USDCUSD" contains neither XBT nor XMR,
    // but a careless XBT test against "XXBTZUSD" and a USDC test against
    // "USDCUSD" can both match a sloppier pattern, so the specific wins.
    if (name.includes('USDT')) keep(out, 'usdt', price);
    else if (name.includes('USDC')) keep(out, 'usdc', price);
    else if (name.includes('XMR')) keep(out, 'xmr', price);
    else if (name.includes('XBT') || name.includes('BTC')) keep(out, 'btc', price);
    else if (name.includes('ETH')) keep(out, 'eth', price);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CoinGecko, for when Kraken is not answering. Also keyless.

const GECKO_IDS: Record<string, PricedTicker> = {
  monero: 'xmr',
  bitcoin: 'btc',
  ethereum: 'eth',
  tether: 'usdt',
  'usd-coin': 'usdc',
};

export function coingeckoUrl(): string {
  const ids = Object.keys(GECKO_IDS).join(',');
  return `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
}

export function parseCoinGecko(json: unknown): Prices {
  const j = (json ?? {}) as Record<string, unknown>;
  const out: Prices = {};
  for (const [id, ticker] of Object.entries(GECKO_IDS)) {
    const entry = j[id] as Record<string, unknown> | undefined;
    if (entry) keep(out, ticker, entry['usd']);
  }
  return out;
}

// ---------------------------------------------------------------------------

/** A table worth serving. One price is a table; none is a failed fetch. */
export function usable(prices: Prices): boolean {
  return Object.keys(prices).length > 0;
}

/**
 * What that much of this is worth, or null when it cannot be said.
 *
 * Null rather than zero, and null rather than a guess: a dash on the screen is
 * honest about not knowing, and "USD 0.00" beside somebody's Monero is not.
 */
export function usdValue(amount: unknown, ticker: string, table: Prices): number | null {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const price = table[String(ticker).toLowerCase() as PricedTicker];
  if (!plausible(price)) return null;
  return n * (price as number);
}

/**
 * Dollars, written the way money is written, and never with more precision
 * than the source deserves. Under a dollar keeps its cents to four places so a
 * dust amount is not simply "USD 0.00"; above that, two.
 */
export function formatUsd(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value > 0 && value < 1) return `USD ${value.toFixed(4)}`;
  return `USD ${value.toFixed(2)}`;
}

/** How stale, in words, for the line that says where the number came from. */
export function ageWords(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

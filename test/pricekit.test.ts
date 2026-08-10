/**
 * The price table.
 *
 * Two risks, and only one of them is "no price". A missing number shows as
 * nothing and costs a line on a page. A *wrong* number is printed beside
 * somebody's money with exactly the same confidence as a right one, so most of
 * what is checked here is the refusing.
 */

import { describe, expect, it } from 'vitest';
import {
  PRICED,
  ageWords,
  coingeckoUrl,
  formatUsd,
  krakenUrl,
  parseCoinGecko,
  parseKraken,
  plausible,
  usable,
  usdValue,
} from '../src/lib/pricekit';

/** Shaped like the real answer, wrapper names and all. */
const KRAKEN = {
  error: [],
  result: {
    XXMRZUSD: { c: ['393.74000000', '0.5'] },
    XXBTZUSD: { c: ['64177.50000', '0.01'] },
    XETHZUSD: { c: ['1875.91000', '1.0'] },
    USDTZUSD: { c: ['0.99909000', '100'] },
    USDCUSD: { c: ['1.00000000', '100'] },
  },
};

const GECKO = {
  monero: { usd: 394.38 },
  bitcoin: { usd: 64236 },
  ethereum: { usd: 1877.25 },
  tether: { usd: 0.999213 },
  'usd-coin': { usd: 0.999656 },
};

describe('reading a price table', () => {
  it('asks both upstreams for every coin the site can price, without a key', () => {
    for (const url of [krakenUrl(), coingeckoUrl()]) {
      expect(url.startsWith('https://')).toBe(true);
      expect(url, 'a key in the URL would be a key in a cached response').not.toMatch(/key|token|secret/i);
    }
    expect(krakenUrl()).toContain('XMRUSD');
    expect(coingeckoUrl()).toContain('monero');
  });

  it('reads Kraken through its own asset names', () => {
    // XMRUSD comes back as XXMRZUSD and XBTUSD as XXBTZUSD; matching on a
    // substring is what keeps that from mattering.
    expect(parseKraken(KRAKEN)).toEqual({
      xmr: 393.74, btc: 64177.5, eth: 1875.91, usdt: 0.99909, usdc: 1,
    });
  });

  it('does not confuse the two dollar coins with the two real ones', () => {
    /* The trap: "USDCUSD" and "USDTZUSD" both contain "USD", and a careless
     * test for bitcoin or ether against a stablecoin pair would file a
     * one-dollar price under btc. That is the wrong-number failure, so it gets
     * its own case. */
    const only = parseKraken({ result: { USDCUSD: { c: ['1.00'] }, USDTZUSD: { c: ['0.999'] } } });
    expect(only).toEqual({ usdc: 1, usdt: 0.999 });
    expect(only.btc).toBeUndefined();
    expect(only.eth).toBeUndefined();
    expect(only.xmr).toBeUndefined();
  });

  it('reads CoinGecko, which is the answer when Kraken is having a day', () => {
    expect(parseCoinGecko(GECKO)).toEqual({
      xmr: 394.38, btc: 64236, eth: 1877.25, usdt: 0.999213, usdc: 0.999656,
    });
  });

  it('agrees with itself across the two sources', () => {
    // Not a market assertion: if one parser is reading the wrong field, the
    // two tables stop being within a percent of each other.
    const a = parseKraken(KRAKEN);
    const b = parseCoinGecko(GECKO);
    for (const t of PRICED) {
      expect(Math.abs(a[t]! - b[t]!) / b[t]!, t).toBeLessThan(0.01);
    }
  });

  it('throws away anything it would be embarrassed to print', () => {
    for (const bad of [null, undefined, '', 'abc', 0, -1, NaN, Infinity, 1e9]) {
      expect(plausible(bad), String(bad)).toBe(false);
    }
    expect(plausible('393.74')).toBe(true);
    expect(plausible(0.999)).toBe(true);
    // And a table carrying one of those keeps the rest rather than the bad one.
    expect(parseKraken({ result: { XXMRZUSD: { c: ['0'] }, XXBTZUSD: { c: ['64000'] } } }))
      .toEqual({ btc: 64000 });
  });

  it('survives every shape an upstream can fail in', () => {
    for (const junk of [null, undefined, {}, { result: null }, { result: 'nope' }, { error: ['EQuery'] }]) {
      expect(parseKraken(junk)).toEqual({});
      expect(usable(parseKraken(junk))).toBe(false);
    }
    expect(parseCoinGecko(null)).toEqual({});
    expect(parseCoinGecko({ monero: {} })).toEqual({});
    // One price is still a table worth serving.
    expect(usable({ xmr: 393.74 })).toBe(true);
  });
});

describe('turning a price into something to print', () => {
  const table = { xmr: 400, btc: 64000, usdt: 1 };

  it('multiplies locally, which is the whole point', () => {
    expect(usdValue(0.18438301, 'xmr', table)).toBeCloseTo(73.75, 2);
    expect(usdValue('0.05', 'btc', table)).toBeCloseTo(3200, 2);
    expect(usdValue(0, 'xmr', table)).toBe(0);
    expect(usdValue(1, 'XMR', table), 'ticker case is the caller’s business, not a failure').toBe(400);
  });

  it('says nothing rather than something wrong', () => {
    // A coin with no price, and an amount that is not one.
    expect(usdValue(1, 'doge', table)).toBeNull();
    expect(usdValue(-1, 'xmr', table)).toBeNull();
    expect(usdValue('abc', 'xmr', table)).toBeNull();
    expect(usdValue(1, 'xmr', {})).toBeNull();
    expect(formatUsd(null)).toBeNull();
  });

  it('keeps the cents a dust amount actually has', () => {
    // "USD 0.00" beside somebody's money reads as zero rather than as small.
    expect(formatUsd(72.0712)).toBe('USD 72.07');
    expect(formatUsd(0.0123)).toBe('USD 0.0123');
    expect(formatUsd(0)).toBe('USD 0.00');
  });

  it('says how old the number is in words', () => {
    const now = 1_000_000_000;
    expect(ageWords(now, now)).toBe('just now');
    expect(ageWords(now - 30_000, now)).toBe('just now');
    expect(ageWords(now - 300_000, now)).toBe('5 minutes ago');
    expect(ageWords(now - 60_000 * 60 * 2, now)).toBe('2 hours ago');
    // A clock that went backwards is not a negative age.
    expect(ageWords(now + 5000, now)).toBe('just now');
  });
});

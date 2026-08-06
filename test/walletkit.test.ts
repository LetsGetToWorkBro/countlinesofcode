/**
 * The wallet's non-cryptographic logic. The amount maths matters most: a wallet
 * that turns 0.1 into 0.09999999999 through a float is a wallet that quietly
 * sends the wrong number, so the parse is integer-exact and the tests prove it
 * at the edges.
 */

import { describe, expect, it } from 'vitest';
import {
  ATOMIC_PER_XMR,
  checkSend,
  formatXmr,
  nodes,
  parseXmr,
  prettyError,
  proxyUri,
  restoreHeightForDate,
} from '../src/client/walletkit';

describe('parseXmr', () => {
  it('parses whole and fractional amounts exactly', () => {
    expect(parseXmr('1').atomic).toBe(ATOMIC_PER_XMR);
    expect(parseXmr('0.1').atomic).toBe(100_000_000_000n);
    expect(parseXmr('0.000000000001').atomic).toBe(1n); // one piconero
    expect(parseXmr('12.5').atomic).toBe(12_500_000_000_000n);
    expect(parseXmr('1,000.5').atomic).toBe(1_000_500_000_000_000n);
  });

  it('does not lose precision the way a float would', () => {
    // 0.1 + 0.2 in float is 0.30000000000000004; integer maths gives exactly 0.3.
    const sum = parseXmr('0.1').atomic! + parseXmr('0.2').atomic!;
    expect(sum).toBe(parseXmr('0.3').atomic);
  });

  it('refuses more decimals than Monero has', () => {
    expect(parseXmr('0.0000000000001').ok).toBe(false); // 13 places
  });

  it('refuses zero, empty and nonsense', () => {
    for (const v of ['', '0', '0.0', 'abc', '.', '1.2.3', '-1']) {
      expect(parseXmr(v).ok, v).toBe(false);
    }
  });
});

describe('formatXmr', () => {
  it('round-trips and trims trailing zeros', () => {
    expect(formatXmr(ATOMIC_PER_XMR)).toBe('1');
    expect(formatXmr(100_000_000_000n)).toBe('0.1');
    expect(formatXmr(1n)).toBe('0.000000000001');
    expect(formatXmr(0n)).toBe('0');
    expect(formatXmr(12_500_000_000_000n)).toBe('12.5');
  });

  it('round-trips a random spread of amounts', () => {
    for (const v of ['0.3', '999.999999999999', '0.000000000007', '42']) {
      expect(formatXmr(parseXmr(v).atomic!)).toBe(v);
    }
  });
});

describe('proxyUri', () => {
  it('builds a curated node path', () => {
    const first = nodes()[0]!;
    expect(proxyUri({ mode: 'n', key: first.id }, 'https://1999loc.com')).toEqual({
      ok: true,
      uri: `https://1999loc.com/api/xmr/n/${first.id}`,
    });
  });

  it('refuses an unknown curated id', () => {
    expect(proxyUri({ mode: 'n', key: 'nope' }).ok).toBe(false);
  });

  it('validates and encodes a custom node', () => {
    const out = proxyUri({ mode: 'c', key: 'https://my.node.example:18089' }, '');
    expect(out.ok).toBe(true);
    expect(out.uri).toMatch(/^\/api\/xmr\/c\/[A-Za-z0-9_-]+$/);
  });

  it('refuses a private custom node before it is ever encoded', () => {
    expect(proxyUri({ mode: 'c', key: 'https://192.168.1.1:18089' }).ok).toBe(false);
    expect(proxyUri({ mode: 'c', key: 'http://node.example.com' }).ok).toBe(false);
  });
});

describe('restoreHeightForDate', () => {
  it('is null when the date is unknown', () => {
    expect(restoreHeightForDate(undefined)).toBeNull();
    expect(restoreHeightForDate('')).toBeNull();
    expect(restoreHeightForDate('not a date')).toBeNull();
  });

  it('is a plausible height for a known recent date', () => {
    const h = restoreHeightForDate('2024-01-01');
    expect(h).toBeGreaterThan(3_000_000);
    expect(h).toBeLessThan(3_500_000);
  });
});

describe('checkSend', () => {
  const MAINNET_ADDR =
    '83TQcTwusSQ4WKbPQE5osrF3cR4GWe2zmcNWeozK6BSqHSaeLvjUVe476ouVwLKn1uVwEFcbJQvnme7W6dTV5SB93x45DEy';

  it('accepts a valid send within balance', () => {
    const r = checkSend(MAINNET_ADDR, '1', 5n * ATOMIC_PER_XMR, 'mainnet');
    expect(r.ok).toBe(true);
    expect(r.atomic).toBe(ATOMIC_PER_XMR);
  });

  it('refuses an amount over the unlocked balance', () => {
    const r = checkSend(MAINNET_ADDR, '10', 1n * ATOMIC_PER_XMR, 'mainnet');
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/more than the unlocked balance/i);
  });

  it('refuses a bad address', () => {
    expect(checkSend('not-an-address', '1', 5n * ATOMIC_PER_XMR, 'mainnet').ok).toBe(false);
  });

  it('refuses an address for the wrong network', () => {
    const r = checkSend(MAINNET_ADDR, '1', 5n * ATOMIC_PER_XMR, 'stagenet');
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/mainnet address.*stagenet wallet/i);
  });
});

describe('prettyError', () => {
  it('translates the errors a wallet user actually hits', () => {
    expect(prettyError(new Error('not enough unlocked money'))).toMatch(/unlocked balance/i);
    expect(prettyError(new Error('failed to connect to node'))).toMatch(/reach the node/i);
    expect(prettyError('invalid address checksum')).toMatch(/not valid/i);
    expect(prettyError(new Error('invalid mnemonic'))).toMatch(/seed phrase/i);
  });

  it('passes an unknown message through rather than swallowing it', () => {
    expect(prettyError(new Error('some novel failure'))).toBe('some novel failure');
  });
});

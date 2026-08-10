/**
 * Pointing one camera at two different formats, and at a lot of things that
 * are neither.
 */

import { describe, expect, it } from 'vitest';
import { encodeParts } from '../src/airgap/envelope';
import { UrEncoder, encodeUr } from '../src/airgap/ur';
import { cborEncode } from '../src/airgap/cbor';
import { Scanner, formatOf } from '../src/airgap/scanner';
import { bitcoinAccount, encodeAccount, moneroAccount, parseAccount } from '../src/keys/account';
import { openFromMnemonic } from '../src/keys/bitcoin';
import { walletFromSeed } from '../src/keys/monero';

function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

describe('telling the two wires apart', () => {
  it('recognises each from its first characters', () => {
    expect(formatOf('LV1:PSBT:1:1:00000000:AA')).toBe('labyrinth');
    expect(formatOf('ur:crypto-psbt/feadaoaxaaahjlkbghmd')).toBe('ur');
    expect(formatOf('UR:CRYPTO-PSBT/FEADAOAXAAAHJLKBGHMD')).toBe('ur');
  });

  it('says no to the rest of the world', () => {
    for (const junk of ['', 'WIFI:S:home;', 'https://example.com', 'bitcoin:bc1qx', 'LV:1', 'urn:isbn:1']) {
      expect(formatOf(junk), junk).toBeNull();
    }
  });
});

describe('reading either format without being told which', () => {
  const payload = bytes(1500, 5);

  it('reads our own wire', () => {
    const scanner = new Scanner();
    let last = scanner.offer('nonsense');
    for (const frame of encodeParts('PSBT', payload)) last = scanner.offer(frame);
    expect(last.format).toBe('labyrinth');
    expect(last.kind).toBe('PSBT');
    expect(last.payload).toEqual(payload);
  });

  it('reads BC-UR, and unwraps the CBOR nobody wants to think about', () => {
    const scanner = new Scanner();
    let last = scanner.offer('');
    for (const frame of encodeUr('crypto-psbt', payload, 200).firstPass()) last = scanner.offer(frame);
    expect(last.format).toBe('ur');
    expect(last.kind).toBe('crypto-psbt');
    expect(last.payload).toEqual(payload);
  });

  it('keeps both alive, so switching wallets mid-scan is not a dead end', () => {
    /* Somebody starts scanning one animation, gives up, and points the camera
     * at a different wallet showing the other format. Locking onto the first
     * format seen would make that a restart for no reason. */
    const scanner = new Scanner();
    const ours = encodeParts('PSBT', payload);
    scanner.offer(ours[0]!);
    scanner.offer(ours[1]!);

    let last = scanner.offer('ur:nonsense');
    for (const frame of encodeUr('crypto-psbt', bytes(400, 9), 200).firstPass()) last = scanner.offer(frame);
    expect(last.payload).toEqual(bytes(400, 9));
    expect(last.format).toBe('ur');

    // And the half-finished scan on the other wire is still there.
    for (const frame of ours.slice(2)) last = scanner.offer(frame);
    expect(last.format).toBe('labyrinth');
    expect(last.payload).toEqual(payload);
  });

  it('reports progress while it is still going', () => {
    const scanner = new Scanner();
    const frames = encodeParts('XMRUNSIGNED', bytes(3000));
    const first = scanner.offer(frames[0]!);
    expect(first.payload).toBeNull();
    expect(first.have).toBe(1);
    expect(first.total).toBe(frames.length);
  });

  it('says so rather than guessing when a UR type is not plain bytes', () => {
    /* crypto-hdkey and friends are CBOR structures, not byte strings. Taking
     * some slice of one and calling it the payload is how a wrong key gets
     * imported, so an unhandled type has to be an honest refusal. */
    const scanner = new Scanner();
    const structured = new UrEncoder('crypto-hdkey', cborEncode([1, new Uint8Array([2, 3])]), 500);
    const progress = scanner.offer(structured.nextPart());
    expect(progress.kind).toBe('crypto-hdkey');
    expect(progress.payload, 'no guess at which part was meant').toBeNull();
    expect(progress.problem).toMatch(/cannot read/i);
  });

  it('forgets everything when told to', () => {
    const scanner = new Scanner();
    const frames = encodeParts('PSBT', payload);
    scanner.offer(frames[0]!);
    scanner.reset();
    expect(scanner.offer(frames[1]!).have).toBe(1);
  });
});

describe('the watch-only export', () => {
  const btc = openFromMnemonic(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  const xmr = walletFromSeed(bytes(32, 77));

  it('carries a Bitcoin account and nothing that can spend', () => {
    const account = bitcoinAccount(btc);
    const wire = JSON.stringify(account);
    expect(account.zpub.startsWith('zpub')).toBe(true);
    expect(wire).not.toContain('abandon');
    expect(wire).not.toContain('zprv');
  });

  it('carries a Monero view key and not the spend key', () => {
    const account = moneroAccount(xmr, 'mainnet', Date.UTC(2024, 0, 1));
    const wire = JSON.stringify(account);
    expect(account.view).toBe(xmr.viewSecret);
    expect(wire).not.toContain(xmr.spendSecret);
    expect(wire).not.toContain(xmr.mnemonic[0]!);
    expect(account.height).toBeGreaterThan(3_000_000);
  });

  it('round-trips over the wire', () => {
    for (const account of [bitcoinAccount(btc), moneroAccount(xmr)]) {
      const frames = encodeParts('ACCOUNT', encodeAccount(account));
      const scanner = new Scanner();
      let last = scanner.offer(frames[0]!);
      for (const frame of frames.slice(1)) last = scanner.offer(frame);
      expect(parseAccount(last.payload!)).toEqual(account);
    }
  });

  it('refuses half an account rather than watching the wrong thing', () => {
    const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(parseAccount(enc({ v: 1, chain: 'btc' })), 'no key').toBeNull();
    expect(parseAccount(enc({ v: 1, chain: 'btc', zpub: 'nope', first: 'x' })), 'not a zpub').toBeNull();
    expect(parseAccount(enc({ v: 1, chain: 'xmr', address: 'a', view: 'zz', height: 1, network: 'mainnet' })), 'bad view key').toBeNull();
    expect(parseAccount(enc({ v: 1, chain: 'xmr', address: 'a', view: 'a'.repeat(64), height: -1, network: 'mainnet' })), 'negative height').toBeNull();
    expect(parseAccount(enc({ v: 1, chain: 'doge', x: 1 })), 'unknown chain').toBeNull();
    expect(parseAccount(new TextEncoder().encode('not json')), 'not json').toBeNull();
  });

  it('refuses a version it does not speak, rather than reading it anyway', () => {
    const future = new TextEncoder().encode(JSON.stringify({ v: 99, chain: 'btc', zpub: 'zpubx', first: 'y' }));
    expect(parseAccount(future)).toBeNull();
  });
});

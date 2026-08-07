/**
 * The onion advertisement.
 *
 * Onion-Location is a small header with sharp edges: sent from the onion it
 * is a loop, sent over plain http it is ignored, and sent with a mistyped
 * address it points people at nothing. The tests here are mostly about
 * refusing to send it, which is the behaviour that matters.
 */

import { describe, expect, it } from 'vitest';
import { isOnionHost, normaliseOnionHost, onionLocationFor, withOnionLocation } from '../src/lib/onion';

/** The Tor Project's own onion, which is a real v3 address. */
const ONION = '2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion';

describe('onion addresses', () => {
  it('accepts a v3 address', () => {
    expect(isOnionHost(ONION)).toBe(true);
    expect(isOnionHost(ONION.toUpperCase())).toBe(true);
    expect(isOnionHost(`${ONION}.`)).toBe(true); // fully qualified, trailing dot
  });

  it('refuses v2, which is dead and was never safe', () => {
    expect(isOnionHost('expyuzz4wqqyqhjn.onion')).toBe(false);
  });

  it('refuses anything that is not one', () => {
    for (const bad of ['', '1999loc.com', 'notanonion.onion', `${ONION}x`, 'a'.repeat(56), '2gzyxa5.onion']) {
      expect(isOnionHost(bad), bad).toBe(false);
    }
    // Base32 has no 0, 1, 8 or 9.
    expect(isOnionHost(ONION.replace('2', '0'))).toBe(false);
  });

  it('cleans up what an operator is likely to paste', () => {
    expect(normaliseOnionHost(`http://${ONION}/`)).toBe(ONION);
    expect(normaliseOnionHost(`  HTTPS://${ONION}/wallet.html  `)).toBe(ONION);
    expect(normaliseOnionHost(`${ONION}:80`)).toBe(ONION);
  });

  it('turns a typo into "no mirror" rather than a broken advertisement', () => {
    expect(normaliseOnionHost('typo.onion')).toBeNull();
    expect(normaliseOnionHost(undefined)).toBeNull();
    expect(normaliseOnionHost('')).toBeNull();
  });
});

describe('when the header is sent', () => {
  const at = (href: string) => new URL(href);

  it('advertises the mirror on an https page, path and query kept', () => {
    expect(onionLocationFor(at('https://1999loc.com/wallet.html#btc'), ONION)).toBe(`http://${ONION}/wallet.html`);
    expect(onionLocationFor(at('https://1999loc.com/golf?x=1'), ONION)).toBe(`http://${ONION}/golf?x=1`);
  });

  it('is http, because an onion is its own transport security', () => {
    // https on an onion buys a certificate warning, not safety.
    expect(onionLocationFor(at('https://1999loc.com/'), ONION)!.startsWith('http://')).toBe(true);
  });

  it('says nothing when no mirror is configured', () => {
    expect(onionLocationFor(at('https://1999loc.com/'), undefined)).toBeNull();
    expect(onionLocationFor(at('https://1999loc.com/'), '')).toBeNull();
    expect(onionLocationFor(at('https://1999loc.com/'), 'typo.onion')).toBeNull();
  });

  it('never advertises the onion to itself', () => {
    expect(onionLocationFor(at(`http://${ONION}/wallet.html`), ONION)).toBeNull();
  });

  it('stays quiet on plain http, where Tor Browser ignores it anyway', () => {
    expect(onionLocationFor(at('http://1999loc.com/'), ONION)).toBeNull();
    // Except on a development host, so the wiring is testable without a cert.
    expect(onionLocationFor(at('http://localhost:8788/'), ONION)).not.toBeNull();
  });

  it('stays out of the API, where nothing reads headers and a switch mid-swap helps nobody', () => {
    expect(onionLocationFor(at('https://1999loc.com/api/swap/quote?from=btc&to=xmr&amount=1'), ONION)).toBeNull();
    expect(onionLocationFor(at('https://1999loc.com/api/btc/n/mempool/fee-estimates'), ONION)).toBeNull();
  });
});

describe('attaching it to a response', () => {
  const url = new URL('https://1999loc.com/');

  it('adds the header without disturbing the response', async () => {
    const original = new Response('hello', { status: 201, headers: { 'x-kept': 'yes' } });
    const out = withOnionLocation(original, url, ONION);
    expect(out.headers.get('onion-location')).toBe(`http://${ONION}/`);
    expect(out.headers.get('x-kept')).toBe('yes');
    expect(out.status).toBe(201);
    expect(await out.text()).toBe('hello');
  });

  it('hands back the same response when there is nothing to add', () => {
    const original = new Response('x');
    expect(withOnionLocation(original, url, undefined)).toBe(original);
  });

  it('leaves a header that is already set alone', () => {
    const original = new Response('x', { headers: { 'onion-location': 'http://other.onion/' } });
    expect(withOnionLocation(original, url, ONION).headers.get('onion-location')).toBe('http://other.onion/');
  });
});

describe('the two places it has to be written', () => {
  it('keeps a placeholder in public/_headers for the static pages', async () => {
    // The asset router serves those without ever waking the Worker, so the
    // Worker's copy cannot cover them. `npm run onion:set` fills both in.
    const headers = await import('node:fs').then((fs) => fs.readFileSync('public/_headers', 'utf8'));
    expect(headers).toMatch(/Onion-Location/);
  });

  it('keeps one in wrangler.toml for the pages the Worker renders', async () => {
    const toml = await import('node:fs').then((fs) => fs.readFileSync('wrangler.toml', 'utf8'));
    expect(toml).toMatch(/ONION_HOST/);
  });
});

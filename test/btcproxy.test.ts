/**
 * The Esplora proxy's gates.
 *
 * Same threat model as the Monero proxy: this Worker forwards requests, so
 * the tests that matter are the ones proving it cannot be steered anywhere
 * but an explorer's wallet surface: not at private networks, not at cloud
 * metadata, not at arbitrary paths on a real explorer.
 */

import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from '../src/lib/xmrproxy';
import {
  BTC_SERVERS,
  btcServerById,
  isAllowedEsploraPath,
  resolveBtcTarget,
  validateCustomEsplora,
} from '../src/lib/btcproxy';

const ADDR = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const TXID = 'f'.repeat(64);

describe('the curated servers', () => {
  it('are exactly the two known public Esplora instances, https, in picker order', () => {
    expect(BTC_SERVERS.map((s) => s.id)).toEqual(['mempool', 'blockstream']);
    for (const server of BTC_SERVERS) {
      expect(server.origin).toMatch(/^https:\/\//);
      expect(server.origin.endsWith('/')).toBe(false);
      expect(server.note.length).toBeGreaterThan(5);
    }
    expect(btcServerById('mempool')!.origin).toBe('https://mempool.space/api');
    expect(btcServerById('nope')).toBeNull();
  });
});

describe('the endpoint allowlist', () => {
  it('permits exactly what the wallet asks', () => {
    for (const path of [
      ['address', ADDR],
      ['address', ADDR, 'utxo'],
      ['address', ADDR, 'txs'],
      ['address', ADDR, 'txs', 'chain'],
      ['address', ADDR, 'txs', 'chain', TXID],
      ['tx', TXID],
      ['tx', TXID, 'hex'],
      ['tx', TXID, 'status'],
      ['fee-estimates'],
      ['blocks', 'tip', 'height'],
    ]) {
      expect(isAllowedEsploraPath(path, 'GET'), path.join('/')).toBe(true);
    }
    expect(isAllowedEsploraPath(['tx'], 'POST')).toBe(true);
  });

  it('refuses everything else, which is the point', () => {
    for (const [path, method] of [
      [['block', '000'], 'GET'],
      [['address', '../../admin'], 'GET'],
      [['address', ADDR, 'delete'], 'GET'],
      [['tx', 'not-a-txid'], 'GET'],
      [['tx', TXID, 'hex', 'extra'], 'GET'],
      [['fee-estimates', 'x'], 'GET'],
      [['address', ADDR], 'POST'],
      [['tx', TXID], 'POST'],
      [['tx'], 'GET'],
      [[], 'GET'],
      [['tx'], 'DELETE'],
    ] as [string[], string][]) {
      expect(isAllowedEsploraPath(path, method), `${method} ${path.join('/')}`).toBe(false);
    }
  });
});

describe('custom Esplora validation', () => {
  it('accepts a clean https instance, with or without its /api path', () => {
    expect(validateCustomEsplora('https://esplora.example')).toEqual({ ok: true, base: 'https://esplora.example' });
    expect(validateCustomEsplora('esplora.example/api/')).toEqual({ ok: true, base: 'https://esplora.example/api' });
    expect(validateCustomEsplora('https://esplora.example:3001/api')).toEqual({
      ok: true,
      base: 'https://esplora.example:3001/api',
    });
  });

  it('runs the same SSRF gauntlet as a custom Monero node', () => {
    for (const bad of [
      'http://esplora.example', // not https
      'https://localhost/api',
      'https://10.0.0.5/api',
      'https://169.254.169.254/latest/meta-data',
      'https://esplora.internal/api',
      'https://[::1]/api',
    ]) {
      expect(validateCustomEsplora(bad).ok, bad).toBe(false);
    }
  });

  it('refuses paths that are not a short clean prefix', () => {
    expect(validateCustomEsplora('https://x.example/a/b/c/d').ok).toBe(false);
    expect(validateCustomEsplora('https://x.example/api?key=1').ok).toBe(false);
    expect(validateCustomEsplora('https://x.example/api#frag').ok).toBe(false);
    expect(validateCustomEsplora('').ok).toBe(false);
  });

  it('refuses credentials in the URL rather than silently stripping them', () => {
    // The Monero validator refuses these; stripping here instead would let a
    // user believe their user:pass was being forwarded when it never was.
    const result = validateCustomEsplora('https://user:pass@esplora.example/api');
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/credentials/i);
    expect(validateCustomEsplora('https://user@esplora.example/api').ok).toBe(false);
  });
});

describe('resolveBtcTarget', () => {
  it('builds the explorer URL for a curated server', () => {
    const target = resolveBtcTarget(['n', 'mempool', 'address', ADDR, 'utxo'], 'GET');
    expect(target).toEqual({ ok: true, url: `https://mempool.space/api/address/${ADDR}/utxo` });
  });

  it('builds the broadcast URL for POST /tx', () => {
    expect(resolveBtcTarget(['n', 'blockstream', 'tx'], 'POST').url).toBe('https://blockstream.info/api/tx');
  });

  it('re-validates a custom server, so a forged path cannot smuggle one', () => {
    const good = resolveBtcTarget(['c', encodeBase64Url('https://esplora.example/api'), 'fee-estimates'], 'GET');
    expect(good.url).toBe('https://esplora.example/api/fee-estimates');
    const smuggled = resolveBtcTarget(['c', encodeBase64Url('https://169.254.169.254'), 'fee-estimates'], 'GET');
    expect(smuggled.ok).toBe(false);
  });

  it('refuses unknown servers, modes, and disallowed paths', () => {
    expect(resolveBtcTarget(['n', 'ghost', 'fee-estimates'], 'GET').status).toBe(404);
    expect(resolveBtcTarget(['x', 'mempool', 'fee-estimates'], 'GET').status).toBe(404);
    expect(resolveBtcTarget(['n', 'mempool', 'admin'], 'GET').status).toBe(400);
    expect(resolveBtcTarget(['n'], 'GET').status).toBe(404);
    expect(resolveBtcTarget(['c', '!!!', 'fee-estimates'], 'GET').status).toBe(400);
  });
});

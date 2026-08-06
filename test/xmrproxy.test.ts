/**
 * The wallet's proxy is the one place this site makes an outbound request on a
 * visitor's behalf, so its gate matters more than most. Two things are being
 * proven: that a real wallet call resolves to the right node URL, and that
 * every server-side request forgery shape - a private IP, a loopback, a
 * metadata address, a smuggled path or query - is refused before a byte leaves.
 */

import { describe, expect, it } from 'vitest';
import {
  XMR_NODES,
  decodeBase64Url,
  encodeBase64Url,
  isAllowedRpcPath,
  nodeById,
  resolveTarget,
  validateCustomNode,
} from '../src/lib/xmrproxy';

describe('isAllowedRpcPath', () => {
  it('accepts the daemon endpoints a wallet actually calls', () => {
    for (const m of ['json_rpc', 'get_height', 'get_blocks.bin', 'get_o_indexes.bin', 'is_key_image_spent', 'send_raw_transaction', 'get_transactions']) {
      expect(isAllowedRpcPath(m), m).toBe(true);
    }
  });

  it('refuses anything that is not a single lowercase RPC method', () => {
    for (const m of ['../secret', 'json_rpc?x=1', 'a/b', 'JSON_RPC', 'json rpc', '..', '', 'get_blocks.bin.', 'x'.repeat(41), 'evil.php']) {
      expect(isAllowedRpcPath(m), m).toBe(false);
    }
  });
});

describe('validateCustomNode', () => {
  it('accepts a real https node, with or without a scheme or port', () => {
    expect(validateCustomNode('https://node.example.com:18089')).toMatchObject({ ok: true, origin: 'https://node.example.com:18089' });
    expect(validateCustomNode('node.example.com')).toMatchObject({ ok: true, origin: 'https://node.example.com' });
    expect(validateCustomNode('  https://xmr.example.org/  ')).toMatchObject({ ok: true, origin: 'https://xmr.example.org' });
  });

  it('refuses plain http', () => {
    expect(validateCustomNode('http://node.example.com').ok).toBe(false);
  });

  it('refuses credentials, a path, a query or a fragment', () => {
    expect(validateCustomNode('https://user:pw@node.example.com').ok).toBe(false);
    expect(validateCustomNode('https://node.example.com/json_rpc').ok).toBe(false);
    expect(validateCustomNode('https://node.example.com/?a=1').ok).toBe(false);
    expect(validateCustomNode('https://node.example.com/#x').ok).toBe(false);
  });

  it('refuses loopback, private, link-local and metadata addresses (SSRF)', () => {
    for (const host of [
      'localhost', '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', 'box.local', 'db.internal',
      'metadata.google.internal', '[fd00::1]', '[fe80::1]',
    ]) {
      expect(validateCustomNode(`https://${host}:18089`).ok, host).toBe(false);
    }
  });

  it('allows a public IP literal', () => {
    expect(validateCustomNode('https://95.217.1.1:18089').ok).toBe(true);
    // But not one that only looks public while decoding to a private tail.
    expect(validateCustomNode('https://[::ffff:10.0.0.1]:18089').ok).toBe(false);
  });

  it('rejects an empty or unparseable address', () => {
    expect(validateCustomNode('').ok).toBe(false);
    expect(validateCustomNode('http://').ok).toBe(false);
  });
});

describe('base64url round trip', () => {
  it('round-trips a node origin', () => {
    const origin = 'https://node.example.com:18089';
    expect(decodeBase64Url(encodeBase64Url(origin))).toBe(origin);
  });

  it('rejects non-base64url input', () => {
    expect(() => decodeBase64Url('has spaces')).toThrow();
    expect(() => decodeBase64Url('a/b+c=')).toThrow();
  });
});

describe('resolveTarget', () => {
  it('resolves a curated node plus method to its full URL', () => {
    const seth = nodeById('seth')!;
    const r = resolveTarget(['n', 'seth', 'json_rpc']);
    expect(r).toMatchObject({ ok: true, url: `${seth.origin}/json_rpc` });
  });

  it('resolves a binary sync endpoint', () => {
    const r = resolveTarget(['n', 'seth', 'get_blocks.bin']);
    expect(r.ok).toBe(true);
    expect(r.url).toMatch(/\/get_blocks\.bin$/);
  });

  it('resolves a validated custom node', () => {
    const key = encodeBase64Url('https://node.example.com:18089');
    const r = resolveTarget(['c', key, 'get_height']);
    expect(r).toMatchObject({ ok: true, url: 'https://node.example.com:18089/get_height' });
  });

  it('refuses a custom node that decodes to a private address', () => {
    const key = encodeBase64Url('https://10.0.0.1:18089');
    const r = resolveTarget(['c', key, 'get_height']);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('refuses an unknown curated id', () => {
    expect(resolveTarget(['n', 'nope', 'json_rpc'])).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses an unknown mode', () => {
    expect(resolveTarget(['x', 'seth', 'json_rpc'])).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses a method that is not a permitted RPC endpoint', () => {
    expect(resolveTarget(['n', 'seth', '../etc/passwd'])).toMatchObject({ ok: false, status: 400 });
    expect(resolveTarget(['n', 'seth', 'json_rpc', 'extra'])).toMatchObject({ ok: false });
  });

  it('refuses a malformed short path', () => {
    expect(resolveTarget(['n', 'seth']).ok).toBe(false);
  });
});

describe('the curated node list', () => {
  it('is all https origins with unique ids', () => {
    const ids = new Set<string>();
    for (const n of XMR_NODES) {
      expect(n.origin, n.id).toMatch(/^https:\/\//);
      expect(ids.has(n.id), `duplicate id ${n.id}`).toBe(false);
      ids.add(n.id);
    }
  });

  it('every curated origin passes the same SSRF gate a custom node must', () => {
    for (const n of XMR_NODES) {
      expect(validateCustomNode(n.origin).ok, n.id).toBe(true);
    }
  });
});

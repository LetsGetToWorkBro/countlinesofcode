/**
 * The Bitcoin wallet's bridge to the network, cut from the same cloth as the
 * Monero one (xmrproxy.ts).
 *
 * Bitcoin has no public wallet-RPC the way Monero nodes do; the lingua franca
 * for light wallets is the Esplora HTTP API that mempool.space and
 * blockstream.info serve. The browser cannot call them (connect-src 'self',
 * on purpose), so the wallet talks to `/api/btc/...` and the Worker forwards.
 * The explorer sees Cloudflare, never the visitor.
 *
 * The same two SSRF gates stand in front of every forward:
 *
 *   1. The destination is a curated server chosen by short id, or a custom
 *      Esplora URL the visitor typed which must survive the same private/
 *      loopback/metadata checks as a custom Monero node. Custom servers may
 *      carry a path (most Esplora instances live under /api).
 *   2. The forwarded path must match the short allowlist of Esplora endpoints
 *      a wallet needs: address lookups, UTXOs, transactions, fee estimates,
 *      the tip height, and POST /tx to broadcast. Nothing else passes, so the
 *      proxy cannot be steered anywhere but an explorer's read surface.
 */

import { validateCustomNode } from './xmrproxy';

export interface BtcServer {
  /** Short, URL-safe id used in the proxy path. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** Base URL of the Esplora API, no trailing slash. */
  origin: string;
  /** A one-line note about who runs it, shown honestly on the page. */
  note: string;
}

/**
 * Curated Esplora servers. Both are long-running public instances run by
 * known organisations; a visitor who trusts neither can point the wallet at
 * their own. Order matters: the first entry is the picker's default.
 */
export const BTC_SERVERS: BtcServer[] = [
  {
    id: 'mempool',
    label: 'mempool.space',
    origin: 'https://mempool.space/api',
    note: 'Run by the mempool.space open-source project.',
  },
  {
    id: 'blockstream',
    label: 'blockstream.info',
    origin: 'https://blockstream.info/api',
    note: 'Run by Blockstream.',
  },
];

export function btcServerById(id: string): BtcServer | null {
  return BTC_SERVERS.find((s) => s.id === id) ?? null;
}

/** Bech32 or base58 shapes; the explorer is the real validator. */
const ADDRESS = /^[a-zA-Z0-9]{14,90}$/;
const TXID = /^[0-9a-f]{64}$/;

/**
 * Is this Esplora path one a wallet legitimately asks? The list is the whole
 * read-and-broadcast surface the Bitcoin tab uses and nothing more.
 */
export function isAllowedEsploraPath(segments: string[], method: string): boolean {
  const [a, b, c, d] = segments;
  if (method === 'POST') {
    // Broadcasting a signed transaction is the one write.
    return segments.length === 1 && a === 'tx';
  }
  if (method !== 'GET') return false;

  if (a === 'address' && b !== undefined && ADDRESS.test(b)) {
    if (segments.length === 2) return true; // address stats
    if (segments.length === 3 && (c === 'utxo' || c === 'txs')) return true;
    if (segments.length === 4 && c === 'txs' && d === 'chain') return true;
    if (segments.length === 5 && c === 'txs' && d === 'chain' && TXID.test(segments[4]!)) return true;
    return false;
  }
  if (a === 'tx' && b !== undefined && TXID.test(b)) {
    if (segments.length === 2) return true;
    if (segments.length === 3 && (c === 'hex' || c === 'status')) return true;
    return false;
  }
  if (a === 'fee-estimates') return segments.length === 1;
  if (a === 'blocks' && b === 'tip' && c === 'height') return segments.length === 3;
  return false;
}

export interface CustomEsploraResult {
  ok: boolean;
  /** Normalised base URL (scheme + host + optional path, no trailing slash). */
  base?: string;
  problem?: string;
}

/**
 * Validate a custom Esplora URL. The host runs the same gauntlet as a custom
 * Monero node (https only, never private/loopback/metadata); unlike a node it
 * may carry a short path, because most self-hosted Esploras live under /api.
 */
export function validateCustomEsplora(raw: string): CustomEsploraResult {
  const text = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!text) return { ok: false, problem: 'Enter a server address.' };

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, problem: 'That is not a valid server address.' };
  }
  if (url.search || url.hash) {
    return { ok: false, problem: 'Give just the server address, with nothing after the path.' };
  }
  // Refused, not silently stripped: the Monero validator refuses these too,
  // and a user who pasted user:pass@host deserves to know the credentials
  // would never have been sent rather than to believe they were.
  if (url.username || url.password) {
    return { ok: false, problem: 'Leave credentials out of the address; this proxy will not forward them.' };
  }

  // The host and port go through the node validator, which owns the SSRF
  // rules; the path is checked separately since a node may not have one.
  const port = url.port ? `:${url.port}` : '';
  const host = validateCustomNode(`${url.protocol}//${url.hostname}${port}`);
  if (!host.ok) return { ok: false, problem: host.problem };

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length > 3 || segments.some((s) => !/^[a-zA-Z0-9._-]+$/.test(s) || s === '.' || s === '..')) {
    return { ok: false, problem: 'That server path does not look like an Esplora API.' };
  }
  const path = segments.length ? `/${segments.join('/')}` : '';
  return { ok: true, base: `${host.origin}${path}` };
}

export interface BtcTarget {
  ok: boolean;
  /** Full URL to fetch on the explorer, when ok. */
  url?: string;
  status?: number;
  problem?: string;
}

/**
 * Turn a proxy path into the explorer URL to fetch.
 *
 * The path is `/api/btc/<mode>/<key>/<esplora path>`:
 *   mode 'n' + a curated id, or
 *   mode 'c' + a base64url-encoded custom base URL (validated here again, so
 *   a forged path cannot smuggle a private address past the client).
 */
export function resolveBtcTarget(segments: string[], method: string): BtcTarget {
  if (segments.length < 3) return { ok: false, status: 404, problem: 'Malformed proxy path.' };
  const [mode, key, ...rest] = segments;

  if (!isAllowedEsploraPath(rest, method)) {
    return { ok: false, status: 400, problem: 'Not a permitted explorer endpoint.' };
  }

  let base: string;
  if (mode === 'n') {
    const server = btcServerById(key!);
    if (!server) return { ok: false, status: 404, problem: 'Unknown server.' };
    base = server.origin;
  } else if (mode === 'c') {
    let decoded: string;
    try {
      decoded = decodeB64Url(key!);
    } catch {
      return { ok: false, status: 400, problem: 'Malformed custom server.' };
    }
    const check = validateCustomEsplora(decoded);
    if (!check.ok) return { ok: false, status: 400, problem: check.problem };
    base = check.base!;
  } else {
    return { ok: false, status: 404, problem: 'Unknown server mode.' };
  }

  return { ok: true, url: `${base}/${rest.map(encodeURIComponent).join('/')}` };
}

/** base64url -> string; identical rules to the Monero proxy's decoder. */
function decodeB64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('not base64url');
  const pad = (4 - (value.length % 4)) % 4;
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  if (typeof atob === 'function') return atob(b64);
  return Buffer.from(b64, 'base64').toString('binary');
}

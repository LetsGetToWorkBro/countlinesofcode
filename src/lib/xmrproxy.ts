/**
 * The Monero wallet's one and only bridge to the network.
 *
 * A browser wallet has to talk to a Monero node to sync and to broadcast a
 * transaction, and this site's Content-Security-Policy is `connect-src 'self'`:
 * the page may reach this origin and nowhere else. That is deliberate and it is
 * not being widened for a wallet, of all pages. So the wallet talks to a
 * same-origin path, `/api/xmr/...`, and the Worker forwards the request to the
 * chosen node. The node never sees the visitor's IP; it sees Cloudflare.
 *
 * The forwarding is the dangerous part. An unrestricted "fetch whatever URL the
 * client names" is a server-side request forgery hole: it would let anyone use
 * this Worker to probe Cloudflare's own internal services or a private network.
 * So two gates stand in front of every forward:
 *
 *   1. The destination is either a node from the curated list below, chosen by
 *      a short id, or a custom node the visitor typed which must survive
 *      validateCustomNode: https only, and never a private, loopback,
 *      link-local or metadata address.
 *   2. The RPC method is a single lowercase daemon endpoint (get_height,
 *      json_rpc, get_blocks.bin ...). No slashes, no query, no traversal, so the
 *      path handed to the node cannot be steered anywhere but its RPC surface.
 *
 * Everything here is pure and unit-tested; the Worker in src/worker/index.ts is
 * the thin shell that calls it and streams the bytes back.
 */

export interface XmrNode {
  /** Short, URL-safe id used in the proxy path. */
  id: string;
  /** Human label for the picker. */
  label: string;
  /** The node's own origin, always https. */
  origin: string;
  network: 'mainnet' | 'stagenet' | 'testnet';
  /** A one-line note about who runs it, shown honestly on the page. */
  note: string;
}

/**
 * Curated remote nodes.
 *
 * All are well-known public nodes that accept remote wallet RPC over TLS. The
 * list is short on purpose: every entry is somebody this page is willing to
 * point traffic at by default, and a visitor who trusts none of them can point
 * the wallet at their own node instead. A public node can see which addresses
 * you ask about; it cannot spend, and with a full wallet it cannot even do that
 * much, because the scanning happens in the browser.
 */
// Every entry here is verified to answer through the proxy: a valid TLS
// certificate (Cloudflare rejects the self-signed certs most public nodes use
// with a 526) and a live daemon. The list is short because that bar removes
// most public nodes; a visitor who trusts none of these can point the wallet at
// their own. Re-test with scripts before adding one: a dead node in this list
// is a wallet that will not sync.
// Order matters: the first entry is the picker's default. Measured 2026-08-06
// against production, seth's json_rpc endpoint (the one a wallet must have to
// connect) timed out 522 on most attempts while its light endpoints answered —
// which as the default made the wallet look broken. Cake and stack answered
// json_rpc reliably, so cake leads and seth sits last as a fallback.
export const XMR_NODES: XmrNode[] = [
  {
    id: 'cake',
    label: 'xmr-node.cakewallet.com',
    origin: 'https://xmr-node.cakewallet.com:18081',
    network: 'mainnet',
    note: 'Run by the Cake Wallet team.',
  },
  {
    id: 'stack',
    label: 'monero.stackwallet.com',
    origin: 'https://monero.stackwallet.com:18081',
    network: 'mainnet',
    note: 'Run by the Stack Wallet team.',
  },
  {
    id: 'seth',
    label: 'node.sethforprivacy.com',
    origin: 'https://node.sethforprivacy.com',
    network: 'mainnet',
    note: 'Run by Seth Simmons. No logs, widely used; can be slow under load.',
  },
];

/** The curated node with this id, or null. */
export function nodeById(id: string): XmrNode | null {
  return XMR_NODES.find((n) => n.id === id) ?? null;
}

/**
 * A single daemon RPC endpoint: lowercase letters and underscores, optionally
 * a `.bin` suffix for the binary sync endpoints. This is the exact shape of
 * every monerod endpoint (get_height, json_rpc, get_blocks.bin,
 * is_key_image_spent, send_raw_transaction ...), and nothing else matches, so a
 * `..`, a slash, a query string or an absolute URL is rejected outright.
 */
const RPC_METHOD = /^[a-z][a-z0-9_]*(\.bin)?$/;

export function isAllowedRpcPath(method: string): boolean {
  return RPC_METHOD.test(method) && method.length <= 40;
}

/**
 * Hostnames and IP literals a forward must never reach: the loopback,
 * link-local (including the cloud metadata address 169.254.169.254), private
 * RFC 1918 ranges, unique-local IPv6, and the internal TLDs a private network
 * hands out. This is the SSRF gate; it runs on any custom node before a single
 * byte is sent.
 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  if (host === 'localhost' || host === 'ip6-localhost' || host === 'ip6-loopback') return true;
  if (/\.(local|internal|localhost|lan|home|intranet|corp|private)$/.test(host)) return true;

  // Bracketed or bare IPv6.
  const v6 = host.startsWith('[') ? host.slice(1, -1) : host;
  if (v6.includes(':')) {
    const lower = v6.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (/^(fc|fd)[0-9a-f]{2}:/.test(lower)) return true; // unique-local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local fe80::/10
    // IPv4-mapped/compatible. The URL parser normalises `::ffff:10.0.0.1` to
    // `::ffff:a00:1` (hex), so a dotted-quad check alone would miss it: decode
    // the embedded v4 from either the dotted or the hex form and gate on it.
    const mapped = mappedV4(lower);
    if (mapped) return isBlockedV4(mapped);
    return false;
  }

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return isBlockedV4(host);

  return false;
}

/** The embedded IPv4 of an IPv4-mapped/compatible IPv6, or null. Handles both
 *  the dotted tail (`::ffff:10.0.0.1`) and the hex tail the URL parser produces
 *  (`::ffff:a00:1`). */
function mappedV4(lower: string): string | null {
  const dotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return null;
}

function isBlockedV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed: reject
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT 100.64/10
  if (a >= 224) return true; // multicast + reserved
  return false;
}

export interface CustomNodeResult {
  ok: boolean;
  /** Normalised origin (scheme + host + port, no trailing slash) when ok. */
  origin?: string;
  problem?: string;
}

/**
 * Validate a node URL a visitor typed. https only, no credentials in the URL,
 * a real host that is not private or loopback, and no path of its own (the RPC
 * method is appended by the proxy). Returns the clean origin to forward to.
 */
export function validateCustomNode(raw: string): CustomNodeResult {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, problem: 'Enter a node address.' };

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, problem: 'That is not a valid node address.' };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, problem: 'The node must be https. A plain-http node would expose the traffic in transit.' };
  }
  if (url.username || url.password) {
    return { ok: false, problem: 'Do not put a username or password in the node address.' };
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { ok: false, problem: 'Give just the host and port, with no path after it.' };
  }
  if (url.search || url.hash) {
    return { ok: false, problem: 'Give just the host and port, with nothing after it.' };
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, problem: 'That address is a private or local one, which this will not connect to.' };
  }

  const port = url.port ? `:${url.port}` : '';
  return { ok: true, origin: `https://${url.hostname}${port}` };
}

export interface ResolvedTarget {
  ok: boolean;
  /** Full URL to fetch on the node, when ok. */
  url?: string;
  status?: number;
  problem?: string;
}

/**
 * Turn a proxy path into the node URL to fetch.
 *
 * The path is `/api/xmr/<mode>/<key>/<method>`:
 *   mode 'n' + a curated id, or
 *   mode 'c' + a base64url-encoded custom origin (validated here again, so a
 *   forged path cannot smuggle a private address past validateCustomNode).
 * `method` is the single RPC endpoint.
 */
export function resolveTarget(segments: string[]): ResolvedTarget {
  if (segments.length < 3) return { ok: false, status: 404, problem: 'Malformed proxy path.' };
  const [mode, key, ...rest] = segments;
  const method = rest.join('/');

  if (!isAllowedRpcPath(method)) {
    return { ok: false, status: 400, problem: 'Not a permitted Monero RPC method.' };
  }

  let origin: string;
  if (mode === 'n') {
    const node = nodeById(key!);
    if (!node) return { ok: false, status: 404, problem: 'Unknown node.' };
    origin = node.origin;
  } else if (mode === 'c') {
    let decoded: string;
    try {
      decoded = decodeBase64Url(key!);
    } catch {
      return { ok: false, status: 400, problem: 'Malformed custom node.' };
    }
    const check = validateCustomNode(decoded);
    if (!check.ok) return { ok: false, status: 400, problem: check.problem };
    origin = check.origin!;
  } else {
    return { ok: false, status: 404, problem: 'Unknown node mode.' };
  }

  return { ok: true, url: `${origin}/${method}` };
}

/** base64url -> string, throwing on anything that is not clean base64url. */
export function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('not base64url');
  // Restore the exact padding: an unpadded base64 of length L needs (4 - L%4)%4
  // '=' characters. The old `'=='.slice((L+3)%4)` added one '=' too few for
  // L%4===2 and L%4===3, so atob rejected those keys as malformed.
  const pad = (4 - (value.length % 4)) % 4;
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  // atob exists in Workers and browsers; in Node tests, Buffer covers it.
  if (typeof atob === 'function') return atob(b64);
  return Buffer.from(b64, 'base64').toString('binary');
}

/** string -> base64url, for the client to build a custom-node proxy path. */
export function encodeBase64Url(value: string): string {
  const b64 = typeof btoa === 'function' ? btoa(value) : Buffer.from(value, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

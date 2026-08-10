/**
 * Payment requests: a coin, an address, an amount, turned into the standard
 * URI a wallet understands and then into a QR code.
 *
 * A payment QR is the one picture where a single wrong character costs real
 * money: it scans perfectly and sends the funds to no one. So the address is
 * checked the way the wallet page's checker checks it, with the actual
 * checksum and not a regular expression: Bitcoin's base58check and bech32/
 * bech32m, and Monero's block base58 with its Keccak checksum. The hashes are
 * the audited @noble ones the wallet already uses. Nothing here talks to a
 * network; the URI and the code are built in the tab, and the address you type
 * is the address that goes in, unchanged.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export type Coin = 'btc' | 'xmr';

export interface CoinInfo {
  id: Coin;
  name: string;
  /** The URI scheme a wallet registers: bitcoin: or monero:. */
  scheme: string;
  ticker: string;
  /** Most decimal places the amount field allows for this coin. */
  decimals: number;
}

export const COINS: Record<Coin, CoinInfo> = {
  btc: { id: 'btc', name: 'Bitcoin', scheme: 'bitcoin', ticker: 'BTC', decimals: 8 },
  xmr: { id: 'xmr', name: 'Monero', scheme: 'monero', ticker: 'XMR', decimals: 12 },
};

export interface AddressCheck {
  valid: boolean;
  /** Why it is not valid, in words, when it is not. */
  problem: string | null;
  /** A short description of the kind of address, when it is valid. */
  kind: string | null;
}

// ---------------------------------------------------------------------------
// Bitcoin: base58check (legacy) and bech32/bech32m (segwit)
// ---------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode a Bitcoin base58 string to bytes, preserving leading-zero bytes, or
 *  null if a character is not in the alphabet. */
function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch === '1') bytes.unshift(0); else break; }
  return new Uint8Array(bytes);
}

function checkBase58Btc(address: string): AddressCheck {
  const raw = base58Decode(address);
  if (!raw || raw.length !== 25) return { valid: false, problem: 'That is not the right length for a Bitcoin address.', kind: null };
  const payload = raw.subarray(0, 21);
  const given = raw.subarray(21);
  const want = sha256(sha256(payload));
  for (let i = 0; i < 4; i++) {
    if (given[i] !== want[i]) return { valid: false, problem: 'The checksum does not match; something in the address is mistyped.', kind: null };
  }
  if (raw[0] === 0x00) return { valid: true, problem: null, kind: 'Bitcoin (P2PKH)' };
  if (raw[0] === 0x05) return { valid: true, problem: null, kind: 'Bitcoin (P2SH)' };
  return { valid: false, problem: 'That is a valid base58 string but not a Bitcoin mainnet address.', kind: null };
}

const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bechPolymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

function bechHrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function checkBech32Btc(address: string): AddressCheck {
  const bad = { valid: false, problem: 'That is not a valid bech32 Bitcoin address.', kind: null };
  // A bech32 string must not mix upper and lower case.
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return bad;
  const a = address.toLowerCase();
  if (a.length < 8 || a.length > 90) return bad;
  const pos = a.lastIndexOf('1');
  if (pos < 1 || pos + 7 > a.length) return bad;
  const hrp = a.slice(0, pos);
  if (hrp !== 'bc') return { valid: false, problem: 'That is a bech32 address but not on the Bitcoin mainnet (it should start with bc1).', kind: null };
  const data: number[] = [];
  for (const c of a.slice(pos + 1)) {
    const d = BECH.indexOf(c);
    if (d < 0) return bad;
    data.push(d);
  }
  const witver = data[0]!;
  if (witver > 16) return bad;
  const constant = bechPolymod([...bechHrpExpand(hrp), ...data]);
  const wanted = witver === 0 ? BECH32_CONST : BECH32M_CONST;
  if (constant !== wanted) return { valid: false, problem: 'The checksum does not match; something in the address is mistyped.', kind: null };
  // Convert the 5-bit data (minus version and 6-char checksum) to bytes to
  // check the witness-program length the spec requires.
  const prog = convertBits(data.slice(1, data.length - 6), 5, 8, false);
  if (!prog || prog.length < 2 || prog.length > 40) return bad;
  if (witver === 0 && prog.length !== 20 && prog.length !== 32) return bad;
  const kind = witver === 0 ? (prog.length === 20 ? 'Bitcoin (P2WPKH)' : 'Bitcoin (P2WSH)') : 'Bitcoin (Taproot)';
  return { valid: true, problem: null, kind };
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Monero: the block base58 and the Keccak checksum
// ---------------------------------------------------------------------------

const XMR_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const XMR_BLOCK_CHARS = [0, 2, 3, 5, 6, 7, 9, 10, 11];

function xmrDecodeBlock(text: string): Uint8Array | null {
  const length = XMR_BLOCK_CHARS.indexOf(text.length);
  if (length < 0) return null;
  let n = 0n;
  for (const ch of text) {
    const index = XMR_ALPHABET.indexOf(ch);
    if (index < 0) return null;
    n = n * 58n + BigInt(index);
  }
  if (n >= 1n << BigInt(length * 8)) return null;
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

function xmrBase58Decode(text: string): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let at = 0;
  for (; at + 11 <= text.length; at += 11) {
    const block = xmrDecodeBlock(text.slice(at, at + 11));
    if (!block) return null;
    parts.push(block);
  }
  if (at < text.length) {
    const block = xmrDecodeBlock(text.slice(at));
    if (!block) return null;
    parts.push(block);
  }
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** Monero mainnet prefix bytes, from cryptonote_config.h. Payment requests are
 *  a mainnet thing, so the test/stage nets are deliberately not accepted. */
const XMR_PREFIXES: { byte: number; kind: string; length: number }[] = [
  { byte: 18, kind: 'Monero (standard)', length: 69 },
  { byte: 19, kind: 'Monero (integrated)', length: 77 },
  { byte: 42, kind: 'Monero (subaddress)', length: 69 },
];

function checkXmr(address: string): AddressCheck {
  const raw = xmrBase58Decode(address);
  if (!raw || raw.length < 69) return { valid: false, problem: 'That is not the right length for a Monero address.', kind: null };
  const prefix = XMR_PREFIXES.find((p) => p.byte === raw[0]);
  if (!prefix) return { valid: false, problem: 'That is not a Monero mainnet address.', kind: null };
  if (raw.length !== prefix.length) return { valid: false, problem: 'That is a Monero address of the wrong length.', kind: null };
  const body = raw.subarray(0, raw.length - 4);
  const given = raw.subarray(raw.length - 4);
  const want = keccak_256(body).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (given[i] !== want[i]) return { valid: false, problem: 'The checksum does not match; something in the address is mistyped.', kind: null };
  }
  return { valid: true, problem: null, kind: prefix.kind };
}

/** Check a receiving address for the chosen coin, with its real checksum. */
export function checkAddress(coin: Coin, address: string): AddressCheck {
  const a = String(address ?? '').trim();
  if (!a) return { valid: false, problem: 'Enter the address the payment should go to.', kind: null };
  if (coin === 'xmr') return checkXmr(a);
  if (/^bc1/i.test(a)) return checkBech32Btc(a);
  if (/^[13]/.test(a)) return checkBase58Btc(a);
  return { valid: false, problem: 'That does not look like a Bitcoin address (it should start with 1, 3, or bc1).', kind: null };
}

// ---------------------------------------------------------------------------
// The amount and the URI
// ---------------------------------------------------------------------------

export interface AmountCheck {
  ok: boolean;
  /** The amount, normalised to a plain decimal string, when ok. */
  value: string | null;
  problem: string | null;
}

/**
 * Read and normalise an amount for a coin. An empty amount is allowed: a
 * payment request without one lets the payer choose how much. A number with
 * more decimals than the coin has, or that is negative, is not.
 */
export function parseAmount(coin: Coin, text: string): AmountCheck {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: true, value: null, problem: null };
  if (!/^\d*\.?\d*$/.test(raw) || raw === '.') return { ok: false, value: null, problem: 'That is not a number.' };
  const num = Number(raw);
  if (!isFinite(num) || num < 0) return { ok: false, value: null, problem: 'That is not a positive amount.' };
  if (num === 0) return { ok: false, value: null, problem: 'An amount of zero is not a payment.' };
  const decimals = (raw.split('.')[1] || '').length;
  if (decimals > COINS[coin].decimals) {
    return { ok: false, value: null, problem: `${COINS[coin].name} has at most ${COINS[coin].decimals} decimal places.` };
  }
  // Normalise: drop a leading '.', trailing zeros, and a trailing dot.
  let value = raw;
  if (value.startsWith('.')) value = '0' + value;
  if (value.includes('.')) value = value.replace(/0+$/, '').replace(/\.$/, '');
  return { ok: true, value, problem: null };
}

export interface Request {
  amount?: string | null;
  label?: string | null;
  message?: string | null;
}

/**
 * Build the payment URI a wallet reads. Bitcoin follows BIP-21 (amount, label,
 * message); Monero follows its own scheme with the same three ideas under
 * tx_amount, recipient_name and tx_description. Only the fields that were given
 * are included, so a bare request is just the scheme and the address.
 */
export function buildUri(coin: Coin, address: string, req: Request = {}): string {
  const scheme = COINS[coin].scheme;
  const params: string[] = [];
  const enc = (v: string) => encodeURIComponent(v);
  const amount = (req.amount ?? '').trim();
  const label = (req.label ?? '').trim();
  const message = (req.message ?? '').trim();
  if (coin === 'btc') {
    if (amount) params.push(`amount=${amount}`);
    if (label) params.push(`label=${enc(label)}`);
    if (message) params.push(`message=${enc(message)}`);
  } else {
    if (amount) params.push(`tx_amount=${amount}`);
    if (label) params.push(`recipient_name=${enc(label)}`);
    if (message) params.push(`tx_description=${enc(message)}`);
  }
  return `${scheme}:${address}${params.length ? '?' + params.join('&') : ''}`;
}

const globalScope = globalThis as unknown as { LOC1999_PAY?: Record<string, unknown> };
globalScope.LOC1999_PAY = {
  COINS,
  checkAddress,
  parseAmount,
  buildUri,
};

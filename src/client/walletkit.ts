/**
 * The wallet page's own logic, kept out of the DOM so it can be tested.
 *
 * The Monero cryptography and the network sync are monero-ts's job, done in a
 * Web Worker; this file is everything around it that has a right or a wrong
 * answer: turning a typed amount into piconero without losing a digit, deciding
 * which node the proxy should forward to, working out where a restored wallet
 * should start scanning, and turning the library's terse errors into a sentence.
 *
 * None of it touches the network or the DOM, so test/walletkit.test.ts can hold
 * it to the awkward cases (a dust amount, a fee that would overdraw, a custom
 * node that is really a private address) without a browser.
 */

import { parseAddress, restoreHeight, type Network } from './monero';
import { XMR_NODES, encodeBase64Url, validateCustomNode, type XmrNode } from '../lib/xmrproxy';

/** Monero has twelve decimal places; one XMR is 10^12 piconero (atomic units). */
export const ATOMIC_PER_XMR = 1_000_000_000_000n;
const DECIMALS = 12;

export interface AmountResult {
  ok: boolean;
  /** The amount in piconero, when ok. */
  atomic?: bigint;
  problem?: string;
}

/**
 * Parse a typed XMR amount into piconero.
 *
 * Done as integer string arithmetic, never through a float: `0.1` is not
 * representable in binary floating point, and a wallet that quietly sends
 * 0.09999999999 because of it is a wallet nobody should trust. The whole and
 * fractional parts are handled as digits and combined, so every value the user
 * can type maps to an exact atomic count or is refused.
 */
export function parseXmr(text: string): AmountResult {
  const raw = String(text ?? '').trim().replace(/,/g, '');
  if (!raw) return { ok: false, problem: 'Enter an amount.' };
  if (!/^\d*\.?\d*$/.test(raw) || raw === '.') return { ok: false, problem: 'That is not a number.' };

  const [whole = '', frac = ''] = raw.split('.');
  if (frac.length > DECIMALS) {
    return { ok: false, problem: `Monero has ${DECIMALS} decimal places; that has more.` };
  }
  const atomic = BigInt(whole || '0') * ATOMIC_PER_XMR + BigInt((frac + '0'.repeat(DECIMALS)).slice(0, DECIMALS) || '0');
  if (atomic <= 0n) return { ok: false, problem: 'Enter an amount greater than zero.' };
  return { ok: true, atomic };
}

/**
 * Format piconero as an XMR string, trimming trailing zeros but never the whole
 * decimal point away to zero. `formatXmr(0n)` is `"0"`, not `"0."`.
 */
export function formatXmr(atomic: bigint): string {
  const negative = atomic < 0n;
  const value = negative ? -atomic : atomic;
  const whole = value / ATOMIC_PER_XMR;
  const frac = (value % ATOMIC_PER_XMR).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + whole.toString() + (frac ? `.${frac}` : '');
}

export interface NodeChoice {
  /** 'n' for a curated node, 'c' for a custom one. */
  mode: 'n' | 'c';
  /** The curated id, or the custom origin. */
  key: string;
}

/**
 * The same-origin proxy base URI the wallet points monero-ts at. The library
 * appends the RPC method (`/json_rpc`, `/get_blocks.bin`), so this is just the
 * base. A curated node is `/api/xmr/n/<id>`; a custom node is validated and its
 * origin base64url-encoded into `/api/xmr/c/<encoded>`.
 *
 * `origin` is normally location.origin; it is a parameter so a test can pin it.
 */
export function proxyUri(choice: NodeChoice, origin = ''): { ok: boolean; uri?: string; problem?: string } {
  if (choice.mode === 'n') {
    if (!XMR_NODES.some((n) => n.id === choice.key)) return { ok: false, problem: 'Unknown node.' };
    return { ok: true, uri: `${origin}/api/xmr/n/${choice.key}` };
  }
  const check = validateCustomNode(choice.key);
  if (!check.ok) return { ok: false, problem: check.problem };
  return { ok: true, uri: `${origin}/api/xmr/c/${encodeBase64Url(check.origin!)}` };
}

/** The curated nodes, for the picker. */
export function nodes(): XmrNode[] {
  return XMR_NODES;
}

/**
 * A restore height for a wallet whose owner knows roughly when they made it.
 *
 * Reuses the paper-wallet page's estimator, which deliberately errs early: a
 * height a little before the real creation date costs some scanning time, while
 * one after it silently hides the earliest payments. When the date is unknown,
 * null means "let the wallet scan from the library's default", which is safe if
 * slow.
 */
export function restoreHeightForDate(when?: string | number | Date): number | null {
  if (when === undefined || when === '' || when === null) return null;
  const at = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(at.getTime())) return null;
  return restoreHeight(at);
}

export interface SendCheck {
  ok: boolean;
  problem?: string;
  atomic?: bigint;
  network?: Network | null;
}

/**
 * Validate a send before it is built: a real destination on the right network,
 * a positive amount, and enough balance to cover it. The fee is not known until
 * the wallet builds the transaction, so this checks against the full unlocked
 * balance and lets the wallet itself reject an amount that leaves nothing for
 * the fee, with its exact number.
 */
export function checkSend(address: string, amountText: string, unlockedAtomic: bigint, walletNetwork: Network): SendCheck {
  const parsed = parseAddress(address);
  if (!parsed.valid) return { ok: false, problem: parsed.problem ?? 'That destination address is not valid.' };
  if (parsed.network !== walletNetwork) {
    return { ok: false, problem: `That is a ${parsed.network} address, but this is a ${walletNetwork} wallet.` };
  }
  const amount = parseXmr(amountText);
  if (!amount.ok) return { ok: false, problem: amount.problem };
  if (amount.atomic! > unlockedAtomic) {
    return { ok: false, problem: `That is more than the unlocked balance (${formatXmr(unlockedAtomic)} XMR).` };
  }
  return { ok: true, atomic: amount.atomic, network: parsed.network };
}

/**
 * Turn the library's errors into something a person can act on. monero-ts
 * surfaces daemon and validation errors as terse strings; the ones a wallet
 * user actually hits are worth translating.
 */
/**
 * A live verdict on an address as somebody types or pastes it.
 *
 * This is the field-side check, not the send-side one: checkSend still has
 * the last word before a payment is built. What this adds is a tick the
 * moment the address is complete, which is the point at which a mistyped or
 * half-pasted address is cheapest to notice.
 *
 * The tick means more than "looks about right": parseAddress verifies the
 * base58 and the four-byte checksum, so a single wrong character fails it.
 * What it cannot tell you, and the page says so, is whether this is the
 * address you were actually given: clipboard malware substitutes addresses
 * that checksum perfectly.
 */
export type AddressState = 'empty' | 'ok' | 'wrong-network' | 'bad';

export interface AddressVerdict {
  state: AddressState;
  /** A few words for the marker beside the field. */
  note: string;
}

export function checkAddress(text: string, walletNetwork: Network = 'mainnet'): AddressVerdict {
  const raw = String(text ?? '').trim();
  if (!raw) return { state: 'empty', note: '' };

  const parsed = parseAddress(raw);
  if (!parsed.valid) return { state: 'bad', note: 'not a valid Monero address' };

  if (parsed.network !== walletNetwork) {
    // Valid, and useless here: paying a stagenet address from a mainnet
    // wallet is a transaction that cannot go anywhere.
    return { state: 'wrong-network', note: `that is a ${parsed.network} address` };
  }

  const kind = parsed.kind === 'integrated' ? 'integrated address'
    : parsed.kind === 'subaddress' ? 'subaddress'
    : 'address';
  return { state: 'ok', note: `valid Monero ${kind}` };
}

export function prettyError(err: unknown): string {
  const message = (err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err)) || 'Something went wrong.';
  if (/not enough (unlocked )?money|not enough unlocked|subtract.*fee/i.test(message)) {
    return 'Not enough unlocked balance to cover the amount and the network fee. Recent incoming funds stay locked for about twenty minutes.';
  }
  if (/failed to connect|connect|connection|not connected|daemon|network error|fetch|timeout|unreachable|502|node_/i.test(message)) {
    return 'Could not reach the node. Pick another node, or check your connection, and try again.';
  }
  if (/invalid address|checksum|decode/i.test(message)) {
    return 'That address is not valid. Check it and paste it again.';
  }
  if (/invalid.*mnemonic|seed|word/i.test(message)) {
    return 'That seed phrase is not valid. It should be 25 words (or 13 for an older wallet), in order.';
  }
  if (/double spend|already|been spent/i.test(message)) {
    return 'Those funds look already spent. Refresh the wallet and try again.';
  }
  return message;
}

const globalScope = globalThis as unknown as { LOC1999_WALLET?: Record<string, unknown> };
globalScope.LOC1999_WALLET = {
  ATOMIC_PER_XMR,
  parseXmr,
  formatXmr,
  proxyUri,
  nodes,
  restoreHeightForDate,
  checkSend,
  checkAddress,
  prettyError,
};

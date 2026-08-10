/**
 * The watch-only export: the one thing this device ever sends first.
 *
 * Everything else that crosses the gap is a reply. This is the handshake: the
 * vault makes a key, and the companion needs enough to watch the chain for it
 * and build transactions, and not one bit more than that.
 *
 * ## What is being handed over, and what it costs
 *
 * For Bitcoin, an account zpub. For Monero, the primary address and the
 * private *view* key. Neither can spend. Both can watch, and watching is not
 * nothing: whoever holds them sees every payment that wallet ever receives,
 * and for Bitcoin an account zpub links every address in the wallet together
 * forever. That is the trade a watch-only companion is, and it should be said
 * out loud rather than buried, because the companion is the networked device
 * and the one most likely to be compromised.
 *
 * What it is not is a way to lose money. An attacker with this learns what you
 * have. An attacker with the seed phrase takes it.
 *
 * ## Why JSON
 *
 * The payload is small, it crosses once, and the thing reading it is a
 * full computer rather than this phone. A compact binary encoding would save a
 * few hundred bytes on a payload that already fits in one QR code, at the cost
 * of being undebuggable by a person holding the two devices and wondering why
 * they will not talk. The envelope around it already provides the framing and
 * the checksum, so this layer only has to be legible.
 */

import { addressAt, type BtcWallet } from './bitcoin';
import { restoreHeight, type Wallet as MoneroWallet, type Network } from './monero';

/** Bumped only if the shape changes in a way an old reader would misread. */
export const ACCOUNT_VERSION = 1;

export interface BitcoinAccount {
  v: number;
  chain: 'btc';
  /** BIP84 account extended public key. */
  zpub: string;
  /** The first receiving address, so a person can eyeball that both devices
   *  ended up on the same wallet without trusting either of them. */
  first: string;
}

export interface MoneroAccount {
  v: number;
  chain: 'xmr';
  network: Network;
  address: string;
  /** The private view key. Watches, cannot spend. */
  view: string;
  /** Where to start scanning, so a restore does not walk the whole chain. */
  height: number;
}

export type Account = BitcoinAccount | MoneroAccount;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bitcoinAccount(wallet: BtcWallet): BitcoinAccount {
  return {
    v: ACCOUNT_VERSION,
    chain: 'btc',
    zpub: wallet.zpub,
    first: addressAt(wallet, 0, 0).address,
  };
}

/**
 * @param when When the wallet was created, which decides the restore height.
 *   Defaulting to now is right for a fresh wallet and wrong for a restored
 *   one, so a caller restoring an old seed must pass the older date or the
 *   companion will scan from today and report a balance of zero.
 */
export function moneroAccount(
  wallet: MoneroWallet,
  network: Network = 'mainnet',
  when: number | Date = Date.now(),
): MoneroAccount {
  return {
    v: ACCOUNT_VERSION,
    chain: 'xmr',
    network,
    address: wallet.address,
    view: wallet.viewSecret,
    height: restoreHeight(when),
  };
}

/** The bytes to put on the wire, as an ACCOUNT payload. */
export function encodeAccount(account: Account): Uint8Array {
  return encoder.encode(JSON.stringify(account));
}

/**
 * Read an account export, or null.
 *
 * Strict about the fields it needs and silent about anything else, so a newer
 * vault can add a field without an older companion refusing the whole thing.
 * Null rather than a partial object: half an account export is not something a
 * companion should try to watch with.
 */
export function parseAccount(bytes: Uint8Array): Account | null {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['v'] !== 'number' || raw['v'] > ACCOUNT_VERSION) return null;

  if (raw['chain'] === 'btc') {
    const zpub = raw['zpub'];
    const first = raw['first'];
    if (typeof zpub !== 'string' || typeof first !== 'string') return null;
    if (!zpub.startsWith('zpub') && !zpub.startsWith('xpub')) return null;
    return { v: raw['v'], chain: 'btc', zpub, first };
  }

  if (raw['chain'] === 'xmr') {
    const address = raw['address'];
    const view = raw['view'];
    const height = raw['height'];
    const network = raw['network'];
    if (typeof address !== 'string' || typeof view !== 'string') return null;
    if (typeof height !== 'number' || !Number.isInteger(height) || height < 0) return null;
    if (network !== 'mainnet' && network !== 'stagenet' && network !== 'testnet') return null;
    // 64 hex characters, or it is not a view key and the companion would fail
    // later and less clearly.
    if (!/^[0-9a-f]{64}$/i.test(view)) return null;
    return { v: raw['v'], chain: 'xmr', network, address, view, height };
  }

  return null;
}

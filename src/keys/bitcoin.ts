/**
 * Bitcoin keys and addresses. BIP84 throughout.
 *
 * Ported from the sibling project, minus everything that touches a network.
 * What is left is the half a vault is allowed to have: turn a seed phrase into
 * an account key, turn an account key into addresses, and say whether a string
 * somebody typed is really an address. The scanning, the fee estimates and the
 * coin selection all live on the companion, which is the device that is
 * allowed to know what a blockchain is.
 *
 * One standard, done properly: 12 words, m/84'/0'/0', bech32 (bc1q) addresses.
 * Every mainstream wallet since 2018 restores from it, which matters more here
 * than it did there. If this device is lost, the phrase has to be enough on its
 * own, in software that is not ours, years from now.
 *
 * The cryptography is @scure/bip39, @scure/bip32 and @scure/btc-signer:
 * audited, minimal, MIT. What is written here is the assembly, and `selfTest`
 * checks that assembly against the vector published in BIP84 itself.
 *
 * ## No platform
 *
 * Nothing in this file reaches for `crypto.getRandomValues`, a filesystem, or
 * a global. Randomness is an argument. That keeps the file testable, keeps it
 * identical under Node, a browser and a React Native bridge, and means the
 * question "where did this key's entropy come from?" has an answer at the call
 * site rather than three layers down.
 */

import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as btc from '@scure/btc-signer';

export const SATS_PER_BTC = 100_000_000n;
const DECIMALS = 8;

/** SLIP-132 version bytes for zpub/zprv, the BIP84 convention. */
export const ZPUB_VERSIONS = { private: 0x04b2430c, public: 0x04b24746 };

/** The account this wallet lives at. Fixed, because a signer with a settings
 *  screen for derivation paths is a signer that will one day sign from the
 *  wrong one. */
export const ACCOUNT_PATH = "m/84'/0'/0'";
/** The same path as numbers, for comparing against what a PSBT claims. */
export const ACCOUNT_PATH_NUMBERS = [84 + 0x80000000, 0 + 0x80000000, 0 + 0x80000000];

// ------------------------------------------------------------------ amounts

export interface AmountResult {
  ok: boolean;
  /** The amount in satoshi, when ok. */
  sats?: bigint;
  problem?: string;
}

/**
 * Parse a typed BTC amount into satoshi.
 *
 * Integer string arithmetic, never a float. `0.1` has no exact binary form, so
 * a wallet that parses an amount with `Number()` is a wallet that rounds money,
 * and the rounding shows up as a fee somebody did not agree to.
 */
export function parseBtc(text: string): AmountResult {
  const raw = String(text ?? '').trim().replace(/,/g, '');
  if (!raw) return { ok: false, problem: 'Enter an amount.' };
  if (!/^\d*\.?\d*$/.test(raw) || raw === '.') return { ok: false, problem: 'That is not a number.' };
  const [whole = '', frac = ''] = raw.split('.');
  if (frac.length > DECIMALS) {
    return { ok: false, problem: `Bitcoin has ${DECIMALS} decimal places; that has more.` };
  }
  const sats = BigInt(whole || '0') * SATS_PER_BTC + BigInt((frac || '').padEnd(DECIMALS, '0') || '0');
  return { ok: true, sats };
}

/** Format satoshi as a BTC string, trailing zeros trimmed. */
export function formatBtc(sats: bigint): string {
  const negative = sats < 0n;
  const value = negative ? -sats : sats;
  const whole = value / SATS_PER_BTC;
  const frac = (value % SATS_PER_BTC).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

// --------------------------------------------------------------------- keys

export interface BtcWallet {
  kind: 'full' | 'watch';
  /** The BIP84 account node: private for a full wallet, public for watch. */
  account: HDKey;
  /** The account's zpub, which is what the companion gets. */
  zpub: string;
}

/**
 * A seed phrase from randomness the caller supplies.
 *
 * `system` is 32 bytes from the platform's CSPRNG and `extra` is anything the
 * person contributed, dice being the usual reason. They are hashed together,
 * so the extra can only add and can never subtract: somebody rolling dice gets
 * real benefit, somebody supplying nothing gets exactly the system's bytes
 * hashed, which is still uniformly random.
 *
 * 16 bytes out, because a 12-word phrase is 128 bits of entropy. Stretching a
 * shorter secret over a longer phrase would be a lie about how much randomness
 * is in it, and a 24-word phrase built from 128 bits is exactly that lie.
 */
export function mnemonicFromEntropy(system: Uint8Array, extra: Uint8Array = new Uint8Array(0)): string {
  if (system.length !== 32) throw new Error('The system must supply 32 bytes.');
  if (!extra.length) return entropyToMnemonic(sha256(system).slice(0, 16), wordlist);
  const both = new Uint8Array(system.length + extra.length);
  both.set(system);
  both.set(extra, system.length);
  return entropyToMnemonic(sha256(both).slice(0, 16), wordlist);
}

/** Whitespace-normalise and checksum-check a typed seed phrase. */
export function checkMnemonic(text: string): { ok: boolean; words?: string; problem?: string } {
  const words = String(text ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  if (!words) return { ok: false, problem: 'Enter the seed words.' };
  const count = words.split(' ').length;
  if (count !== 12 && count !== 24) {
    return { ok: false, problem: `That is ${count} words; a Bitcoin seed is 12 (or 24).` };
  }
  if (!validateMnemonic(words, wordlist)) {
    return { ok: false, problem: 'Those words fail their own checksum. One is mistyped or out of order.' };
  }
  return { ok: true, words };
}

export function openFromMnemonic(words: string): BtcWallet {
  const seed = mnemonicToSeedSync(words);
  const account = HDKey.fromMasterSeed(seed, ZPUB_VERSIONS).derive(ACCOUNT_PATH);
  return { kind: 'full', account, zpub: account.publicExtendedKey };
}

/**
 * Open watch-only from a zpub (BIP84) or xpub (the same key in older clothes).
 *
 * A zpub can only be a native-segwit account key, so it is unambiguous. An xpub
 * is not: this derives bc1q addresses from it, and a BIP44 legacy account xpub
 * holds real public keys, so the derivation succeeds and produces valid-looking
 * addresses that belong to no funded wallet. The caution says so rather than
 * letting somebody watch the wrong addresses and conclude their money is gone.
 */
export function openWatch(text: string): { ok: boolean; wallet?: BtcWallet; problem?: string; caution?: string } {
  const key = String(text ?? '').trim();
  try {
    if (key.startsWith('zpub')) {
      const account = HDKey.fromExtendedKey(key, ZPUB_VERSIONS);
      return { ok: true, wallet: { kind: 'watch', account, zpub: key } };
    }
    if (key.startsWith('xpub')) {
      const account = HDKey.fromExtendedKey(key);
      return {
        ok: true,
        wallet: { kind: 'watch', account, zpub: key },
        caution:
          'An xpub only works here if it is a native-segwit (BIP84) account key. ' +
          'This derives bc1q addresses from it; if your wallet uses 1... or 3... addresses, ' +
          'the balance shown will be empty even though the wallet is funded. ' +
          'Export the zpub instead if your wallet offers one.',
      };
    }
  } catch {
    return { ok: false, problem: 'That extended key does not decode. Check it and paste it again.' };
  }
  return { ok: false, problem: 'Paste a zpub (or xpub) extended public key. A single address cannot be watched as a wallet.' };
}

/** The bech32 address (and script) at a BIP84 chain/index. */
export function addressAt(wallet: BtcWallet, change: 0 | 1, index: number): { address: string; script: Uint8Array } {
  const node = wallet.account.deriveChild(change).deriveChild(index);
  if (!node.publicKey) throw new Error('That key cannot derive a public key.');
  const pay = btc.p2wpkh(node.publicKey);
  return { address: pay.address!, script: pay.script };
}

/** The private key at a BIP84 chain/index, for signing. Null on a watch-only wallet. */
export function privateKeyAt(wallet: BtcWallet, change: number, index: number): Uint8Array | null {
  if (wallet.kind !== 'full') return null;
  return wallet.account.deriveChild(change).deriveChild(index).privateKey ?? null;
}

/** A mainnet address of any standard type, or not. */
export function isBtcAddress(text: string): boolean {
  try {
    btc.Address().decode(String(text ?? '').trim());
    return true;
  } catch {
    return false;
  }
}

/** The address a script pays to, or null when it is a shape we cannot name. */
export function addressFromScript(script: Uint8Array): string | null {
  try {
    const decoded = btc.OutScript.decode(script);
    return btc.Address().encode(decoded);
  } catch {
    return null;
  }
}

const ADDRESS_KINDS: Record<string, string> = {
  wpkh: 'bech32 address',
  wsh: 'bech32 script address',
  tr: 'taproot address',
  pkh: 'legacy address',
  sh: 'script address',
};

export interface BtcAddressVerdict {
  state: 'empty' | 'ok' | 'bad';
  note: string;
}

/**
 * A verdict on an address, for the tick beside a field.
 *
 * Decoding is the check: the bech32 or base58 checksum fails on one wrong
 * character. Naming the type is worth showing, because "legacy" and "bech32"
 * both being valid is exactly what somebody pasting an address wants confirmed.
 */
export function checkBtcAddress(text: string): BtcAddressVerdict {
  const raw = String(text ?? '').trim();
  if (!raw) return { state: 'empty', note: '' };
  try {
    const decoded = btc.Address().decode(raw) as { type?: string } | undefined;
    const kind = (decoded && ADDRESS_KINDS[decoded.type ?? '']) ?? 'address';
    return { state: 'ok', note: `valid Bitcoin ${kind}` };
  } catch {
    return { state: 'bad', note: 'not a valid Bitcoin address' };
  }
}

/** The same, for an extended public key. */
export function checkExtendedKey(text: string): BtcAddressVerdict {
  const raw = String(text ?? '').trim();
  if (!raw) return { state: 'empty', note: '' };
  const opened = openWatch(raw);
  if (!opened.ok) return { state: 'bad', note: 'not a valid extended key' };
  return { state: 'ok', note: raw.startsWith('zpub') ? 'valid zpub' : 'valid xpub' };
}

// ---------------------------------------------------------------- self-test

/**
 * Re-derive the vector published in BIP84 and compare every step.
 *
 * The same discipline the Monero side has: keys are money, so the machinery
 * that derives them proves itself against a known answer on this device before
 * it is allowed to make one. If any line stops matching, nothing is generated,
 * which is the only honest response to an engine that cannot reproduce the
 * spec it claims to implement.
 */
export function selfTest(): { ok: boolean; problem?: string } {
  const VECTOR = {
    words: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    zpub: 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs',
    receive0: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
    receive1: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
    change0: 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
  };
  try {
    const wallet = openFromMnemonic(VECTOR.words);
    if (wallet.zpub !== VECTOR.zpub) {
      return { ok: false, problem: 'The account key derived from the BIP84 test words does not match the published vector.' };
    }
    if (
      addressAt(wallet, 0, 0).address !== VECTOR.receive0 ||
      addressAt(wallet, 0, 1).address !== VECTOR.receive1 ||
      addressAt(wallet, 1, 0).address !== VECTOR.change0
    ) {
      return { ok: false, problem: 'An address derived from the BIP84 test vector does not match the published one.' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, problem: 'The self-check itself failed: ' + String((err as Error)?.message ?? err) };
  }
}

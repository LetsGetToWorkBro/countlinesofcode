/**
 * The Bitcoin wallet's brains, mirroring what walletkit.ts is to the Monero
 * wallet: everything with a right answer, kept out of the DOM.
 *
 * The cryptography is @scure/bip39, @scure/bip32 and @scure/btc-signer
 * (audited, minimal, MIT), bundled into this one file. Keys are derived and
 * transactions signed here, in the tab; the network half goes through the
 * page's fetcher to `/api/btc/...`, this site's proxy in front of an Esplora
 * explorer, because the browser may not talk to anyone else and the explorer
 * has no business seeing the visitor's IP.
 *
 * The wallet is BIP84 throughout: 12 words, m/84'/0'/0', bech32 (bc1q...)
 * addresses. One standard done properly beats four done vaguely, and every
 * mainstream wallet since 2018 can restore from it.
 */

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { BTC_SERVERS, validateCustomEsplora, type BtcServer } from '../lib/btcproxy';
import { encodeBase64Url } from '../lib/xmrproxy';
import { DECOY_ADDRESSES } from './btcdecoys';

export const SATS_PER_BTC = 100_000_000n;
const DECIMALS = 8;

/** SLIP-132 version bytes for zpub/zprv, the BIP84 convention. */
const ZPUB_VERSIONS = { private: 0x04b2430c, public: 0x04b24746 };

// ---------------------------------------------------------------- amounts

export interface AmountResult {
  ok: boolean;
  /** The amount in satoshi, when ok. */
  sats?: bigint;
  problem?: string;
}

/** Parse a typed BTC amount into satoshi. Integer string arithmetic, never a
 *  float, for exactly the reason walletkit.parseXmr gives: `0.1` has no exact
 *  binary form and a wallet must not round money. */
export function parseBtc(text: string): AmountResult {
  const raw = String(text ?? '').trim().replace(/,/g, '');
  if (!raw) return { ok: false, problem: 'Enter an amount.' };
  if (!/^\d*\.?\d*$/.test(raw) || raw === '.') return { ok: false, problem: 'That is not a number.' };
  const [whole = '', frac = ''] = raw.split('.');
  if (frac.length > DECIMALS) {
    return { ok: false, problem: `Bitcoin has ${DECIMALS} decimal places; that has more.` };
  }
  const sats = BigInt(whole || '0') * SATS_PER_BTC + BigInt((frac + '0'.repeat(DECIMALS)).slice(0, DECIMALS) || '0');
  if (sats <= 0n) return { ok: false, problem: 'Enter an amount greater than zero.' };
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

// ------------------------------------------------------------------ keys

export interface BtcWallet {
  kind: 'full' | 'watch';
  /** The BIP84 account node: private for a full wallet, public for watch. */
  account: HDKey;
  /** The account's zpub, shareable as the watch-only key. */
  zpub: string;
}

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

/** Whitespace-normalise and checksum-check a typed seed phrase. */
export function checkMnemonic(text: string): { ok: boolean; words?: string; problem?: string } {
  const words = String(text ?? '').trim().toLowerCase().split(/\s+/).join(' ');
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
  const account = HDKey.fromMasterSeed(seed, ZPUB_VERSIONS).derive("m/84'/0'/0'");
  return { kind: 'full', account, zpub: account.publicExtendedKey };
}

/** Open watch-only from a zpub (BIP84) or xpub (same key, older clothes). */
export function openWatch(text: string): { ok: boolean; wallet?: BtcWallet; problem?: string } {
  const key = String(text ?? '').trim();
  try {
    if (key.startsWith('zpub')) {
      const account = HDKey.fromExtendedKey(key, ZPUB_VERSIONS);
      return { ok: true, wallet: { kind: 'watch', account, zpub: key } };
    }
    if (key.startsWith('xpub')) {
      const account = HDKey.fromExtendedKey(key);
      return { ok: true, wallet: { kind: 'watch', account, zpub: key } };
    }
  } catch {
    return { ok: false, problem: 'That extended key does not decode. Check it and paste it again.' };
  }
  return { ok: false, problem: 'Paste a zpub (or xpub) extended public key. A single address cannot be watched as a wallet.' };
}

/** The bech32 address (and script) at a BIP84 chain/index. */
export function addressAt(wallet: BtcWallet, change: 0 | 1, index: number): { address: string; script: Uint8Array } {
  const node = wallet.account.deriveChild(change).deriveChild(index);
  const pay = btc.p2wpkh(node.publicKey!);
  return { address: pay.address!, script: pay.script };
}

/** A mainnet address of any standard type, or not. Send-time gate. */
export function isBtcAddress(text: string): boolean {
  try {
    btc.Address().decode(String(text ?? '').trim());
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ scan

/** One spendable coin, remembered with the path that can sign it. */
export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
  address: string;
  change: 0 | 1;
  index: number;
  confirmed: boolean;
}

export interface HistoryEntry {
  txid: string;
  /** Net effect on this wallet in sats: positive received, negative sent. */
  net: bigint;
  confirmed: boolean;
  time: number | null;
}

export interface WalletView {
  balance: bigint;
  /** Portion of the balance still waiting for a first confirmation. */
  pending: bigint;
  utxos: Utxo[];
  receiveAddress: string;
  receiveIndex: number;
  usedAddresses: number;
  history: HistoryEntry[];
}

/** GET an Esplora path and parse JSON; the page supplies the transport. */
export type EsploraFetch = (path: string) => Promise<unknown>;

const GAP = 20;
const CAP = 200; // addresses per chain; a wallet deeper than this needs a real client

/** What a wallet that has never touched the chain looks like. A freshly
 *  created wallet is this by construction, so the page shows it without a
 *  single network request (and without burning an explorer's rate limit on
 *  forty lookups that can only say "empty"). */
export function emptyView(wallet: BtcWallet): WalletView {
  return {
    balance: 0n,
    pending: 0n,
    utxos: [],
    receiveAddress: addressAt(wallet, 0, 0).address,
    receiveIndex: 0,
    usedAddresses: 0,
    history: [],
  };
}

/**
 * How much of a haystack to hide the wallet's lookups in.
 *
 * 'direct' asks only about the wallet's own addresses: fastest, and the
 * server carrying the questions can read the wallet straight off the log.
 * 'padded' mixes each batch with real, already-used decoy addresses in a
 * shuffled order, so the log holds a set the wallet is merely somewhere
 * inside. It costs (1 + ratio) times the requests, which public explorers
 * rate-limit, and it does not defeat an adversary willing to cluster the
 * addresses on chain. Pointing the wallet at your own server beats both and
 * is a field away.
 */
export type ScanPrivacy = 'direct' | 'padded';

export interface ScanOptions {
  privacy?: ScanPrivacy;
  /** Decoys per real address in padded mode. */
  ratio?: number;
  concurrency?: number;
  /** Injectable for tests; the shipped pool otherwise. */
  decoys?: string[];
  /** Injectable for tests; Math.random otherwise. */
  random?: () => number;
}

/** Fisher-Yates, so the wallet's addresses are not simply the first ones. */
function shuffle<T>(items: T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Distinct decoys for one batch, drawn from the pool without repeats. */
export function drawDecoys(count: number, pool: string[], random: () => number): string[] {
  if (count <= 0 || pool.length === 0) return [];
  return shuffle(pool, random).slice(0, Math.min(count, pool.length));
}

/** A tiny worker pool: explorers rate-limit, so the scan asks a few at a
 *  time rather than everything at once or one long crawl. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Walk the BIP84 chains in gap-limit windows and come back with everything
 * the page shows: balance, coins, the next fresh address, and a short
 * history. Windows of twenty are checked a few addresses at a time and the
 * walk stops at the first fully-unused window, which is the standard gap
 * rule; a wallet that has never received skips the change chain outright,
 * because change only exists after a spend. Address-level queries are
 * inherent to Esplora; the honest notes on the page say plainly that the
 * chosen explorer sees the addresses as a cluster (through the proxy,
 * without the visitor's IP).
 */
export async function scanWallet(get: EsploraFetch, wallet: BtcWallet, options: ScanOptions = {}): Promise<WalletView> {
  const concurrency = options.concurrency ?? 3;
  const random = options.random ?? Math.random;
  const padding = options.privacy === 'padded' ? Math.max(1, Math.round(options.ratio ?? 2)) : 0;
  const decoyPool = options.decoys ?? DECOY_ADDRESSES;
  /** Every address the scan has asked a decoy question about, so the follow
   *  up calls cover them too and the second round does not undo the first. */
  const decoysAsked: string[] = [];

  let balance = 0n;
  let pending = 0n;
  const used: { address: string; change: 0 | 1; index: number }[] = [];
  let receiveIndex = 0;

  for (const change of [0, 1] as const) {
    if (change === 1 && used.length === 0) break;
    let highestUsed = -1;
    for (let start = 0; start < CAP; start += GAP) {
      const indexes = Array.from({ length: GAP }, (_, i) => start + i);
      const mine = indexes.map((index) => ({ index, address: addressAt(wallet, change, index).address }));
      const decoys = drawDecoys(padding * mine.length, decoyPool, random).map((address) => ({ index: -1, address }));
      decoysAsked.push(...decoys.map((d) => d.address));
      const asked = padding ? shuffle([...mine, ...decoys], random) : mine;

      const answers = await pool(asked, concurrency, async (target) => {
        const stats = (await get(`address/${target.address}`)) as {
          chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
          mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
        };
        return { index: target.index, address: target.address, stats };
      });
      // A decoy's answer is read and thrown away; only ours count.
      const window = answers.filter((a) => a.index >= 0).sort((a, b) => a.index - b.index);
      let anyUsed = false;
      for (const { index, address, stats } of window) {
        if (stats.chain_stats.tx_count + stats.mempool_stats.tx_count === 0) continue;
        anyUsed = true;
        highestUsed = Math.max(highestUsed, index);
        used.push({ address, change, index });
        balance +=
          BigInt(stats.chain_stats.funded_txo_sum) - BigInt(stats.chain_stats.spent_txo_sum) +
          BigInt(stats.mempool_stats.funded_txo_sum) - BigInt(stats.mempool_stats.spent_txo_sum);
        pending += BigInt(stats.mempool_stats.funded_txo_sum) - BigInt(stats.mempool_stats.spent_txo_sum);
      }
      if (!anyUsed) break;
    }
    if (change === 0) receiveIndex = Math.min(highestUsed + 1, CAP);
  }
  const receiveAddress = addressAt(wallet, 0, receiveIndex).address;

  const ours = new Set(used.map((u) => u.address));
  const historyByTx = new Map<string, HistoryEntry>();
  const utxos: Utxo[] = [];
  /* The follow up calls are the second half of the leak: asking only about
     the addresses that turned out to be used would hand back exactly what
     the shuffle just hid. So the decoys that have history are followed up
     too, and their answers discarded. */
  const followUps: { slot: { address: string; change: 0 | 1; index: number } | null; address: string }[] =
    used.map((slot) => ({ slot, address: slot.address }));
  if (padding) {
    const decoyFollowUps = await pool(
      shuffle(decoysAsked, random).slice(0, used.length * padding),
      concurrency,
      async (address) => address,
    );
    for (const address of decoyFollowUps) followUps.push({ slot: null, address });
  }

  const details = await pool(padding ? shuffle(followUps, random) : followUps, concurrency, async ({ slot, address }) => ({
    slot,
    address,
    coins: (await get(`address/${address}/utxo`)) as {
      txid: string; vout: number; value: number; status: { confirmed: boolean };
    }[],
    txs: (await get(`address/${address}/txs`)) as {
      txid: string;
      status: { confirmed: boolean; block_time?: number };
      vin: { prevout?: { scriptpubkey_address?: string; value: number } }[];
      vout: { scriptpubkey_address?: string; value: number }[];
    }[],
  }));
  for (const { slot, coins, txs } of details) {
    if (!slot) continue;  // a decoy's answer, read and dropped
    for (const coin of coins) {
      utxos.push({
        txid: coin.txid,
        vout: coin.vout,
        value: BigInt(coin.value),
        address: slot.address,
        change: slot.change,
        index: slot.index,
        confirmed: coin.status.confirmed,
      });
    }
    for (const tx of txs) {
      if (historyByTx.has(tx.txid)) continue;
      let net = 0n;
      for (const vin of tx.vin) {
        if (vin.prevout?.scriptpubkey_address && ours.has(vin.prevout.scriptpubkey_address)) {
          net -= BigInt(vin.prevout.value);
        }
      }
      for (const out of tx.vout) {
        if (out.scriptpubkey_address && ours.has(out.scriptpubkey_address)) net += BigInt(out.value);
      }
      historyByTx.set(tx.txid, {
        txid: tx.txid,
        net,
        confirmed: tx.status.confirmed,
        time: tx.status.block_time ?? null,
      });
    }
  }

  const history = [...historyByTx.values()]
    .sort((a, b) => (b.time ?? Number.MAX_SAFE_INTEGER) - (a.time ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 25);

  return { balance, pending, utxos, receiveAddress, receiveIndex, usedAddresses: used.length, history };
}

// ------------------------------------------------------------------ fees

/** Esplora's /fee-estimates: { "1": satPerVb, "3": ..., "144": ... }.
 *  Pick the rate for the nearest documented target at or above ours, floor
 *  1 sat/vB, so a sparse map still answers. */
export function pickFeeRate(estimates: unknown, targetBlocks: number): number {
  const map = (estimates ?? {}) as Record<string, number>;
  const targets = Object.keys(map).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  let chosen: number | null = null;
  for (const t of targets) {
    if (t <= targetBlocks) chosen = map[String(t)]!;
  }
  if (chosen === null && targets.length) chosen = map[String(targets[0])]!;
  return Math.max(1, Math.ceil(chosen ?? 1));
}

// ------------------------------------------------------------------ send

const DUST = 546n;
// P2WPKH weight arithmetic, in vbytes: fixed overhead, per input, per output.
const VB_OVERHEAD = 11n;
const VB_INPUT = 68n;
const VB_OUTPUT = 31n;

const feeFor = (inputs: number, outputs: number, rate: bigint): bigint =>
  (VB_OVERHEAD + VB_INPUT * BigInt(inputs) + VB_OUTPUT * BigInt(outputs)) * rate;

export interface SendPlan {
  ok: boolean;
  problem?: string;
  /** Signed transaction, ready to broadcast. */
  hex?: string;
  txid?: string;
  fee?: bigint;
  /** What actually reaches the destination (differs from asked on send-max). */
  amount?: bigint;
  change?: bigint;
}

export interface SendRequest {
  wallet: BtcWallet;
  utxos: Utxo[];
  to: string;
  /** null means send everything. */
  amount: bigint | null;
  /** sat/vB. */
  feeRate: number;
}

/**
 * Select coins, build, and sign a P2WPKH transaction in the tab.
 *
 * Largest-first selection: fewer inputs means a smaller fee, and a site
 * wallet is not the place for coin-control theatre. Change below dust is
 * folded into the fee rather than creating an output the network would
 * refuse. Every path that cannot produce a valid transaction says why.
 */
export function buildSend(req: SendRequest): SendPlan {
  if (req.wallet.kind !== 'full') return { ok: false, problem: 'A watch-only wallet cannot sign. Restore with the seed words to send.' };
  if (!isBtcAddress(req.to)) return { ok: false, problem: 'That is not a valid Bitcoin address.' };
  const rate = BigInt(Math.max(1, Math.ceil(req.feeRate)));
  const coins = [...req.utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const total = coins.reduce((sum, c) => sum + c.value, 0n);

  let picked: Utxo[];
  let amount: bigint;
  let fee: bigint;
  let change: bigint;

  if (req.amount === null) {
    // Send-max: every coin in, one output, fee comes off the top.
    picked = coins;
    fee = feeFor(picked.length, 1, rate);
    amount = total - fee;
    change = 0n;
    if (amount <= DUST) return { ok: false, problem: 'After the fee there would be nothing left worth sending.' };
  } else {
    amount = req.amount;
    if (amount <= 0n) return { ok: false, problem: 'Enter an amount greater than zero.' };
    if (amount <= DUST) return { ok: false, problem: `That amount is below Bitcoin's dust limit (${DUST} sats); the network would refuse it.` };
    picked = [];
    let gathered = 0n;
    for (const coin of coins) {
      picked.push(coin);
      gathered += coin.value;
      if (gathered >= amount + feeFor(picked.length, 2, rate)) break;
    }
    fee = feeFor(picked.length, 2, rate);
    if (gathered < amount + fee) {
      return { ok: false, problem: 'Not enough funds for that amount plus the fee.' };
    }
    change = gathered - amount - fee;
    if (change < DUST) {
      // No change output: what would have been dust goes to the miner instead
      // of becoming a coin the network (and the fee math) would hate.
      change = 0n;
      fee = gathered - amount;
    }
  }

  const tx = new btc.Transaction();
  for (const coin of picked) {
    const node = req.wallet.account.deriveChild(coin.change).deriveChild(coin.index);
    const pay = btc.p2wpkh(node.publicKey!);
    tx.addInput({ txid: coin.txid, index: coin.vout, witnessUtxo: { script: pay.script, amount: coin.value } });
  }
  tx.addOutputAddress(req.to, amount);
  if (change > 0n) {
    // Change returns to our own change chain, one past the highest used slot.
    const changeIndex = Math.max(-1, ...req.utxos.filter((u) => u.change === 1).map((u) => u.index)) + 1;
    tx.addOutputAddress(addressAt(req.wallet, 1, changeIndex).address, change);
  }
  for (let i = 0; i < picked.length; i++) {
    const node = req.wallet.account.deriveChild(picked[i]!.change).deriveChild(picked[i]!.index);
    tx.signIdx(node.privateKey!, i);
  }
  tx.finalize();
  return { ok: true, hex: tx.hex, txid: tx.id, fee, amount, change };
}

// ----------------------------------------------------------- the servers

/** The curated Esplora servers, for the page's picker. */
export function btcServers(): BtcServer[] {
  return BTC_SERVERS;
}

export interface ServerChoice {
  /** A curated id, or 'custom'. */
  id: string;
  custom?: string;
}

/** The same-origin proxy base for a server choice, or why not. */
export function btcProxyBase(choice: ServerChoice): { ok: boolean; base?: string; problem?: string } {
  if (choice.id !== 'custom') {
    if (!BTC_SERVERS.some((s) => s.id === choice.id)) return { ok: false, problem: 'Unknown server.' };
    return { ok: true, base: `/api/btc/n/${choice.id}` };
  }
  const checked = validateCustomEsplora(choice.custom ?? '');
  if (!checked.ok) return { ok: false, problem: checked.problem };
  return { ok: true, base: `/api/btc/c/${encodeBase64Url(checked.base!)}` };
}

/** Library errors, turned into a sentence someone can act on. */
export function prettyBtcError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/429|too many requests|rate.?limit/i.test(message)) {
    return 'The explorer is rate-limiting requests right now. Wait a moment and press Refresh, or pick the other explorer.';
  }
  if (/fetch|network|abort|timeout|failed/i.test(message)) {
    return 'Could not reach the explorer. Pick another server, or check your connection, and try again.';
  }
  if (/checksum|decode|invalid address|bech32|base58/i.test(message)) {
    return 'That address is not valid. Check it and paste it again.';
  }
  return message;
}

const globalScope = globalThis as unknown as { LOC1999_BTC?: Record<string, unknown> };
globalScope.LOC1999_BTC = {
  SATS_PER_BTC,
  parseBtc,
  formatBtc,
  newMnemonic,
  checkMnemonic,
  openFromMnemonic,
  openWatch,
  addressAt,
  isBtcAddress,
  scanWallet,
  emptyView,
  drawDecoys,
  pickFeeRate,
  buildSend,
  btcServers,
  btcProxyBase,
  prettyBtcError,
};

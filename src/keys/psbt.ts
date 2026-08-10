/**
 * Reading a transaction to a person, and only then signing it.
 *
 * This is the file the rest of the project exists to protect. Everything else
 * is transport: chunking, checksums, word tables. None of it decides anything.
 * Here is where an unsigned transaction arrives from a device that might be
 * compromised, gets turned into sentences somebody can read, and becomes a
 * signature or does not.
 *
 * ## The threat, stated plainly
 *
 * The online half builds the transaction. If it is compromised it can build a
 * *valid* one that pays somebody else. Every byte checks out. Every checksum
 * passes. The airgap does not help: it faithfully carries the attacker's
 * transaction across. So the question this file answers is not "did these
 * bytes arrive intact" but "what do these bytes actually do", and the answer
 * has to be legible to a tired person holding a phone.
 *
 * ## Three attacks it is specifically built to stop
 *
 * **Lying about the change address.** A PSBT can mark an output as change,
 * with a derivation path, and a wallet that believes it shows "0.4 BTC back to
 * you" while the script pays the attacker. So `mine` here is never read from
 * the PSBT. Every output claimed as ours is re-derived from our own key and
 * the script compared. A mismatch is not a warning to scroll past, it is
 * fatal: the PSBT has been caught lying, and nothing it says can be trusted
 * afterwards.
 *
 * **Hiding the fee.** The fee is not written in a transaction; it is what is
 * left over, so a signer can only state it if it knows what every input was
 * worth, and it only knows that because the PSBT told it. A PSBT that omits
 * the previous outputs leaves the fee unknowable, and there is no honest way
 * to render "fee: probably fine" on a confirmation screen. So a missing input
 * value is fatal here rather than a blank field.
 *
 * Worth being precise about the neighbouring attack rather than claiming to
 * stop it: a PSBT that *understates* an input amount does not steal anything
 * from this wallet, because a segwit signature commits to the amount, so a
 * wrong one produces a signature that simply does not verify. The danger is
 * the honest-looking transaction with a real and enormous fee, which is a
 * number on the screen for a person to read, not something to catch by
 * arithmetic.
 *
 * **Describing one transaction and signing another.** The screen a person
 * approved and the bytes that get signed have to be the same bytes. `signPsbt`
 * will not take a PSBT on its own: it takes the summary that was shown, and
 * checks that summary's digest against the bytes in front of it. A UI that
 * re-fetches, re-parses or re-orders between the two steps fails closed rather
 * than signing something nobody read.
 *
 * ## What it does not do
 *
 * It does not decide anything. There is no threshold above which it signs on
 * its own, and the warnings are not a substitute for the destination and the
 * amount being read. A person who approves without reading gets what they
 * approved. The most this file can do is make sure that what was on the screen
 * is what gets signed, and refuse in the cases where the screen would
 * necessarily be wrong.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import * as btc from '@scure/btc-signer';
import {
  ACCOUNT_PATH_NUMBERS,
  addressAt,
  addressFromScript,
  formatBtc,
  privateKeyAt,
  type BtcWallet,
} from './bitcoin';

/** How far along each chain to look for our own scripts, when a PSBT does not
 *  say which are ours. Beyond this an output is reported as leaving, which is
 *  the safe direction to be wrong in: it overstates what is being spent. */
const DEFAULT_SCAN_DEPTH = 200;

/** Above this, a fee is worth stopping over. Not fatal: fee markets happen. */
const HIGH_FEE_RATIO = 0.1;
const HIGH_FEE_RATE = 500;

export interface PsbtInput {
  /** Display order, the way an explorer shows it. */
  txid: string;
  vout: number;
  /** Null when the PSBT did not carry the previous output. That is fatal. */
  value: bigint | null;
  address: string | null;
  /** Derived and verified here, never taken from the PSBT. */
  mine: boolean;
  path: string | null;
}

export interface PsbtOutput {
  address: string | null;
  /** Hex, for the case where the script is a shape we cannot name. */
  script: string;
  value: bigint;
  /** Derived and verified here, never taken from the PSBT. */
  mine: boolean;
  path: string | null;
}

export type WarningCode =
  | 'unknown-input-value'
  | 'foreign-input'
  | 'output-path-mismatch'
  | 'unusual-path'
  | 'high-fee'
  | 'nothing-leaves'
  | 'watch-only'
  | 'unreadable';

export interface PsbtWarning {
  code: WarningCode;
  /** Fatal means do not sign, whatever the person says. */
  fatal: boolean;
  message: string;
}

export interface PsbtSummary {
  ok: boolean;
  problem?: string;
  /** sha256 of the exact bytes described, hex. `signPsbt` checks it. */
  digest: string;
  inputs: PsbtInput[];
  outputs: PsbtOutput[];
  /** Total of the inputs that are ours. */
  spending: bigint;
  /** Total going to outputs that are not ours: the actual payment. */
  leaving: bigint;
  /** Total coming back to our own addresses. */
  returning: bigint;
  /** Null when any input value is unknown, because then it is unknowable. */
  fee: bigint | null;
  /** An estimate in sat/vB, and labelled as one: the real size is not known
   *  until the signatures exist. */
  feeRate: number | null;
  warnings: PsbtWarning[];
  /** Every input is ours, every value is known, nothing fatal. */
  signable: boolean;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function psbtDigest(psbt: Uint8Array): string {
  return hex(sha256(psbt));
}

function failed(digest: string, problem: string): PsbtSummary {
  return {
    ok: false,
    problem,
    digest,
    inputs: [],
    outputs: [],
    spending: 0n,
    leaving: 0n,
    returning: 0n,
    fee: null,
    feeRate: null,
    warnings: [{ code: 'unreadable', fatal: true, message: problem }],
    signable: false,
  };
}

/** Where a script of ours lives, or null if it is not ours. */
interface Spot {
  change: 0 | 1;
  index: number;
}

/**
 * Our own scripts, by script.
 *
 * Built once per description and reused, because deriving a few hundred
 * public keys twice per transaction is the difference between a screen that
 * appears and a screen that hangs.
 */
class OwnScripts {
  private map = new Map<string, Spot>();
  private depth = 0;

  constructor(wallet: BtcWallet, depth: number) {
    this.extend(wallet, depth);
  }

  /** Derive up to `depth` on both chains, skipping what is already known. */
  extend(wallet: BtcWallet, depth: number): void {
    if (depth <= this.depth) return;
    for (const change of [0, 1] as const) {
      for (let index = this.depth; index < depth; index++) {
        try {
          this.map.set(hex(addressAt(wallet, change, index).script), { change, index });
        } catch {
          break; // a key that cannot derive further ends that chain
        }
      }
    }
    this.depth = depth;
  }

  /**
   * Where this script sits, if it is ours and within `limit`.
   *
   * The limit is applied on the way out rather than by deriving less, because
   * the cache above is shared and may already hold more than this caller asked
   * for. Without it, a caller passing a small scanDepth would silently get
   * whatever depth some earlier caller happened to warm the cache to, and an
   * option that does not mean what it says is worse than no option.
   */
  find(script: Uint8Array, limit: number): Spot | null {
    const spot = this.map.get(hex(script));
    return spot && spot.index < limit ? spot : null;
  }
}

/**
 * Derived scripts, remembered per wallet.
 *
 * Four hundred public keys is a fraction of a second on a laptop and a visible
 * pause on a seven-year-old phone, which is the device this is for. Describing
 * a transaction happens every time a scan completes, including the scans that
 * get cancelled, so doing this work once per wallet rather than once per look
 * is the difference between a screen that appears and a screen that hesitates.
 *
 * Weak, so a wallet that is closed takes its derived keys with it rather than
 * leaving them in a module-level map for the life of the process.
 */
const scriptCache = new WeakMap<BtcWallet, OwnScripts>();

function ownScriptsFor(wallet: BtcWallet, depth: number): OwnScripts {
  const cached = scriptCache.get(wallet);
  if (cached) {
    cached.extend(wallet, depth);
    return cached;
  }
  const fresh = new OwnScripts(wallet, depth);
  scriptCache.set(wallet, fresh);
  return fresh;
}

/** The BIP32 path a PSBT claims for a script, as chain and index, if it looks
 *  like one of ours at all. */
function claimedSpot(derivation: unknown): { spot: Spot | null; unusual: boolean } {
  if (!Array.isArray(derivation) || derivation.length === 0) return { spot: null, unusual: false };
  const entry = derivation[0] as unknown;
  const info = Array.isArray(entry) ? (entry[1] as { path?: number[] } | undefined) : undefined;
  const path = info?.path;
  if (!Array.isArray(path) || path.length !== 5) return { spot: null, unusual: true };
  /* Compared against the account path rather than against a master
   * fingerprint. A fingerprint is four bytes an attacker can simply copy off a
   * previous PSBT, so it proves nothing; the script comparison below is what
   * actually decides, and this only picks which child to derive. */
  for (let i = 0; i < 3; i++) if (path[i] !== ACCOUNT_PATH_NUMBERS[i]) return { spot: null, unusual: true };
  const change = path[3];
  const index = path[4];
  if ((change !== 0 && change !== 1) || typeof index !== 'number' || index < 0) {
    return { spot: null, unusual: true };
  }
  return { spot: { change, index }, unusual: false };
}

function pathOf(spot: Spot): string {
  return `m/84'/0'/0'/${spot.change}/${spot.index}`;
}

/** Roughly how big this will be once signed, for a fee rate worth showing.
 *  P2WPKH inputs, which is all this wallet makes. */
function estimateVsize(inputs: number, outputs: Uint8Array[]): number {
  const overhead = 10.5;
  const perInput = 68;
  const outs = outputs.reduce((sum, script) => sum + 9 + script.length, 0);
  return Math.ceil(overhead + perInput * inputs + outs);
}

export interface DescribeOptions {
  /** How far along each chain to look for our own addresses. */
  scanDepth?: number;
}

/**
 * Turn a PSBT into what has to be on the screen.
 *
 * Everything reported as ours has been re-derived and compared here. Anything
 * this function is unsure about is reported as *not* ours, which overstates
 * what is leaving rather than understating it: the failure mode of being
 * cautious is a person seeing a scary number and cancelling, and the failure
 * mode of being trusting is a signature.
 */
export function describePsbt(
  psbt: Uint8Array,
  wallet: BtcWallet,
  options: DescribeOptions = {},
): PsbtSummary {
  const digest = psbtDigest(psbt);

  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(psbt, { allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true });
  } catch (err) {
    return failed(digest, 'That is not a transaction this device can read: ' + String((err as Error)?.message ?? err));
  }
  if (tx.inputsLength === 0) return failed(digest, 'That transaction has no inputs.');
  if (tx.outputsLength === 0) return failed(digest, 'That transaction has no outputs.');

  const depth = Math.max(1, options.scanDepth ?? DEFAULT_SCAN_DEPTH);
  const own = ownScriptsFor(wallet, depth);
  const warnings: PsbtWarning[] = [];
  const inputs: PsbtInput[] = [];
  const outputs: PsbtOutput[] = [];

  let spending = 0n;
  let leaving = 0n;
  let returning = 0n;
  let valuesKnown = true;
  let foreignInputs = 0;

  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i) as {
      txid?: Uint8Array;
      index?: number;
      witnessUtxo?: { script: Uint8Array; amount: bigint };
      nonWitnessUtxo?: { outputs: { script: Uint8Array; amount: bigint }[] };
      bip32Derivation?: unknown;
    };
    const vout = input.index ?? 0;
    const previous =
      input.witnessUtxo ?? (input.nonWitnessUtxo ? input.nonWitnessUtxo.outputs[vout] : undefined);
    const value = previous ? previous.amount : null;
    const script = previous?.script;
    const spot = script ? own.find(script, depth) : null;

    if (value === null) valuesKnown = false;
    if (spot) spending += value ?? 0n;
    else foreignInputs++;

    inputs.push({
      txid: input.txid ? hex(input.txid) : '',
      vout,
      value,
      address: script ? addressFromScript(script) : null,
      mine: spot !== null,
      path: spot ? pathOf(spot) : null,
    });
  }

  const outputScripts: Uint8Array[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    const output = tx.getOutput(i) as {
      script?: Uint8Array;
      amount?: bigint;
      bip32Derivation?: unknown;
    };
    const script = output.script ?? new Uint8Array(0);
    const value = output.amount ?? 0n;
    outputScripts.push(script);

    const spot = own.find(script, depth);
    const claimed = claimedSpot(output.bip32Derivation);

    /* The change-swap attack, caught here. The PSBT says this output is ours
     * and gives a path; we derived that path and the script it produces is not
     * this script. There is no innocent version of that, so it is fatal rather
     * than a note: a device that showed "and the rest comes back to you" here
     * would be reading the attacker's caption over the attacker's payment. */
    if (!spot && claimed.spot) {
      warnings.push({
        code: 'output-path-mismatch',
        fatal: true,
        message:
          `Output ${i + 1} claims to be your own change at ${pathOf(claimed.spot)}, but that key ` +
          `does not produce this address. This transaction is lying about where the money goes. ` +
          `Do not sign it.`,
      });
    }
    if (claimed.unusual && !spot) {
      warnings.push({
        code: 'unusual-path',
        fatal: false,
        message: `Output ${i + 1} carries a derivation path this wallet does not use.`,
      });
    }

    if (spot) returning += value;
    else leaving += value;

    outputs.push({
      address: addressFromScript(script),
      script: hex(script),
      value,
      mine: spot !== null,
      path: spot ? pathOf(spot) : null,
    });
  }

  if (!valuesKnown) {
    warnings.push({
      code: 'unknown-input-value',
      fatal: true,
      message:
        'This transaction does not say how much one of its inputs is worth, so the fee cannot be ' +
        'worked out. A transaction that hides its fee can spend the difference on one. Ask the ' +
        'other device to send it again with the full input information.',
    });
  }
  if (foreignInputs > 0) {
    warnings.push({
      code: 'foreign-input',
      fatal: false,
      message:
        `${foreignInputs} of the ${inputs.length} inputs are not from this wallet, so this device ` +
        `cannot sign them. The transaction will need another signer before it can be broadcast.`,
    });
  }
  if (wallet.kind !== 'full') {
    warnings.push({
      code: 'watch-only',
      fatal: true,
      message: 'This is a watch-only wallet. It has no private key and cannot sign anything.',
    });
  }

  const totalIn = inputs.reduce((sum, input) => sum + (input.value ?? 0n), 0n);
  const totalOut = outputs.reduce((sum, output) => sum + output.value, 0n);
  const fee = valuesKnown ? totalIn - totalOut : null;

  if (fee !== null && fee < 0n) {
    return failed(digest, 'That transaction spends more than it takes in, which cannot be right.');
  }

  const vsize = estimateVsize(inputs.length, outputScripts);
  const feeRate = fee === null ? null : Math.round((Number(fee) / vsize) * 100) / 100;

  if (fee !== null && leaving > 0n && Number(fee) > Number(leaving) * HIGH_FEE_RATIO) {
    warnings.push({
      code: 'high-fee',
      fatal: false,
      message:
        `The fee is ${formatBtc(fee)} BTC against a payment of ${formatBtc(leaving)} BTC. ` +
        `That is unusually high. Check it before approving.`,
    });
  } else if (feeRate !== null && feeRate > HIGH_FEE_RATE) {
    warnings.push({
      code: 'high-fee',
      fatal: false,
      message: `The fee works out at about ${feeRate} sat/vB, which is very high.`,
    });
  }
  if (leaving === 0n) {
    warnings.push({
      code: 'nothing-leaves',
      fatal: false,
      message:
        'Every output of this transaction comes back to your own wallet. Nothing is being paid to ' +
        'anybody. That is what a consolidation looks like, and also what a mistake looks like.',
    });
  }

  const fatal = warnings.some((warning) => warning.fatal);
  return {
    ok: true,
    digest,
    inputs,
    outputs,
    spending,
    leaving,
    returning,
    fee,
    feeRate,
    warnings,
    signable: !fatal && foreignInputs === 0 && valuesKnown && wallet.kind === 'full',
  };
}

export interface SignResult {
  ok: boolean;
  problem?: string;
  /** The PSBT with our signatures in it, for a companion that wants one. */
  psbt?: Uint8Array;
  /** The finished transaction, when every input could be finalised. */
  hex?: string;
  txid?: string;
  signed: number;
}

/**
 * Sign, having been shown the approval that a person actually gave.
 *
 * `approval` is the summary `describePsbt` returned for the very bytes now
 * being signed, and its digest is checked against them. This is not ceremony.
 * A signer whose sign function takes only the transaction is one refactor away
 * from a UI that describes the PSBT it scanned first and signs the one it
 * scanned second, and that bug produces a valid signature on a transaction
 * nobody ever saw. Making the approval an argument means the mistake does not
 * compile into a signature; it fails here.
 */
export function signPsbt(psbt: Uint8Array, wallet: BtcWallet, approval: PsbtSummary): SignResult {
  if (psbtDigest(psbt) !== approval.digest) {
    return {
      ok: false,
      signed: 0,
      problem:
        'These are not the bytes that were approved. Something changed between the screen and the ' +
        'signature, so nothing has been signed. Scan it again.',
    };
  }
  if (!approval.ok) return { ok: false, signed: 0, problem: approval.problem ?? 'That transaction could not be read.' };
  if (wallet.kind !== 'full') {
    return { ok: false, signed: 0, problem: 'A watch-only wallet has no private key and cannot sign.' };
  }

  const fatal = approval.warnings.find((warning) => warning.fatal);
  if (fatal) return { ok: false, signed: 0, problem: fatal.message };

  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(psbt, { allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true });
  } catch (err) {
    return { ok: false, signed: 0, problem: String((err as Error)?.message ?? err) };
  }

  let signed = 0;
  for (let i = 0; i < approval.inputs.length; i++) {
    const input = approval.inputs[i];
    if (!input?.mine || !input.path) continue;
    const parts = input.path.split('/');
    const change = Number(parts[parts.length - 2]);
    const index = Number(parts[parts.length - 1]);
    const key = privateKeyAt(wallet, change, index);
    if (!key) continue;
    try {
      if (tx.signIdx(key, i)) signed++;
    } catch (err) {
      return { ok: false, signed, problem: `Input ${i + 1} could not be signed: ${String((err as Error)?.message ?? err)}` };
    }
  }

  if (signed === 0) {
    return { ok: false, signed: 0, problem: 'None of the inputs belong to this wallet, so there was nothing to sign.' };
  }

  /* Finalising is attempted, not required. A transaction with another party's
   * inputs in it is legitimately unfinished after we sign, and handing back a
   * part-signed PSBT is the right answer there rather than an error. */
  let hex: string | undefined;
  let txid: string | undefined;
  try {
    tx.finalize();
    hex = tx.hex;
    txid = tx.id;
  } catch {
    hex = undefined;
    txid = undefined;
  }

  const result: SignResult = { ok: true, signed, psbt: tx.toPSBT() };
  if (hex !== undefined) result.hex = hex;
  if (txid !== undefined) result.txid = txid;
  return result;
}

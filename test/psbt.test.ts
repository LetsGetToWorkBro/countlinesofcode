/**
 * The confirmation screen, which is the only real defence this device has.
 *
 * Most of this file builds hostile transactions. That is deliberate: a signer
 * that handles the honest case is a signer that has been tested against a
 * cooperative counterparty, and the entire premise of an airgap is that the
 * other side may not be one. The transactions below are the ones a compromised
 * companion would send, and every test asks the same question, which is whether
 * a person reading this screen would be told the truth.
 */

import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { addressAt, openFromMnemonic, openWatch } from '../src/keys/bitcoin';
import { describePsbt, psbtDigest, signPsbt } from '../src/keys/psbt';

const WORDS =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
/** Somebody else's wallet, for inputs and outputs that are not ours. */
const STRANGER_WORDS =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

const wallet = openFromMnemonic(WORDS);
const stranger = openFromMnemonic(STRANGER_WORDS);

const STRANGER_ADDRESS = addressAt(stranger, 0, 0).address;

/** A fake but well-formed previous txid, distinct per input. */
function txidFor(n: number): Uint8Array {
  return new Uint8Array(32).fill(n);
}

interface InputSpec {
  /** Whose address the coin sits on. */
  owner?: 'ours' | 'stranger';
  change?: 0 | 1;
  index?: number;
  value?: bigint;
  /** Leave the previous output off entirely, so the fee cannot be worked out. */
  hideValue?: boolean;
}

interface OutputSpec {
  address?: string;
  /** Derive one of our own addresses to pay to. */
  ours?: { change: 0 | 1; index: number };
  value: bigint;
  /** Claim a derivation path, truthfully or otherwise. */
  claimPath?: [0 | 1, number];
}

function build(inputs: InputSpec[], outputs: OutputSpec[]): Uint8Array {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  inputs.forEach((spec, i) => {
    const source = spec.owner === 'stranger' ? stranger : wallet;
    const { script } = addressAt(source, spec.change ?? 0, spec.index ?? i);
    if (spec.hideValue) {
      tx.addInput({ txid: txidFor(i + 1), index: 0 });
    } else {
      tx.addInput({
        txid: txidFor(i + 1),
        index: 0,
        witnessUtxo: { script, amount: spec.value ?? 100_000n },
      });
    }
  });
  for (const spec of outputs) {
    const script = spec.ours
      ? addressAt(wallet, spec.ours.change, spec.ours.index).script
      : btc.OutScript.encode(btc.Address().decode(spec.address ?? STRANGER_ADDRESS));
    if (spec.claimPath) {
      const [change, index] = spec.claimPath;
      const node = wallet.account.deriveChild(change).deriveChild(index);
      tx.addOutput({
        script,
        amount: spec.value,
        bip32Derivation: [
          [node.publicKey!, { fingerprint: 0x12345678, path: [2147483732, 2147483648, 2147483648, change, index] }],
        ],
      });
    } else {
      tx.addOutput({ script, amount: spec.value });
    }
  }
  return tx.toPSBT();
}

describe('an ordinary payment', () => {
  // Two coins of 100,000 in; 150,000 to a stranger; 45,000 back as change.
  const psbt = build(
    [{ index: 0 }, { index: 1 }],
    [{ value: 150_000n }, { ours: { change: 1, index: 0 }, value: 45_000n, claimPath: [1, 0] }],
  );
  const summary = describePsbt(psbt, wallet);

  it('adds up, and says which side of the transaction each number is on', () => {
    expect(summary.ok).toBe(true);
    expect(summary.spending).toBe(200_000n);
    expect(summary.leaving).toBe(150_000n);
    expect(summary.returning).toBe(45_000n);
    expect(summary.fee).toBe(5_000n);
  });

  it('names the destination, which is the thing a person actually reads', () => {
    expect(summary.outputs[0]!.address).toBe(STRANGER_ADDRESS);
    expect(summary.outputs[0]!.mine).toBe(false);
    expect(summary.outputs[1]!.mine).toBe(true);
    expect(summary.outputs[1]!.path).toBe("m/84'/0'/0'/1/0");
  });

  it('knows both inputs are ours and where they came from', () => {
    expect(summary.inputs.every((input) => input.mine)).toBe(true);
    expect(summary.inputs[0]!.path).toBe("m/84'/0'/0'/0/0");
    expect(summary.inputs[0]!.address).toBe(addressAt(wallet, 0, 0).address);
  });

  it('estimates a fee rate and does not pretend it is exact', () => {
    expect(summary.feeRate).toBeGreaterThan(0);
    expect(summary.feeRate).toBeLessThan(100);
  });

  it('is signable and says nothing alarming', () => {
    expect(summary.signable).toBe(true);
    expect(summary.warnings).toEqual([]);
  });

  it('signs into a finished transaction', () => {
    const result = signPsbt(psbt, wallet, summary);
    expect(result.ok).toBe(true);
    expect(result.signed).toBe(2);
    expect(result.hex).toMatch(/^[0-9a-f]+$/);
    expect(result.txid).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the change-swap attack', () => {
  /* The one that costs the most and looks the most innocent. The PSBT marks an
   * output as change, with a derivation path that really is ours, but the
   * script pays somebody else. A signer that believed the label would show
   * "0.00045 back to you" over an output that is nothing of the sort. */
  const psbt = build(
    [{ index: 0, value: 200_000n }],
    [{ value: 150_000n }, { address: STRANGER_ADDRESS, value: 45_000n, claimPath: [1, 0] }],
  );
  const summary = describePsbt(psbt, wallet);

  it('does not believe the label', () => {
    expect(summary.outputs[1]!.mine).toBe(false);
  });

  it('counts the money as leaving, because it is', () => {
    expect(summary.leaving).toBe(195_000n);
    expect(summary.returning).toBe(0n);
  });

  it('calls it out as a lie rather than as an oddity', () => {
    const caught = summary.warnings.find((w) => w.code === 'output-path-mismatch');
    expect(caught).toBeDefined();
    expect(caught!.fatal).toBe(true);
    expect(caught!.message).toMatch(/lying|do not sign/i);
  });

  it('refuses to sign it even when asked directly', () => {
    expect(summary.signable).toBe(false);
    const result = signPsbt(psbt, wallet, summary);
    expect(result.ok).toBe(false);
    expect(result.signed).toBe(0);
  });
});

describe('a transaction that will not say what its inputs are worth', () => {
  const psbt = build([{ index: 0, hideValue: true }], [{ value: 50_000n }]);
  const summary = describePsbt(psbt, wallet);

  it('reports the fee as unknown rather than as zero', () => {
    // Zero would be a number somebody could read and believe.
    expect(summary.fee).toBeNull();
    expect(summary.feeRate).toBeNull();
  });

  it('treats an unknowable fee as fatal', () => {
    const caught = summary.warnings.find((w) => w.code === 'unknown-input-value');
    expect(caught?.fatal).toBe(true);
    expect(summary.signable).toBe(false);
    expect(signPsbt(psbt, wallet, summary).ok).toBe(false);
  });
});

describe('describing one transaction and signing another', () => {
  const first = build([{ index: 0 }], [{ value: 50_000n }]);
  const second = build([{ index: 0 }], [{ value: 90_000n }]);

  it('refuses when the bytes are not the ones that were approved', () => {
    /* The bug this exists to make impossible: a screen that describes the PSBT
     * it scanned first and signs the one it scanned second. Both are valid,
     * both are signable, and the signature lands on the transaction nobody
     * read. */
    const approvedFirst = describePsbt(first, wallet);
    const result = signPsbt(second, wallet, approvedFirst);
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/not the bytes that were approved/i);
    expect(result.signed).toBe(0);
  });

  it('signs when they are', () => {
    expect(signPsbt(second, wallet, describePsbt(second, wallet)).ok).toBe(true);
  });

  it('digests the exact bytes, so any edit at all is caught', () => {
    expect(psbtDigest(first)).not.toBe(psbtDigest(second));
    expect(psbtDigest(first)).toBe(describePsbt(first, wallet).digest);
  });
});

describe('inputs that are not ours', () => {
  const psbt = build(
    [{ index: 0, value: 100_000n }, { owner: 'stranger', index: 0, value: 100_000n }],
    [{ value: 190_000n }],
  );
  const summary = describePsbt(psbt, wallet);

  it('counts only our own coins as being spent by us', () => {
    expect(summary.spending).toBe(100_000n);
    expect(summary.inputs[1]!.mine).toBe(false);
  });

  it('says so, without calling it an attack', () => {
    // A shared or collaborative transaction is a legitimate thing.
    const caught = summary.warnings.find((w) => w.code === 'foreign-input');
    expect(caught?.fatal).toBe(false);
  });

  it('signs our half and hands back an unfinished PSBT', () => {
    const result = signPsbt(psbt, wallet, summary);
    expect(result.ok).toBe(true);
    expect(result.signed).toBe(1);
    expect(result.psbt).toBeInstanceOf(Uint8Array);
    // Not finished, because somebody else still has to sign. That is not an
    // error, and returning a half-signed PSBT is the whole point of the format.
    expect(result.hex).toBeUndefined();
  });
});

describe('change we can prove is ours without being told', () => {
  it('finds our own output by derivation when the PSBT says nothing', () => {
    // A companion that omits the derivation data is unhelpful, not hostile.
    const psbt = build([{ index: 0, value: 200_000n }], [{ value: 100_000n }, { ours: { change: 1, index: 4 }, value: 95_000n }]);
    const summary = describePsbt(psbt, wallet);
    expect(summary.outputs[1]!.mine).toBe(true);
    expect(summary.outputs[1]!.path).toBe("m/84'/0'/0'/1/4");
    expect(summary.returning).toBe(95_000n);
  });

  it('reports an address past the search depth as leaving, not as ours', () => {
    /* Wrong in the safe direction: it overstates what is being paid away. A
     * person sees a bigger number than the truth and cancels, which costs a
     * scan. The other way round costs the money. */
    const psbt = build([{ index: 0, value: 200_000n }], [{ ours: { change: 1, index: 50 }, value: 195_000n }]);
    const shallow = describePsbt(psbt, wallet, { scanDepth: 5 });
    expect(shallow.outputs[0]!.mine).toBe(false);
    expect(shallow.leaving).toBe(195_000n);
    // With a normal depth it is found and reported honestly.
    expect(describePsbt(psbt, wallet).outputs[0]!.mine).toBe(true);
  });
});

describe('things worth saying out loud but not refusing over', () => {
  it('flags a fee that is large next to the payment', () => {
    const psbt = build([{ index: 0, value: 200_000n }], [{ value: 100_000n }]);
    const summary = describePsbt(psbt, wallet);
    expect(summary.fee).toBe(100_000n);
    const caught = summary.warnings.find((w) => w.code === 'high-fee');
    expect(caught?.fatal).toBe(false);
    expect(summary.signable).toBe(true);
  });

  it('names a transaction where nothing actually leaves', () => {
    const psbt = build([{ index: 0, value: 100_000n }], [{ ours: { change: 0, index: 3 }, value: 95_000n }]);
    const summary = describePsbt(psbt, wallet);
    const caught = summary.warnings.find((w) => w.code === 'nothing-leaves');
    expect(caught?.fatal).toBe(false);
    expect(summary.leaving).toBe(0n);
    expect(summary.returning).toBe(95_000n);
  });
});

describe('a wallet that cannot sign', () => {
  const watch = openWatch(wallet.zpub).wallet!;

  it('still reads the transaction, so it can be checked on a second device', () => {
    const psbt = build([{ index: 0, value: 100_000n }], [{ value: 95_000n }]);
    const summary = describePsbt(psbt, watch);
    expect(summary.ok).toBe(true);
    expect(summary.inputs[0]!.mine).toBe(true);
    expect(summary.leaving).toBe(95_000n);
  });

  it('says plainly that it has no key, rather than failing at the signature', () => {
    const psbt = build([{ index: 0, value: 100_000n }], [{ value: 95_000n }]);
    const summary = describePsbt(psbt, watch);
    expect(summary.warnings.find((w) => w.code === 'watch-only')?.fatal).toBe(true);
    expect(summary.signable).toBe(false);
    expect(signPsbt(psbt, watch, summary).problem).toMatch(/watch-only|no private key/i);
  });
});

describe('input that is not a transaction at all', () => {
  it('says so instead of throwing, because a camera sees everything', () => {
    for (const junk of [new Uint8Array(0), new Uint8Array([1, 2, 3]), new TextEncoder().encode('hello')]) {
      const summary = describePsbt(junk, wallet);
      expect(summary.ok).toBe(false);
      expect(summary.signable).toBe(false);
      expect(summary.warnings[0]!.fatal).toBe(true);
    }
  });

  it('will not sign something it could not read', () => {
    const junk = new Uint8Array([9, 9, 9]);
    expect(signPsbt(junk, wallet, describePsbt(junk, wallet)).ok).toBe(false);
  });
});

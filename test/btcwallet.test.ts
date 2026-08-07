/**
 * The Bitcoin wallet's brains.
 *
 * The derivation tests pin this wallet to the official BIP84 test vector: if
 * addresses ever drift from what every other BIP84 wallet derives, restoring
 * a seed elsewhere would show an empty wallet, which is the most frightening
 * bug a wallet can have. The send tests build real signed transactions and
 * check the money arithmetic the hard way: fee, change, dust, send-max.
 */

import { describe, expect, it } from 'vitest';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import {
  addressAt,
  buildSend,
  checkMnemonic,
  formatBtc,
  isBtcAddress,
  newMnemonic,
  openFromMnemonic,
  openWatch,
  parseBtc,
  pickFeeRate,
  drawDecoys,
  prettyBtcError,
  scanWallet,
  type Utxo,
} from '../src/client/btcwallet';

/** The BIP84 reference vector: the mnemonic every implementation documents. */
const VECTOR_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR = {
  zpub: 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs',
  receive0: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  receive1: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
  change0: 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
};

describe('amounts', () => {
  it('parses BTC into sats without floating point', () => {
    expect(parseBtc('0.1').sats).toBe(10_000_000n);
    expect(parseBtc('0.00000001').sats).toBe(1n);
    expect(parseBtc('21000000').sats).toBe(21_000_000n * 100_000_000n);
  });

  it('refuses more decimals than Bitcoin has, and nonsense', () => {
    expect(parseBtc('0.000000001').ok).toBe(false);
    expect(parseBtc('ten').ok).toBe(false);
    expect(parseBtc('0').ok).toBe(false);
    expect(parseBtc('').ok).toBe(false);
  });

  it('formats sats back, round-tripping cleanly', () => {
    expect(formatBtc(10_000_000n)).toBe('0.1');
    expect(formatBtc(0n)).toBe('0');
    expect(formatBtc(150_000_000n)).toBe('1.5');
    expect(formatBtc(parseBtc('0.00034501').sats!)).toBe('0.00034501');
  });
});

describe('seed words', () => {
  it('generates twelve valid words', () => {
    const words = newMnemonic();
    expect(words.split(' ')).toHaveLength(12);
    expect(checkMnemonic(words).ok).toBe(true);
  });

  it('normalises case and whitespace before judging', () => {
    const sloppy = '  Abandon ABANDON abandon\tabandon abandon abandon\nabandon abandon abandon abandon abandon about ';
    const checked = checkMnemonic(sloppy);
    expect(checked.ok).toBe(true);
    expect(checked.words).toBe(VECTOR_WORDS);
  });

  it('catches a mistyped word by its checksum, in words', () => {
    const wrong = checkMnemonic(VECTOR_WORDS.replace('about', 'abandon'));
    expect(wrong.ok).toBe(false);
    expect(wrong.problem).toMatch(/checksum|mistyped/i);
    expect(checkMnemonic('one two three').problem).toMatch(/3 words/);
  });
});

describe('BIP84 derivation, held to the reference vector', () => {
  const wallet = openFromMnemonic(VECTOR_WORDS);

  it('derives the documented zpub', () => {
    expect(wallet.zpub).toBe(VECTOR.zpub);
  });

  it('derives the documented first addresses', () => {
    expect(addressAt(wallet, 0, 0).address).toBe(VECTOR.receive0);
    expect(addressAt(wallet, 0, 1).address).toBe(VECTOR.receive1);
    expect(addressAt(wallet, 1, 0).address).toBe(VECTOR.change0);
  });

  it('watches the same wallet from the zpub alone', () => {
    const watch = openWatch(VECTOR.zpub);
    expect(watch.ok).toBe(true);
    expect(addressAt(watch.wallet!, 0, 0).address).toBe(VECTOR.receive0);
    expect(watch.wallet!.kind).toBe('watch');
  });

  it('turns a mangled key or a bare address into words, not a throw', () => {
    expect(openWatch('zpub6rFR7y4Q2Aij000000').ok).toBe(false);
    expect(openWatch(VECTOR.receive0).problem).toMatch(/zpub/i);
  });
});

describe('address judgement', () => {
  it('takes mainnet addresses of every standard shape', () => {
    expect(isBtcAddress(VECTOR.receive0)).toBe(true); // bech32
    expect(isBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true); // legacy
    expect(isBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true); // p2sh
  });

  it('refuses testnet and noise, because money', () => {
    expect(isBtcAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false);
    expect(isBtcAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv')).toBe(false); // bad checksum
    expect(isBtcAddress('')).toBe(false);
  });
});

describe('scanning through a fake explorer', () => {
  const wallet = openFromMnemonic(VECTOR_WORDS);
  const empty = { chain_stats: zeroStats(), mempool_stats: zeroStats() };
  function zeroStats() {
    return { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 };
  }

  it('finds the balance, the coins, and the next fresh address', async () => {
    const addr0 = VECTOR.receive0;
    const answers: Record<string, unknown> = {
      [`address/${addr0}`]: {
        chain_stats: { funded_txo_sum: 150_000, spent_txo_sum: 50_000, tx_count: 2 },
        mempool_stats: zeroStats(),
      },
      [`address/${addr0}/utxo`]: [
        { txid: 'a'.repeat(64), vout: 1, value: 100_000, status: { confirmed: true } },
      ],
      [`address/${addr0}/txs`]: [
        {
          txid: 'a'.repeat(64),
          status: { confirmed: true, block_time: 1_700_000_000 },
          vin: [{ prevout: { scriptpubkey_address: 'bc1qsomebodyelse', value: 200_000 } }],
          vout: [{ scriptpubkey_address: addr0, value: 100_000 }],
        },
      ],
    };
    const asked: string[] = [];
    const view = await scanWallet(async (path) => {
      asked.push(path);
      return answers[path] ?? empty;
    }, wallet);

    expect(view.balance).toBe(100_000n);
    expect(view.pending).toBe(0n);
    expect(view.utxos).toHaveLength(1);
    expect(view.utxos[0]).toMatchObject({ txid: 'a'.repeat(64), value: 100_000n, change: 0, index: 0 });
    // Address 0 is used, so the fresh receive address is the next one.
    expect(view.receiveAddress).toBe(VECTOR.receive1);
    expect(view.history).toHaveLength(1);
    expect(view.history[0]!.net).toBe(100_000n); // received, not sent
    // The gap limit ended both chains rather than walking to the cap.
    expect(asked.filter((p) => !p.includes('/')).length).toBeLessThan(50);
  });

  it('shows an untouched wallet as empty with address zero on offer', async () => {
    const asked: string[] = [];
    const view = await scanWallet(async (path) => { asked.push(path); return empty; }, wallet);
    expect(view.balance).toBe(0n);
    expect(view.utxos).toHaveLength(0);
    expect(view.receiveAddress).toBe(VECTOR.receive0);
    expect(view.usedAddresses).toBe(0);
    // A wallet that never received cannot have change, so the change chain
    // is never asked about: one gap window, twenty lookups, done.
    expect(asked).toHaveLength(20);
  });

  it('pads the lookups with real decoys so the log is a haystack', async () => {
    // The leak this closes: whoever carries the questions (our Worker, and
    // Cloudflare behind it) could read the wallet straight off the request
    // log. Padded mode asks about decoys too, shuffled in, so the log holds
    // a set the wallet is merely somewhere inside.
    const pool = Array.from({ length: 80 }, (_, i) => `bc1qdecoy${String(i).padStart(34, '0')}`);
    const asked: string[] = [];
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

    await scanWallet(
      async (path) => { asked.push(path); return empty; },
      wallet,
      { privacy: 'padded', ratio: 2, decoys: pool, random },
    );

    const addresses = asked.map((p) => p.split('/')[1]!);
    const ours = addresses.filter((a) => !a.startsWith('bc1qdecoy'));
    const theirs = addresses.filter((a) => a.startsWith('bc1qdecoy'));
    // Twenty real ones (one gap window, no change chain on an unused wallet)
    // and twice as many decoys.
    expect(ours).toHaveLength(20);
    expect(theirs).toHaveLength(40);
    // And they are not in a block at the front: the order is shuffled, so
    // position does not give the wallet away either.
    const firstDecoy = addresses.findIndex((a) => a.startsWith('bc1qdecoy'));
    expect(firstDecoy).toBeLessThan(20);
  });

  it('still reports the right balance while padded', async () => {
    const addr0 = VECTOR.receive0;
    const answers: Record<string, unknown> = {
      [`address/${addr0}`]: {
        chain_stats: { funded_txo_sum: 90_000, spent_txo_sum: 0, tx_count: 1 },
        mempool_stats: zeroStats(),
      },
      [`address/${addr0}/utxo`]: [{ txid: 'b'.repeat(64), vout: 0, value: 90_000, status: { confirmed: true } }],
      [`address/${addr0}/txs`]: [],
    };
    // Every decoy answers as used, so the follow-up round is padded too.
    const usedDecoy = {
      chain_stats: { funded_txo_sum: 5, spent_txo_sum: 0, tx_count: 3 },
      mempool_stats: zeroStats(),
    };
    const pool = Array.from({ length: 40 }, (_, i) => `bc1qdecoy${String(i).padStart(34, '0')}`);
    const followUps: string[] = [];
    const view = await scanWallet(
      async (path) => {
        const address = path.split('/')[1]!;
        if (/\/(utxo|txs)$/.test(path)) followUps.push(address);
        if (answers[path] !== undefined) return answers[path];
        if (path.endsWith('/utxo') || path.endsWith('/txs')) return [];
        // Every decoy looks used; the wallet's other addresses are empty.
        return address.startsWith('bc1qdecoy') ? usedDecoy : empty;
      },
      wallet,
      { privacy: 'padded', ratio: 1, decoys: pool },
    );

    // A decoy's answer is read and dropped: it never reaches the balance.
    expect(view.balance).toBe(90_000n);
    expect(view.utxos).toHaveLength(1);
    // And the follow-up round is padded too, or it would hand back exactly
    // the set the shuffle just hid: the used addresses.
    expect(followUps.some((a) => a.startsWith('bc1qdecoy'))).toBe(true);
  });

  it('draws distinct decoys and never more than the pool holds', () => {
    const pool = ['a', 'b', 'c'];
    const drawn = drawDecoys(2, pool, Math.random);
    expect(drawn).toHaveLength(2);
    expect(new Set(drawn).size).toBe(2);
    expect(drawDecoys(99, pool, Math.random)).toHaveLength(3);
    expect(drawDecoys(0, pool, Math.random)).toEqual([]);
    expect(drawDecoys(5, [], Math.random)).toEqual([]);
  });

  it('ships a pool that looks exactly like what the wallet derives', async () => {
    // A haystack of the wrong shape is not a haystack. These are real
    // mainnet P2WPKH addresses, the same form as m/84'/0'/0' produces.
    const { DECOY_ADDRESSES } = await import('../src/client/btcdecoys');
    expect(DECOY_ADDRESSES.length).toBeGreaterThan(200);
    expect(new Set(DECOY_ADDRESSES).size).toBe(DECOY_ADDRESSES.length);
    for (const address of DECOY_ADDRESSES) {
      expect(address, address).toMatch(/^bc1q[ac-hj-np-z02-9]{38}$/);
      expect(isBtcAddress(address), address).toBe(true);
    }
  });

  it('describes a freshly created wallet without any network at all', async () => {
    const view = await import('../src/client/btcwallet').then((m) => m.emptyView(wallet));
    expect(view.balance).toBe(0n);
    expect(view.receiveAddress).toBe(VECTOR.receive0);
    expect(view.history).toHaveLength(0);
  });
});

describe('fee estimates', () => {
  const esploraShape = { '1': 32.5, '3': 20.1, '6': 12.4, '144': 3.2 };

  it('picks the nearest documented target at or below ours', () => {
    expect(pickFeeRate(esploraShape, 1)).toBe(33);
    expect(pickFeeRate(esploraShape, 6)).toBe(13);
    expect(pickFeeRate(esploraShape, 200)).toBe(4);
    expect(pickFeeRate(esploraShape, 4)).toBe(21); // between 3 and 6: the 3-block rate
  });

  it('never answers below one sat per vbyte, even on garbage', () => {
    expect(pickFeeRate({}, 6)).toBe(1);
    expect(pickFeeRate(null, 6)).toBe(1);
    expect(pickFeeRate({ '6': 0.1 }, 6)).toBe(1);
  });
});

describe('building a send', () => {
  const wallet = openFromMnemonic(VECTOR_WORDS);
  const DEST = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

  const coin = (value: bigint, index = 0, change: 0 | 1 = 0, vout = 0): Utxo => ({
    txid: 'ab'.repeat(32),
    vout,
    value,
    address: addressAt(wallet, change, index).address,
    change,
    index,
    confirmed: true,
  });

  /** Decode the signed hex and hand back its outputs as {amount, address}. */
  type OutInfo = Parameters<ReturnType<typeof btc.Address>['encode']>[0];
  function outputsOf(txHex: string) {
    const parsed = btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownOutputs: true });
    const outs = [];
    for (let i = 0; i < parsed.outputsLength; i++) {
      const out = parsed.getOutput(i)!;
      outs.push({ amount: out.amount!, address: btc.Address().encode(btc.OutScript.decode(out.script!) as OutInfo) });
    }
    return outs;
  }

  it('signs a real transaction with correct outputs and honest change', () => {
    const plan = buildSend({ wallet, utxos: [coin(100_000n)], to: DEST, amount: 40_000n, feeRate: 10 });
    expect(plan.ok).toBe(true);
    const outs = outputsOf(plan.hex!);
    expect(outs).toHaveLength(2);
    expect(outs[0]).toMatchObject({ amount: 40_000n, address: DEST });
    // Change goes to our own change chain, and the books balance exactly.
    expect(outs[1]!.address).toBe(addressAt(wallet, 1, 0).address);
    expect(100_000n - outs[0]!.amount - outs[1]!.amount).toBe(plan.fee!);
    expect(plan.fee!).toBe(BigInt(11 + 68 + 31 * 2) * 10n);
  });

  it('continues the change chain rather than reusing it', () => {
    const utxos = [coin(100_000n), coin(90_000n, 3, 1, 1)];
    const plan = buildSend({ wallet, utxos, to: DEST, amount: 150_000n, feeRate: 5 });
    expect(plan.ok).toBe(true);
    const outs = outputsOf(plan.hex!);
    expect(outs[1]!.address).toBe(addressAt(wallet, 1, 4).address); // past index 3
  });

  it('folds dust change into the fee instead of minting an unspendable coin', () => {
    // 100_000 in, ~99_000 out at a rate where change would land under dust.
    const plan = buildSend({ wallet, utxos: [coin(100_000n)], to: DEST, amount: 98_500n, feeRate: 10 });
    expect(plan.ok).toBe(true);
    const outs = outputsOf(plan.hex!);
    expect(outs).toHaveLength(1);
    expect(plan.change).toBe(0n);
    expect(plan.fee).toBe(1_500n);
  });

  it('send-max empties the wallet minus the fee, in one output', () => {
    const plan = buildSend({ wallet, utxos: [coin(50_000n), coin(30_000n, 1)], to: DEST, amount: null, feeRate: 2 });
    expect(plan.ok).toBe(true);
    const outs = outputsOf(plan.hex!);
    expect(outs).toHaveLength(1);
    expect(outs[0]!.amount + plan.fee!).toBe(80_000n);
    expect(plan.fee).toBe(BigInt(11 + 68 * 2 + 31) * 2n);
  });

  it('says why, for every way a send cannot happen', () => {
    const funded = [coin(10_000n)];
    expect(buildSend({ wallet, utxos: funded, to: 'not-an-address', amount: 5_000n, feeRate: 5 }).problem).toMatch(/valid Bitcoin address/);
    expect(buildSend({ wallet, utxos: funded, to: DEST, amount: 500n, feeRate: 5 }).problem).toMatch(/dust/);
    expect(buildSend({ wallet, utxos: funded, to: DEST, amount: 9_900n, feeRate: 5 }).problem).toMatch(/Not enough/);
    const watch = openWatch(VECTOR.zpub).wallet!;
    expect(buildSend({ wallet: watch, utxos: funded, to: DEST, amount: 5_000n, feeRate: 5 }).problem).toMatch(/watch-only/i);
  });
});

describe('errors in words', () => {
  it('turns transport failures into advice', () => {
    expect(prettyBtcError(new Error('fetch failed'))).toMatch(/explorer/);
    expect(prettyBtcError(new Error('Invalid checksum in bech32 string'))).toMatch(/address/i);
  });
});

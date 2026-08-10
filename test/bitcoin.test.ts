/**
 * Bitcoin keys, held to the vector published in BIP84.
 *
 * Ported with the code. The derivation tests are the ones that matter and they
 * are unchanged: a wallet that derives its own consistent wrong answer passes
 * every round-trip test anybody writes, so the only assertions worth having
 * are against numbers somebody else published.
 *
 * The entropy tests got shorter in the port, because randomness is an argument
 * here rather than a global. There is nothing to stub.
 */

import { describe, expect, it } from 'vitest';
import {
  addressAt,
  addressFromScript,
  checkBtcAddress,
  checkExtendedKey,
  checkMnemonic,
  formatBtc,
  isBtcAddress,
  mnemonicFromEntropy,
  openFromMnemonic,
  openWatch,
  parseBtc,
  privateKeyAt,
  selfTest,
} from '../src/keys/bitcoin';

/** The words and the answers, straight out of BIP84. */
const VECTOR_WORDS =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VECTOR = {
  zpub: 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs',
  receive0: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  receive1: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
  change0: 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
};

const bytes = (text: string) => new TextEncoder().encode(text);
const filled = (byte: number) => new Uint8Array(32).fill(byte);

describe('amounts', () => {
  it('parses BTC into sats without floating point', () => {
    expect(parseBtc('0.1').sats).toBe(10_000_000n);
    expect(parseBtc('0.00000001').sats).toBe(1n);
    expect(parseBtc('21000000').sats).toBe(21_000_000n * 100_000_000n);
  });

  it('refuses more decimals than Bitcoin has, and nonsense', () => {
    expect(parseBtc('0.000000001').ok).toBe(false);
    expect(parseBtc('ten').ok).toBe(false);
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
  it('normalises case and whitespace before judging', () => {
    const sloppy =
      '  Abandon ABANDON abandon\tabandon abandon abandon\nabandon abandon abandon abandon abandon about ';
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

  it('has no private key to give when it is only watching', () => {
    const watch = openWatch(VECTOR.zpub).wallet!;
    expect(privateKeyAt(watch, 0, 0)).toBeNull();
    expect(privateKeyAt(wallet, 0, 0)).toBeInstanceOf(Uint8Array);
  });

  it('turns a mangled key or a bare address into words, not a throw', () => {
    expect(openWatch('zpub6rFR7y4Q2Aij000000').ok).toBe(false);
    expect(openWatch(VECTOR.receive0).problem).toMatch(/zpub/i);
  });

  it('cautions about an xpub instead of silently deriving the wrong chain', () => {
    // A BIP44 account xpub derives valid bech32 addresses that hold nothing.
    // Saying so beats letting somebody conclude their money vanished.
    const xpub =
      'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj';
    const watched = openWatch(xpub);
    expect(watched.ok).toBe(true);
    expect(watched.caution).toMatch(/native-segwit|BIP84/);
  });
});

describe('address judgement', () => {
  it('takes mainnet addresses of every standard shape', () => {
    expect(isBtcAddress(VECTOR.receive0)).toBe(true);
    expect(isBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
    expect(isBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
  });

  it('refuses testnet and noise, because money', () => {
    expect(isBtcAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false);
    expect(isBtcAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv')).toBe(false);
    expect(isBtcAddress('')).toBe(false);
  });

  it('reads an address back out of a script, which is how outputs arrive', () => {
    const wallet = openFromMnemonic(VECTOR_WORDS);
    const { address, script } = addressAt(wallet, 0, 0);
    expect(addressFromScript(script)).toBe(address);
    expect(addressFromScript(new Uint8Array([0x6a, 0x02, 0x01, 0x02]))).not.toBe(address);
  });

  it('says nothing about an empty field, ticks a real address, names the type', () => {
    expect(checkBtcAddress('')).toEqual({ state: 'empty', note: '' });
    expect(checkBtcAddress(VECTOR.receive0)).toMatchObject({
      state: 'ok',
      note: expect.stringMatching(/bech32/),
    });
    expect(checkBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toMatchObject({
      state: 'ok',
      note: expect.stringMatching(/legacy/),
    });
  });

  it('fails a one-character typo and a testnet address', () => {
    expect(checkBtcAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv').state).toBe('bad');
    expect(checkBtcAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx').state).toBe('bad');
    expect(checkBtcAddress('bc1qcr8te4kr609').state).toBe('bad');
  });

  it('ticks an extended key only when it really decodes', () => {
    expect(checkExtendedKey('')).toEqual({ state: 'empty', note: '' });
    expect(checkExtendedKey(VECTOR.zpub)).toMatchObject({ state: 'ok', note: 'valid zpub' });
    expect(checkExtendedKey(VECTOR.zpub.slice(0, 40)).state).toBe('bad');
    expect(checkExtendedKey(VECTOR.receive0).state).toBe('bad');
  });
});

describe('a seed folds in whatever the person supplied', () => {
  /* The claim is that the extra can only add. With randomness as an argument
   * that is directly observable: hold the system bytes fixed and vary only the
   * extra, and the phrase has to change. */

  it('makes a phrase every BIP39 wallet accepts', () => {
    const words = mnemonicFromEntropy(filled(0x11), bytes('dice 4 6 2 1 5 3'));
    expect(words.split(' ')).toHaveLength(12);
    expect(checkMnemonic(words).ok, `rejected its own phrase: ${words}`).toBe(true);
  });

  it('derives a real bech32 wallet from it', () => {
    const wallet = openFromMnemonic(mnemonicFromEntropy(filled(0x22), bytes('anything')));
    const first = addressAt(wallet, 0, 0).address;
    expect(first.startsWith('bc1q')).toBe(true);
    expect(isBtcAddress(first)).toBe(true);
    expect(wallet.zpub.startsWith('zpub')).toBe(true);
  });

  it('gives a different phrase for different extras, from identical randomness', () => {
    const a = mnemonicFromEntropy(filled(0x11), bytes('dice one'));
    const b = mnemonicFromEntropy(filled(0x11), bytes('dice two'));
    const none = mnemonicFromEntropy(filled(0x11));
    expect(a).not.toBe(b);
    expect(a).not.toBe(none);
    expect(b).not.toBe(none);
    // Same inputs, same phrase: the mixing is a hash of both, not a second
    // source of randomness pretending to be one.
    expect(mnemonicFromEntropy(filled(0x11), bytes('dice one'))).toBe(a);
  });

  it('tracks the system bytes when the extra is held still', () => {
    expect(mnemonicFromEntropy(filled(0x01), bytes('same'))).not.toBe(
      mnemonicFromEntropy(filled(0x02), bytes('same')),
    );
  });

  it('insists on being given real randomness rather than reaching for some', () => {
    // No fallback to a global CSPRNG: on a device this old, where the entropy
    // came from is a question with an answer at the call site.
    expect(() => mnemonicFromEntropy(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});

describe('the self-check', () => {
  it('reproduces the test vector published in BIP84', () => {
    expect(selfTest()).toEqual({ ok: true });
  });
});

/**
 * Bytewords, checked against the reference implementation.
 *
 * This file is not really testing our code. It is testing that our copy of a
 * 256-word table published by somebody else matches theirs, because if it does
 * not, every function above it still passes its own tests, round-trips
 * perfectly with itself, and hands Sparrow a transaction that is not the one
 * on our screen.
 *
 * The vectors below were produced by running @ngraveio/bc-ur, the reference
 * implementation, rather than by reading a specification and typing out what
 * we thought it said.
 */

import { describe, expect, it } from 'vitest';
import { bytewordsDecode, bytewordsEncode, minimalFor, wordFor } from '../src/airgap/bytewords';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** hex payload, and what the reference implementation writes for it. */
const VECTORS: Array<{ hex: string; minimal: string; standard: string }> = [
  { hex: '', minimal: 'aeaeaeae', standard: 'able able able able' },
  { hex: '00', minimal: 'aetdaowslg', standard: 'able tied also webs lung' },
  { hex: 'ff', minimal: 'zmzmaeaeae', standard: 'zoom zoom able able able' },
  {
    hex: '00010203',
    minimal: 'aeadaoaxlurhlnbw',
    standard: 'able acid also apex luau rich lion brew',
  },
  {
    // A real one: `ur:crypto-seed` payload, CBOR and all.
    hex: 'd9012ca20150c7098580125e2ab0981253468b2dbc52',
    minimal: 'taaddwoeadgdstaslplabghydrpfmkbggufgludprfgmaxkpmekp',
    standard:
      'tuna acid draw oboe acid good slot axis limp lava brag holy door puff monk brag guru frog luau drop roof grim apex keep maze keep',
  },
  {
    hex: '0102030405060708090a0b0c0d0e0f',
    minimal: 'adaoaxaaahamatayasbkbdbnbtbabsykolpkft',
    standard:
      'acid also apex aqua arch atom aunt away axis back bald barn belt beta bias yank oval peck fact',
  },
];

describe('the table itself', () => {
  it('is 256 four-letter words', () => {
    for (let i = 0; i < 256; i++) expect(wordFor(i), `byte ${i}`).toMatch(/^[a-z]{4}$/);
    expect(wordFor(0)).toBe('able');
    expect(wordFor(255)).toBe('zoom');
  });

  it('has a unique first-and-last letter pair for every byte', () => {
    // This is the property that makes minimal style decodable at all. If two
    // words collided, one of 256 byte values would silently become another.
    const seen = new Set<string>();
    for (let i = 0; i < 256; i++) seen.add(minimalFor(i));
    expect(seen.size).toBe(256);
  });

  it('agrees with the reference implementation on known payloads', () => {
    for (const v of VECTORS) {
      const payload = hexToBytes(v.hex);
      expect(bytewordsEncode(payload, 'minimal'), `minimal ${v.hex || '(empty)'}`).toBe(v.minimal);
      expect(bytewordsEncode(payload, 'standard'), `standard ${v.hex || '(empty)'}`).toBe(
        v.standard,
      );
    }
  });
});

describe('reading bytewords back', () => {
  it('decodes every reference vector, in both styles', () => {
    for (const v of VECTORS) {
      const payload = hexToBytes(v.hex);
      expect(bytewordsDecode(v.minimal, 'minimal'), v.hex).toEqual(payload);
      expect(bytewordsDecode(v.standard, 'standard'), v.hex).toEqual(payload);
    }
  });

  it('round-trips every length, including the ones with no payload', () => {
    for (let n = 0; n < 70; n++) {
      const payload = new Uint8Array(n);
      for (let i = 0; i < n; i++) payload[i] = (i * 37 + n) & 0xff;
      for (const style of ['minimal', 'standard', 'uri'] as const) {
        expect(bytewordsDecode(bytewordsEncode(payload, style), style), `${style} ${n}`).toEqual(
          payload,
        );
      }
    }
  });

  it('is not fussy about case or surrounding whitespace', () => {
    // A camera and a copy-paste both introduce these, and neither changes what
    // was meant. Nothing else is forgiven.
    expect(bytewordsDecode('  AETDAOWSLG \n', 'minimal')).toEqual(hexToBytes('00'));
    expect(bytewordsDecode(' Able Tied Also Webs Lung ', 'standard')).toEqual(hexToBytes('00'));
  });

  it('refuses a checksum that disagrees', () => {
    // The last four bytes of "00" are its CRC-32. Change one word of the
    // payload and the sum no longer matches: that is a misread frame, and the
    // answer is nothing rather than a different byte.
    expect(bytewordsDecode('adtdaowslg', 'minimal'), 'payload changed').toBeNull();
    expect(bytewordsDecode('aetdaowslf', 'minimal'), 'checksum changed').toBeNull();
  });

  it('refuses words that are not in the table', () => {
    expect(bytewordsDecode('able zzzz also webs lung', 'standard')).toBeNull();
    expect(bytewordsDecode('aexxaowslg', 'minimal')).toBeNull();
  });

  it('refuses a length that cannot be bytes', () => {
    expect(bytewordsDecode('aetdaowslgz', 'minimal'), 'odd number of letters').toBeNull();
    expect(bytewordsDecode('ae ae ae', 'standard'), 'too short to hold a checksum').toBeNull();
    expect(bytewordsDecode('', 'minimal'), 'nothing at all').toBeNull();
    expect(bytewordsDecode('AE-TD-AO', 'minimal'), 'separators in minimal style').toBeNull();
  });

  it('does not read one style as another', () => {
    // Minimal text is all letters, so a standard-style reader must reject it
    // on the word lookup rather than quietly find something.
    expect(bytewordsDecode('aetdaowslg', 'standard')).toBeNull();
    expect(bytewordsDecode('able tied also webs lung', 'minimal')).toBeNull();
  });
});

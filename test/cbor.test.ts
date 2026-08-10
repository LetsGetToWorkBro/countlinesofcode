/**
 * The CBOR subset.
 *
 * Half of this file is about what the reader refuses. A signing device that
 * accepts a broader grammar than it needs is handing a parser to whoever is
 * holding the other screen, and CBOR has plenty of grammar to hand over:
 * indefinite lengths, tags, maps, floats, 64-bit sizes. None of it appears in
 * a UR frame, so none of it gets a code path, and a frame containing any of it
 * is a misread rather than an exotic encoding.
 */

import { describe, expect, it } from 'vitest';
import { cborDecode, cborEncode } from '../src/airgap/cbor';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const bin = (text: string): Uint8Array =>
  new Uint8Array((text.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

describe('writing', () => {
  it('uses the shortest form for every integer size', () => {
    expect(hex(cborEncode(0))).toBe('00');
    expect(hex(cborEncode(23))).toBe('17');
    expect(hex(cborEncode(24))).toBe('1818');
    expect(hex(cborEncode(255))).toBe('18ff');
    expect(hex(cborEncode(256))).toBe('190100');
    expect(hex(cborEncode(65535))).toBe('19ffff');
    expect(hex(cborEncode(65536))).toBe('1a00010000');
    expect(hex(cborEncode(0xffffffff))).toBe('1affffffff');
  });

  it('writes byte strings the way BC-UR does', () => {
    // 165 bytes is the length prefix a real PSBT lands on, and it is the one
    // that appears at the front of every ur:crypto-psbt in the wild.
    expect(hex(cborEncode(new Uint8Array(165))).slice(0, 4)).toBe('58a5');
    expect(hex(cborEncode(new Uint8Array([1, 2, 3])))).toBe('43010203');
    expect(hex(cborEncode(new Uint8Array(0)))).toBe('40');
  });

  it('writes the five-item array a multi-part frame is', () => {
    const frame = cborEncode([1, 3, 167, 0x6d0bfee7, new Uint8Array([0xaa, 0xbb])]);
    expect(hex(frame)).toBe('85010318a71a6d0bfee742aabb');
  });

  it('refuses to write anything it cannot read back', () => {
    expect(() => cborEncode(-1)).toThrow(/cannot write/);
    expect(() => cborEncode(1.5)).toThrow(/cannot write/);
    expect(() => cborEncode(0x100000000)).toThrow(/cannot write/);
    // @ts-expect-error a JS caller can pass anything
    expect(() => cborEncode('text')).toThrow(/cannot write/);
  });
});

describe('reading', () => {
  it('round-trips what it writes', () => {
    const values = [0, 23, 24, 1000, 0xffffffff, new Uint8Array([9, 8, 7]), new Uint8Array(0)];
    for (const value of values) expect(cborDecode(cborEncode(value))).toEqual(value);
    const frame = [7, 9, 400, 12345, new Uint8Array([1, 2, 3])];
    expect(cborDecode(cborEncode(frame))).toEqual(frame);
  });

  it('reads the frame the reference implementation writes', () => {
    const decoded = cborDecode(bin('85010318a71a6d0bfee742aabb'));
    expect(decoded).toEqual([1, 3, 167, 0x6d0bfee7, new Uint8Array([0xaa, 0xbb])]);
  });

  it('refuses a length written longer than it needed to be', () => {
    /* `1a00000003` is a perfectly legal CBOR 3, and no encoder in this
     * ecosystem emits it. Accepting it would mean two different frames decode
     * to the same value, which is a distinction worth keeping on a wire where
     * the only question is whether the camera read what the screen drew. */
    expect(cborDecode(bin('1a00000003'))).toBeNull();
    expect(cborDecode(bin('1803'))).toBeNull();
    expect(cborDecode(bin('5803010203'))).toBeNull();
  });

  it('refuses the parts of CBOR that never appear in a UR frame', () => {
    expect(cborDecode(bin('20')), 'negative integer').toBeNull();
    expect(cborDecode(bin('a0')), 'map').toBeNull();
    expect(cborDecode(bin('63616263')), 'text string').toBeNull();
    expect(cborDecode(bin('d9012c40')), 'tag').toBeNull();
    expect(cborDecode(bin('5f42010243030405ff')), 'indefinite length').toBeNull();
    expect(cborDecode(bin('fb3ff0000000000000')), 'float').toBeNull();
    expect(cborDecode(bin('1b0000000100000000')), '64-bit integer').toBeNull();
  });

  it('refuses truncated and over-long input', () => {
    expect(cborDecode(bin('')), 'nothing').toBeNull();
    expect(cborDecode(bin('43_0102'.replace('_', ''))), 'byte string cut short').toBeNull();
    expect(cborDecode(bin('8501')), 'array cut short').toBeNull();
    expect(cborDecode(bin('0001')), 'a second item after the first').toBeNull();
    expect(cborDecode(bin('4301020304')), 'trailing byte').toBeNull();
  });

  it('refuses arrays nested deeper than a frame can be', () => {
    expect(cborDecode(bin('8181818181818100'))).toBeNull();
  });
});

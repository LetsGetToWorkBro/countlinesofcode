/**
 * SHA-256 against the published vectors.
 *
 * The interesting cases are the boundaries, because a hand-written padding
 * step is where these go wrong: a message that ends exactly on a block, one
 * that leaves too few bytes for the length field and needs an extra block,
 * and one long enough to run the compression function many times.
 */

import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/airgap/sha256';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const ascii = (text: string): Uint8Array => new Uint8Array([...text].map((c) => c.charCodeAt(0)));

describe('sha256', () => {
  it('matches the NIST vectors', () => {
    expect(hex(sha256(ascii('')))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hex(sha256(ascii('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hex(sha256(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('pads correctly at every length around a block boundary', () => {
    // 55 bytes is the last message that fits its length field in one block,
    // 56 is the first that needs a second, and 64 fills a block exactly. Every
    // padding bug lives in that range.
    const known: Record<number, string> = {
      55: '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
      56: 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
      63: '7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34',
      64: 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
      119: '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb',
    };
    const message = (n: number) => ascii('a'.repeat(n));
    for (const n of [55, 56, 63, 64, 119]) {
      expect(hex(sha256(message(n))), `${n} bytes of "a"`).toBe(known[n]);
    }
  });

  it('handles a message long enough to need many blocks', () => {
    expect(hex(sha256(ascii('a'.repeat(1_000_000))))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });
});

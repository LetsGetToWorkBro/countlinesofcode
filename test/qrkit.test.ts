/**
 * The QR encoder and reader.
 *
 * A QR code that encodes wrong is a picture that scans as the wrong address; a
 * reader that decodes wrong tells you the wrong one back. Both halves are the
 * whole of ISO/IEC 18004 written here, so both are checked against the
 * standard's own worked example and against each other: everything the encoder
 * draws, the reader has to read back exactly, across every version and every
 * error-correction level, and the error correction has to repair real damage.
 */

import { describe, expect, it } from 'vitest';
import { chooseVersion, decodeQr, detectMode, encodeQr, rsEncode } from '../src/client/qrkit';

/** Paint a QR matrix into RGBA pixels, the way a canvas hands them to the
 *  reader: black modules, a white quiet zone, `scale` pixels per module. */
function raster(qr: { size: number; modules: boolean[][] }, scale: number, margin = 4): { data: Uint8ClampedArray; dim: number } {
  const dim = (qr.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r]![c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + margin) * scale + dx;
          const y = (r + margin) * scale + dy;
          const i = (y * dim + x) * 4;
          data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
        }
      }
    }
  }
  return { data, dim };
}

describe('rsEncode (Reed-Solomon over GF(256))', () => {
  it('matches the worked example in the standard for 01234567, version 1-M', () => {
    // The 16 data codewords for "01234567" at version 1, level M, and the ten
    // error-correction codewords ISO/IEC 18004 says they produce.
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    expect(rsEncode(data, 10)).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });

  it('produces exactly the requested number of check codewords', () => {
    expect(rsEncode([1, 2, 3], 7)).toHaveLength(7);
    expect(rsEncode([0], 30)).toHaveLength(30);
  });
});

describe('detectMode', () => {
  it('picks the tightest mode a string fits', () => {
    expect(detectMode('8675309')).toBe('numeric');
    expect(detectMode('HELLO WORLD 123')).toBe('alphanumeric');
    expect(detectMode('lower case')).toBe('byte'); // lowercase is not in the alnum set
    expect(detectMode('café')).toBe('byte'); // a combining accent needs bytes
  });
});

describe('chooseVersion', () => {
  it('grows with the text and never shrinks', () => {
    const short = chooseVersion('hi', 'M');
    const long = chooseVersion('x'.repeat(400), 'M');
    expect(short).toBeGreaterThanOrEqual(1);
    expect(long).toBeGreaterThan(short);
  });

  it('returns 0 when nothing from 1 to 40 can hold it', () => {
    // Version 40-L tops out near 2953 bytes; well past that, nothing fits.
    expect(chooseVersion('x'.repeat(8000), 'L')).toBe(0);
  });
});

describe('encodeQr', () => {
  it('draws a square matrix of the version dimension with the three finders', () => {
    const qr = encodeQr('finders', 'M');
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.modules).toHaveLength(qr.size);
    // A finder's centre 3x3 is dark at each of the three corners.
    const dark = (r: number, c: number) => qr.modules[r]![c] === true;
    expect(dark(3, 3)).toBe(true);
    expect(dark(3, qr.size - 4)).toBe(true);
    expect(dark(qr.size - 4, 3)).toBe(true);
    // The fixed dark module beside the bottom-left finder is always set.
    expect(qr.modules[qr.size - 8]![8]).toBe(true);
  });

  it('refuses an empty string and an oversize one rather than guessing', () => {
    expect(() => encodeQr('', 'M')).toThrow();
    expect(() => encodeQr('x'.repeat(8000), 'L')).toThrow();
  });
});

describe('encode then read back', () => {
  // One string per mode, plus a link and a run long enough to force a version
  // with alignment patterns and version information (the parts that break
  // independently of the data).
  const cases = [
    '8675309',
    'HELLO WORLD 123',
    'https://1999loc.com/wallet.html#addresses',
    'Grüße 日本語 bytes mode',
    'The quick brown fox jumps over the lazy dog. '.repeat(6),
    'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.001',
  ];

  for (const ec of ['L', 'M', 'Q', 'H'] as const) {
    for (const text of cases) {
      it(`round-trips ${JSON.stringify(text.slice(0, 24))} at level ${ec}`, () => {
        const qr = encodeQr(text, ec);
        const { data, dim } = raster(qr, 6);
        expect(decodeQr(data, dim, dim)).toBe(text);
      });
    }
  }
});

describe('the reader repairs damage with the error-correction codewords', () => {
  it('still reads a code with a block of modules flipped', () => {
    const text = 'https://1999loc.com/qr.html repair me';
    const qr = encodeQr(text, 'H'); // H recovers about 30 percent
    // Flip a patch of modules in the data region, clear of the finders.
    const damaged = { size: qr.size, modules: qr.modules.map((row) => row.slice()) };
    for (let r = qr.size - 12; r < qr.size - 4; r++) {
      for (let c = qr.size - 12; c < qr.size - 4; c++) damaged.modules[r]![c] = !damaged.modules[r]![c];
    }
    const { data, dim } = raster(damaged, 6);
    expect(decodeQr(data, dim, dim)).toBe(text);
  });
});

describe('the reader when there is nothing to read', () => {
  it('returns null for a blank image instead of inventing a string', () => {
    const dim = 200;
    const white = new Uint8ClampedArray(dim * dim * 4).fill(255);
    expect(decodeQr(white, dim, dim)).toBeNull();
  });
});

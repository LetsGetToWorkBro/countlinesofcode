/**
 * The GIF encoder.
 *
 * The LZW compressor is the part that has to be exactly right — one bit out of
 * place and the image is noise from that point on — so it is tested against a
 * decoder written independently here, from the format specification rather than
 * from the encoder. A round trip through the encoder alone would only prove it
 * agreed with itself.
 *
 * The rest of the encoder is checked against the properties that actually
 * matter to the result: that a palette follows the picture rather than a fixed
 * grid, that dithering carries error rather than discarding it, and that an
 * unchanged region is not re-encoded.
 */

import { describe, expect, it } from 'vitest';
import {
  GIF_RATES,
  MAX_COLORS,
  PaletteMatcher,
  buildGif,
  changedRect,
  codeSizeFor,
  estimateGifBytes,
  lzwEncode,
  medianCut,
  planGif,
  quantise,
  samplePixels,
} from '../src/client/gif';

// ---------------------------------------------------------------------------
// An LZW decoder, written from the format rather than from the encoder.
// ---------------------------------------------------------------------------

function unblock(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let at = 0;
  while (at < data.length) {
    const length = data[at++]!;
    if (length === 0) break;
    for (let i = 0; i < length; i++) out.push(data[at++]!);
  }
  return new Uint8Array(out);
}

function lzwDecode(blocked: Uint8Array, minCodeSize: number): Uint8Array {
  const bytes = unblock(blocked);
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let bitPos = 0;
  const read = (width: number): number => {
    let value = 0;
    for (let i = 0; i < width; i++) {
      const byte = bytes[bitPos >> 3] ?? 0;
      value |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return value;
  };

  let dictionary: number[][] = [];
  const reset = () => {
    dictionary = [];
    for (let i = 0; i < clearCode; i++) dictionary.push([i]);
    dictionary.push([], []); // clear and end occupy their slots
  };
  reset();

  let codeSize = minCodeSize + 1;
  const out: number[] = [];
  let previous: number[] | null = null;

  for (;;) {
    if (bitPos + codeSize > bytes.length * 8) break;
    const code = read(codeSize);
    if (code === endCode) break;
    if (code === clearCode) {
      reset();
      codeSize = minCodeSize + 1;
      previous = null;
      continue;
    }

    let entry: number[];
    if (code < dictionary.length) {
      entry = dictionary[code]!;
    } else if (previous) {
      entry = [...previous, previous[0]!];
    } else {
      throw new Error(`code ${code} with no dictionary entry and no previous`);
    }

    out.push(...entry);
    if (previous) {
      dictionary.push([...previous, entry[0]!]);
      // The decoder is always one entry behind the encoder — it can only
      // complete an entry once it sees the code that follows it — so it grows
      // its code width when the table *reaches* the limit, one assignment
      // earlier in its own count than the encoder does in its. That lines the
      // two up at the same position in the bit stream.
      if (dictionary.length >= 1 << codeSize && codeSize < 12) codeSize++;
    }
    previous = entry;
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------

describe('lzwEncode', () => {
  it('round-trips through an independent decoder', () => {
    const indices = new Uint8Array([1, 2, 3, 1, 2, 3, 1, 2, 3, 4, 4, 4, 4, 0, 0, 1]);
    expect(Array.from(lzwDecode(lzwEncode(indices, 3), 3))).toEqual(Array.from(indices));
  });

  it('round-trips a run long enough to grow the code width several times', () => {
    // The width grows as the dictionary fills, and the decoder has to grow at
    // exactly the same instant. This is the classic off-by-one.
    const indices = new Uint8Array(20000);
    for (let i = 0; i < indices.length; i++) indices[i] = (i * 7 + (i >> 5)) & 0xff;
    expect(Array.from(lzwDecode(lzwEncode(indices, 8), 8))).toEqual(Array.from(indices));
  });

  it('round-trips past the point where the dictionary fills and resets', () => {
    // 4096 entries is the ceiling; after that the encoder must emit a clear
    // code and start again, and the decoder must notice.
    const indices = new Uint8Array(120000);
    let seed = 12345;
    for (let i = 0; i < indices.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      indices[i] = (seed >> 16) & 0xff;
    }
    expect(lzwDecode(lzwEncode(indices, 8), 8)).toEqual(indices);
  });

  it('round-trips a single flat colour, which compresses to almost nothing', () => {
    const indices = new Uint8Array(5000).fill(7);
    const encoded = lzwEncode(indices, 8);
    expect(Array.from(lzwDecode(encoded, 8))).toEqual(Array.from(indices));
    expect(encoded.length).toBeLessThan(200);
  });

  it('round-trips at the format’s minimum code size', () => {
    // A two-colour image still uses two bits, because GIF forbids one.
    const indices = new Uint8Array([0, 1, 1, 0, 0, 0, 1, 1, 1, 0]);
    expect(Array.from(lzwDecode(lzwEncode(indices, 2), 2))).toEqual(Array.from(indices));
  });

  it('round-trips a single pixel', () => {
    expect(Array.from(lzwDecode(lzwEncode(new Uint8Array([5]), 8), 8))).toEqual([5]);
  });

  it('handles an empty image without producing a broken stream', () => {
    expect(Array.from(lzwDecode(lzwEncode(new Uint8Array(0), 8), 8))).toEqual([]);
  });

  it('writes sub-blocks no longer than the format allows', () => {
    const indices = new Uint8Array(50000);
    for (let i = 0; i < indices.length; i++) indices[i] = i & 0xff;
    const encoded = lzwEncode(indices, 8);
    let at = 0;
    let blocks = 0;
    while (at < encoded.length) {
      const length = encoded[at]!;
      if (length === 0) break;
      expect(length).toBeLessThanOrEqual(255);
      at += length + 1;
      blocks++;
    }
    expect(blocks).toBeGreaterThan(1);
    expect(encoded[encoded.length - 1]).toBe(0); // block terminator
  });
});

describe('medianCut', () => {
  it('spends the palette on the colours that are there', () => {
    // Two tight clusters: the palette should land on both rather than spread
    // itself evenly over a colour cube that is mostly empty.
    const samples = new Uint8Array(600);
    for (let i = 0; i < 100; i++) {
      samples.set([200 + (i % 5), 40, 40], i * 3);
      samples.set([40, 40, 200 + (i % 5)], (100 + i) * 3);
    }
    const palette = medianCut(samples, 4);
    const matcher = new PaletteMatcher(palette);
    const red = matcher.entry(matcher.nearest(202, 40, 40));
    const blue = matcher.entry(matcher.nearest(40, 40, 202));
    expect(red[0]).toBeGreaterThan(150);
    expect(blue[2]).toBeGreaterThan(150);
  });

  it('never returns more colours than asked for', () => {
    const samples = new Uint8Array(3000);
    for (let i = 0; i < 1000; i++) samples.set([i % 256, (i * 3) % 256, (i * 7) % 256], i * 3);
    expect(medianCut(samples, 16).length / 3).toBeLessThanOrEqual(16);
    expect(medianCut(samples, MAX_COLORS).length / 3).toBeLessThanOrEqual(MAX_COLORS);
  });

  it('does not invent colours for an image that has one', () => {
    const samples = new Uint8Array(300);
    for (let i = 0; i < 100; i++) samples.set([10, 20, 30], i * 3);
    const palette = medianCut(samples, 64);
    expect(palette.length / 3).toBe(1);
    expect(Array.from(palette)).toEqual([10, 20, 30]);
  });

  it('survives an empty image', () => {
    expect(medianCut(new Uint8Array(0), 16).length).toBe(3);
  });

  it('gets closer to the truth with more colours', () => {
    // A gradient: sixty-four entries must beat four, or the quantiser is not
    // doing anything.
    const samples = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) samples.set([i, 255 - i, (i * 2) % 256], i * 3);

    const error = (colors: number) => {
      const matcher = new PaletteMatcher(medianCut(samples, colors));
      let total = 0;
      for (let i = 0; i < 256; i++) {
        const want = [samples[i * 3]!, samples[i * 3 + 1]!, samples[i * 3 + 2]!];
        const got = matcher.entry(matcher.nearest(want[0]!, want[1]!, want[2]!));
        total += Math.abs(want[0]! - got[0]) + Math.abs(want[1]! - got[1]) + Math.abs(want[2]! - got[2]);
      }
      return total;
    };
    expect(error(64)).toBeLessThan(error(4));
  });
});

describe('samplePixels', () => {
  it('thins a large image down to something worth quantising', () => {
    const rgba = new Uint8Array(400000 * 4).fill(120);
    expect(samplePixels(rgba, 1000).length / 3).toBeLessThanOrEqual(1001);
  });

  it('keeps every pixel of a small one', () => {
    const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(Array.from(samplePixels(rgba, 1000))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('ignores transparent pixels, which have no colour to contribute', () => {
    const rgba = new Uint8Array([1, 2, 3, 255, 9, 9, 9, 0]);
    expect(Array.from(samplePixels(rgba, 1000))).toEqual([1, 2, 3]);
  });
});

describe('PaletteMatcher', () => {
  const palette = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 0, 0]);
  const matcher = new PaletteMatcher(palette);

  it('finds the obvious match', () => {
    expect(matcher.nearest(250, 5, 5)).toBe(2);
    expect(matcher.nearest(0, 0, 0)).toBe(0);
  });

  it('gives the same answer twice, cached or not', () => {
    expect(matcher.nearest(120, 130, 140)).toBe(matcher.nearest(120, 130, 140));
  });

  it('reports its own size', () => {
    expect(matcher.size).toBe(3);
  });
});

describe('quantise', () => {
  const palette = new Uint8Array([0, 0, 0, 255, 255, 255]);
  const matcher = new PaletteMatcher(palette);

  it('produces one index per pixel', () => {
    const rgba = new Uint8Array(4 * 4 * 4).fill(255);
    expect(quantise(rgba, 4, 4, matcher, { dither: false }).length).toBe(16);
  });

  it('bands a gradient without dithering and breaks it up with it', () => {
    // The whole reason dithering exists: mid-grey against a black-and-white
    // palette is a flat block one way and a mix the other.
    const width = 32;
    const rgba = new Uint8Array(width * 4 * 4);
    for (let i = 0; i < width * 4; i++) {
      const v = Math.round((i / (width * 4)) * 255);
      rgba.set([v, v, v, 255], i * 4);
    }
    const flat = quantise(rgba, width, 4, matcher, { dither: false });
    const dithered = quantise(rgba, width, 4, matcher, { dither: true });

    // Count how often the index changes along the row. Dithering changes it far
    // more, because it is trading banding for speckle.
    const switches = (data: Uint8Array) => {
      let n = 0;
      for (let i = 1; i < data.length; i++) if (data[i] !== data[i - 1]) n++;
      return n;
    };
    expect(switches(dithered)).toBeGreaterThan(switches(flat) * 2);
  });

  it('keeps the average brightness while dithering', () => {
    // Error diffusion moves error around; it must not lose it.
    const rgba = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < 64 * 64; i++) rgba.set([128, 128, 128, 255], i * 4);
    const dithered = quantise(rgba, 64, 64, matcher, { dither: true });
    const white = dithered.reduce((n, i) => n + (i === 1 ? 1 : 0), 0);
    expect(white / dithered.length).toBeGreaterThan(0.35);
    expect(white / dithered.length).toBeLessThan(0.65);
  });

  it('leaves kept pixels transparent instead of colouring them', () => {
    const rgba = new Uint8Array(4 * 4).fill(255);
    const keep = new Uint8Array([0, 1, 0, 1]);
    const out = quantise(rgba, 4, 1, matcher, { dither: false, transparentIndex: 5, keep });
    expect(Array.from(out)).toEqual([1, 5, 1, 5]);
  });
});

describe('changedRect', () => {
  const frame = (fill: number, changes: [number, number][] = []) => {
    const data = new Uint8Array(8 * 8 * 4).fill(fill);
    for (const [x, y] of changes) data.set([9, 9, 9, 255], (y * 8 + x) * 4);
    return data;
  };

  it('is nothing when the frames match', () => {
    expect(changedRect(frame(100), frame(100), 8, 8)).toBeNull();
  });

  it('bounds exactly the pixels that moved', () => {
    const rect = changedRect(frame(100), frame(100, [[2, 3], [5, 6]]), 8, 8);
    expect(rect).toEqual({ x: 2, y: 3, width: 4, height: 4 });
  });

  it('finds a single changed pixel', () => {
    expect(changedRect(frame(100), frame(100, [[7, 7]]), 8, 8)).toEqual({ x: 7, y: 7, width: 1, height: 1 });
  });

  it('ignores a change in the alpha channel alone', () => {
    // Only colour matters; the encoder makes its own transparency decisions.
    const a = new Uint8Array(8 * 8 * 4).fill(100);
    const b = a.slice();
    b[3] = 0;
    expect(changedRect(a, b, 8, 8)).toBeNull();
  });
});

describe('codeSizeFor', () => {
  it('never goes below the format’s floor of two', () => {
    expect(codeSizeFor(1)).toBe(2);
    expect(codeSizeFor(2)).toBe(2);
  });

  it('takes the next power of two up', () => {
    expect(codeSizeFor(5)).toBe(3);
    expect(codeSizeFor(8)).toBe(3);
    expect(codeSizeFor(9)).toBe(4);
    expect(codeSizeFor(256)).toBe(8);
  });
});

describe('buildGif', () => {
  const palette = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const indices = new Uint8Array(16).fill(1);
  const one = { indices, width: 4, height: 4, x: 0, y: 0, delayMs: 100 };

  it('writes a file a decoder would recognise', () => {
    const gif = buildGif([one], palette, 4, 4);
    expect(new TextDecoder().decode(gif.subarray(0, 6))).toBe('GIF89a');
    expect(gif[gif.length - 1]).toBe(0x3b); // trailer
  });

  it('records the canvas size in the screen descriptor', () => {
    const gif = buildGif([one], palette, 320, 240);
    expect(gif[6]! | (gif[7]! << 8)).toBe(320);
    expect(gif[8]! | (gif[9]! << 8)).toBe(240);
  });

  it('pads the colour table to the power of two the format demands', () => {
    // Four colours means a two-bit code size and a four-entry table; a table of
    // three would make every decoder read the following bytes as colour.
    const gif = buildGif([one], palette, 4, 4);
    const codeSize = (gif[10]! & 0x07) + 1;
    expect(codeSize).toBe(2);
    // Header is 13 bytes, then the table, then the extension block.
    expect(gif[13 + (1 << codeSize) * 3]).toBe(0x21);
  });

  it('asks to loop forever', () => {
    const gif = buildGif([one], palette, 4, 4);
    expect(new TextDecoder().decode(gif).includes('NETSCAPE2.0')).toBe(true);
  });

  it('writes one image block per frame', () => {
    const two = buildGif([one, { ...one, delayMs: 50 }], palette, 4, 4);
    const separators = Array.from(two).filter((b, i) => b === 0x2c && two[i - 1] === 0x00).length;
    expect(separators).toBeGreaterThanOrEqual(2);
  });

  it('round-trips the pixels of a frame through the decoder', () => {
    // End to end: what comes out of buildGif still decodes to what went in.
    const pixels = new Uint8Array(64);
    for (let i = 0; i < 64; i++) pixels[i] = i % 4;
    const gif = buildGif([{ indices: pixels, width: 8, height: 8, x: 0, y: 0, delayMs: 100 }], palette, 8, 8);
    const at = gif.indexOf(0x2c, 13);
    const codeSize = gif[at + 10]!;
    expect(Array.from(lzwDecode(gif.subarray(at + 11), codeSize))).toEqual(Array.from(pixels));
  });

  it('never writes a delay the format rounds to zero', () => {
    // A delay of 0 or 1 hundredths makes most viewers run the GIF at whatever
    // speed they feel like, which is not what anyone asked for.
    const gif = buildGif([{ ...one, delayMs: 4 }], palette, 4, 4);
    const at = gif.indexOf(0xf9);
    expect(gif[at + 3]! | (gif[at + 4]! << 8)).toBeGreaterThanOrEqual(2);
  });
});

describe('planGif', () => {
  it('scales to the requested width, keeping the shape', () => {
    const plan = planGif(5, 1920, 1080, 480, 10);
    expect(plan.width).toBe(480);
    expect(plan.height).toBe(270);
    expect(plan.frames).toBe(50);
  });

  it('never scales up', () => {
    expect(planGif(5, 320, 240, 800, 10).width).toBe(320);
  });

  it('warns that a long high-resolution GIF is a bad idea', () => {
    // Half a minute of 720p is hundreds of megabytes, and finding that out
    // after five minutes of encoding is not acceptable.
    expect(planGif(30, 1920, 1080, 1280, 20).warning).toBeTruthy();
  });

  it('says nothing about a small one', () => {
    expect(planGif(3, 640, 480, 320, 10).warning).toBeUndefined();
  });

  it('predicts a bigger file for more frames and more pixels', () => {
    const small = planGif(2, 1920, 1080, 320, 10).bytes;
    expect(planGif(4, 1920, 1080, 320, 10).bytes).toBeGreaterThan(small);
    expect(planGif(2, 1920, 1080, 640, 10).bytes).toBeGreaterThan(small);
  });

  it('keeps the frame rate inside what the format can express', () => {
    expect(planGif(2, 640, 480, 320, 500).fps).toBeLessThanOrEqual(50);
    expect(planGif(2, 640, 480, 320, 0).fps).toBeGreaterThanOrEqual(1);
  });

  it('offers only rates the format handles sensibly', () => {
    for (const rate of GIF_RATES) expect(100 % rate === 0 || rate <= 20).toBe(true);
  });
});

describe('estimateGifBytes', () => {
  it('makes dithering cost more, because it defeats the compressor', () => {
    expect(estimateGifBytes(320, 240, 30, true)).toBeGreaterThan(estimateGifBytes(320, 240, 30, false));
  });

  it('grows with frames but not quite linearly', () => {
    // Later frames carry only what moved.
    const one = estimateGifBytes(320, 240, 1);
    const ten = estimateGifBytes(320, 240, 10);
    expect(ten).toBeGreaterThan(one * 5);
    expect(ten).toBeLessThan(one * 10);
  });
});

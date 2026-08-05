/**
 * A GIF encoder, written out because there is nowhere to fetch one from.
 *
 * The site's policy is `script-src 'self'` — no CDN, ever — so the usual answer
 * of dropping in gif.js is not available, and neither is ffmpeg.wasm. What
 * follows is the whole format: a colour quantiser, a ditherer, an LZW
 * compressor and the file structure itself. It is DOM-free so it can be tested,
 * and the page feeds it frames pulled out of a video.
 *
 * GIF is a 1987 format and it shows, in three ways that decide the quality of
 * everything that comes out of it:
 *
 *   **256 colours, total.** A frame of video has tens of thousands. Choosing
 *   which 256 is the single biggest lever on how the result looks, and the
 *   naive answer — round every channel to a fixed grid — is why so many GIFs
 *   look like they were made in 1997. Median cut instead splits the colours
 *   the picture actually contains, so a sunset spends its palette on oranges.
 *
 *   **No half-tones.** Snapping each pixel to the nearest of 256 colours turns
 *   a smooth gradient into bands. Floyd–Steinberg dithering pushes each pixel's
 *   rounding error into its neighbours, trading a fine speckle for the banding,
 *   which the eye much prefers.
 *
 *   **LZW compression, patented until 2003.** Variable-width codes, a
 *   dictionary that resets when it fills, and bits packed low-order first. It
 *   is not hard, but it is unforgiving: one bit out of place and the whole
 *   image after that point is noise.
 *
 * And one thing the format does give you: a frame may cover part of the canvas
 * and leave the rest showing through. Encoding only what moved, and marking
 * everything that did not as transparent, is where most of the size saving in a
 * good GIF comes from.
 */

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** Palette entries are RGB triples packed end to end. */
export type Palette = Uint8Array;

export const MAX_COLORS = 256;

interface Box {
  /** Indices into the sample array. */
  from: number;
  to: number;
  /** Channel extents, so a split can pick the widest. */
  min: [number, number, number];
  max: [number, number, number];
}

function boxOf(samples: Uint8Array, from: number, to: number): Box {
  const min: [number, number, number] = [255, 255, 255];
  const max: [number, number, number] = [0, 0, 0];
  for (let i = from; i < to; i++) {
    for (let c = 0; c < 3; c++) {
      const v = samples[i * 3 + c]!;
      if (v < min[c]!) min[c] = v;
      if (v > max[c]!) max[c] = v;
    }
  }
  return { from, to, min, max };
}

/** The channel this box varies most in, weighted for how the eye sees them. */
function widestChannel(box: Box): number {
  // Green carries most of perceived brightness, blue least; splitting on raw
  // extents alone spends the palette on blue noise nobody can see.
  const weights = [0.9, 1.2, 0.7];
  let best = 0;
  let bestSpan = -1;
  for (let c = 0; c < 3; c++) {
    const span = (box.max[c]! - box.min[c]!) * weights[c]!;
    if (span > bestSpan) {
      bestSpan = span;
      best = c;
    }
  }
  return best;
}

/**
 * Choose a palette by repeatedly splitting the box of colours in half.
 *
 * Median cut: start with every colour in one box, and each round take the box
 * with the widest spread, sort it on that channel and split it at the median.
 * Colours that are crowded together get boxes to themselves, so the palette
 * follows the picture instead of a fixed grid. The average of each final box
 * becomes an entry.
 *
 * `samples` is RGB triples — the caller decides how much of the image to feed
 * in, because quantising ten million pixels to pick 256 colours is wasted work.
 */
export function medianCut(samples: Uint8Array, maxColors = MAX_COLORS): Palette {
  const count = Math.floor(samples.length / 3);
  if (count === 0) return new Uint8Array([0, 0, 0]);

  const working = samples.slice();
  let boxes: Box[] = [boxOf(working, 0, count)];

  while (boxes.length < maxColors) {
    // The box worth splitting is the one whose colours are furthest apart, not
    // the one with the most pixels: a large flat sky needs one entry.
    let target = -1;
    let bestSpan = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      if (box.to - box.from < 2) continue;
      const channel = widestChannel(box);
      const span = box.max[channel]! - box.min[channel]!;
      if (span > bestSpan) {
        bestSpan = span;
        target = i;
      }
    }
    if (target < 0) break; // every box is a single colour

    const box = boxes[target]!;
    const channel = widestChannel(box);
    sortRange(working, box.from, box.to, channel);
    const mid = box.from + ((box.to - box.from) >> 1);
    boxes = [
      ...boxes.slice(0, target),
      boxOf(working, box.from, mid),
      boxOf(working, mid, box.to),
      ...boxes.slice(target + 1),
    ];
  }

  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, i) => {
    const n = box.to - box.from;
    for (let c = 0; c < 3; c++) {
      let total = 0;
      for (let p = box.from; p < box.to; p++) total += working[p * 3 + c]!;
      palette[i * 3 + c] = n ? Math.round(total / n) : 0;
    }
  });
  return palette;
}

/** Sort a range of RGB triples in place on one channel. */
function sortRange(data: Uint8Array, from: number, to: number, channel: number): void {
  const n = to - from;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = from + i;
  const sorted = Array.from(order).sort((a, b) => data[a * 3 + channel]! - data[b * 3 + channel]!);
  const copy = new Uint8Array(n * 3);
  sorted.forEach((src, i) => {
    copy[i * 3] = data[src * 3]!;
    copy[i * 3 + 1] = data[src * 3 + 1]!;
    copy[i * 3 + 2] = data[src * 3 + 2]!;
  });
  data.set(copy, from * 3);
}

/**
 * Take every nth pixel, as RGB, ignoring the transparent ones.
 *
 * A palette built from a hundred thousand pixels is indistinguishable from one
 * built from ten million, and it is a hundred times faster.
 */
export function samplePixels(rgba: Uint8ClampedArray | Uint8Array, limit = 60000): Uint8Array {
  const pixels = Math.floor(rgba.length / 4);
  const step = Math.max(1, Math.floor(pixels / limit));
  const out = new Uint8Array(Math.ceil(pixels / step) * 3);
  let n = 0;
  for (let p = 0; p < pixels; p += step) {
    if (rgba[p * 4 + 3]! < 128) continue; // transparent pixels have no colour
    out[n * 3] = rgba[p * 4]!;
    out[n * 3 + 1] = rgba[p * 4 + 1]!;
    out[n * 3 + 2] = rgba[p * 4 + 2]!;
    n++;
  }
  return out.subarray(0, n * 3);
}

/**
 * Nearest palette entry, with a cache.
 *
 * An exact search is 256 comparisons per pixel, which at a million pixels a
 * frame is the slowest thing in the encoder by a wide margin. Colours repeat
 * enormously in real images, so results are cached against the top five bits of
 * each channel — 32768 buckets, one small typed array, and the search runs
 * perhaps a few thousand times instead of a million.
 */
export class PaletteMatcher {
  private readonly cache = new Int16Array(32768).fill(-1);

  constructor(private readonly palette: Palette) {}

  get size(): number {
    return Math.floor(this.palette.length / 3);
  }

  /** The colour at an index, which the ditherer needs to measure its error. */
  entry(index: number): [number, number, number] {
    return [this.palette[index * 3] ?? 0, this.palette[index * 3 + 1] ?? 0, this.palette[index * 3 + 2] ?? 0];
  }

  nearest(r: number, g: number, b: number): number {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const cached = this.cache[key]!;
    if (cached >= 0) return cached;

    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < this.palette.length; i += 3) {
      // Weighted so the distance means something to a person looking at it.
      const dr = (r - this.palette[i]!) * 0.9;
      const dg = (g - this.palette[i + 1]!) * 1.2;
      const db = (b - this.palette[i + 2]!) * 0.7;
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i / 3;
        if (distance === 0) break;
      }
    }
    this.cache[key] = best;
    return best;
  }
}

// ---------------------------------------------------------------------------
// Quantising and dithering
// ---------------------------------------------------------------------------

export interface QuantiseOptions {
  /** Spread each pixel's rounding error into its neighbours. */
  dither?: boolean;
  /**
   * An index to use for pixels that should show the previous frame through.
   * Everything at or above `transparent` in the palette is left alone.
   */
  transparentIndex?: number;
  /** Pixels to leave transparent, as a mask the same length as the pixel count. */
  keep?: Uint8Array;
}

/**
 * Turn a frame of RGBA into palette indices.
 *
 * With dithering this is Floyd–Steinberg: the difference between a pixel's
 * true colour and the palette entry it had to settle for is carried into the
 * pixels right, below-left, below and below-right of it, in the proportions
 * 7/16, 3/16, 5/16, 1/16. The error travels, so a gradient that would have
 * banded becomes a fine speckle that averages out to the right colour.
 */
export function quantise(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  matcher: PaletteMatcher,
  options: QuantiseOptions = {},
): Uint8Array {
  const pixels = width * height;
  const indices = new Uint8Array(pixels);
  const { dither = true, transparentIndex, keep } = options;

  // Errors are carried in a float buffer; doing it in the source array would
  // clamp them to 0-255 and lose the sign.
  const errors = dither ? new Float32Array(pixels * 3) : null;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (keep && keep[p] && transparentIndex !== undefined) {
        indices[p] = transparentIndex;
        continue;
      }

      let r = rgba[p * 4]!;
      let g = rgba[p * 4 + 1]!;
      let b = rgba[p * 4 + 2]!;
      if (errors) {
        r = clamp255(r + errors[p * 3]!);
        g = clamp255(g + errors[p * 3 + 1]!);
        b = clamp255(b + errors[p * 3 + 2]!);
      }

      const index = matcher.nearest(r, g, b);
      indices[p] = index;
      if (errors) spread(errors, matcher, index, r, g, b, x, y, width, height);
    }
  }
  return indices;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Carry one pixel's rounding error into the neighbours that come after it. */
function spread(
  errors: Float32Array,
  matcher: PaletteMatcher,
  index: number,
  r: number,
  g: number,
  b: number,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const chosen = matcher.entry(index);
  const errR = r - chosen[0];
  const errG = g - chosen[1];
  const errB = b - chosen[2];

  const push = (nx: number, ny: number, weight: number) => {
    if (nx < 0 || nx >= width || ny >= height) return;
    const n = (ny * width + nx) * 3;
    errors[n]! += errR * weight;
    errors[n + 1]! += errG * weight;
    errors[n + 2]! += errB * weight;
  };

  push(x + 1, y, 7 / 16);
  push(x - 1, y + 1, 3 / 16);
  push(x, y + 1, 5 / 16);
  push(x + 1, y + 1, 1 / 16);
}

// ---------------------------------------------------------------------------
// LZW
// ---------------------------------------------------------------------------

/**
 * GIF's LZW, which is the part that has to be exactly right.
 *
 * The dictionary starts as the palette itself plus two control codes, and grows
 * by one entry for every new sequence seen. Codes are written at the smallest
 * width that fits the dictionary so far, growing from `minCodeSize + 1` bits up
 * to twelve; at twelve the dictionary is full and a clear code resets both the
 * table and the width. Bits are packed low-order first, which is the opposite
 * of most binary formats and the usual place to get it wrong.
 *
 * The output is then cut into sub-blocks of at most 255 bytes, each preceded by
 * its length, terminated by a zero — GIF has no other way to say how long the
 * image data is.
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  const out: number[] = [];
  let current = 0; // bit accumulator
  let bits = 0;

  const emit = (code: number, width: number) => {
    current |= code << bits;
    bits += width;
    while (bits >= 8) {
      out.push(current & 0xff);
      current >>= 8;
      bits -= 8;
    }
  };

  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let table = new Map<number, number>();

  emit(clearCode, codeSize);

  if (indices.length) {
    let prefix = indices[0]!;
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i]!;
      const key = (prefix << 12) | k;
      const found = table.get(key);
      if (found !== undefined) {
        prefix = found;
        continue;
      }
      emit(prefix, codeSize);
      if (nextCode < 4096) {
        table.set(key, nextCode++);
        // The width grows the moment the dictionary outgrows it, and the
        // decoder grows at exactly the same instant.
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        emit(clearCode, codeSize);
        table = new Map();
        codeSize = minCodeSize + 1;
        nextCode = endCode + 1;
      }
      prefix = k;
    }
    emit(prefix, codeSize);
  }

  emit(endCode, codeSize);
  if (bits > 0) out.push(current & 0xff);

  // Sub-blocks: a length byte, up to 255 bytes, repeated, then a zero.
  const blocked: number[] = [];
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    blocked.push(chunk.length, ...chunk);
  }
  blocked.push(0);
  return new Uint8Array(blocked);
}

// ---------------------------------------------------------------------------
// Frames and the file
// ---------------------------------------------------------------------------

export interface GifFrame {
  /** Palette indices, `width * height` of them. */
  indices: Uint8Array;
  width: number;
  height: number;
  /** Where this frame sits on the canvas. */
  x: number;
  y: number;
  /** How long it stays up, in milliseconds. */
  delayMs: number;
  /** The index that means "show what was underneath". */
  transparentIndex?: number;
}

/** The rectangle in which two frames differ, or null when they do not. */
export function changedRect(
  previous: Uint8ClampedArray | Uint8Array,
  next: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (previous[p] !== next[p] || previous[p + 1] !== next[p + 1] || previous[p + 2] !== next[p + 2]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** How many bits a palette of this size needs. GIF's floor is two. */
export function codeSizeFor(colors: number): number {
  let bits = 2;
  while (1 << bits < colors) bits++;
  return Math.min(8, bits);
}

/** A palette padded up to the power of two the format insists on. */
function paddedPalette(palette: Palette, codeSize: number): Uint8Array {
  const entries = 1 << codeSize;
  const out = new Uint8Array(entries * 3);
  out.set(palette.subarray(0, Math.min(palette.length, out.length)));
  return out;
}

export interface GifOptions {
  /** 0 loops forever, which is what a GIF is for. */
  loops?: number;
}

/**
 * Assemble the frames into a GIF file.
 *
 * Structure, in order: the signature, a screen descriptor, the global colour
 * table, the Netscape extension that carries the loop count (an extension,
 * because looping was never in the specification), then each frame as a control
 * block plus an image, and a trailer byte.
 */
export function buildGif(
  frames: GifFrame[],
  palette: Palette,
  width: number,
  height: number,
  options: GifOptions = {},
): Uint8Array {
  const colors = Math.floor(palette.length / 3);
  const codeSize = codeSizeFor(colors);
  const table = paddedPalette(palette, codeSize);
  const parts: Uint8Array[] = [];
  const push = (...bytes: number[]) => parts.push(new Uint8Array(bytes));
  const short = (v: number) => [v & 0xff, (v >> 8) & 0xff];

  push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // GIF89a

  // Logical screen: size, then a packed byte saying a global table follows and
  // how big it is.
  push(...short(width), ...short(height), 0x80 | (codeSize - 1), 0, 0);
  parts.push(table);

  // Netscape 2.0 application extension: the only way to say "loop".
  const loops = options.loops ?? 0;
  push(0x21, 0xff, 0x0b);
  parts.push(new TextEncoder().encode('NETSCAPE2.0'));
  push(0x03, 0x01, ...short(loops), 0x00);

  for (const frame of frames) {
    // Delays are in hundredths of a second, which is the format's real frame
    // rate limit: anything faster than 100 fps cannot be expressed, and most
    // viewers treat a delay of 0 or 1 as "as fast as you like".
    const delay = Math.max(2, Math.round(frame.delayMs / 10));
    const transparent = frame.transparentIndex !== undefined;
    // Disposal 1 means "leave it there", which is what makes an unchanged
    // region showing through the transparent pixels work.
    push(0x21, 0xf9, 0x04, (1 << 2) | (transparent ? 1 : 0), ...short(delay), transparent ? frame.transparentIndex! : 0, 0x00);

    push(0x2c, ...short(frame.x), ...short(frame.y), ...short(frame.width), ...short(frame.height), 0x00);
    push(codeSize);
    parts.push(lzwEncode(frame.indices, codeSize));
  }

  push(0x3b); // trailer

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Choosing the settings
// ---------------------------------------------------------------------------

/**
 * How big a GIF of these dimensions is likely to be.
 *
 * Rough, and labelled as such wherever shown, but the order of magnitude is the
 * point: people ask for a thirty second 1080p GIF without realising that is a
 * quarter of a gigabyte, and finding out after five minutes of encoding is not
 * acceptable.
 *
 * The constant is bytes per pixel per frame after LZW on real video content —
 * measured, not derived; GIF's compression is weak on photographic images and
 * dithering makes it weaker by design, since the speckle it adds is noise to
 * the compressor.
 */
export const GIF_BYTES_PER_PIXEL = 0.42;

export function estimateGifBytes(width: number, height: number, frames: number, dither = true): number {
  const perFrame = width * height * GIF_BYTES_PER_PIXEL * (dither ? 1 : 0.72);
  // Later frames only carry what moved; across typical footage that is most of
  // the frame, but not all of it.
  return Math.round(perFrame * (1 + (frames - 1) * 0.8) + 800);
}

export interface GifPlan {
  width: number;
  height: number;
  fps: number;
  frames: number;
  bytes: number;
  /** Something worth saying before they wait for it. */
  warning?: string;
}

/** Frame rates worth offering. Above 20 the format's timing granularity bites. */
export const GIF_RATES = [5, 8, 10, 12, 15, 20];

/**
 * Work out what a GIF of this clip would come to, and say if it is a bad idea.
 *
 * GIF has no motion compensation and no lossy colour: it is a stack of
 * separately compressed still images. That makes it roughly twenty times the
 * size of the same clip as video, which is why the honest advice for anything
 * long is "do not".
 */
export function planGif(
  clipSeconds: number,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  fps: number,
  dither = true,
): GifPlan {
  const safeFps = Math.max(1, Math.min(50, fps));
  const frames = Math.max(1, Math.round(clipSeconds * safeFps));
  const scale = sourceWidth > 0 ? Math.min(1, targetWidth / sourceWidth) : 1;
  const width = Math.max(2, Math.round(sourceWidth * scale));
  const height = Math.max(2, Math.round(sourceHeight * scale));
  const bytes = estimateGifBytes(width, height, frames, dither);

  let warning: string | undefined;
  if (bytes > 50 * 1024 * 1024) {
    warning = 'That is enormous. GIF stores every frame as a separate image, so it cannot compress motion. Shorten the clip, drop the width, or use fewer frames a second.';
  } else if (bytes > 12 * 1024 * 1024) {
    warning = 'Big for a GIF. Most places that accept GIFs refuse anything over a few megabytes.';
  } else if (clipSeconds > 30) {
    warning = 'A GIF this long is a video with extra steps. Consider trimming it.';
  }

  return { width, height, fps: safeFps, frames, bytes, ...(warning ? { warning } : {}) };
}

const globalScope = globalThis as unknown as { LOC1999_GIF?: Record<string, unknown> };
globalScope.LOC1999_GIF = {
  medianCut,
  samplePixels,
  PaletteMatcher,
  quantise,
  changedRect,
  lzwEncode,
  buildGif,
  planGif,
  estimateGifBytes,
  codeSizeFor,
  GIF_RATES,
  MAX_COLORS,
};

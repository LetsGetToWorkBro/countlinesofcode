/**
 * The fountain code underneath BC-UR.
 *
 * A long payload is cut into N fragments. The first N frames of the animation
 * carry one fragment each; every frame after that carries the XOR of a random
 * handful of them. A receiver that missed frame 5 can recover it from a later
 * mixed frame instead of waiting for the animation to be restarted, which is
 * the difference between "point the camera at it" and "point the camera at it,
 * notice it never finishes, and start over".
 *
 * The catch is that the sender never says which fragments went into a mixed
 * frame. Both sides derive it from the frame number, the fragment count and
 * the payload checksum, by seeding a PRNG with them and drawing. So this file
 * is not an algorithm we get to choose: it has to reproduce, exactly,
 *
 *   - xoshiro256** seeded with sha256(seqNum || checksum), big-endian,
 *   - Vose's alias method over the degree distribution 1, 1/2, 1/3 ... 1/N,
 *     drawing two doubles per sample and in that order,
 *   - a Fisher-Yates-shaped shuffle that draws one integer per remaining item.
 *
 * Any deviation, including one that looks like a tidy-up, produces a different
 * set of indexes for the same frame and therefore a different payload than the
 * sender meant, with every checksum on the outside still intact. The tests
 * check this file's output against the reference implementation rather than
 * against a description of it.
 */

import { sha256 } from './sha256';

const MASK64 = (1n << 64n) - 1n;

function rotl(x: bigint, k: number): bigint {
  const n = BigInt(k);
  return ((x << n) | (x >> (64n - n))) & MASK64;
}

/**
 * xoshiro256**, seeded the way BC-UR seeds it: sha256 of the seed material,
 * read as four big-endian 64-bit words.
 */
export class Xoshiro {
  private s: [bigint, bigint, bigint, bigint];

  constructor(seed: Uint8Array) {
    const digest = sha256(seed);
    const word = (offset: number): bigint => {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(digest[offset + i]!);
      return v;
    };
    this.s = [word(0), word(8), word(16), word(24)];
  }

  private roll(): bigint {
    const result = (rotl((this.s[1] * 5n) & MASK64, 7) * 9n) & MASK64;
    const t = (this.s[1] << 17n) & MASK64;

    this.s[2] ^= this.s[0];
    this.s[3] ^= this.s[1];
    this.s[1] ^= this.s[2];
    this.s[0] ^= this.s[3];
    this.s[2] ^= t;
    this.s[3] = rotl(this.s[3], 45);

    return result;
  }

  /**
   * A double in [0, 1).
   *
   * The reference divides the 64-bit draw by 2^64 in arbitrary precision and
   * then lets JavaScript coerce the result to a double. Converting first and
   * dividing after gives the identical double, because scaling by a power of
   * two is exact, so this is the same number by a shorter route.
   */
  nextDouble(): number {
    return Number(this.roll()) / 18446744073709551616;
  }

  nextInt(low: number, high: number): number {
    return Math.floor(this.nextDouble() * (high - low + 1) + low);
  }
}

// ---------------------------------------------------------------------------
// Vose's alias method, in the exact shape BC-UR's sampler builds it.
//
// The tables depend on the order the small and large buckets are filled and
// drained, so the loops below are transcribed from the reference rather than
// written from the textbook: the textbook version samples the same
// distribution and would still pick a different bucket for the same draw.

interface AliasTable {
  prob: number[];
  alias: number[];
}

function buildAlias(probabilities: number[]): AliasTable {
  const n = probabilities.length;
  const sum = probabilities.reduce((acc, value) => acc + value, 0);
  const scaled = probabilities.map((p) => (p * n) / sum);
  const prob = new Array<number>(n);
  const alias = new Array<number>(n);
  const small: number[] = [];
  const large: number[] = [];

  // Descending, which is what puts a particular index on top of each stack.
  for (let i = n - 1; i >= 0; i--) (scaled[i]! < 1 ? small : large).push(i);

  while (small.length > 0 && large.length > 0) {
    const less = small.pop()!;
    const more = large.pop()!;
    prob[less] = scaled[less]!;
    alias[less] = more;
    scaled[more] = scaled[more]! + scaled[less]! - 1;
    (scaled[more]! < 1 ? small : large).push(more);
  }
  while (large.length > 0) prob[large.pop()!] = 1;
  while (small.length > 0) prob[small.pop()!] = 1;

  return { prob, alias };
}

/**
 * How many fragments go into one mixed frame.
 *
 * Degree 1 is as likely as all the rest put together, which is what makes the
 * stream self-repairing: most frames are a plain fragment, and the mixed ones
 * fill the gaps.
 */
export function chooseDegree(seqLength: number, rng: Xoshiro): number {
  const probabilities: number[] = [];
  for (let i = 0; i < seqLength; i++) probabilities.push(1 / (i + 1));
  const table = buildAlias(probabilities);
  // Two draws, in this order. Swapping them samples the same distribution and
  // returns a different answer for the same seed, which is the whole risk.
  const bucket = Math.floor(rng.nextDouble() * table.prob.length);
  return (rng.nextDouble() < table.prob[bucket]! ? bucket : table.alias[bucket]!) + 1;
}

export function shuffle<T>(items: T[], rng: Xoshiro): T[] {
  const remaining = [...items];
  const result: T[] = [];
  while (remaining.length > 0) {
    const index = rng.nextInt(0, remaining.length - 1);
    result.push(remaining[index]!);
    remaining.splice(index, 1);
  }
  return result;
}

function uint32BE(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

/**
 * Which fragments frame `seqNum` is made of.
 *
 * The first `seqLength` frames are single fragments, in order. That is what
 * lets a receiver that catches a clean first pass decode without ever touching
 * the code above.
 */
export function chooseFragments(seqNum: number, seqLength: number, checksum: number): number[] {
  if (seqNum <= seqLength) return [seqNum - 1];

  const seed = new Uint8Array(8);
  seed.set(uint32BE(seqNum), 0);
  seed.set(uint32BE(checksum), 4);

  const rng = new Xoshiro(seed);
  const degree = chooseDegree(seqLength, rng);
  const indexes: number[] = [];
  for (let i = 0; i < seqLength; i++) indexes.push(i);
  return shuffle(indexes, rng).slice(0, degree);
}

/** XOR of two fragments of the same length, which is how frames are mixed. */
export function xorInto(target: Uint8Array, other: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.max(target.length, other.length));
  for (let i = 0; i < out.length; i++) out[i] = (target[i] ?? 0) ^ (other[i] ?? 0);
  return out;
}

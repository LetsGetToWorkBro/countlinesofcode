/**
 * BC-UR: the QR format the rest of the world already speaks.
 *
 * envelope.ts is our own wire, and it only ever has to talk to our own
 * companion app. This file is the other half of the bargain: Sparrow,
 * Electrum, Keystone, Passport, Foundation and Cupcake all animate
 * Blockchain Commons Uniform Resources at each other, and a signing device
 * that cannot read them is a device you can only use with software we wrote.
 * That is worth much less than one you can point at the wallet you already
 * have.
 *
 * A single-frame message looks like
 *
 *     ur:crypto-psbt/hdonjojkidjyzmadaekpaoaeaeaeaddslyjsemck...
 *
 * and a long one is animated as
 *
 *     ur:crypto-psbt/1-3/lpadaxcsoscyjnbdzevdhdethdonjojkidjy...
 *     ur:crypto-psbt/2-3/lpaoaxcsoscyjnbdzevdhdetaoteurykahae...
 *
 * where the body is bytewords (bytewords.ts) around CBOR (cbor.ts), and the
 * frames after the first pass are XOR mixtures chosen by a shared PRNG
 * (fountain.ts). Those three files are transcriptions of somebody else's
 * decisions; this one is the assembly.
 *
 * The same rule as everywhere else in this project applies at the end of it:
 * a payload that reassembles is not a payload that is safe to sign. It is
 * bytes that survived a camera. What makes them safe to sign is a person
 * reading the confirmation screen.
 */

import { bytewordsDecode, bytewordsEncode } from './bytewords';
import { cborDecode, cborEncode } from './cbor';
import { crc32 } from './envelope';
import { chooseFragments, xorInto } from './fountain';

/** The registry type for an unsigned or partially signed Bitcoin transaction. */
export const UR_PSBT = 'crypto-psbt';
/** Undifferentiated bytes, which is what a wallet uses when nothing fits. */
export const UR_BYTES = 'bytes';

/**
 * Payload ceilings.
 *
 * A frame states how long the whole message is before any of it has arrived,
 * so a hostile or garbled one can ask for an allocation before it has proved
 * anything. These are far above a real Monero transaction set and far below
 * anything that hurts.
 */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_FRAGMENTS = 5000;

/** UR type names are lower-case letters, digits and hyphens, and nothing else. */
function isUrType(type: string): boolean {
  return /^[a-z0-9-]+$/.test(type);
}

// ---------------------------------------------------------------------------
// Fragmenting

/**
 * The fragment size BC-UR would pick for this message.
 *
 * Not simply `ceil(length / count)` for the first count that fits: it walks
 * the counts upward so that every fragment is the same size, which is what
 * lets the receiver XOR them without knowing which is the last.
 */
export function nominalFragmentLength(
  messageLength: number,
  maxFragmentLength: number,
  minFragmentLength = 10,
): number {
  const maxCount = Math.ceil(messageLength / minFragmentLength);
  let fragmentLength = messageLength;
  for (let count = 1; count <= maxCount; count++) {
    fragmentLength = Math.ceil(messageLength / count);
    if (fragmentLength <= maxFragmentLength) break;
  }
  return Math.max(1, fragmentLength);
}

function partition(message: Uint8Array, fragmentLength: number): Uint8Array[] {
  const fragments: Uint8Array[] = [];
  for (let at = 0; at < message.length; at += fragmentLength) {
    // Padded with zeroes, so every fragment is the same length and the XOR of
    // any two of them is meaningful. The message length in the header says
    // where the padding starts.
    const fragment = new Uint8Array(fragmentLength);
    fragment.set(message.subarray(at, at + fragmentLength), 0);
    fragments.push(fragment);
  }
  return fragments.length ? fragments : [new Uint8Array(fragmentLength)];
}

/**
 * Produces the frames of an animated UR, one call at a time.
 *
 * The first `seqLength` frames are the fragments in order; after that it keeps
 * going forever with mixtures, so a viewer who missed one does not have to ask
 * for the animation to be restarted. There is no way to ask.
 */
export class UrEncoder {
  readonly type: string;
  readonly seqLength: number;
  private fragments: Uint8Array[];
  private messageLength: number;
  private checksum: number;
  private seqNum = 0;

  /**
   * @param cbor The CBOR-encoded payload. For a PSBT that is
   *   `cborEncode(psbtBytes)`, not the PSBT itself: the CBOR wrapper is part
   *   of what `ur:crypto-psbt` means, and leaving it off produces frames that
   *   look right and that Sparrow will not read.
   */
  constructor(type: string, cbor: Uint8Array, maxFragmentLength = 200) {
    if (!isUrType(type)) throw new Error(`not a UR type: ${type}`);
    this.type = type;
    this.messageLength = cbor.length;
    this.checksum = crc32(cbor);
    this.fragments = partition(cbor, nominalFragmentLength(cbor.length, maxFragmentLength));
    this.seqLength = this.fragments.length;
  }

  /** Every frame of a message that fits in one, or the next of an animation. */
  nextPart(): string {
    this.seqNum = (this.seqNum + 1) >>> 0;

    if (this.seqLength === 1) {
      // A message small enough for one code is written without a sequence, so
      // a receiver knows from the shape that there is nothing to wait for.
      return `ur:${this.type}/${bytewordsEncode(this.fragments[0]!.subarray(0, this.messageLength))}`;
    }

    const indexes = chooseFragments(this.seqNum, this.seqLength, this.checksum);
    let mixed: Uint8Array = new Uint8Array(this.fragments[0]!.length);
    for (const index of indexes) mixed = xorInto(mixed, this.fragments[index]!);

    const body = cborEncode([this.seqNum, this.seqLength, this.messageLength, this.checksum, mixed]);
    return `ur:${this.type}/${this.seqNum}-${this.seqLength}/${bytewordsEncode(body)}`;
  }

  /** The frames of one clean pass, which is all a patient receiver needs. */
  firstPass(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.seqLength; i++) out.push(this.nextPart());
    return out;
  }
}

/** Wrap raw bytes as CBOR and animate them. The usual entry point. */
export function encodeUr(type: string, payload: Uint8Array, maxFragmentLength = 200): UrEncoder {
  return new UrEncoder(type, cborEncode(payload), maxFragmentLength);
}

// ---------------------------------------------------------------------------
// Reading one frame

export interface UrPart {
  type: string;
  /** Absent for a message that fits in a single frame. */
  seqNum?: number;
  seqLength?: number;
  messageLength?: number;
  checksum?: number;
  fragment?: Uint8Array;
  /** For a single-frame message, the whole CBOR payload. */
  cbor?: Uint8Array;
}

/**
 * Read one `ur:` string, or null if it is not one.
 *
 * Null rather than throwing, for the same reason as envelope.ts: a camera
 * pointed at the world sees wifi codes and cereal boxes, and every one of them
 * arrives here.
 */
export function parseUr(text: string): UrPart | null {
  const raw = String(text ?? '').trim().toLowerCase();
  if (!raw.startsWith('ur:')) return null;

  const components = raw.slice(3).split('/');
  const type = components[0] ?? '';
  if (!isUrType(type) || components.length < 2 || components.length > 3) return null;

  if (components.length === 2) {
    const cbor = bytewordsDecode(components[1]!, 'minimal');
    if (cbor === null) return null;
    return { type, cbor };
  }

  const seq = /^(\d+)-(\d+)$/.exec(components[1]!);
  if (!seq) return null;
  const seqNum = Number(seq[1]);
  const seqLength = Number(seq[2]);
  if (!(seqNum >= 1 && seqLength >= 1 && seqLength <= MAX_FRAGMENTS)) return null;

  const body = bytewordsDecode(components[2]!, 'minimal');
  if (body === null) return null;
  const decoded = cborDecode(body);
  if (!Array.isArray(decoded) || decoded.length !== 5) return null;

  const [num, len, messageLength, checksum, fragment] = decoded;
  if (typeof num !== 'number' || typeof len !== 'number') return null;
  if (typeof messageLength !== 'number' || typeof checksum !== 'number') return null;
  if (!(fragment instanceof Uint8Array) || fragment.length === 0) return null;

  // The header outside the body and the header inside it have to agree. If
  // they do not, one of the two was misread and neither can be trusted.
  if (num !== seqNum || len !== seqLength) return null;
  if (!(messageLength > 0 && messageLength <= MAX_MESSAGE_BYTES)) return null;
  if (fragment.length * seqLength < messageLength) return null;

  return { type, seqNum, seqLength, messageLength, checksum, fragment };
}

// ---------------------------------------------------------------------------
// Collecting an animation

export interface UrProgress {
  type: string;
  /** Distinct fragments recovered so far, including ones peeled out of mixtures. */
  have: number;
  total: number;
  /** The CBOR payload, once the whole message is in and its checksum agrees. */
  cbor: Uint8Array | null;
  problem?: string;
}

interface Piece {
  indexes: number[];
  fragment: Uint8Array;
}

function isSubset(outer: number[], inner: number[]): boolean {
  return inner.every((value) => outer.includes(value));
}

/**
 * Reads an animated UR off a camera.
 *
 * The interesting part is peeling: a frame mixing fragments {1,4,7} plus a
 * known 1 and a known 7 yields fragment 4, which may in turn unlock another
 * mixture, and so on. That is why frames go through a queue rather than being
 * handled where they arrive.
 */
export class UrCollector {
  private type: string | null = null;
  private seqLength = 0;
  private messageLength = 0;
  private checksum = 0;
  private fragmentLength = 0;
  private simple = new Map<number, Uint8Array>();
  private mixed: Piece[] = [];
  private queue: Piece[] = [];
  private done: Uint8Array | null = null;

  status(): UrProgress {
    return {
      type: this.type ?? '',
      have: this.simple.size,
      total: this.seqLength,
      cbor: this.done,
    };
  }

  reset(): void {
    this.type = null;
    this.seqLength = 0;
    this.messageLength = 0;
    this.checksum = 0;
    this.fragmentLength = 0;
    this.simple.clear();
    this.mixed = [];
    this.queue = [];
    this.done = null;
  }

  offer(text: string): UrProgress {
    const part = parseUr(text);
    if (!part) return { ...this.status(), problem: 'That is not a UR code.' };

    if (part.cbor) {
      // A whole message in one frame. Nothing to assemble and nothing to
      // check: bytewords carried its own checksum and it already passed.
      this.reset();
      this.type = part.type;
      this.seqLength = 1;
      this.done = part.cbor;
      return { type: part.type, have: 1, total: 1, cbor: part.cbor };
    }

    const { seqNum, seqLength, messageLength, checksum, fragment } = part as Required<UrPart>;

    /* A frame from a different message is somebody scanning a second
     * transaction, not a corruption of this one. Start again on the new one
     * rather than rejecting it forever, which is the same choice envelope.ts
     * makes and for the same reason: the alternative is a scanner that
     * silently ignores what the person is pointing it at. */
    const mismatch =
      this.type !== null &&
      (part.type !== this.type ||
        seqLength !== this.seqLength ||
        messageLength !== this.messageLength ||
        checksum !== this.checksum ||
        fragment.length !== this.fragmentLength);
    if (mismatch) this.reset();

    if (this.type === null) {
      this.type = part.type;
      this.seqLength = seqLength;
      this.messageLength = messageLength;
      this.checksum = checksum;
      this.fragmentLength = fragment.length;
    }
    if (this.done) return this.status();

    this.queue.push({ indexes: chooseFragments(seqNum, seqLength, checksum), fragment });
    while (!this.done && this.queue.length > 0) this.step();

    if (this.done === null && this.simple.size === this.seqLength) {
      /* Every fragment arrived and the message failed its own checksum. That
       * is a misread somewhere in a long animation, and the only safe move is
       * to throw the lot away: handing back bytes that failed their checksum
       * means signing a transaction nobody composed. */
      this.reset();
      return {
        type: part.type,
        have: 0,
        total: 0,
        cbor: null,
        problem: 'The codes did not add up to a whole message. Start the scan again.',
      };
    }
    return this.status();
  }

  private step(): void {
    const piece = this.queue.shift()!;
    // A mixture that reduced to nothing carries no information; it happens
    // when two frames turn out to have been built from the same fragments.
    if (piece.indexes.length === 0) return;
    if (piece.indexes.length === 1) this.takeSimple(piece);
    else this.takeMixed(piece);
  }

  private takeSimple(piece: Piece): void {
    const index = piece.indexes[0]!;
    if (this.simple.has(index)) return;
    this.simple.set(index, piece.fragment);

    if (this.simple.size === this.seqLength) {
      const message = new Uint8Array(this.seqLength * this.fragmentLength);
      for (let i = 0; i < this.seqLength; i++) message.set(this.simple.get(i)!, i * this.fragmentLength);
      const trimmed = message.subarray(0, this.messageLength);
      if (crc32(trimmed) === this.checksum) this.done = trimmed.slice();
      return;
    }
    this.reduceMixedBy(piece);
  }

  private takeMixed(piece: Piece): void {
    const key = piece.indexes.slice().sort((a, b) => a - b).join(',');
    if (this.mixed.some((other) => other.indexes.slice().sort((a, b) => a - b).join(',') === key)) {
      return;
    }

    let reduced = piece;
    for (const [index, fragment] of this.simple) {
      reduced = reduce(reduced, { indexes: [index], fragment });
    }
    for (const other of this.mixed) reduced = reduce(reduced, other);

    if (reduced.indexes.length === 0) return;
    if (reduced.indexes.length === 1) {
      this.queue.push(reduced);
      return;
    }
    this.reduceMixedBy(reduced);
    this.mixed.push(reduced);
  }

  /** Feed a newly known piece back through everything still mixed. */
  private reduceMixedBy(piece: Piece): void {
    const remaining: Piece[] = [];
    for (const other of this.mixed) {
      const reduced = reduce(other, piece);
      if (reduced.indexes.length === 1) this.queue.push(reduced);
      else if (reduced.indexes.length > 1) remaining.push(reduced);
    }
    this.mixed = remaining;
  }
}

/** Subtract `b` from `a` when everything in `b` is also in `a`. */
function reduce(a: Piece, b: Piece): Piece {
  if (b.indexes.length === 0 || !isSubset(a.indexes, b.indexes)) return a;
  if (a.indexes.length === b.indexes.length) return { indexes: [], fragment: new Uint8Array(0) };
  return {
    indexes: a.indexes.filter((index) => !b.indexes.includes(index)),
    fragment: xorInto(a.fragment, b.fragment),
  };
}

/**
 * The bytes inside a finished UR, for the types that wrap a byte string.
 *
 * `ur:crypto-psbt` and `ur:bytes` both carry one CBOR byte string and nothing
 * else. Types with a richer structure need their own reader, and get null
 * here rather than a plausible-looking slice of themselves.
 */
export function urPayloadBytes(cbor: Uint8Array): Uint8Array | null {
  const value = cborDecode(cbor);
  return value instanceof Uint8Array ? value : null;
}

/**
 * The wire between the two halves, which is a camera pointed at a screen.
 *
 * Labyrinth Vault is a phone with no network. The only thing that crosses
 * between it and the online half is light: one device draws a QR code, the
 * other reads it. That makes this file the entire attack surface of the
 * airgap, and the reason it is written before any user interface.
 *
 * Four things it has to do, and the fourth is the one that matters.
 *
 *   1. Carry more than fits. A QR code holds a couple of kilobytes at a
 *      density a phone camera reads reliably across a room-lit table. A
 *      Bitcoin PSBT is a few kilobytes and a Monero unsigned transaction set
 *      can be tens, so a payload is cut into parts and played as a sequence.
 *
 *   2. Say what it is. A part names the payload type and the format version,
 *      so a device can refuse a thing it does not understand rather than
 *      guess at it.
 *
 *   3. Arrive out of order. A camera catches frames as it happens to catch
 *      them: parts turn up shuffled and repeated, and the reader has to cope
 *      without asking for anything, because there is no back channel. This
 *      is a one-way pipe by construction.
 *
 *   4. Refuse to assemble something that is not what was sent. Every part
 *      carries the digest of the *whole* payload, and assembly recomputes it.
 *      A single flipped bit, a part from a different transaction that happens
 *      to have the same index, a partially-updated screen caught mid-refresh:
 *      all of them fail closed. On this wire, silently assembling the wrong
 *      bytes means signing the wrong transaction, so "fail closed" is not
 *      defensive programming, it is the product.
 *
 * The text is deliberately upper-case and digits only. QR has an alphanumeric
 * mode covering exactly that set, and it stores roughly 1.55 bits per
 * character against binary mode's 8 bits per byte: base32 in alphanumeric
 * mode beats raw binary for the same payload, and the codes come out sparser
 * and easier for a cheap camera on an old phone. Which is the whole premise
 * of the product: the phone in your drawer is the vault.
 *
 * Interoperating with desktop Bitcoin wallets means also speaking BC-UR
 * (`ur:crypto-psbt`), which Sparrow, Electrum and the hardware signers use.
 * That is an encoder over this same chunk-and-verify core rather than a
 * different design; see docs/airgap-protocol.md.
 *
 * No imports, no platform. This runs in Node under test, in a browser, and
 * inside a React Native bridge without changing.
 */

/** The format this file speaks. A reader refuses anything else. */
export const WIRE_VERSION = 1;

/** What a payload is, so the far side knows what it just received. */
export type PayloadKind =
  /** A watch-only export: xpub/zpub, or a Monero view key and address. */
  | 'ACCOUNT'
  /** An unsigned Bitcoin transaction (PSBT). */
  | 'PSBT'
  /** An unsigned Monero transaction set. */
  | 'XMRUNSIGNED'
  /** A signed Monero transaction set, ready to broadcast. */
  | 'XMRSIGNED'
  /** A finished, signed, broadcastable raw transaction. */
  | 'TXSIGNED';

const KINDS: PayloadKind[] = ['ACCOUNT', 'PSBT', 'XMRUNSIGNED', 'XMRSIGNED', 'TXSIGNED'];

/**
 * How many payload bytes travel in one code.
 *
 * A version-20 QR at error correction level M holds about 850 alphanumeric
 * characters; base32 spends 8 characters per 5 bytes, and the header takes a
 * few dozen. 400 bytes a part leaves comfortable room, keeps the modules
 * large enough for an old camera, and puts a 40 KB Monero transaction set at
 * about a hundred frames, which is fifteen seconds of animation.
 */
export const DEFAULT_PART_BYTES = 400;

export interface Part {
  version: number;
  kind: PayloadKind;
  /** 1-based, because it is shown to a person as "3 of 12". */
  index: number;
  total: number;
  /** Digest of the entire payload, hex, lower case. Identifies the payload
   *  and, after assembly, proves it. */
  digest: string;
  /** This part's slice of the payload, base32. */
  body: string;
}

// ---------------------------------------------------------------------------
// Base32, RFC 4648 alphabet without padding.
//
// Chosen over base64 because QR's alphanumeric mode has no lower case: base64
// in that mode is impossible and in binary mode costs 8 bits a character,
// while base32 costs 5 bits of payload per ~1.55-bit character. The alphabet
// deliberately excludes nothing, because unlike a human-typed code this is
// never read aloud; the confusable characters are the machine's problem, not
// a person's.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array | null {
  const clean = String(text ?? '').toUpperCase();
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = B32.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// The digest.
//
// CRC-32 is not a hash and is not pretending to be one: it is here to catch a
// misread frame, a truncated scan, or two payloads confused for each other,
// which are accidents rather than attacks. It cannot stop somebody who
// controls the screen from crafting a collision, and nothing on a one-way
// optical wire could: an attacker who owns the online device can simply show
// you a *valid* transaction that pays them.
//
// That is why the vault shows what it is about to sign, in full, and makes a
// person approve it. The digest protects against noise; the confirmation
// screen protects against malice. Neither substitutes for the other, and the
// protocol document says so in as many words.

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function digestOf(payload: Uint8Array): string {
  return crc32(payload).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Encoding

/**
 * Cut a payload into the frames to display, in order.
 *
 * An empty payload still produces one part. A reader that received nothing at
 * all and a reader that received an empty thing are different situations, and
 * only one of them should look like success.
 */
export function encodeParts(
  kind: PayloadKind,
  payload: Uint8Array,
  partBytes: number = DEFAULT_PART_BYTES,
): string[] {
  if (!KINDS.includes(kind)) throw new Error(`unknown payload kind: ${kind}`);
  const size = Math.max(1, Math.floor(partBytes));
  const digest = digestOf(payload);
  const total = Math.max(1, Math.ceil(payload.length / size));
  const frames: string[] = [];
  for (let i = 0; i < total; i++) {
    const slice = payload.subarray(i * size, (i + 1) * size);
    frames.push(`LV${WIRE_VERSION}:${kind}:${i + 1}:${total}:${digest}:${base32Encode(slice)}`);
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Decoding

/**
 * Read one frame, or null if it is not one of ours.
 *
 * Null rather than an exception: a camera pointed at the world sees wifi
 * codes, payment codes and cereal boxes, and a scanner that threw on each of
 * them would be unusable. Anything malformed is simply not a part.
 */
export function parsePart(text: string): Part | null {
  const raw = String(text ?? '').trim();
  const match = /^LV(\d+):([A-Z]+):(\d+):(\d+):([0-9a-f]{8}):([A-Z2-7]*)$/.exec(raw);
  if (!match) return null;
  const version = Number(match[1]);
  const kind = match[2] as PayloadKind;
  const index = Number(match[3]);
  const total = Number(match[4]);
  if (version !== WIRE_VERSION) return null;
  if (!KINDS.includes(kind)) return null;
  // A part numbered zero, or numbered past the end, is not a part of this.
  if (!(index >= 1 && total >= 1 && index <= total)) return null;
  return { version, kind, index, total, digest: match[5]!, body: match[6]! };
}

export interface Progress {
  kind: PayloadKind;
  have: number;
  total: number;
  /** The payload, once every part is in and the digest agrees. */
  payload: Uint8Array | null;
  /** Set when a part could not be accepted, in words fit for a screen. */
  problem?: string;
}

/**
 * Collects frames until it has a payload.
 *
 * Deliberately a small state machine rather than a function over an array:
 * the caller is a camera loop handing over whatever it just saw, possibly the
 * same frame forty times, and it needs to know after each one whether to keep
 * filming.
 */
export class Collector {
  private kind: PayloadKind | null = null;
  private digest: string | null = null;
  private total = 0;
  private parts = new Map<number, string>();

  /** Everything so far, for a progress line. */
  status(): Progress {
    return {
      kind: this.kind ?? 'PSBT',
      have: this.parts.size,
      total: this.total,
      payload: null,
    };
  }

  reset(): void {
    this.kind = null;
    this.digest = null;
    this.total = 0;
    this.parts.clear();
  }

  /**
   * Offer a scanned frame.
   *
   * A frame belonging to a different payload than the one in progress is not
   * an error and not something to merge: it is somebody scanning a second
   * transaction, so the collector starts again on the new one. Merging two
   * payloads that share a part count is exactly the silent-wrong-bytes
   * failure this whole file exists to prevent.
   */
  offer(text: string): Progress {
    const part = parsePart(text);
    if (!part) return { ...this.status(), problem: 'That is not a Labyrinth code.' };

    if (this.digest !== null && (part.digest !== this.digest || part.kind !== this.kind)) {
      this.reset();
    }
    if (this.digest === null) {
      this.kind = part.kind;
      this.digest = part.digest;
      this.total = part.total;
    }
    // Same payload claiming a different length is a corrupted header; the
    // safe reading is that one of the two frames is not what it says.
    if (part.total !== this.total) {
      return { ...this.status(), problem: 'That code does not belong to this set.' };
    }

    const bytes = base32Decode(part.body);
    if (bytes === null) {
      return { ...this.status(), problem: 'That code did not read cleanly. Hold steadier.' };
    }
    this.parts.set(part.index, part.body);

    if (this.parts.size < this.total) return this.status();

    // Every part is in. Assemble, then prove it before handing it over.
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (let i = 1; i <= this.total; i++) {
      const decoded = base32Decode(this.parts.get(i) ?? '');
      if (decoded === null) return { ...this.status(), problem: 'One of the codes was damaged.' };
      chunks.push(decoded);
      length += decoded.length;
    }
    const payload = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      payload.set(chunk, at);
      at += chunk.length;
    }

    if (digestOf(payload) !== this.digest) {
      /* Assembled, complete, and not what was sent. Everything is thrown
       * away: a caller must never be handed bytes that failed their own
       * checksum, however tempting "probably fine" is when the person has
       * been waving a phone at a screen for thirty seconds. */
      this.reset();
      return {
        kind: part.kind,
        have: 0,
        total: 0,
        payload: null,
        problem: 'The codes did not add up to a whole message. Start the scan again.',
      };
    }

    return { kind: part.kind, have: this.total, total: this.total, payload };
  }
}

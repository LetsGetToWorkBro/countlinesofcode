/**
 * The Labyrinth Vault's airgap wire, and Monero's own file headers.
 *
 * ## What this is for
 *
 * A Labyrinth Vault is an offline phone with a camera and no radio. It can
 * open one of Monero's own wallet files — an `unsigned_monero_tx`, the thing
 * Feather and the Monero GUI write when they prepare a payment for a cold
 * signer — and tell you what is in it. The only way to hand it one is light:
 * the file goes on a screen as a sequence of QR codes and the vault films
 * them.
 *
 * That is what this module builds. It takes bytes off a disk and produces the
 * frames. Nothing here talks to a network, and nothing here can: the whole
 * point of the device on the other side is that it has no way to be talked to.
 *
 * ## This is a second implementation, and that is a debt
 *
 * The vault has its own copy of this encoder, in `src/airgap/envelope.ts` of
 * the labyrinth-vault repository, and that is the one that decides what a
 * frame means. Two implementations of a wire format is exactly the situation
 * where one of them is quietly wrong about a payload nobody tested — a
 * five-byte remainder in the base32 tail, a checksum computed over the wrong
 * slice — and the failure is not an error message, it is a vault that says
 * "the codes did not add up" and a person who blames their camera.
 *
 * So the port is not trusted to agree by inspection. `test/vaultwire.test.ts`
 * checks it against frames the vault's own encoder produced, recorded in
 * `test/fixtures/vault-frames.json`, over payload sizes chosen to hit every
 * base32 remainder and both sides of a frame boundary. The fixture says which
 * commit of the vault made it and `docs/vault-frames.md` says how to make it
 * again. If the two ever disagree, this file is the one that is wrong.
 *
 * ## The format, from docs/airgap-protocol.md
 *
 *     LV1:KIND:index:total:digest:body
 *
 * Upper case and digits only, because QR's alphanumeric mode covers exactly
 * that set and stores about 1.55 bits a character against binary mode's eight
 * bits a byte. Base32 in alphanumeric mode beats raw binary for the same
 * payload and the codes come out sparser, which is what a five-year-old phone
 * camera across a kitchen table needs.
 *
 * The digest is a CRC-32 of the *whole* payload, on every frame. It is not a
 * hash and is not pretending to be one: it catches a misread frame, a
 * truncated scan, or two payloads confused for each other. It cannot stop
 * somebody who controls this screen, and nothing on a one-way optical wire
 * could. That is why the vault shows what it read and makes a person approve
 * it, and why this page is careful to say that the vault will not sign one of
 * these files at all.
 */

/** The wire version this speaks. A vault refuses anything else. */
export const WIRE_VERSION = 1;

/**
 * Payload bytes per frame, matching the vault's `DEFAULT_PART_BYTES`.
 *
 * A version-20 QR at error correction M holds about 850 alphanumeric
 * characters; base32 spends 8 characters per 5 bytes and the header takes a
 * few dozen. 400 leaves room, keeps the modules large enough for an old
 * camera, and is what the vault's own encoder uses — which matters here
 * because the frame count shown on screen has to be the number that actually
 * gets drawn.
 */
export const FRAME_BYTES = 400;

/** The kinds the vault's wire carries. Only one of them is ours to send. */
export type PayloadKind =
  | 'ACCOUNT'
  | 'PSBT'
  | 'XMRUNSIGNED'
  | 'XMRSIGNED'
  | 'XMROUTPUTS'
  | 'XMRKEYIMAGES'
  | 'XMRFILE'
  | 'TXSIGNED';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding. The vault decodes exactly this. */
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
  /* The tail. Whatever is left is shifted up into a full five-bit group and
   * padded with zeroes, which is the step a re-implementation gets wrong: drop
   * it and every payload whose length is not a multiple of five loses its last
   * byte or two, and only on some files. */
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

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

/**
 * Cut a payload into the frames to display, in order.
 *
 * An empty payload still produces one frame. A vault that received nothing and
 * a vault that received an empty thing are different situations, and only one
 * of them should look like success.
 */
export function encodeParts(
  kind: PayloadKind,
  payload: Uint8Array,
  partBytes: number = FRAME_BYTES,
): string[] {
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
// Monero's own file headers
//
// Ported from `src/keys/monerotx.ts` in the vault, and kept to the same two
// flags, because the whole value of recognising these here is that this page
// agrees with the device about which files are worth showing it.

export type ContainerKind =
  | 'unsigned-tx-set'
  | 'signed-tx-set'
  | 'multisig-unsigned-tx-set'
  | 'key-image-export'
  | 'multisig-export'
  | 'output-export';

interface Magic {
  kind: ContainerKind;
  magic: string;
  version: number;
  what: string;
  /** Whether the vault can open it and describe what is inside. */
  readable: boolean;
}

/**
 * The six magic strings from `src/wallet/wallet2.cpp`, longest first.
 *
 * The order defends nothing today and is kept anyway, which is worth being
 * precise about because the obvious claim here is false: none of these six
 * names is a prefix of another, so `readContainer` finds the right entry
 * whatever order it walks them in. The vault's own module says the same thing
 * about its own copy.
 *
 * What the order buys is a future edit. `Monero unsigned tx set v2`, or any
 * name that extends an existing one, would be shadowed by its own prefix in a
 * table walked shortest-first. `test/vaultwire.test.ts` asserts both halves:
 * that the no-prefix property holds, and that the sort is there anyway.
 */
const MAGICS: Magic[] = ([
  {
    kind: 'multisig-unsigned-tx-set',
    magic: 'Monero multisig unsigned tx set',
    version: 1,
    what: 'a Monero multisig unsigned transaction set',
    /* Not a missing reader. The vault does not do multisig in either currency,
     * and offering to show it one would be the first thing that suggested it
     * might. */
    readable: false,
  },
  {
    kind: 'unsigned-tx-set',
    magic: 'Monero unsigned tx set',
    version: 5,
    what: 'a Monero unsigned transaction set',
    readable: true,
  },
  {
    kind: 'signed-tx-set',
    magic: 'Monero signed tx set',
    version: 5,
    what: 'a Monero signed transaction set',
    readable: false,
  },
  {
    kind: 'key-image-export',
    magic: 'Monero key image export',
    version: 3,
    what: 'a Monero key image export',
    readable: false,
  },
  {
    kind: 'multisig-export',
    magic: 'Monero multisig export',
    version: 1,
    what: 'a Monero multisig export',
    readable: false,
  },
  {
    kind: 'output-export',
    magic: 'Monero output export',
    version: 4,
    what: 'a Monero output export',
    readable: false,
  },
] satisfies Magic[]).sort((a, b) => b.magic.length - a.magic.length);

/** Every magic this build knows, for tests and for documentation. */
export function knownContainers(): { kind: ContainerKind; magic: string; readable: boolean }[] {
  return MAGICS.map(({ kind, magic, readable }) => ({ kind, magic, readable }));
}

export interface Container {
  kind: ContainerKind;
  what: string;
  /** Whether the vault will open it and describe it. */
  readable: boolean;
  /** The version byte this file carries, or null when it is truncated away. */
  version: number | null;
  /** The version the vault was written against. */
  expectedVersion: number;
}

/** Which of Monero's files this is, or null when it is not one of them. */
export function readContainer(bytes: Uint8Array): Container | null {
  for (const entry of MAGICS) {
    if (bytes.length < entry.magic.length) continue;
    let matches = true;
    for (let i = 0; i < entry.magic.length; i++) {
      if (bytes[i] !== entry.magic.charCodeAt(i)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    return {
      kind: entry.kind,
      what: entry.what,
      readable: entry.readable,
      version: bytes.length > entry.magic.length ? bytes[entry.magic.length]! : null,
      expectedVersion: entry.version,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// What this page will and will not put on a screen

/**
 * The largest file this animates.
 *
 * The wire's own cap is 2048 frames, which at 400 bytes is over 800 KB and a
 * quarter of an hour of animation. That is a limit against a hostile header
 * rather than a useful one for a person: nobody holds a phone at a monitor for
 * fifteen minutes. 64 KB is about 160 frames, and an ordinary payment's
 * construction data is a few kilobytes.
 */
export const MAX_FILE_BYTES = 64 * 1024;

/** How long one frame stays up, matching the vault companion's cadence. */
export const FRAME_MS = 220;

export interface FileOffer {
  ok: boolean;
  /** Plain words for the file, when it was recognised at all. */
  what?: string;
  frames?: number;
  /** Seconds for one full pass, rounded up. */
  seconds?: number;
  problem?: string;
}

/**
 * Decide whether this file is worth showing a vault, before anything is drawn.
 *
 * Every refusal here saves somebody fetching a phone out of a drawer for a
 * file the vault would only name back at them. The `readable` flag is the
 * vault's own, ported with the table above, so the two cannot come to disagree
 * about which files are worth the trip.
 */
export function offerFile(bytes: Uint8Array): FileOffer {
  if (bytes.length === 0) return { ok: false, problem: 'That file is empty.' };

  const container = readContainer(bytes);
  if (!container) {
    return {
      ok: false,
      problem:
        "That is not one of Monero's wallet files. The vault reads an unsigned transaction set, " +
        'which Feather and the Monero GUI write as unsigned_monero_tx when they prepare a payment ' +
        'for an offline signer.',
    };
  }

  if (!container.readable) {
    return {
      ok: false,
      what: container.what,
      problem:
        `That is ${container.what}. The vault has no reader for it, so showing it would only get ` +
        'the file named back at you. It reads an unsigned transaction set.',
    };
  }

  if (bytes.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      what: container.what,
      problem:
        `That file is ${Math.round(bytes.length / 1024)} KB, and this shows up to ` +
        `${MAX_FILE_BYTES / 1024} KB. Past that the codes take longer to play than anyone will ` +
        'hold a phone still for.',
    };
  }

  const frames = Math.max(1, Math.ceil(bytes.length / FRAME_BYTES));
  return {
    ok: true,
    what: container.what,
    frames,
    seconds: Math.ceil((frames * FRAME_MS) / 1000),
  };
}

/**
 * The frames themselves, or null for exactly the files `offerFile` refuses.
 *
 * Two functions rather than one so a page can decide what to say before it
 * decides what to draw. The split must not become a way around the decision,
 * so this asks again.
 */
export function framesFor(bytes: Uint8Array): string[] | null {
  if (!offerFile(bytes).ok) return null;
  return encodeParts('XMRFILE', bytes, FRAME_BYTES);
}

const globalScope = globalThis as unknown as { LOC1999_VAULTWIRE?: Record<string, unknown> };
globalScope.LOC1999_VAULTWIRE = {
  encodeParts,
  digestOf,
  readContainer,
  offerFile,
  framesFor,
  FRAME_MS,
  FRAME_BYTES,
  MAX_FILE_BYTES,
};

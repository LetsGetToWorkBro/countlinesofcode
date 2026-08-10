/**
 * The airgap wire.
 *
 * A signer that assembles the wrong bytes signs the wrong transaction, so
 * most of this file is about refusing rather than about working. The happy
 * path is four cases; the rest is noise, shuffling, mixing two payloads, and
 * a bit flipped somewhere nobody would notice by eye.
 */

import { describe, expect, it } from 'vitest';
import {
  Collector,
  DEFAULT_PART_BYTES,
  base32Decode,
  base32Encode,
  digestOf,
  encodeParts,
  parsePart,
} from '../src/airgap/envelope';

/** Deterministic bytes, so a failure is reproducible rather than a story. */
function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

/** Scan a list of frames in the given order and return the last progress. */
function scan(frames: string[]) {
  const collector = new Collector();
  let last = collector.status();
  for (const frame of frames) last = collector.offer(frame);
  return last;
}

describe('base32, because QR has no lower case', () => {
  it('round-trips every length, including the ragged tails', () => {
    for (let n = 0; n < 40; n++) {
      const original = bytes(n, n + 1);
      const back = base32Decode(base32Encode(original));
      expect(back, `length ${n}`).toEqual(original);
    }
  });

  it('encodes into the alphanumeric set QR can pack densely', () => {
    // Anything outside A-Z2-7 would force QR into binary mode and cost about
    // five times the bits per character, which is the whole reason for base32.
    expect(base32Encode(bytes(200))).toMatch(/^[A-Z2-7]*$/);
  });

  it('refuses text that is not base32 rather than inventing bytes', () => {
    expect(base32Decode('NOT-BASE32!')).toBeNull();
    expect(base32Decode('01889')).toBeNull();   // 0, 1, 8, 9 are not in the set
    expect(base32Decode('')).toEqual(new Uint8Array(0));
  });
});

describe('cutting a payload into frames', () => {
  it('carries a payload bigger than any one code', () => {
    const payload = bytes(40_000);           // a Monero unsigned set, roughly
    const frames = encodeParts('XMRUNSIGNED', payload);
    expect(frames.length).toBe(Math.ceil(40_000 / DEFAULT_PART_BYTES));
    expect(scan(frames).payload).toEqual(payload);
  });

  it('still sends one frame for an empty payload', () => {
    // Received-nothing and received-an-empty-thing must not look the same.
    const frames = encodeParts('ACCOUNT', new Uint8Array(0));
    expect(frames).toHaveLength(1);
    const done = scan(frames);
    expect(done.payload).toEqual(new Uint8Array(0));
  });

  it('numbers the frames for a person, from one', () => {
    const frames = encodeParts('PSBT', bytes(1000), 400);
    expect(frames).toHaveLength(3);
    expect(parsePart(frames[0]!)!.index).toBe(1);
    expect(parsePart(frames[2]!)!).toMatchObject({ index: 3, total: 3, kind: 'PSBT' });
  });

  it('puts the digest of the whole payload on every frame', () => {
    const payload = bytes(1000);
    const frames = encodeParts('PSBT', payload, 400);
    for (const frame of frames) {
      expect(parsePart(frame)!.digest).toBe(digestOf(payload));
    }
  });
});

describe('reading frames off a camera', () => {
  const payload = bytes(2500);
  const frames = encodeParts('PSBT', payload, 400);

  it('assembles them out of order, which is how a camera sees them', () => {
    const shuffled = [...frames].reverse();
    expect(scan(shuffled).payload).toEqual(payload);
  });

  it('tolerates the same frame forty times over', () => {
    const repeated: string[] = [];
    for (const frame of frames) for (let i = 0; i < 40; i++) repeated.push(frame);
    expect(scan(repeated).payload).toEqual(payload);
  });

  it('reports progress so a person knows to keep filming', () => {
    const collector = new Collector();
    const first = collector.offer(frames[0]!);
    expect(first.payload).toBeNull();
    expect(first.have).toBe(1);
    expect(first.total).toBe(frames.length);
    const second = collector.offer(frames[1]!);
    expect(second.have).toBe(2);
  });

  it('ignores the rest of the world without complaining loudly', () => {
    // A camera pointed at a room sees wifi codes and cereal boxes.
    for (const junk of ['', 'WIFI:S:home;', 'https://example.com', 'LV9:PSBT:1:1:00000000:AA']) {
      expect(parsePart(junk), junk).toBeNull();
    }
    const collector = new Collector();
    const progress = collector.offer('https://example.com');
    expect(progress.payload).toBeNull();
    expect(progress.problem).toMatch(/not a Labyrinth code/i);
  });
});

describe('refusing to assemble the wrong thing', () => {
  const payload = bytes(2500);
  const frames = encodeParts('PSBT', payload, 400);

  it('throws it all away when a frame was misread', () => {
    /* The failure that costs money: every part arrives, the count is right,
     * the screen says done, and one character was read wrong. It has to fail
     * closed rather than hand over bytes that failed their own checksum. */
    const damaged = [...frames];
    const parsed = parsePart(damaged[1]!)!;
    const flipped = parsed.body[0] === 'A' ? 'B' : 'A';
    damaged[1] = `LV1:PSBT:2:${parsed.total}:${parsed.digest}:${flipped}${parsed.body.slice(1)}`;

    const done = scan(damaged);
    expect(done.payload, 'a corrupted set must never assemble').toBeNull();
    expect(done.problem).toMatch(/start the scan again/i);
  });

  it('does not merge two different payloads that are the same shape', () => {
    /* Somebody scans half of one transaction, then starts on another with the
     * same number of parts. Merging them would produce a valid-looking
     * assembly of two different transactions. */
    const other = encodeParts('PSBT', bytes(2500, 99), 400);
    expect(parsePart(other[0]!)!.digest).not.toBe(parsePart(frames[0]!)!.digest);

    const collector = new Collector();
    collector.offer(frames[0]!);
    collector.offer(frames[1]!);
    // Switching payloads starts again rather than mixing.
    const after = collector.offer(other[0]!);
    expect(after.have).toBe(1);
    for (const frame of other.slice(1)) collector.offer(frame);
    const done = collector.offer(other[0]!);
    expect(done.payload).toEqual(bytes(2500, 99));
  });

  it('refuses a frame whose header disagrees about the length', () => {
    const collector = new Collector();
    collector.offer(frames[0]!);
    const parsed = parsePart(frames[1]!)!;
    const lying = `LV1:PSBT:2:99:${parsed.digest}:${parsed.body}`;
    const progress = collector.offer(lying);
    expect(progress.problem).toMatch(/does not belong/i);
    expect(progress.have, 'the good frame is kept').toBe(1);
  });

  it('refuses impossible frame numbers', () => {
    expect(parsePart('LV1:PSBT:0:3:00000000:AA'), 'part zero').toBeNull();
    expect(parsePart('LV1:PSBT:4:3:00000000:AA'), 'past the end').toBeNull();
    expect(parsePart('LV1:NOPE:1:1:00000000:AA'), 'unknown kind').toBeNull();
  });

  it('refuses a version it does not speak', () => {
    // A future format must not be read with today's rules.
    const future = frames[0]!.replace(/^LV1:/, 'LV2:');
    expect(parsePart(future)).toBeNull();
  });
});

describe('the kinds of thing that cross the gap', () => {
  it('round-trips each one, and says which it was', () => {
    for (const kind of ['ACCOUNT', 'PSBT', 'XMRUNSIGNED', 'XMRSIGNED', 'TXSIGNED'] as const) {
      const payload = bytes(900, kind.length);
      const done = scan(encodeParts(kind, payload));
      expect(done.kind, kind).toBe(kind);
      expect(done.payload, kind).toEqual(payload);
    }
  });

  it('will not encode a kind it does not know', () => {
    // @ts-expect-error deliberately outside the type, which a JS caller can do
    expect(() => encodeParts('WHATEVER', bytes(10))).toThrow(/unknown payload kind/);
  });
});

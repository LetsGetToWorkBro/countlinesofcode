/**
 * The vault wire, checked against the vault.
 *
 * `src/client/vaultwire.ts` is a second implementation of a format that
 * already has one, in the Labyrinth Vault's `src/airgap/envelope.ts`. That is
 * a debt rather than a design, and this file is how it gets serviced: the
 * frames below were produced by the vault's own encoder and recorded in
 * `test/fixtures/vault-frames.json`, so the port is compared to the code that
 * actually reads the codes rather than to itself.
 *
 * The payload sizes are not arbitrary. Base32 packs five bytes into eight
 * characters, so the interesting cases are the remainders — a payload whose
 * length is 1, 2, 3 or 4 past a multiple of five exercises the tail that a
 * re-implementation forgets, and forgetting it loses the last byte or two of
 * *some* files and none of the others. The rest sit on both sides of a frame
 * boundary, where an off-by-one splits a payload into the wrong number of
 * parts and every frame carries the wrong `total`.
 *
 * What a failure here means: a person points a vault at this page and it says
 * the codes did not add up, and they blame their camera.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  base32Encode,
  crc32,
  digestOf,
  encodeParts,
  framesFor,
  FRAME_BYTES,
  MAX_FILE_BYTES,
  knownContainers,
  offerFile,
  readContainer,
  type PayloadKind,
} from '../src/client/vaultwire';

const fixture = JSON.parse(readFileSync('test/fixtures/vault-frames.json', 'utf8')) as {
  source: { repo: string; commit: string; partBytes: number };
  cases: { name: string; payload: string; frames: string[] }[];
  kinds: { kind: string; frames: string[] }[];
};

const bytes = (hex: string): Uint8Array =>
  new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** A wallet2 container header, for the kinds with no fixture. */
function container(magic: string, version: number, body = 512): Uint8Array {
  const out = new Uint8Array(magic.length + 1 + body);
  for (let i = 0; i < magic.length; i++) out[i] = magic.charCodeAt(i);
  out[magic.length] = version;
  for (let i = 0; i < body; i++) out[magic.length + 1 + i] = (i * 37 + 11) & 0xff;
  return out;
}

describe('the frames match the ones the vault produces', () => {
  it('found the fixture, and it says where it came from', () => {
    expect(fixture.cases.length).toBeGreaterThan(10);
    expect(fixture.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.source.partBytes).toBe(FRAME_BYTES);
  });

  for (const one of fixture.cases) {
    it(`reproduces the vault's frames for ${one.name}`, () => {
      expect(encodeParts('XMRFILE', bytes(one.payload), FRAME_BYTES)).toEqual(one.frames);
    });
  }

  for (const one of fixture.kinds) {
    it(`labels a ${one.kind} payload the way the vault does`, () => {
      /* Every kind, not only ours. A port that hardcoded XMRFILE into the
       * frame header would pass every test above and be wrong about a format
       * it claims to implement. */
      const payload = new Uint8Array(11).map((_, i) => i * 9);
      expect(encodeParts(one.kind as PayloadKind, payload, FRAME_BYTES)).toEqual(one.frames);
    });
  }

  it('agrees about the digest, which is what makes a scan fail closed', () => {
    /* Read out of the frames rather than recomputed here, so this compares the
     * vault's number with ours instead of ours with ours. */
    for (const one of fixture.cases) {
      const [, , , , digest] = one.frames[0]!.split(':');
      expect(digestOf(bytes(one.payload)), one.name).toBe(digest);
    }
  });
});

describe('the pieces underneath', () => {
  it('base32-encodes the RFC 4648 alphabet without padding', () => {
    /* RFC 4648 section 10's own vectors, which is a second opinion that is not
     * the vault either. */
    const ascii = (text: string) => new TextEncoder().encode(text);
    expect(base32Encode(ascii(''))).toBe('');
    expect(base32Encode(ascii('f'))).toBe('MY');
    expect(base32Encode(ascii('fo'))).toBe('MZXQ');
    expect(base32Encode(ascii('foo'))).toBe('MZXW6');
    expect(base32Encode(ascii('foob'))).toBe('MZXW6YQ');
    expect(base32Encode(ascii('fooba'))).toBe('MZXW6YTB');
    expect(base32Encode(ascii('foobar'))).toBe('MZXW6YTBOI');
  });

  it('computes the CRC-32 everyone else computes', () => {
    // The check value from the CRC catalogue: "123456789" is 0xCBF43926.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(digestOf(new Uint8Array(0))).toBe('00000000');
  });

  it('emits one frame for an empty payload rather than none', () => {
    /* A vault that received nothing and a vault that received an empty thing
     * are different situations, and only one of them should look like
     * success. */
    expect(encodeParts('XMRFILE', new Uint8Array(0))).toHaveLength(1);
  });
});

describe('which files are worth showing a vault', () => {
  it('accepts a real unsigned transaction set and costs it', () => {
    const real = bytes(fixture.cases[fixture.cases.length - 1]!.payload);
    const offer = offerFile(real);
    expect(offer.problem ?? null).toBeNull();
    expect(offer.ok).toBe(true);
    expect(offer.what).toBe('a Monero unsigned transaction set');
    expect(offer.frames).toBe(Math.ceil(real.length / FRAME_BYTES));
    expect(offer.seconds).toBeGreaterThan(0);
  });

  it('refuses anything that is not one of Monero\'s files', () => {
    for (const junk of [
      new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]),
      new Uint8Array(64).fill(0xab),
      new TextEncoder().encode('Monero is a cryptocurrency'),
    ]) {
      const offer = offerFile(junk);
      expect(offer.ok).toBe(false);
      expect(offer.problem).toMatch(/not one of Monero's wallet files/);
      expect(offer.problem).toMatch(/unsigned_monero_tx/);
    }
  });

  it('names a real Monero file the vault has no reader for, and stops', () => {
    for (const [magic, version] of [
      ['Monero signed tx set', 5],
      ['Monero output export', 4],
      ['Monero key image export', 3],
      ['Monero multisig unsigned tx set', 1],
    ] as const) {
      const offer = offerFile(container(magic, version));
      expect(offer.ok, magic).toBe(false);
      expect(offer.what, magic).toContain('Monero');
      expect(offer.problem, magic).toMatch(/no reader for it/);
    }
  });

  it('cannot let a shorter magic shadow a longer one', () => {
    /* This test was written wrong first, and the wrong version is instructive:
     * it fed a multisig set in and checked it came back as multisig, which
     * passes whatever order the table is in. None of these six names is a
     * prefix of another, so there is nothing to shadow and the assertion could
     * not fail. Reversing the sort broke no test, which is how it was caught.
     *
     * So assert the two things that are load-bearing. The no-prefix property
     * is what makes the order irrelevant; the sort is what keeps it irrelevant
     * when somebody adds `Monero unsigned tx set v2`. Deleting the sort fails
     * the second, and an overlapping name fails the first. The vault's own
     * test says the same thing about its own copy of this table. */
    const magics = knownContainers().map((k) => k.magic);
    expect(magics).toHaveLength(6);

    for (const a of magics) {
      for (const b of magics) {
        if (a === b) continue;
        expect(b.startsWith(a), `"${a}" is a prefix of "${b}"`).toBe(false);
      }
    }

    const lengths = magics.map((m) => m.length);
    expect(lengths, 'the table is not longest-first').toEqual([...lengths].sort((x, y) => y - x));

    // And, since it is cheap, that each one is still found by its own name.
    expect(readContainer(container('Monero multisig unsigned tx set', 1))!.kind)
      .toBe('multisig-unsigned-tx-set');
    expect(readContainer(container('Monero unsigned tx set', 5))!.kind).toBe('unsigned-tx-set');
  });

  it('agrees with the vault about which of the six open', () => {
    /* The flag this page refuses files on. It is a copy of the vault's, and a
     * copy that drifted would send somebody across a room for a file the vault
     * declines, or refuse one it would have read. */
    const readable = knownContainers().filter((k) => k.readable).map((k) => k.kind);
    expect(readable).toEqual(['unsigned-tx-set']);
  });

  it('reports the version it saw and the one it expects', () => {
    const future = readContainer(container('Monero unsigned tx set', 9))!;
    expect(future.version).toBe(9);
    expect(future.expectedVersion).toBe(5);
    /* A file truncated to nothing but its magic still gets named. */
    const bare = readContainer(new TextEncoder().encode('Monero unsigned tx set'))!;
    expect(bare.version).toBeNull();
  });

  it('refuses a file too long to animate, and says how long it is', () => {
    const huge = container('Monero unsigned tx set', 5, MAX_FILE_BYTES + 1);
    expect(offerFile(huge).problem).toMatch(/KB/);
    /* Refused rather than truncated: a truncated payload assembles into
     * nothing at the far end, and the failure surfaces over there as "the
     * codes did not add up", which points at the camera. */
    expect(framesFor(huge)).toBeNull();
  });

  it('accepts a file at exactly the limit', () => {
    const body = MAX_FILE_BYTES - 'Monero unsigned tx set'.length - 1;
    expect(offerFile(container('Monero unsigned tx set', 5, body)).ok).toBe(true);
  });

  it('builds no frames for anything the offer refused', () => {
    for (const refused of [
      new Uint8Array(0),
      new Uint8Array(64).fill(0xab),
      container('Monero signed tx set', 5),
      container('Monero unsigned tx set', 5, MAX_FILE_BYTES + 1),
    ]) {
      expect(framesFor(refused)).toBeNull();
    }
  });

  it('sends only XMRFILE, whatever it is given', () => {
    /* This page hands the vault files to *read*. XMRUNSIGNED is the vault's
     * own signing request format and nothing here may produce one: a frame
     * labelled that way asks a vault to open its confirmation screen over a
     * payload nobody derived from its keys. */
    const frames = framesFor(bytes(fixture.cases[fixture.cases.length - 1]!.payload))!;
    for (const frame of frames) expect(frame.split(':')[1]).toBe('XMRFILE');
  });
});

describe('the panel says what the round trip is', () => {
  /* The page and the script are plain files with no build step, so nothing but
   * this reads them. What matters is not that the words are pretty: it is that
   * the panel cannot come to imply a signature comes back, because none does
   * and none can. */

  const html = readFileSync('public/wallet.html', 'utf8');
  const page = readFileSync('public/vault-page.js', 'utf8');

  it('found the panel, so a pass means something', () => {
    expect(html).toContain('data-panel="vault"');
    expect(page.length).toBeGreaterThan(1000);
  });

  it('is reachable from the tab strip and from the File menu', () => {
    /* Two ways in, which is how the rest of this window works: the strip is
     * the running order and the menu is the other way to say the same thing.
     * A panel reachable from one control is a panel that disappears when that
     * control scrolls off. */
    expect(html).toMatch(/class="sheet-tab" data-tab="vault"/);
    expect(html).toMatch(/<button type="button" data-tab="vault">/);
  });

  it('promises no signature, in words rather than by omission', () => {
    expect(html).toMatch(/The vault reads these\. It does not sign them\./);
    expect(html).toMatch(/sending wallet's own account of its\s+own transaction/);
  });

  it('says the file does not leave the tab', () => {
    expect(html).toMatch(/Nothing is uploaded/);
  });

  it('uploads nothing, and has nowhere to upload to', () => {
    /* The claim above, checked against the code rather than trusted. This
     * script reads a file and draws squares; a fetch in it would be a page
     * whose notice is a lie. */
    const code = page
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new\s+WebSocket/);
  });

  it('only ever loads its own two engines', () => {
    /* `script-src 'self'`, and the page has to hold to it without relying on
     * the header to catch a mistake. */
    const sources = [...page.matchAll(/load\('([^']+)'\)/g)].map((m) => m[1]!);
    expect(sources.sort()).toEqual(['/qrkit.js', '/vaultwire.js']);
  });

  it('draws no code for a file the offer refused', () => {
    /* The page asks `offerFile` and stops on a refusal. If it ever drew first
     * and checked afterwards, somebody would scan a code for a file the vault
     * is about to decline. */
    expect(page).toMatch(/if \(!offer\.ok\) \{\s*\n\s*fail\(offer\.problem\);\s*\n\s*return;/);
  });

  it('clears the codes when the panel is not the one on screen', () => {
    /* A code left running behind another tab is a code somebody could still
     * scan by accident. */
    expect(page).toMatch(/tab:hidden/);
    expect(page).toMatch(/if \(event\.detail && event\.detail\.tab === 'vault'\) reset\(\);/);
  });
});

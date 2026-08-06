/**
 * The throwaway-inbox primitives. The address rules carry the whole security
 * model (unguessable, generated-only), so they get the most attention: a valid
 * generated address round-trips, and everything that is not one is refused.
 */

import { describe, expect, it } from 'vitest';
import {
  ADDRESS_ALPHABET,
  INBOX_TTL_MS,
  LOCALPART_LEN,
  encodeBase32,
  expiryFrom,
  localPartValid,
  makeAddress,
  parseInboxAddress,
  preview,
  randomId,
  randomLocalPart,
  truncateBody,
} from '../src/lib/mailbox';

const bytes = (n: number, fill = 0) => new Uint8Array(n).fill(fill);

describe('address generation', () => {
  it('is base32, the right length, and only the safe alphabet', () => {
    const b = new Uint8Array(64);
    for (let i = 0; i < b.length; i++) b[i] = (i * 37 + 11) & 255;
    const local = randomLocalPart(b);
    expect(local).toHaveLength(LOCALPART_LEN);
    expect(local).toMatch(/^[a-z2-7]+$/);
  });

  it('maps every byte value into the alphabet without bias in range', () => {
    // byte & 31 must land inside the 32-char alphabet for all 256 byte values.
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const out = encodeBase32(all, 256);
    for (const ch of out) expect(ADDRESS_ALPHABET.includes(ch)).toBe(true);
  });

  it('builds a full address on the configured domain', () => {
    const addr = makeAddress(bytes(LOCALPART_LEN, 0), 'mail.example.com');
    expect(addr).toBe('aaaaaaaaaaaaaa@mail.example.com');
  });

  it('lower-cases the domain', () => {
    expect(makeAddress(bytes(LOCALPART_LEN, 0), 'Mail.Example.COM')).toContain('@mail.example.com');
  });

  it('a generated id is the safe alphabet too', () => {
    expect(randomId(bytes(32, 5))).toMatch(/^[a-z2-7]+$/);
  });
});

describe('localPartValid', () => {
  it('accepts a generated-looking local part', () => {
    expect(localPartValid('abcdefghijklmn')).toBe(true);
    expect(localPartValid('mn4pqrst2uvwxy')).toBe(true);
  });

  it('rejects everything that is not one', () => {
    for (const bad of ['', 'admin', 'info', 'short', 'a'.repeat(41), 'has.dot', 'UPPER1234abcd', 'has space12', '01890abcdefg', 'plus+addr1234']) {
      expect(localPartValid(bad), bad).toBe(false);
    }
  });
});

describe('parseInboxAddress', () => {
  const DOMAIN = 'mail.example.com';

  it('accepts and normalises a valid address', () => {
    expect(parseInboxAddress('AbCdEfGhIjKlMn@Mail.Example.com', DOMAIN)).toBe('abcdefghijklmn@mail.example.com');
  });

  it('refuses the wrong domain', () => {
    expect(parseInboxAddress('abcdefghijklmn@evil.example', DOMAIN)).toBeNull();
    expect(parseInboxAddress('abcdefghijklmn@sub.mail.example.com', DOMAIN)).toBeNull();
  });

  it('refuses a non-generated local part (admin, info, the guessable ones)', () => {
    for (const local of ['admin', 'info', 'postmaster', 'hello', 'a', 'has+plus1234']) {
      expect(parseInboxAddress(`${local}@${DOMAIN}`, DOMAIN), local).toBeNull();
    }
  });

  it('refuses malformed input', () => {
    for (const bad of ['', 'no-at-sign', '@nothing', 'abcdefghijklmn@', 'a@b@c']) {
      expect(parseInboxAddress(bad, DOMAIN), bad).toBeNull();
    }
  });
});

describe('expiry and shaping', () => {
  it('expires an hour out', () => {
    expect(expiryFrom(1_000_000)).toBe(1_000_000 + INBOX_TTL_MS);
  });

  it('previews to one short line', () => {
    expect(preview('  hello\n\tthere   world  ')).toBe('hello there world');
    expect(preview('x'.repeat(500)).length).toBeLessThanOrEqual(140);
    expect(preview('x'.repeat(500))).toMatch(/…$/);
  });

  it('truncates an oversized body and marks it', () => {
    const big = 'a'.repeat(200_000);
    const out = truncateBody(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toMatch(/\[truncated\]$/);
    expect(truncateBody('short')).toBe('short');
  });
});

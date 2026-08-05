/**
 * The page that is exactly 1999 bytes.
 *
 * This is the whole mechanism. The page makes a claim about itself that anyone
 * can check with one command, and the only thing keeping that claim true is
 * this file refusing to let it drift. Without it the page becomes a page that
 * says it is 1999 bytes, which is worse than not making the claim at all.
 *
 * The failure message says how far off it is and in which direction, because
 * the point is that rebalancing should take a minute, not that it should be a
 * puzzle. There is no padding to adjust: pay for a new sentence by shortening
 * another one.
 */

import { describe, expect, it } from 'vitest';
import { EXACTLY_1999 } from '../src/worker/exact1999';

const bytes = new TextEncoder().encode(EXACTLY_1999).length;

describe('the 1999-byte page', () => {
  it('is exactly 1999 bytes', () => {
    const off = bytes - 1999;
    expect(
      bytes,
      off === 0
        ? ''
        : `the page is ${Math.abs(off)} bytes ${off > 0 ? 'over' : 'under'}. ` +
          'Every byte in it is content, so balance the edit rather than padding: ' +
          `${off > 0 ? 'shorten' : 'lengthen'} a sentence by ${Math.abs(off)} bytes.`,
    ).toBe(1999);
  });

  it('measures the bytes, not the characters', () => {
    // A single accented letter would make these differ, and the claim is about
    // what curl counts.
    expect(new TextEncoder().encode(EXACTLY_1999).length).toBe(bytes);
    expect(EXACTLY_1999).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('says what it is, so the claim is on the page and not only in the byte count', () => {
    expect(EXACTLY_1999).toContain('exactly 1999 bytes');
    expect(EXACTLY_1999).toContain('wc -c');
  });

  it('admits there is no padding, which is the part worth checking', () => {
    expect(EXACTLY_1999).toContain('no padding');
    // And is true: no run of spaces or tabs doing the arithmetic.
    expect(EXACTLY_1999).not.toMatch(/ {4}/);
    expect(EXACTLY_1999).not.toContain('\t');
  });

  it('is a whole page rather than a fragment', () => {
    expect(EXACTLY_1999.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(EXACTLY_1999.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('does not claim a crown that can be shared', () => {
    // Two repositories can both be exactly 1999 lines. The page says nothing
    // beats zero, which is true; an earlier draft said nobody could tie you,
    // which was not.
    expect(EXACTLY_1999).not.toMatch(/never tie|cannot tie|ever tie/i);
  });
});

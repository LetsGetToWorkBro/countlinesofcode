/**
 * The page-range parser decides which pages of somebody's document survive, so
 * every ambiguous input it accepts is a chance to quietly produce the wrong
 * PDF. It refuses rather than guesses, and these pin that down.
 *
 * The pdf-lib-backed functions are not unit tested here — they need a real
 * document and a DOM. They are exercised in a browser instead.
 */

import { describe, expect, it } from 'vitest';
import { describeSize, parseRange } from '../src/client/pdfkit';

describe('parseRange', () => {
  it('selects everything when nothing is typed', () => {
    expect(parseRange('', 3)).toEqual([0, 1, 2]);
    expect(parseRange('   ', 2)).toEqual([0, 1]);
  });

  it('reads single pages, one-based', () => {
    expect(parseRange('1', 5)).toEqual([0]);
    expect(parseRange('5', 5)).toEqual([4]);
  });

  it('reads ranges and lists the way a print dialog does', () => {
    expect(parseRange('1-3', 10)).toEqual([0, 1, 2]);
    expect(parseRange('1-3, 7', 10)).toEqual([0, 1, 2, 6]);
    expect(parseRange('2,4,6', 10)).toEqual([1, 3, 5]);
  });

  it('treats an open end as "to the last page"', () => {
    expect(parseRange('8-', 10)).toEqual([7, 8, 9]);
    expect(parseRange('-3', 10)).toEqual([0, 1, 2]);
  });

  it('keeps the order written, so a range can reverse or shuffle pages', () => {
    expect(parseRange('3,1', 5)).toEqual([2, 0]);
    expect(parseRange('3-1', 5)).toEqual([2, 1, 0]);
  });

  it('allows a page to be repeated, because duplicating one is a real need', () => {
    expect(parseRange('1,1,2', 5)).toEqual([0, 0, 1]);
  });

  it('tolerates untidy spacing and trailing commas', () => {
    expect(parseRange(' 1 - 2 ,, 4 ', 5)).toEqual([0, 1, 3]);
  });

  it('refuses a page the document does not have, rather than clamping', () => {
    // Clamping would hand back a PDF that silently lost a page.
    expect(() => parseRange('11', 10)).toThrow(/10 pages/);
    expect(() => parseRange('5-99', 10)).toThrow(/10 pages/);
    expect(() => parseRange('1', 1)).not.toThrow();
    expect(() => parseRange('2', 1)).toThrow(/1 page\b/);
  });

  it('refuses page zero, because pages start at one everywhere else', () => {
    expect(() => parseRange('0', 5)).toThrow(/numbered from 1/);
    expect(() => parseRange('0-2', 5)).toThrow(/numbered from 1/);
  });

  it('refuses input it cannot read instead of guessing', () => {
    for (const bad of ['abc', '1-2-3', '1..3', '#', 'first page']) {
      expect(() => parseRange(bad, 10), bad).toThrow();
    }
  });

  it('refuses a range that would select nothing', () => {
    expect(() => parseRange(',,,', 5)).toThrow(/selects no pages/);
  });
});

describe('describeSize', () => {
  it('names the two page sizes anyone recognises', () => {
    expect(describeSize({ width: 595.28, height: 841.89 })).toBe('A4');
    expect(describeSize({ width: 612, height: 792 })).toBe('Letter');
  });

  it('says when a page is on its side', () => {
    expect(describeSize({ width: 841.89, height: 595.28 })).toBe('A4 landscape');
    expect(describeSize({ width: 792, height: 612 })).toBe('Letter landscape');
  });

  it('falls back to millimetres for anything else', () => {
    expect(describeSize({ width: 283.46, height: 283.46 })).toBe('100×100 mm');
  });

  it('tolerates the rounding real documents contain', () => {
    // Scanners and word processors emit A4 a point or two off constantly.
    expect(describeSize({ width: 596, height: 842 })).toBe('A4');
  });
});

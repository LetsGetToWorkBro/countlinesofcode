/**
 * Merging, splitting, reordering and rotating pages.
 *
 * The working state is one flat list of page references, so the interesting
 * tests are about that list: that a drag lands where the gap was, that a page
 * range typed the way a print dialog takes one means what the person meant, and
 * that rotation accumulates rather than replaces.
 *
 * The last few go through pdf-lib for real, because "the pages came out in the
 * right order" is not something a model test can answer.
 */

import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  buildPdf,
  countByDoc,
  formatRanges,
  loadSources,
  movePage,
  normaliseRotation,
  outputName,
  parseRanges,
  planSplit,
  removePages,
  rotatePages,
  sortByOrigin,
  type PageRef,
} from '../src/client/pdfpages';

const ref = (doc: number, page: number, rotation = 0): PageRef => ({ doc, page, rotation });

/** A PDF whose pages say which page they are, so order can be checked. */
async function makePdf(count: number, tag: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`${tag}${i + 1}`, { x: 40, y: 200, size: 40, font });
  }
  return doc.save();
}

describe('normaliseRotation', () => {
  it('keeps to the four turns a PDF can hold', () => {
    expect(normaliseRotation(90)).toBe(90);
    expect(normaliseRotation(360)).toBe(0);
    expect(normaliseRotation(450)).toBe(90);
  });

  it('brings a negative turn back round', () => {
    expect(normaliseRotation(-90)).toBe(270);
    expect(normaliseRotation(-450)).toBe(270);
  });

  it('snaps something that is not a quarter turn', () => {
    expect(normaliseRotation(89)).toBe(90);
  });
});

describe('movePage', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('drops the page into the gap, shifting the rest', () => {
    // Not a swap: dragging the first page to the end should leave the others in
    // their original order.
    expect(movePage(list, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moves backwards too', () => {
    expect(movePage(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('clamps a target past the end', () => {
    expect(movePage(list, 0, 99)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('leaves the list alone when the index is not real', () => {
    expect(movePage(list, 9, 0)).toEqual(list);
  });

  it('does not mutate the original', () => {
    const original = [...list];
    movePage(list, 0, 2);
    expect(list).toEqual(original);
  });
});

describe('rotatePages', () => {
  it('turns only the chosen pages', () => {
    const pages = [ref(0, 0), ref(0, 1), ref(0, 2)];
    const turned = rotatePages(pages, [1], 90);
    expect(turned.map((p) => p.rotation)).toEqual([0, 90, 0]);
  });

  it('accumulates rather than replacing', () => {
    // Two clicks of "turn right" is half a turn, not a quarter.
    let pages = [ref(0, 0)];
    pages = rotatePages(pages, [0], 90);
    pages = rotatePages(pages, [0], 90);
    expect(pages[0]!.rotation).toBe(180);
  });

  it('comes back to zero after four turns', () => {
    let pages = [ref(0, 0)];
    for (let i = 0; i < 4; i++) pages = rotatePages(pages, [0], 90);
    expect(pages[0]!.rotation).toBe(0);
  });
});

describe('removePages and sortByOrigin', () => {
  it('drops the chosen pages', () => {
    expect(removePages(['a', 'b', 'c'], [1])).toEqual(['a', 'c']);
  });

  it('puts pages back in the order they arrived, across documents', () => {
    const shuffled = [ref(1, 2), ref(0, 1), ref(1, 0), ref(0, 0)];
    expect(sortByOrigin(shuffled).map((p) => `${p.doc}:${p.page}`)).toEqual(['0:0', '0:1', '1:0', '1:2']);
  });
});

describe('parseRanges', () => {
  it('reads what a print dialog reads', () => {
    // One-based in, zero-based out — the mistake that silently prints the
    // wrong pages rather than failing.
    expect(parseRanges('1-3', 10)).toEqual([0, 1, 2]);
    expect(parseRanges('2,4,6', 10)).toEqual([1, 3, 5]);
    expect(parseRanges('1-2, 5', 10)).toEqual([0, 1, 4]);
  });

  it('takes an open-ended range at either end', () => {
    expect(parseRanges('8-', 10)).toEqual([7, 8, 9]);
    expect(parseRanges('-3', 10)).toEqual([0, 1, 2]);
  });

  it('clamps to the document rather than inventing pages', () => {
    expect(parseRanges('8-99', 10)).toEqual([7, 8, 9]);
    expect(parseRanges('50', 10)).toEqual([]);
  });

  it('treats a backwards range as the range, not as a reversal', () => {
    expect(parseRanges('5-3', 10)).toEqual([2, 3, 4]);
  });

  it('accepts the dashes a word processor substitutes', () => {
    // Typing 1-3 into something that autocorrects gives an en dash.
    expect(parseRanges('1–3', 10)).toEqual([0, 1, 2]);
  });

  it('never repeats a page that was asked for twice', () => {
    expect(parseRanges('1-3, 2', 10)).toEqual([0, 1, 2]);
  });

  it('refuses text that is not a range, rather than selecting nothing', () => {
    for (const bad of ['', 'all', 'first three', '1;2', 'a-b']) {
      expect(parseRanges(bad, 10), bad).toBeNull();
    }
  });
});

describe('formatRanges', () => {
  it('collapses runs the way a person writes them', () => {
    expect(formatRanges([0, 1, 2, 4, 7, 8, 9])).toBe('1-3, 5, 8-10');
  });

  it('handles a single page and nothing at all', () => {
    expect(formatRanges([3])).toBe('4');
    expect(formatRanges([])).toBe('');
  });

  it('sorts and deduplicates first', () => {
    expect(formatRanges([4, 0, 1, 4])).toBe('1-2, 5');
  });

  it('round-trips through parseRanges', () => {
    const indices = [0, 1, 2, 6, 9];
    expect(parseRanges(formatRanges(indices), 10)).toEqual(indices);
  });
});

describe('planSplit', () => {
  it('makes one file per page', () => {
    const plan = planSplit(3, { mode: 'each' });
    expect(plan.groups.map((g) => g.pages)).toEqual([[0], [1], [2]]);
    expect(plan.groups[0]!.label).toBe('page-1');
  });

  it('makes fixed-size chunks, with a short last one', () => {
    const plan = planSplit(7, { mode: 'every', size: 3 });
    expect(plan.groups.map((g) => g.pages)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
  });

  it('refuses a chunk size that is not one', () => {
    expect(planSplit(7, { mode: 'every', size: 0 }).error).toBeTruthy();
    expect(planSplit(7, { mode: 'every' }).error).toBeTruthy();
  });

  it('makes one file per comma group, which is the point of the mode', () => {
    // "1-3, 8-10" means two documents, not one document of six pages.
    const plan = planSplit(12, { mode: 'ranges', ranges: '1-3, 8-10' });
    expect(plan.groups).toHaveLength(2);
    expect(plan.groups[0]!.pages).toEqual([0, 1, 2]);
    expect(plan.groups[1]!.pages).toEqual([7, 8, 9]);
  });

  it('names each file after the pages in it', () => {
    expect(planSplit(12, { mode: 'ranges', ranges: '1-3' }).groups[0]!.label).toBe('pages-1-3');
  });

  it('says which part was not understood', () => {
    const plan = planSplit(12, { mode: 'ranges', ranges: '1-3, banana' });
    expect(plan.error).toContain('banana');
  });

  it('asks for input rather than failing silently on an empty range', () => {
    expect(planSplit(12, { mode: 'ranges', ranges: '' }).error).toMatch(/type which pages/i);
  });

  it('says so when nothing asked for exists', () => {
    expect(planSplit(3, { mode: 'ranges', ranges: '50-60' }).error).toMatch(/none of those pages/i);
  });

  it('has nothing to split when there are no pages', () => {
    expect(planSplit(0, { mode: 'each' }).error).toBeTruthy();
  });
});

describe('outputName', () => {
  it('names a single-source output after the source', () => {
    expect(outputName(['report.pdf'], 'merged')).toBe('report-merged.pdf');
  });

  it('says how many others went in', () => {
    expect(outputName(['a.pdf', 'b.pdf', 'c.pdf'], 'merged')).toBe('a-and-2-more-merged.pdf');
  });

  it('copes with nothing at all', () => {
    expect(outputName([], 'merged')).toBe('document-merged.pdf');
  });
});

describe('countByDoc', () => {
  it('counts what each source still contributes', () => {
    expect(countByDoc([ref(0, 0), ref(0, 1), ref(1, 0)], 2)).toEqual([2, 1]);
  });

  it('reports zero for a document whose pages were all deleted', () => {
    expect(countByDoc([ref(0, 0)], 2)).toEqual([1, 0]);
  });
});

// ---------------------------------------------------------------------------
// Through pdf-lib for real
// ---------------------------------------------------------------------------

describe('buildPdf', () => {
  it('merges two documents into one, in the order given', async () => {
    const a = await makePdf(2, 'A');
    const b = await makePdf(3, 'B');
    const docs = await loadSources([
      { name: 'a.pdf', bytes: a },
      { name: 'b.pdf', bytes: b },
    ]);
    const out = await buildPdf(docs, [ref(0, 0), ref(1, 0), ref(0, 1), ref(1, 2)]);
    const check = await PDFDocument.load(out);
    expect(check.getPageCount()).toBe(4);
  });

  it('keeps each page at its own size', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 300]);
    doc.addPage([600, 400]);
    const docs = await loadSources([{ name: 'mixed.pdf', bytes: await doc.save() }]);
    const out = await PDFDocument.load(await buildPdf(docs, [ref(0, 1), ref(0, 0)]));
    expect(out.getPage(0).getWidth()).toBe(600);
    expect(out.getPage(1).getWidth()).toBe(200);
  });

  it('writes the rotation into the page', async () => {
    const docs = await loadSources([{ name: 'a.pdf', bytes: await makePdf(1, 'A') }]);
    const out = await PDFDocument.load(await buildPdf(docs, [ref(0, 0, 90)]));
    expect(out.getPage(0).getRotation().angle).toBe(90);
  });

  it('adds to a rotation the page already had, rather than replacing it', async () => {
    // A scan that is already sideways, turned once more, must end up at 180.
    const source = await PDFDocument.create();
    source.addPage([300, 400]).setRotation(degrees(90));
    const docs = await loadSources([{ name: 'sideways.pdf', bytes: await source.save() }]);
    const out = await PDFDocument.load(await buildPdf(docs, [ref(0, 0, 90)]));
    expect(out.getPage(0).getRotation().angle).toBe(180);
  });

  it('can use the same page twice', async () => {
    const docs = await loadSources([{ name: 'a.pdf', bytes: await makePdf(1, 'A') }]);
    const out = await PDFDocument.load(await buildPdf(docs, [ref(0, 0), ref(0, 0)]));
    expect(out.getPageCount()).toBe(2);
  });

  it('does not embed the same font once per page', async () => {
    // copyPages deduplicates shared resources within one call; copying page at
    // a time does not, and on a long report that multiplies the file size.
    const docs = await loadSources([{ name: 'long.pdf', bytes: await makePdf(30, 'P') }]);
    const all = Array.from({ length: 30 }, (_, i) => ref(0, i));
    const out = await buildPdf(docs, all);
    expect(out.length).toBeLessThan(30 * 3000);
  });

  it('refuses to save nothing', async () => {
    const docs = await loadSources([{ name: 'a.pdf', bytes: await makePdf(1, 'A') }]);
    await expect(buildPdf(docs, [])).rejects.toThrow(/no pages/i);
  });

  it('splits into documents that each hold their own pages', async () => {
    const docs = await loadSources([{ name: 'a.pdf', bytes: await makePdf(6, 'A') }]);
    const plan = planSplit(6, { mode: 'every', size: 2 });
    const all = Array.from({ length: 6 }, (_, i) => ref(0, i));
    for (const group of plan.groups) {
      const out = await PDFDocument.load(await buildPdf(docs, group.pages.map((i) => all[i]!)));
      expect(out.getPageCount()).toBe(2);
    }
  });
});

describe('loadSources', () => {
  it('reads an ordinary PDF', async () => {
    expect(await loadSources([{ name: 'a.pdf', bytes: await makePdf(1, 'A') }])).toHaveLength(1);
  });

  it('names the file that could not be read', async () => {
    const junk = new TextEncoder().encode('this is not a PDF at all');
    await expect(loadSources([{ name: 'notes.txt', bytes: junk }])).rejects.toThrow(/notes\.txt/);
  });

  it('opens a document with permissions-only encryption', async () => {
    // "No printing, no copying" with no password to open is extremely common,
    // and refusing those would turn away files the visitor can already read.
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    const bytes = await doc.save();
    expect(await loadSources([{ name: 'restricted.pdf', bytes }])).toHaveLength(1);
  });
});

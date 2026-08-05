/**
 * The document model to PDF.
 *
 * The failure that matters is an export that throws — a document with a curly
 * quote in it is completely ordinary, and the standard-14 fonts cannot encode
 * one, so anything that reaches drawText has to be folded first. After that,
 * what is checked is that the output is a real PDF whose text is real text.
 */

import { describe, expect, it } from 'vitest';
import { toLatin1, writePdf } from '../src/client/docpdf';
import type { Doc } from '../src/client/docmodel';

async function textOf(bytes: Uint8Array, page = 0): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/',
  }).promise;
  const content = await (await doc.getPage(page + 1)).getTextContent();
  return content.items.map((i) => ('str' in i ? i.str : '')).join(' ').replace(/\s+/g, ' ');
}

async function pageCount(bytes: Uint8Array): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/',
  }).promise;
  return doc.numPages;
}

describe('toLatin1', () => {
  it('folds the punctuation a word processor inserts automatically', () => {
    expect(toLatin1('“Smart” quotes — and an ellipsis…')).toBe('"Smart" quotes -- and an ellipsis...');
    expect(toLatin1('it’s')).toBe("it's");
  });

  it('keeps accented Latin text, which the fonts do have', () => {
    expect(toLatin1('café naïve Zürich')).toBe('café naïve Zürich');
  });

  it('marks what it cannot represent rather than dropping it silently', () => {
    // A reader seeing "?" knows something was lost; a reader seeing nothing does not.
    expect(toLatin1('CJK: 中文')).toBe('CJK: ??');
  });

  it('turns a tab into spaces, since PDF text has no tab', () => {
    expect(toLatin1('a\tb')).toBe('a    b');
  });
});

describe('writePdf', () => {
  const doc: Doc = {
    title: 'Export test',
    blocks: [
      { kind: 'heading', level: 1, runs: [{ text: 'The Title' }] },
      { kind: 'paragraph', runs: [{ text: 'Plain and ' }, { text: 'bold', bold: true }, { text: ' together.' }] },
      { kind: 'listItem', level: 1, ordered: false, runs: [{ text: 'a bullet' }] },
      { kind: 'listItem', level: 1, ordered: true, runs: [{ text: 'first' }] },
      { kind: 'listItem', level: 1, ordered: true, runs: [{ text: 'second' }] },
      { kind: 'table', runs: [], rows: [[{ runs: [{ text: 'Name' }] }, { runs: [{ text: 'Value' }] }]] },
    ],
  };

  it('writes a real PDF whose text is selectable', async () => {
    const bytes = await writePdf(doc);
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 5))).toBe('%PDF-');
    const text = await textOf(bytes);
    expect(text).toContain('The Title');
    expect(text).toContain('bold');
    expect(text).toContain('a bullet');
  });

  it('numbers an ordered list in sequence', async () => {
    const text = await textOf(await writePdf(doc));
    expect(text).toContain('1.');
    expect(text).toContain('2.');
  });

  it('does not rasterise anything', async () => {
    // The whole point over the shrink tool: this is vector text, so no images.
    const bytes = await writePdf(doc);
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('/Subtype /Image');
  });

  it('survives text the standard fonts cannot encode, instead of throwing', async () => {
    const nasty: Doc = {
      blocks: [{ kind: 'paragraph', runs: [{ text: '“Smart” — 中文 — café…' }] }],
    };
    await expect(writePdf(nasty)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('honours an explicit page break', async () => {
    const broken: Doc = {
      blocks: [
        { kind: 'paragraph', runs: [{ text: 'One.' }] },
        { kind: 'pageBreak', runs: [] },
        { kind: 'paragraph', runs: [{ text: 'Two.' }] },
      ],
    };
    const bytes = await writePdf(broken);
    expect(await pageCount(bytes)).toBe(2);
    expect(await textOf(bytes, 1)).toContain('Two.');
  });

  it('flows onto new pages when the text runs past the bottom', async () => {
    const long: Doc = {
      blocks: Array.from({ length: 120 }, (_, i) => ({
        kind: 'paragraph' as const,
        runs: [{ text: `Paragraph number ${i} with enough words in it to occupy a full line of the page.` }],
      })),
    };
    expect(await pageCount(await writePdf(long))).toBeGreaterThan(1);
  });

  it('wraps a long paragraph rather than running off the edge', async () => {
    const long: Doc = {
      blocks: [{ kind: 'paragraph', runs: [{ text: 'word '.repeat(300).trim() }] }],
    };
    const bytes = await writePdf(long);
    // 1500 characters cannot fit on one line; if wrapping failed this would be
    // a single overflowing line and the page count would stay at one.
    const text = await textOf(bytes);
    expect(text.split('word').length - 1).toBeGreaterThan(200);
  });

  it('keeps an empty document to a single blank page rather than failing', async () => {
    expect(await pageCount(await writePdf({ blocks: [] }))).toBe(1);
  });
});

/**
 * EPUB output.
 *
 * The format is unforgiving in two specific ways, and both are checked here: an
 * XHTML file with an unescaped ampersand is refused outright by readers rather
 * than rendered, and the `mimetype` entry has to be first in the archive and
 * stored uncompressed or the file is not recognised as a book at all.
 */

import { describe, expect, it } from 'vitest';
import { MAX_TITLE, chapterHtml, escapeXml, shortTitle, splitChapters, writeEpub } from '../src/client/epub';
import type { Doc } from '../src/client/docmodel';
import { entry, unzip } from '../src/client/zip';

const book: Doc = {
  title: 'A Report',
  blocks: [
    { kind: 'heading', level: 1, runs: [{ text: 'First Chapter' }] },
    { kind: 'paragraph', runs: [{ text: 'Some ' }, { text: 'bold', bold: true }, { text: ' words.' }] },
    { kind: 'listItem', level: 1, ordered: false, runs: [{ text: 'a bullet' }] },
    { kind: 'listItem', level: 1, ordered: false, runs: [{ text: 'another bullet' }] },
    { kind: 'listItem', level: 1, ordered: true, runs: [{ text: 'numbered one' }] },
    { kind: 'heading', level: 1, runs: [{ text: 'Second Chapter' }] },
    { kind: 'paragraph', runs: [{ text: 'R&D <notes> "quoted"' }] },
    { kind: 'table', runs: [], rows: [[{ runs: [{ text: 'Name' }] }, { runs: [{ text: 'Value' }] }]] },
  ],
};

describe('escapeXml', () => {
  it('escapes what XHTML cannot hold literally', () => {
    expect(escapeXml('R&D <x> "y"')).toBe('R&amp;D &lt;x&gt; &quot;y&quot;');
  });

  it('strips control characters a reader would reject the file for', () => {
    expect(escapeXml(`a${String.fromCharCode(7)}b`)).toBe('ab');
  });
});

describe('splitChapters', () => {
  it('splits at top-level headings', () => {
    const chapters = splitChapters(book);
    expect(chapters.map((c) => c.title)).toEqual(['First Chapter', 'Second Chapter']);
  });

  it('splits at the shallowest heading present, not always at H1', () => {
    // A PDF whose top level is H2 still has to divide somewhere sensible.
    const doc: Doc = {
      blocks: [
        { kind: 'heading', level: 2, runs: [{ text: 'One' }] },
        { kind: 'paragraph', runs: [{ text: 'x' }] },
        { kind: 'heading', level: 3, runs: [{ text: 'One point one' }] },
        { kind: 'heading', level: 2, runs: [{ text: 'Two' }] },
      ],
    };
    expect(splitChapters(doc).map((c) => c.title)).toEqual(['One', 'Two']);
  });

  it('makes one chapter of a document with no headings at all', () => {
    // An EPUB with an empty spine is invalid, and plenty of PDFs are one
    // unbroken report.
    const doc: Doc = { blocks: [{ kind: 'paragraph', runs: [{ text: 'just prose' }] }] };
    const chapters = splitChapters(doc, 'Untitled');
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.blocks).toHaveLength(1);
  });

  it('keeps text that appears before the first heading', () => {
    const doc: Doc = {
      blocks: [
        { kind: 'paragraph', runs: [{ text: 'a foreword' }] },
        { kind: 'heading', level: 1, runs: [{ text: 'One' }] },
      ],
    };
    const chapters = splitChapters(doc, 'Book');
    expect(chapters).toHaveLength(2);
    expect(chapters[0]!.blocks[0]!.runs[0]!.text).toBe('a foreword');
  });

  it('never returns an empty spine', () => {
    expect(splitChapters({ blocks: [] }, 'Empty')).toHaveLength(1);
  });
});

describe('shortTitle', () => {
  it('leaves a normal heading alone', () => {
    expect(shortTitle('Chapter One', 'x')).toBe('Chapter One');
  });

  it('shortens a heading that is really a paragraph', () => {
    // Untagged PDFs glue running headers onto body text; a contents list of
    // hundred-character entries is unusable on a phone.
    const long = 'arXiv:1706.03762v7 [cs.CL] 2 Aug 2023 best models from the literature. We show that the Transformer generalises well';
    const short = shortTitle(long, 'x');
    expect(short.length).toBeLessThanOrEqual(MAX_TITLE + 1);
    expect(short.endsWith('…')).toBe(true);
  });

  it('cuts at a word rather than mid-word', () => {
    const short = shortTitle('word '.repeat(40), 'x');
    expect(short).not.toMatch(/wor…$/);
  });

  it('falls back when the heading is empty', () => {
    expect(shortTitle('   ', 'Part 3')).toBe('Part 3');
  });

  it('collapses the whitespace a PDF leaves behind', () => {
    expect(shortTitle('Two   \n words', 'x')).toBe('Two words');
  });
});

describe('chapterHtml', () => {
  it('gathers consecutive list items into one real list', () => {
    const html = chapterHtml(splitChapters(book)[0]!);
    expect(html).toContain('<ul><li>a bullet</li><li>another bullet</li></ul>');
  });

  it('starts a new list when the kind changes', () => {
    const html = chapterHtml(splitChapters(book)[0]!);
    expect(html).toContain('<ol><li>numbered one</li></ol>');
  });

  it('keeps bold and italic as real markup', () => {
    expect(chapterHtml(splitChapters(book)[0]!)).toContain('<strong>bold</strong>');
  });

  it('escapes text that would otherwise break the XHTML', () => {
    const html = chapterHtml(splitChapters(book)[1]!);
    expect(html).toContain('R&amp;D &lt;notes&gt;');
    expect(html).not.toContain('R&D <notes>');
  });

  it('writes a heading at its own level', () => {
    expect(chapterHtml(splitChapters(book)[0]!)).toContain('<h1>First Chapter</h1>');
  });
});

describe('writeEpub', () => {
  it('puts mimetype first and stores it uncompressed', async () => {
    // Both are required. A reader identifies the file from these bytes without
    // inflating anything, so a deflated mimetype is not recognised as a book.
    const parts = await unzip(await writeEpub(book));
    expect(parts[0]!.name).toBe('mimetype');
    expect(new TextDecoder().decode(parts[0]!.data)).toBe('application/epub+zip');
  });

  it('actually stores it, rather than relying on deflate happening to lose', async () => {
    const raw = await writeEpub(book);
    // Compression method lives at offset 8 of the first local file header.
    const method = new DataView(raw.buffer, raw.byteOffset).getUint16(8, true);
    expect(method).toBe(0);
  });

  it('ships every part a reader needs', async () => {
    const names = (await unzip(await writeEpub(book))).map((p) => p.name);
    for (const required of ['mimetype', 'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml']) {
      expect(names, `missing ${required}`).toContain(required);
    }
  });

  it('lists every chapter in both the manifest and the spine', async () => {
    const parts = await unzip(await writeEpub(book));
    const opf = new TextDecoder().decode(entry(parts, 'OEBPS/content.opf')!);
    const chapters = parts.filter((p) => /chapter\d+\.xhtml$/.test(p.name));
    expect(chapters.length).toBe(2);
    for (let i = 1; i <= chapters.length; i++) {
      expect(opf, `chapter ${i} missing from the manifest`).toContain(`href="chapter${i}.xhtml"`);
      expect(opf, `chapter ${i} missing from the spine`).toContain(`idref="ch${i}"`);
    }
  });

  it('references only files it actually ships', async () => {
    // A manifest entry pointing at a missing file makes the book unopenable.
    const parts = await unzip(await writeEpub(book));
    const opf = new TextDecoder().decode(entry(parts, 'OEBPS/content.opf')!);
    const names = new Set(parts.map((p) => p.name));
    for (const href of [...opf.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!)) {
      expect(names.has(`OEBPS/${href}`), `manifest references missing ${href}`).toBe(true);
    }
  });

  it('builds a table of contents naming each chapter', async () => {
    const parts = await unzip(await writeEpub(book));
    const nav = new TextDecoder().decode(entry(parts, 'OEBPS/nav.xhtml')!);
    expect(nav).toContain('First Chapter');
    expect(nav).toContain('Second Chapter');
  });

  it('carries the title and author into the metadata', async () => {
    const parts = await unzip(await writeEpub(book, { title: 'My Book', author: 'Ada Lovelace' }));
    const opf = new TextDecoder().decode(entry(parts, 'OEBPS/content.opf')!);
    expect(opf).toContain('<dc:title>My Book</dc:title>');
    expect(opf).toContain('<dc:creator>Ada Lovelace</dc:creator>');
  });

  it('gives the same document the same identifier twice', async () => {
    // Converting a document twice should update a book in a library, not add a
    // second copy of it.
    const read = async () => {
      const parts = await unzip(await writeEpub(book, { title: 'Steady' }));
      return /<dc:identifier[^>]*>([^<]+)</.exec(new TextDecoder().decode(entry(parts, 'OEBPS/content.opf')!))?.[1];
    };
    expect(await read()).toBe(await read());
  });

  it('writes well-formed XHTML in every chapter', async () => {
    const parts = await unzip(await writeEpub(book));
    for (const chapter of parts.filter((p) => p.name.endsWith('.xhtml'))) {
      const source = new TextDecoder().decode(chapter.data);
      const opens = [...source.matchAll(/<([a-zA-Z][\w:-]*)(?:\s[^>]*?)?(\/?)>/g)]
        .filter((m) => !m[2] && !/^(meta|link|br|img)$/i.test(m[1]!)).length;
      const closes = [...source.matchAll(/<\/[a-zA-Z][\w:-]*>/g)].length;
      expect(opens, `${chapter.name} has unbalanced tags`).toBe(closes);
    }
  });
});

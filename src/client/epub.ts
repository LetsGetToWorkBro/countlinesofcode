/**
 * The shared document model to EPUB.
 *
 * This is the format PDF should have been for reading. A PDF is a fixed page:
 * on a phone you pinch and pan across a sheet designed for A4. An EPUB
 * re-flows, so the same book fits whatever screen it lands on, at whatever text
 * size the reader wants. Converting a long PDF to EPUB is the difference
 * between a document you can file and a document you can read.
 *
 * An EPUB is a ZIP with a fixed shape:
 *
 *   mimetype                 first, stored uncompressed — the spec is strict
 *   META-INF/container.xml   points at the package document
 *   OEBPS/content.opf        metadata, manifest, and the reading order
 *   OEBPS/nav.xhtml          the table of contents
 *   OEBPS/chapterN.xhtml     the text itself, as XHTML
 *
 * Chapters are split at top-level headings, because that is what a reader's
 * "next chapter" gesture expects to land on, and because one enormous XHTML
 * file makes e-readers slow and their progress bars meaningless.
 */

import { blockText, type Block, type Doc } from './docmodel';
import { zip, type ZipEntry } from './zip';

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s);

/** XHTML is XML, so an unescaped ampersand is a file the reader refuses. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export interface EpubMeta {
  title?: string;
  author?: string;
  /** Stable identifier. A reader uses it to tell two books apart. */
  identifier?: string;
  language?: string;
}

export interface Chapter {
  title: string;
  blocks: Block[];
}

/**
 * A chapter title is a table-of-contents entry, not a sentence.
 *
 * On an untagged PDF the heading detector sometimes glues a running header to
 * the first line of body text, and a contents list of hundred-character
 * paragraphs is unusable on a phone. The full text stays in the chapter; only
 * the entry that points at it is shortened.
 */
export const MAX_TITLE = 80;

export function shortTitle(value: string, fallback: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  if (clean.length <= MAX_TITLE) return clean;
  // Cut at a word boundary where there is one close to the limit.
  const cut = clean.slice(0, MAX_TITLE);
  const space = cut.lastIndexOf(' ');
  return (space > MAX_TITLE * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

/**
 * Split the document into chapters at its top-level headings.
 *
 * A document with no headings at all becomes one chapter rather than none —
 * plenty of PDFs are a single unbroken report, and an EPUB with an empty spine
 * is invalid.
 */
export function splitChapters(doc: Doc, title = 'Document'): Chapter[] {
  const headings = doc.blocks.filter((b) => b.kind === 'heading');
  // Split at the shallowest heading level present, so a document whose top
  // level is H2 still divides sensibly.
  const top = headings.length ? Math.min(...headings.map((h) => h.level ?? 1)) : 0;

  const chapters: Chapter[] = [];
  let current: Chapter | null = null;

  for (const block of doc.blocks) {
    if (block.kind === 'pageBreak') continue; // a page is not a chapter
    if (top && block.kind === 'heading' && (block.level ?? 1) === top) {
      current = { title: shortTitle(blockText(block), `Part ${chapters.length + 1}`), blocks: [block] };
      chapters.push(current);
      continue;
    }
    if (!current) {
      current = { title: title, blocks: [] };
      chapters.push(current);
    }
    current.blocks.push(block);
  }

  const useful = chapters.filter((c) => c.blocks.length);
  return useful.length ? useful : [{ title, blocks: [] }];
}

function runsHtml(block: Block): string {
  return block.runs
    .map((run) => {
      let html = escapeXml(run.text).replace(/\n/g, '<br/>');
      if (run.bold) html = `<strong>${html}</strong>`;
      if (run.italic) html = `<em>${html}</em>`;
      return html;
    })
    .join('');
}

function blockHtml(block: Block): string {
  if (block.kind === 'heading') {
    const level = Math.min(Math.max(block.level ?? 1, 1), 6);
    return `<h${level}>${runsHtml(block)}</h${level}>`;
  }
  if (block.kind === 'table') {
    const rows = (block.rows ?? [])
      .map((row) => `<tr>${row.map((cell) => `<td>${runsHtml({ ...block, runs: cell.runs })}</td>`).join('')}</tr>`)
      .join('');
    return `<table>${rows}</table>`;
  }
  if (block.kind === 'pageBreak') return '';
  // List items are wrapped into real lists by chapterHtml, which can see their
  // neighbours; on their own they are just paragraphs with a marker.
  return `<p>${runsHtml(block)}</p>`;
}

/** One chapter as XHTML, with runs of list items gathered into real lists. */
export function chapterHtml(chapter: Chapter): string {
  const parts: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    parts.push(`<${tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${tag}>`);
    list = null;
  };

  for (const block of chapter.blocks) {
    if (block.kind === 'listItem') {
      const ordered = Boolean(block.ordered);
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push(runsHtml(block));
      continue;
    }
    flush();
    const html = blockHtml(block);
    if (html) parts.push(html);
  }
  flush();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escapeXml(chapter.title)}</title><meta charset="utf-8"/>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>${parts.join('\n')}</body>
</html>`;
}

/**
 * Minimal styling.
 *
 * Deliberately almost nothing: an e-reader's own typography is better tuned to
 * its screen than anything guessed here, and a book that overrides the reader's
 * font size is a book people put down. This sets spacing and leaves the rest.
 */
const STYLESHEET = `body { margin: 0 5%; line-height: 1.4; }
h1, h2, h3, h4, h5, h6 { line-height: 1.2; margin: 1.2em 0 0.4em 0; }
p { margin: 0 0 0.8em 0; }
table { border-collapse: collapse; margin: 0.8em 0; }
td { border: 1px solid #888; padding: 2px 5px; vertical-align: top; }
ul, ol { margin: 0 0 0.8em 1.2em; padding: 0; }
`;

export async function writeEpub(doc: Doc, meta: EpubMeta = {}): Promise<Uint8Array> {
  const title = meta.title || doc.title || 'Document';
  const author = meta.author || 'Unknown';
  const language = meta.language || 'en';
  // A book needs a stable identifier; derived from the title so converting the
  // same document twice does not produce two different books in a library.
  const identifier = meta.identifier || `loc1999:${title.replace(/\s+/g, '-').toLowerCase().slice(0, 60)}`;
  const chapters = splitChapters(doc, title);

  const manifest = chapters
    .map((_, i) => `<item id="ch${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('');
  const spine = chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('');
  const navItems = chapters
    .map((c, i) => `<li><a href="chapter${i + 1}.xhtml">${escapeXml(c.title)}</a></li>`)
    .join('');

  const parts: ZipEntry[] = [
    // First, and stored: a reader identifies the file from these bytes.
    { name: 'mimetype', data: bytes('application/epub+zip'), store: true },
    {
      name: 'META-INF/container.xml',
      data: bytes(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    },
    {
      name: 'OEBPS/content.opf',
      data: bytes(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${escapeXml(identifier)}</dc:identifier>
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>${escapeXml(author)}</dc:creator>
<dc:language>${escapeXml(language)}</dc:language>
<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
${manifest}
</manifest>
<spine>${spine}</spine>
</package>`),
    },
    {
      name: 'OEBPS/nav.xhtml',
      data: bytes(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escapeXml(title)}</title><meta charset="utf-8"/></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navItems}</ol></nav></body>
</html>`),
    },
    { name: 'OEBPS/style.css', data: bytes(STYLESHEET) },
    ...chapters.map((chapter, i) => ({
      name: `OEBPS/chapter${i + 1}.xhtml`,
      data: bytes(chapterHtml(chapter)),
    })),
  ];

  return zip(parts);
}

/**
 * The shared document model to PDF.
 *
 * This lays the document out afresh rather than trying to reproduce, pixel for
 * pixel, what Word would have printed. Matching Word's pagination exactly needs
 * Word's own font metrics — Calibri and Cambria are not free fonts, and the
 * metric-compatible substitutes are another megabyte and a font embedder. So
 * the honest description, which the page gives, is: a clean, correctly typeset
 * PDF of your document, with real selectable text, that breaks its lines where
 * *this* typesetter breaks them.
 *
 * Everything is drawn as vector text. Nothing is rasterised, so the output is
 * small, sharp at any zoom, searchable, and copies out cleanly.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Block, Doc, Run } from './docmodel';

/** A4, and margins wide enough to read comfortably. */
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = { top: 64, right: 56, bottom: 64, left: 56 };
const BODY_SIZE = 11;
const LINE_HEIGHT = 1.38;
const PARAGRAPH_GAP = 6;
const LIST_INDENT = 22;

/** Point size for each heading level, and the gap above it. */
const HEADING = [
  { size: 20, before: 16, after: 6 },
  { size: 16, before: 14, after: 5 },
  { size: 13.5, before: 12, after: 4 },
  { size: 12, before: 10, after: 4 },
  { size: 11.5, before: 9, after: 3 },
  { size: 11, before: 8, after: 3 },
];

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

const fontFor = (fonts: Fonts, run: Run): PDFFont =>
  run.bold && run.italic ? fonts.boldItalic : run.bold ? fonts.bold : run.italic ? fonts.italic : fonts.regular;

/**
 * The standard-14 fonts cover Latin-1 and nothing else, and pdf-lib throws on a
 * character outside that. A document with a curly quote or an em dash is
 * completely ordinary, so those are folded to what the font does have rather
 * than being allowed to fail the export.
 */
export function toLatin1(text: string): string {
  const swaps: Record<string, string> = {
    '‘': "'", '’': "'", '‚': ',', '‛': "'",
    '“': '"', '”': '"', '„': '"',
    '–': '-', '—': '--', '―': '--', '−': '-',
    '…': '...', '•': '·', ' ': ' ',
    '‹': '<', '›': '>', '⁄': '/', 'ˆ': '^', '˜': '~',
    '\t': '    ',
  };
  let out = '';
  for (const ch of text.replace(/[‘-„–-―…• ‹›⁄ˆ˜−\t]/g, (c) => swaps[c] ?? c)) {
    const code = ch.codePointAt(0) ?? 0;
    // Printable Latin-1 only; anything else becomes a question mark so the
    // reader can see something was lost rather than silently losing it.
    out += code === 10 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255) ? ch : '?';
  }
  return out;
}

/** A word with the font it is set in, ready to be measured. */
interface Word {
  text: string;
  run: Run;
  width: number;
}

function wordsOf(runs: Run[], fonts: Fonts, size: number): Word[] {
  const words: Word[] = [];
  for (const run of runs) {
    const font = fontFor(fonts, run);
    // Keep the spaces: splitting on them and re-adding loses double spaces and
    // makes "end. Next" and "end.Next" indistinguishable.
    for (const piece of toLatin1(run.text).split(/(\s+)/)) {
      if (!piece) continue;
      words.push({ text: piece, run, width: font.widthOfTextAtSize(piece, size) });
    }
  }
  return words;
}

/** Break words into lines that fit `maxWidth`. Long unbreakable words overflow. */
export function wrap(words: Word[], maxWidth: number): Word[][] {
  const lines: Word[][] = [];
  let line: Word[] = [];
  let width = 0;

  for (const word of words) {
    const blank = /^\s+$/.test(word.text);
    if (blank && !line.length) continue; // no leading spaces on a fresh line
    if (!blank && line.length && width + word.width > maxWidth) {
      // Trailing spaces do not belong at the end of a wrapped line.
      while (line.length && /^\s+$/.test(line[line.length - 1]!.text)) line.pop();
      lines.push(line);
      line = [];
      width = 0;
    }
    line.push(word);
    width += word.width;
  }
  while (line.length && /^\s+$/.test(line[line.length - 1]!.text)) line.pop();
  if (line.length) lines.push(line);
  return lines;
}

interface Cursor {
  page: PDFPage;
  y: number;
}

export interface PdfOptions {
  /** Base body size in points. Headings scale from it. */
  bodySize?: number;
}

export async function writePdf(doc: Doc, options: PdfOptions = {}): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  if (doc.title) out.setTitle(doc.title);
  const fonts: Fonts = {
    regular: await out.embedFont(StandardFonts.Helvetica),
    bold: await out.embedFont(StandardFonts.HelveticaBold),
    italic: await out.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await out.embedFont(StandardFonts.HelveticaBoldOblique),
  };
  const base = options.bodySize ?? BODY_SIZE;
  const contentWidth = PAGE.width - MARGIN.left - MARGIN.right;

  const cursor: Cursor = { page: out.addPage([PAGE.width, PAGE.height]), y: PAGE.height - MARGIN.top };
  const newPage = () => {
    cursor.page = out.addPage([PAGE.width, PAGE.height]);
    cursor.y = PAGE.height - MARGIN.top;
  };
  const need = (height: number) => {
    if (cursor.y - height < MARGIN.bottom) newPage();
  };

  /** Draw one wrapped line, word by word, so each run keeps its own font. */
  const drawLine = (line: Word[], x: number, y: number, size: number) => {
    let at = x;
    for (const word of line) {
      if (!/^\s+$/.test(word.text)) {
        cursor.page.drawText(word.text, {
          x: at,
          y,
          size,
          font: fontFor(fonts, word.run),
          color: rgb(0, 0, 0),
        });
      }
      at += word.width;
    }
  };

  const drawParagraph = (runs: Run[], size: number, indent: number, marker?: string) => {
    const width = contentWidth - indent;
    const lines = wrap(wordsOf(runs, fonts, size), width);
    const step = size * LINE_HEIGHT;
    lines.forEach((line, index) => {
      need(step);
      if (index === 0 && marker) {
        cursor.page.drawText(toLatin1(marker), {
          x: MARGIN.left + indent - LIST_INDENT + 4,
          y: cursor.y - size,
          size,
          font: fonts.regular,
          color: rgb(0, 0, 0),
        });
      }
      drawLine(line, MARGIN.left + indent, cursor.y - size, size);
      cursor.y -= step;
    });
    if (!lines.length) cursor.y -= step;
  };

  const drawTable = (block: Block) => {
    const rows = block.rows ?? [];
    if (!rows.length) return;
    const columns = Math.max(...rows.map((r) => r.length));
    const columnWidth = contentWidth / columns;
    const padding = 4;
    const size = base - 0.5;

    for (const row of rows) {
      // Wrap every cell first, so the row is as tall as its fullest cell.
      const wrapped = row.map((cell) => wrap(wordsOf(cell.runs, fonts, size), columnWidth - padding * 2));
      const lineCount = Math.max(1, ...wrapped.map((w) => w.length));
      const rowHeight = lineCount * size * LINE_HEIGHT + padding * 2;
      need(rowHeight);

      const top = cursor.y;
      wrapped.forEach((cellLines, column) => {
        const x = MARGIN.left + column * columnWidth;
        let y = top - padding - size;
        for (const line of cellLines) {
          drawLine(line, x + padding, y, size);
          y -= size * LINE_HEIGHT;
        }
      });

      // The grid, drawn after the text so a border never sits on a glyph.
      for (let column = 0; column <= columns; column++) {
        const x = MARGIN.left + column * columnWidth;
        cursor.page.drawLine({
          start: { x, y: top },
          end: { x, y: top - rowHeight },
          thickness: 0.5,
          color: rgb(0.4, 0.4, 0.4),
        });
      }
      for (const y of [top, top - rowHeight]) {
        cursor.page.drawLine({
          start: { x: MARGIN.left, y },
          end: { x: MARGIN.left + columnWidth * columns, y },
          thickness: 0.5,
          color: rgb(0.4, 0.4, 0.4),
        });
      }
      cursor.y -= rowHeight;
    }
    cursor.y -= PARAGRAPH_GAP;
  };

  let counter = 0;
  for (const block of doc.blocks) {
    if (block.kind === 'pageBreak') {
      newPage();
      counter = 0;
      continue;
    }

    if (block.kind === 'heading') {
      const style = HEADING[Math.min(Math.max(block.level ?? 1, 1), 6) - 1]!;
      const size = (style.size / BODY_SIZE) * base;
      cursor.y -= style.before;
      need(size * LINE_HEIGHT);
      // Headings are bold whatever the source said, which is what a heading is.
      drawParagraph(block.runs.map((r) => ({ ...r, bold: true })), size, 0);
      cursor.y -= style.after;
      counter = 0;
      continue;
    }

    if (block.kind === 'listItem') {
      const depth = Math.max(block.level ?? 1, 1);
      const indent = LIST_INDENT * depth;
      counter = block.ordered ? counter + 1 : 0;
      drawParagraph(block.runs, base, indent, block.ordered ? `${counter}.` : '·');
      cursor.y -= 2;
      continue;
    }

    if (block.kind === 'table') {
      drawTable(block);
      counter = 0;
      continue;
    }

    drawParagraph(block.runs, base, 0);
    cursor.y -= PARAGRAPH_GAP;
    counter = 0;
  }

  return out.save({ useObjectStreams: true });
}

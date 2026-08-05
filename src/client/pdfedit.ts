/**
 * The sign-and-redact engine, bundled to public/pdfsign.js.
 *
 * Runs entirely in the visitor's tab, like everything else here. The page is
 * rendered by pdf.js (vendored, not bundled — see scripts/vendor-pdfjs.mjs) and
 * written by pdf-lib; this module owns the part in between: where a click lands
 * on the page, and how a redaction is made real.
 *
 * The one thing worth understanding before changing anything below:
 *
 *   Drawing a black rectangle over text is NOT redaction. The text stays in the
 *   content stream, and anyone can select it, search it, or paste the file into
 *   a chatbot and ask what is under the box. Every redaction here works by
 *   rasterising the whole page — rendering it to pixels with the boxes painted
 *   in — so the characters stop existing rather than being covered up.
 *
 * That is why `applyEdits` takes a rendered image for redacted pages: this
 * module cannot rasterise on its own (that needs a canvas, and this file is
 * deliberately DOM-free so it unit tests under Node), so the caller renders and
 * hands the pixels over.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/** A point in PDF user space: origin bottom-left, units of 1/72 inch. */
export interface PdfPoint {
  x: number;
  y: number;
}

/** A rectangle in PDF user space, normalised so width and height are positive. */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextEdit {
  kind: 'text';
  page: number;
  at: PdfPoint;
  value: string;
  size: number;
}

export interface StampEdit {
  kind: 'stamp';
  page: number;
  at: PdfPoint;
  /** PNG bytes — a drawn signature, a typed one, or an uploaded image. */
  png: Uint8Array;
  /** Width in points; height follows from the image's aspect ratio. */
  width: number;
}

export interface RedactEdit {
  kind: 'redact';
  page: number;
  rect: PdfRect;
}

export type Edit = TextEdit | StampEdit | RedactEdit;

/**
 * Turn a click on a rendered canvas into a point in PDF user space.
 *
 * Canvas coordinates run top-down from the top-left; PDF coordinates run
 * bottom-up from the bottom-left. `scale` is the pdf.js viewport scale used to
 * render, so dividing by it undoes the zoom.
 *
 * Page rotation is handled by the caller passing the *viewport's* dimensions,
 * because pdf.js has already applied the rotation when it produced them.
 */
export function canvasToPdf(
  point: { x: number; y: number },
  viewport: { width: number; height: number; scale: number },
): PdfPoint {
  return {
    x: point.x / viewport.scale,
    y: (viewport.height - point.y) / viewport.scale,
  };
}

/** The same conversion for a dragged box, normalised so the rect is positive. */
export function canvasRectToPdf(
  from: { x: number; y: number },
  to: { x: number; y: number },
  viewport: { width: number; height: number; scale: number },
): PdfRect {
  const a = canvasToPdf(from, viewport);
  const b = canvasToPdf(to, viewport);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Which pages carry a redaction, and therefore have to be flattened. */
export function pagesNeedingRaster(edits: Edit[]): Set<number> {
  const pages = new Set<number>();
  for (const edit of edits) if (edit.kind === 'redact') pages.add(edit.page);
  return pages;
}

/**
 * A redaction box smaller than this is almost certainly a stray click rather
 * than a selection, and silently flattening a whole page because of a stray
 * click is a nasty surprise.
 */
export const MIN_REDACTION_POINTS = 4;

export function usefulRedactions(edits: Edit[]): RedactEdit[] {
  return edits.filter(
    (e): e is RedactEdit =>
      e.kind === 'redact' && e.rect.width >= MIN_REDACTION_POINTS && e.rect.height >= MIN_REDACTION_POINTS,
  );
}

export interface RasterPage {
  page: number;
  /** PNG of the whole page, with the redaction boxes already painted in. */
  png: Uint8Array;
}

/**
 * Write the edits into a new PDF.
 *
 * Pages with no redaction are copied intact, so their text stays selectable and
 * their links keep working. Pages with a redaction are replaced outright by the
 * caller's rendered image: that is what makes the redaction real, and it is
 * also why those pages stop being selectable text. The page says so.
 *
 * Text and signatures are drawn *after* the image, so they stay crisp vector
 * content even on a flattened page.
 */
export async function applyEdits(
  source: Uint8Array,
  edits: Edit[],
  rasters: RasterPage[],
): Promise<Uint8Array> {
  const src = await PDFDocument.load(source, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const rasterByPage = new Map(rasters.map((r) => [r.page, r.png]));
  const pageCount = src.getPageCount();

  for (let index = 0; index < pageCount; index++) {
    const raster = rasterByPage.get(index);
    let page;

    if (raster) {
      // Replace the page rather than draw over it: nothing of the original
      // content stream survives, which is the entire point.
      const original = src.getPage(index);
      const { width, height } = original.getSize();
      page = out.addPage([width, height]);
      const image = await out.embedPng(raster);
      page.drawImage(image, { x: 0, y: 0, width, height });
    } else {
      const [copied] = await out.copyPages(src, [index]);
      if (!copied) throw new Error(`Could not copy page ${index + 1}.`);
      out.addPage(copied);
      page = copied;
    }

    for (const edit of edits) {
      if (edit.page !== index) continue;
      if (edit.kind === 'text') {
        if (!edit.value) continue;
        // drawText does not wrap, and a literal newline throws in pdf-lib, so
        // lines are placed one below another at the requested size.
        const lines = edit.value.split('\n');
        lines.forEach((line, offset) => {
          page.drawText(line, {
            x: edit.at.x,
            y: edit.at.y - offset * edit.size * 1.2,
            size: edit.size,
            font,
            color: rgb(0, 0, 0),
          });
        });
      } else if (edit.kind === 'stamp') {
        const image = await out.embedPng(edit.png);
        const height = (image.height / image.width) * edit.width;
        page.drawImage(image, {
          x: edit.at.x,
          // The click marks the top-left of the signature, which is what it
          // looks like on screen; PDF places images from the bottom-left.
          y: edit.at.y - height,
          width: edit.width,
          height,
        });
      }
    }
  }

  return out.save({ useObjectStreams: true });
}

// Published on the global object rather than as a module export, matching the
// other bundles: loaded with a plain <script> tag, no module plumbing on the
// page. Assigned through globalThis so the pure helpers unit test under Node.
const globalScope = globalThis as unknown as {
  LOC1999_SIGN?: {
    applyEdits: typeof applyEdits;
    canvasToPdf: typeof canvasToPdf;
    canvasRectToPdf: typeof canvasRectToPdf;
    pagesNeedingRaster: typeof pagesNeedingRaster;
    usefulRedactions: typeof usefulRedactions;
    MIN_REDACTION_POINTS: number;
  };
};
globalScope.LOC1999_SIGN = {
  applyEdits,
  canvasToPdf,
  canvasRectToPdf,
  pagesNeedingRaster,
  usefulRedactions,
  MIN_REDACTION_POINTS,
};

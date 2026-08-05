/**
 * The PDF tool's engine, bundled to public/pdfkit.js.
 *
 * Everything here runs in the visitor's tab. No file, and no byte of a file,
 * is ever sent anywhere — which is the entire reason to use this instead of
 * the sites that ask you to upload a contract to find out how many pages it
 * has. The Worker serves static bytes and never sees the document.
 *
 * pdf-lib is bundled in rather than loaded from a CDN because the site's
 * Content-Security-Policy is `script-src 'self'`. That is deliberate: a CDN
 * script tag is an invitation to have someone else's code read your files.
 */

import { PDFDocument, degrees, StandardFonts, rgb } from 'pdf-lib';

export interface PageRef {
  /** Index of the source file this page came from. */
  file: number;
  /** Zero-based page index within that file. */
  page: number;
  rotate: number;
}

export interface LoadedPdf {
  name: string;
  bytes: Uint8Array;
  pageCount: number;
  /** Page sizes in points, for the "A4 / Letter / mixed" line. */
  sizes: { width: number; height: number }[];
  encrypted: boolean;
}

/**
 * Read a PDF far enough to describe it.
 *
 * `ignoreEncryption` lets pdf-lib open documents that carry an owner password
 * (the "you may not print this" kind, which browsers open freely anyway). A
 * document needing a *user* password to open cannot be read at all, and throws
 * — the caller turns that into an honest error rather than a silent skip.
 */
export async function loadPdf(name: string, data: ArrayBuffer): Promise<LoadedPdf> {
  const bytes = new Uint8Array(data);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const sizes = doc.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight() }));
  return {
    name,
    bytes,
    pageCount: doc.getPageCount(),
    sizes,
    encrypted: doc.isEncrypted,
  };
}

/**
 * Build one PDF from an explicit list of pages.
 *
 * Every operation the tool offers — merge, split, extract, delete, reorder,
 * rotate — is this one function with a different list. That is why the preview
 * can be trusted: what you see selected is literally the argument passed here.
 */
export async function assemble(sources: LoadedPdf[], pages: PageRef[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  // Cache each source document so a 400-page merge parses each file once
  // rather than once per page.
  const loaded = new Map<number, PDFDocument>();

  for (const ref of pages) {
    let doc = loaded.get(ref.file);
    if (!doc) {
      const src = sources[ref.file];
      if (!src) throw new Error(`Missing source file ${ref.file}.`);
      doc = await PDFDocument.load(src.bytes, { ignoreEncryption: true });
      loaded.set(ref.file, doc);
    }
    const [copied] = await out.copyPages(doc, [ref.page]);
    if (!copied) throw new Error('That page could not be copied.');
    if (ref.rotate) {
      const current = copied.getRotation().angle;
      copied.setRotation(degrees(normaliseAngle(current + ref.rotate)));
    }
    out.addPage(copied);
  }

  if (out.getPageCount() === 0) throw new Error('That would produce a PDF with no pages.');
  return out.save({ useObjectStreams: true });
}

function normaliseAngle(angle: number): number {
  // pdf-lib rejects rotations that are not multiples of 90, and negative
  // values are legal in the spec but confusing in a UI.
  const rounded = Math.round(angle / 90) * 90;
  return ((rounded % 360) + 360) % 360;
}

export interface NumberOptions {
  /** 1-based page to begin numbering from. Pages before it are left alone. */
  startAt: number;
  /** The number printed on `startAt`. Lets you continue another document. */
  firstNumber: number;
  position: 'bottom-center' | 'bottom-right' | 'top-right';
  size: number;
}

/** Stamp page numbers onto an existing PDF. */
export async function addPageNumbers(bytes: Uint8Array, options: NumberOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  pages.forEach((page, index) => {
    if (index + 1 < options.startAt) return;
    const label = String(options.firstNumber + (index + 1 - options.startAt));
    const width = font.widthOfTextAtSize(label, options.size);
    const { width: pw, height: ph } = page.getSize();
    const margin = 24;

    let x = pw / 2 - width / 2;
    let y = margin;
    if (options.position === 'bottom-right') x = pw - margin - width;
    if (options.position === 'top-right') {
      x = pw - margin - width;
      y = ph - margin - options.size;
    }

    page.drawText(label, { x, y, size: options.size, font, color: rgb(0, 0, 0) });
  });

  return doc.save({ useObjectStreams: true });
}

/**
 * The only two image formats PDF can embed directly.
 *
 * Anything else — HEIC, WebP, AVIF, GIF — has to be re-encoded first. That
 * happens in the page script rather than here, because it needs a canvas, and
 * this module is deliberately free of DOM: it takes bytes and returns bytes,
 * which is what makes it unit testable under Node. (It also cannot import DOM
 * types at all: the tsconfig uses @cloudflare/workers-types, and those two
 * type libraries contradict each other over `fetch` and friends.)
 */
export const EMBEDDABLE_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const;

export interface ImageToPdfOptions {
  /** Page size in points, or `fit` to make each page match its image. */
  pageSize: 'fit' | 'a4' | 'letter';
  marginPt: number;
}

const A4 = { width: 595.28, height: 841.89 };
const LETTER = { width: 612, height: 792 };

/**
 * Turn images into a PDF, one image per page.
 *
 * Callers must hand over JPEG or PNG — see EMBEDDABLE_IMAGE_TYPES. Converting
 * anything else is the page script's job, so this stays DOM-free and testable.
 */
export async function imagesToPdf(
  files: { name: string; type: string; data: ArrayBuffer }[],
  options: ImageToPdfOptions,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();

  for (const file of files) {
    const bytes = new Uint8Array(file.data);
    const type = file.type;
    if (type !== 'image/jpeg' && type !== 'image/png') {
      throw new Error(`${file.name}: expected JPEG or PNG here, got ${type || 'an unknown type'}.`);
    }

    const image = type === 'image/jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);

    if (options.pageSize === 'fit') {
      const page = doc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      continue;
    }

    const box = options.pageSize === 'a4' ? A4 : LETTER;
    const page = doc.addPage([box.width, box.height]);
    const usableW = box.width - options.marginPt * 2;
    const usableH = box.height - options.marginPt * 2;
    const scale = Math.min(usableW / image.width, usableH / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    page.drawImage(image, {
      x: (box.width - w) / 2,
      y: (box.height - h) / 2,
      width: w,
      height: h,
    });
  }

  if (doc.getPageCount() === 0) throw new Error('No images to put in a PDF.');
  return doc.save({ useObjectStreams: true });
}

/**
 * Parse a page range the way a print dialog does: "1-3, 7, 12-".
 *
 * Returns zero-based indices, in the order written, so "3,1" really does put
 * page 3 first. Out-of-range numbers are an error rather than being clamped —
 * silently dropping a page from a document someone is about to rely on is the
 * kind of helpfulness nobody wants.
 */
export function parseRange(input: string, pageCount: number): number[] {
  const text = input.trim();
  if (!text) return Array.from({ length: pageCount }, (_, i) => i);

  const out: number[] = [];
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;

    const match = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!match || (!match[1] && !match[3])) throw new Error(`Cannot read "${part}" as a page range.`);

    const isRange = Boolean(match[2]);
    const from = match[1] ? Number(match[1]) : 1;
    const to = isRange ? (match[3] ? Number(match[3]) : pageCount) : from;

    if (from < 1 || to < 1) throw new Error('Pages are numbered from 1.');
    if (from > pageCount || to > pageCount) {
      throw new Error(`This document has ${pageCount} page${pageCount === 1 ? '' : 's'}, so "${part}" is out of range.`);
    }

    if (to >= from) for (let i = from; i <= to; i++) out.push(i - 1);
    else for (let i = from; i >= to; i--) out.push(i - 1);
  }

  if (out.length === 0) throw new Error('That range selects no pages.');
  return out;
}

/** Human-readable page size, for describing a loaded document. */
export function describeSize(size: { width: number; height: number }): string {
  const near = (a: number, b: number) => Math.abs(a - b) < 3;
  const w = Math.min(size.width, size.height);
  const h = Math.max(size.width, size.height);
  const landscape = size.width > size.height;
  const suffix = landscape ? ' landscape' : '';
  if (near(w, A4.width) && near(h, A4.height)) return `A4${suffix}`;
  if (near(w, LETTER.width) && near(h, LETTER.height)) return `Letter${suffix}`;
  const mm = (pt: number) => Math.round((pt / 72) * 25.4);
  return `${mm(size.width)}×${mm(size.height)} mm`;
}

// Published on the global object rather than as a module export, matching
// bigcount.js: the bundle is loaded with a plain <script> tag and the page
// stays free of module plumbing. Assigned through `globalThis` so the pure
// helpers above can be unit tested under Node, where `window` does not exist.
const globalScope = globalThis as unknown as {
  LOC1999_PDF?: {
    loadPdf: typeof loadPdf;
    assemble: typeof assemble;
    addPageNumbers: typeof addPageNumbers;
    imagesToPdf: typeof imagesToPdf;
    parseRange: typeof parseRange;
    describeSize: typeof describeSize;
  };
};
globalScope.LOC1999_PDF = {
  loadPdf,
  assemble,
  addPageNumbers,
  imagesToPdf,
  parseRange,
  describeSize,
};

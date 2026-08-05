/**
 * Pages: merging, splitting, reordering, rotating.
 *
 * The most-searched thing anyone does to a PDF, and the one operation where
 * "nothing is uploaded" is easiest to explain — combining a scanned passport
 * with a bank statement should not involve a stranger's server.
 *
 * The model is deliberately flat. Whatever files are open, the working state is
 * one list of *page references*: which document a page came from, which page it
 * was there, and how far it has been turned. Every action — reorder, delete,
 * rotate, split — is a change to that list, and the PDF is only built at the
 * end. That keeps the whole tool undoable, makes it testable without pdf-lib in
 * the loop, and means merging two files and reordering them are the same
 * operation rather than two features.
 *
 * Everything above `buildPdf` is pure and DOM-free.
 */

import { PDFDocument, degrees } from 'pdf-lib';

/** One page, wherever it came from. */
export interface PageRef {
  /** Which open document. An index into the caller's list. */
  doc: number;
  /** Which page of that document, from zero. */
  page: number;
  /** Extra turn to apply, clockwise, on top of whatever the page already has. */
  rotation: number;
}

/** Rotation, normalised to the four values a PDF can hold. */
export function normaliseRotation(degreesClockwise: number): number {
  const turn = Math.round(degreesClockwise / 90) * 90;
  return ((turn % 360) + 360) % 360;
}

/**
 * Move a page to a new position.
 *
 * Splice-out-then-splice-in, which is the behaviour a drag between two other
 * pages should have: the page lands where the gap was, and everything after it
 * shifts by one rather than swapping.
 */
export function movePage<T>(pages: T[], from: number, to: number): T[] {
  if (from < 0 || from >= pages.length) return pages.slice();
  const out = pages.slice();
  const [moved] = out.splice(from, 1);
  if (moved === undefined) return out;
  out.splice(Math.max(0, Math.min(to, out.length)), 0, moved);
  return out;
}

/** Turn the chosen pages, leaving the rest alone. */
export function rotatePages(pages: PageRef[], chosen: Iterable<number>, delta: number): PageRef[] {
  const set = new Set(chosen);
  return pages.map((page, i) =>
    set.has(i) ? { ...page, rotation: normaliseRotation(page.rotation + delta) } : page,
  );
}

/** Drop the chosen pages. */
export function removePages<T>(pages: T[], chosen: Iterable<number>): T[] {
  const set = new Set(chosen);
  return pages.filter((_, i) => !set.has(i));
}

/** Put the pages back in the order they came in. */
export function sortByOrigin(pages: PageRef[]): PageRef[] {
  return [...pages].sort((a, b) => (a.doc !== b.doc ? a.doc - b.doc : a.page - b.page));
}

/**
 * Read a page range the way a print dialog reads one.
 *
 * `1-3, 7, 12-` and `2,4,6` both work; so does `-5` for "up to five". Numbers
 * people type are one-based and the result is zero-based, because that mistake
 * silently prints the wrong pages rather than failing.
 *
 * Returns null when the text is not a range at all, so the caller can say so
 * instead of quietly selecting nothing.
 */
export function parseRanges(text: string, total: number): number[] | null {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  if (!/^[\d\s,–—-]+$/.test(clean)) return null;

  const chosen = new Set<number>();
  for (const rawPart of clean.split(',')) {
    const part = rawPart.trim().replace(/[–—]/g, '-');
    if (!part) continue;

    const match = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (match) {
      const from = match[1] ? Number(match[1]) : 1;
      const to = match[2] ? Number(match[2]) : total;
      if (!from && !to) return null;
      // A backwards range is a typo, not an instruction to reverse.
      const low = Math.min(from, to);
      const high = Math.max(from, to);
      for (let n = Math.max(1, low); n <= Math.min(total, high); n++) chosen.add(n - 1);
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    const one = Number(part);
    if (one >= 1 && one <= total) chosen.add(one - 1);
  }
  return [...chosen].sort((a, b) => a - b);
}

/** Page numbers as a person writes them: 1-3, 5, 8-10. */
export function formatRanges(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;

  const flush = () => {
    if (start === null || previous === null) return;
    parts.push(start === previous ? `${start + 1}` : `${start + 1}-${previous + 1}`);
  };

  for (const index of sorted) {
    if (start === null) {
      start = index;
    } else if (previous !== null && index !== previous + 1) {
      flush();
      start = index;
    }
    previous = index;
  }
  flush();
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

export type SplitMode = 'every' | 'ranges' | 'each';

export interface SplitRequest {
  mode: SplitMode;
  /** How many pages per file, for 'every'. */
  size?: number;
  /** Ranges as typed, for 'ranges'. Each comma group becomes its own file. */
  ranges?: string;
}

export interface SplitGroup {
  /** Indices into the working page list. */
  pages: number[];
  /** What to call the file, without an extension. */
  label: string;
}

export interface SplitPlan {
  groups: SplitGroup[];
  error?: string;
}

/**
 * Work out which pages go in which output file.
 *
 * Separate from doing it, so the page can say "this makes 14 files" before
 * anyone commits to fourteen downloads.
 */
export function planSplit(total: number, request: SplitRequest): SplitPlan {
  if (total <= 0) return { groups: [], error: 'there are no pages to split' };

  if (request.mode === 'each') {
    return {
      groups: Array.from({ length: total }, (_, i) => ({ pages: [i], label: `page-${i + 1}` })),
    };
  }

  if (request.mode === 'every') {
    const size = Math.floor(request.size ?? 0);
    if (!(size >= 1)) return { groups: [], error: 'that is not a number of pages' };
    const groups: SplitGroup[] = [];
    for (let start = 0; start < total; start += size) {
      const pages = [];
      for (let i = start; i < Math.min(total, start + size); i++) pages.push(i);
      groups.push({ pages, label: `pages-${formatRanges(pages).replace(/,\s*/g, '_')}` });
    }
    return { groups };
  }

  // 'ranges': each comma-separated group is one file, so "1-3, 8-10" makes two.
  const text = String(request.ranges ?? '').trim();
  if (!text) return { groups: [], error: 'type which pages you want, like 1-3, 8-10' };

  const groups: SplitGroup[] = [];
  for (const part of text.split(',')) {
    if (!part.trim()) continue;
    const pages = parseRanges(part, total);
    if (pages === null) return { groups: [], error: `"${part.trim()}" is not a page range` };
    if (!pages.length) continue;
    groups.push({ pages, label: `pages-${formatRanges(pages).replace(/,\s*/g, '_')}` });
  }
  if (!groups.length) return { groups: [], error: 'none of those pages exist in this document' };
  return { groups };
}

/** The name for a merged or split file, derived from what went in. */
export function outputName(sources: string[], suffix: string): string {
  const first = (sources[0] ?? 'document').replace(/\.pdf$/i, '');
  const stem = sources.length > 1 ? `${first}-and-${sources.length - 1}-more` : first;
  return `${stem}-${suffix}.pdf`;
}

// ---------------------------------------------------------------------------
// Building the file
// ---------------------------------------------------------------------------

export interface SourceDoc {
  name: string;
  bytes: Uint8Array;
}

/**
 * Load the sources once, so pages can be copied out of them repeatedly.
 *
 * `ignoreEncryption` is on because a great many real PDFs carry the
 * permissions-only encryption the unlock tool exists for — "no printing, no
 * copying" with no password to open. Refusing those would turn away files the
 * visitor can already read. A PDF that genuinely needs a password to open still
 * fails, and the caller says so.
 */
export async function loadSources(sources: SourceDoc[]): Promise<PDFDocument[]> {
  const docs: PDFDocument[] = [];
  for (const source of sources) {
    try {
      docs.push(await PDFDocument.load(source.bytes, { ignoreEncryption: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/password|encrypt/i.test(message)) {
        throw new Error(`"${source.name}" needs a password to open, so its pages cannot be read.`);
      }
      throw new Error(`"${source.name}" could not be read as a PDF.`);
    }
  }
  return docs;
}

/**
 * Build one PDF from a list of page references.
 *
 * `copyPages` carries the page's own resources — its fonts, its images, its
 * annotations — across into the new document, which is why this is a rearrange
 * rather than a re-render: nothing is rasterised, nothing is re-compressed, and
 * the text stays selectable exactly as it was.
 */
export async function buildPdf(docs: PDFDocument[], pages: PageRef[]): Promise<Uint8Array> {
  if (!pages.length) throw new Error('there are no pages left to save');
  const out = await PDFDocument.create();

  /* Copy in one call per source document rather than one per page.
   *
   * copyPages deduplicates shared resources within a single call, so copying
   * page at a time embeds the document's fonts once per page — on a fifty-page
   * report that is the difference between a file the same size as the original
   * and one several times larger. */
  const copiedByPosition = new Map<number, Awaited<ReturnType<typeof out.copyPages>>[number]>();
  for (const [index, doc] of docs.entries()) {
    const positions = pages.map((page, at) => ({ page, at })).filter((p) => p.page.doc === index);
    if (!positions.length) continue;
    const copied = await out.copyPages(doc, positions.map((p) => p.page.page));
    positions.forEach((p, i) => {
      const page = copied[i];
      if (page) copiedByPosition.set(p.at, page);
    });
  }

  pages.forEach((ref, at) => {
    const copied = copiedByPosition.get(at);
    if (!copied) return;
    const added = out.addPage(copied);
    if (ref.rotation) {
      // Rotation is cumulative: the page may already be turned, and turning it
      // again should add to that rather than replace it.
      added.setRotation(degrees(normaliseRotation(added.getRotation().angle + ref.rotation)));
    }
  });

  return out.save();
}

/** How many pages each source contributes, for the page's summary. */
export function countByDoc(pages: PageRef[], docs: number): number[] {
  const counts = new Array(docs).fill(0);
  for (const page of pages) if (page.doc >= 0 && page.doc < docs) counts[page.doc]++;
  return counts;
}

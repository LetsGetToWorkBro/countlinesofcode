/**
 * The converter's engine, bundled to public/convert.js.
 *
 * PDF and DOCX both convert to and from one shared model rather than to each
 * other, so a round trip means the same thing in both directions. The page
 * supplies pdf.js output; everything here is DOM-free and unit tested.
 *
 * Also here: the local learning store. The site's promise is that nothing
 * leaves your browser, which rules out improving the heuristics from other
 * people's documents — so instead a correction you make is remembered *here*,
 * keyed by the software that produced the PDF, and applied the next time you
 * open a document from the same source. Converting the same monthly statement
 * gets better every month, and no document ever leaves the machine.
 */

import { describe, docText, tidy, type Doc, type Verdict } from './docmodel';
import { readDocx, writeDocx } from './docx';
import { inspectOoxml, inspectPdf, looksHidden, patchStats, pdfFeaturesFromBytes, textBox } from './inspect';
import { unzip } from './zip';
import { writePdf } from './docpdf';
import {
  DEFAULT_HEADING_RATIO,
  fromPages,
  fromStructure,
  grade,
  type GeometryOptions,
  type PageInput,
  type StructNode,
  type Survey,
} from './pdfdoc';

export interface Profile {
  /** Multiplier at which a line counts as a heading. */
  headingRatio: number;
  /** How many corrections have gone into this profile. */
  corrections: number;
  /** When it was last touched, so a stale profile can be spotted. */
  updated: number;
}

const STORE_KEY = 'loc1999:convert-profiles';
const MIN_RATIO = 1.02;
const MAX_RATIO = 2.2;

type Store = Record<string, Profile>;

function readStore(): Store {
  try {
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Private browsing, or storage full. Learning is a convenience, not a
    // requirement, so losing it must never break a conversion.
  }
}

/**
 * The key a profile is stored under.
 *
 * The PDF's producer string is a good proxy for "documents that look alike":
 * every statement from one bank, every invoice from one system, shares it. It
 * is metadata the file already advertises, not anything derived from content.
 */
export function profileKey(producer: string | undefined | null): string {
  const cleaned = (producer ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || 'unknown';
}

export function loadProfile(producer: string | undefined | null): Profile {
  const stored = readStore()[profileKey(producer)];
  return stored ?? { headingRatio: DEFAULT_HEADING_RATIO, corrections: 0, updated: 0 };
}

/**
 * Record that a conversion found too many or too few headings.
 *
 * Steps rather than jumps: one nudge should visibly help without overshooting,
 * and repeated nudges converge. Clamped so a run of clicks cannot push the
 * threshold somewhere it can never come back from.
 */
export function learn(producer: string | undefined | null, direction: 'fewer' | 'more'): Profile {
  const store = readStore();
  const key = profileKey(producer);
  const current = store[key] ?? { headingRatio: DEFAULT_HEADING_RATIO, corrections: 0, updated: 0 };
  // "Fewer headings" means the bar must be higher.
  const ratio = current.headingRatio * (direction === 'fewer' ? 1.08 : 1 / 1.08);
  const next: Profile = {
    headingRatio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, Math.round(ratio * 1000) / 1000)),
    corrections: current.corrections + 1,
    updated: Date.now(),
  };
  store[key] = next;
  writeStore(store);
  return next;
}

export function forgetProfiles(): void {
  writeStore({});
}

export function allProfiles(): { key: string; profile: Profile }[] {
  return Object.entries(readStore()).map(([key, profile]) => ({ key, profile }));
}

/** Everything the page needs to show a verdict and then convert. */
export interface PdfInput {
  pages: PageInput[];
  /** pdf.js structure tree per page, where the document has one. */
  trees: (StructNode | null)[];
  /** Marked-content id -> text, merged across pages. */
  textById: Map<string, string>;
  producer?: string;
  title?: string;
}

/** Whether a page's text falls into two clearly separated horizontal bands. */
export function looksMultiColumn(page: PageInput): boolean {
  const xs = page.pieces.filter((p) => p.str.trim()).map((p) => p.x);
  if (xs.length < 40) return false;
  const middle = page.width / 2;
  const left = xs.filter((x) => x < middle * 0.9).length;
  const right = xs.filter((x) => x > middle * 1.1).length;
  if (left < 10 || right < 10) return false;
  // A single column that merely reaches past the middle has plenty of pieces
  // *starting* near the middle; two columns leave a gutter almost empty.
  const gutter = xs.filter((x) => x >= middle * 0.9 && x <= middle * 1.1).length;
  return gutter / xs.length < 0.04;
}

export function surveyPdf(input: PdfInput): Survey {
  const roles = new Set<string>();
  const collect = (node: StructNode | null) => {
    if (!node) return;
    if (node.role) roles.add(node.role);
    for (const kid of node.children ?? []) collect(kid);
  };
  input.trees.forEach(collect);

  const pieces = input.pages.reduce((n, p) => n + p.pieces.filter((x) => x.str.trim()).length, 0);
  const tagged = roles.size > 0 && [...roles].some((r) => r !== 'Root' && r !== 'Document' && r !== 'NonStruct');

  return {
    tagged,
    roles: [...roles],
    pages: input.pages.length,
    pieces,
    columns: input.pages.some(looksMultiColumn),
    ruledTables: input.pages.some((p) => p.hasLines),
  };
}

export interface Conversion {
  doc: Doc;
  verdict: Verdict;
  survey: Survey;
  counts: ReturnType<typeof describe>;
  /** Which tier actually produced the document. */
  tier: 'tags' | 'geometry';
}

/** Convert a PDF into the model, choosing the best available tier. */
export function convertPdf(input: PdfInput, options: GeometryOptions = {}): Conversion {
  const survey = surveyPdf(input);
  const verdict = grade(survey);

  let doc: Doc;
  let tier: 'tags' | 'geometry';

  if (survey.tagged) {
    const blocks = input.trees.flatMap((tree, index) => {
      const page = fromStructure(tree, input.textById).blocks;
      return index > 0 && page.length ? [{ kind: 'pageBreak' as const, runs: [] }, ...page] : page;
    });
    doc = tidy({ blocks, ...(input.title ? { title: input.title } : {}) });
    tier = 'tags';
    // A tagged file whose tree turned out to hold nothing useful is worse than
    // an untagged one; fall back rather than hand over an empty document.
    if (!docText(doc).trim()) {
      doc = fromPages(input.pages, options);
      tier = 'geometry';
    }
  } else {
    doc = fromPages(input.pages, options);
    tier = 'geometry';
  }

  if (input.title) doc.title = input.title;
  return { doc, verdict, survey, counts: describe(doc), tier };
}

const globalScope = globalThis as unknown as { LOC1999_CONVERT?: Record<string, unknown> };
globalScope.LOC1999_CONVERT = {
  convertPdf,
  surveyPdf,
  looksMultiColumn,
  grade,
  readDocx,
  writeDocx,
  writePdf,
  describe,
  docText,
  loadProfile,
  learn,
  forgetProfiles,
  allProfiles,
  profileKey,
  DEFAULT_HEADING_RATIO,
  // The leak audit shares this bundle: it needs the same ZIP reader and runs on
  // the same two file types, so a visitor who opens one has the other already.
  inspectPdf,
  inspectOoxml,
  pdfFeaturesFromBytes,
  patchStats,
  looksHidden,
  textBox,
  unzip,
};

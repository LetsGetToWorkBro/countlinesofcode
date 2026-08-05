/**
 * PDF to the shared document model.
 *
 * There are two ways to get a document out of a PDF, and they are not close in
 * quality:
 *
 *   Tier 1 — the PDF is *tagged*. It carries a structure tree naming its own
 *   headings, paragraphs, lists and tables, in reading order. Anything exported
 *   from Word, Google Docs or LibreOffice usually is. Here the conversion is a
 *   mapping, not a guess, and it is very good.
 *
 *   Tier 2 — the PDF is untagged, which is a bag of positioned glyphs. Nothing
 *   in it says where a paragraph starts. Structure has to be inferred from
 *   geometry: baselines, gaps, indentation, font size. That is a reconstruction,
 *   and it is honest to call it one.
 *
 * The important product decision is that the tier is *reported*, not hidden.
 * Every other converter takes the file and hands back whatever it managed, so a
 * mangled result is a nasty surprise. Here `grade()` says which tier the
 * document is in before anyone commits, and what will suffer.
 *
 * This module is DOM-free so it unit tests under Node. The caller supplies
 * already-extracted page data; pdf.js does the extracting.
 */

import { tidy, type Block, type Doc, type Finding, type Run, type Verdict } from './docmodel';

/** One positioned piece of text, as pdf.js reports it. */
export interface TextPiece {
  str: string;
  /** Baseline origin, PDF user space. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The font pdf.js resolved, when known — used to spot bold and italic. */
  fontName?: string;
  /** Marked-content id, which is what ties a piece to the structure tree. */
  markedId?: string;
}

export interface PageInput {
  width: number;
  height: number;
  pieces: TextPiece[];
  /** True when the page had a ruling-line grid, i.e. a drawn table. */
  hasLines?: boolean;
}

/** A node of pdf.js's structure tree, in the shape getStructTree() returns. */
export interface StructNode {
  role?: string;
  type?: string;
  id?: string;
  children?: StructNode[];
}

const BOLD = /bold|black|heavy|semibold|demibold/i;
const ITALIC = /italic|oblique/i;

function runFrom(piece: TextPiece): Run {
  const run: Run = { text: piece.str };
  if (piece.fontName && BOLD.test(piece.fontName)) run.bold = true;
  if (piece.fontName && ITALIC.test(piece.fontName)) run.italic = true;
  if (piece.height > 0) run.size = Math.round(piece.height * 10) / 10;
  return run;
}

// ---------------------------------------------------------------------------
// Tier 1: the structure tree
// ---------------------------------------------------------------------------

/** PDF structure roles mapped onto the model. Anything else becomes a paragraph. */
function blockForRole(role: string): { kind: Block['kind']; level?: number; ordered?: boolean } | null {
  const heading = /^H([1-6])$/.exec(role);
  if (heading) return { kind: 'heading', level: Number(heading[1]) };
  if (role === 'Title') return { kind: 'heading', level: 1 };
  if (role === 'H') return { kind: 'heading', level: 1 };
  if (role === 'LI' || role === 'LBody') return { kind: 'listItem', level: 1 };
  if (role === 'P' || role === 'Note' || role === 'Caption' || role === 'Quote') return { kind: 'paragraph' };
  return null;
}

/**
 * Build a document from the structure tree.
 *
 * `textById` maps a marked-content id to the text drawn under it, which is how
 * a structure node — which holds no text itself — is joined to what it names.
 * Tables are assembled from their own TR/TD roles rather than guessed at.
 */
export function fromStructure(tree: StructNode | null, textById: Map<string, string>, fonts?: Map<string, string>): Doc {
  const blocks: Block[] = [];
  if (!tree) return { blocks };

  const textOf = (node: StructNode): string => {
    let out = '';
    const walk = (n: StructNode) => {
      if (n.type === 'content' && n.id) out += textById.get(n.id) ?? '';
      for (const kid of n.children ?? []) walk(kid);
    };
    walk(node);
    return out;
  };

  const runsOf = (node: StructNode): Run[] => {
    const text = textOf(node).replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const run: Run = { text };
    const font = node.id ? fonts?.get(node.id) : undefined;
    if (font && BOLD.test(font)) run.bold = true;
    if (font && ITALIC.test(font)) run.italic = true;
    return [run];
  };

  const walk = (node: StructNode, listDepth: number) => {
    const role = node.role ?? node.type ?? '';

    if (role === 'Table') {
      const rows: { runs: Run[] }[][] = [];
      const collectRows = (n: StructNode) => {
        if ((n.role ?? '') === 'TR') {
          const cells = (n.children ?? [])
            .filter((c) => c.role === 'TD' || c.role === 'TH')
            .map((c) => ({ runs: runsOf(c) }));
          if (cells.length) rows.push(cells);
          return;
        }
        for (const kid of n.children ?? []) collectRows(kid);
      };
      collectRows(node);
      if (rows.length) {
        blocks.push({ kind: 'table', runs: [], rows });
        return;
      }
    }

    if (role === 'L') {
      for (const kid of node.children ?? []) walk(kid, listDepth + 1);
      return;
    }

    const mapped = blockForRole(role);
    if (mapped) {
      const runs = runsOf(node);
      if (runs.length) {
        blocks.push(
          mapped.kind === 'listItem'
            ? { kind: 'listItem', level: Math.max(listDepth, 1), ordered: false, runs }
            : { kind: mapped.kind, ...(mapped.level ? { level: mapped.level } : {}), runs },
        );
        return;
      }
    }

    /* Nothing here matched a known role, so descend. If the whole subtree
     * produced no block but does hold text, emit it as a paragraph rather than
     * dropping it: an unfamiliar or vendor-specific role must never cost the
     * reader their words. The innermost node wins, so ancestors do not
     * duplicate what a child already emitted. */
    const before = blocks.length;
    for (const kid of node.children ?? []) walk(kid, listDepth);
    if (blocks.length === before) {
      const runs = runsOf(node);
      if (runs.length) blocks.push({ kind: 'paragraph', runs });
    }
  };

  walk(tree, 0);
  return tidy({ blocks });
}

// ---------------------------------------------------------------------------
// Tier 2: geometry
// ---------------------------------------------------------------------------

export interface Line {
  y: number;
  x: number;
  right: number;
  height: number;
  pieces: TextPiece[];
}

/**
 * Group pieces into lines by shared baseline.
 *
 * A tolerance is needed because a line containing a superscript, a different
 * font, or an inline formula does not share one exact y. Half the text height
 * is comfortably inside the leading between two lines.
 */
export function groupLines(pieces: TextPiece[]): Line[] {
  const useful = pieces.filter((p) => p.str && p.str.trim());
  const sorted = [...useful].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];

  for (const piece of sorted) {
    const tolerance = Math.max(piece.height * 0.5, 1.5);
    const line = lines.find((l) => Math.abs(l.y - piece.y) <= tolerance);
    if (line) {
      line.pieces.push(piece);
      line.x = Math.min(line.x, piece.x);
      line.right = Math.max(line.right, piece.x + piece.width);
      line.height = Math.max(line.height, piece.height);
    } else {
      lines.push({
        y: piece.y,
        x: piece.x,
        right: piece.x + piece.width,
        height: piece.height,
        pieces: [piece],
      });
    }
  }

  for (const line of lines) line.pieces.sort((a, b) => a.x - b.x);
  return lines;
}

/** The text of a line, with a space inserted where the glyphs leave a gap. */
export function lineText(line: Line): string {
  let out = '';
  let previousEnd: number | null = null;
  for (const piece of line.pieces) {
    // pdf.js often emits words with no spaces between them; a gap wider than a
    // quarter of the text height is a space that was drawn as position.
    if (previousEnd !== null && piece.x - previousEnd > line.height * 0.25 && !/\s$/.test(out)) out += ' ';
    out += piece.str;
    previousEnd = piece.x + piece.width;
  }
  return out.replace(/\s+/g, ' ').trim();
}

const BULLET = /^\s*([•·▪◦‣∙*-]|•|\(?\d{1,2}[.)]|[a-z][.)])\s+/i;

/**
 * Body text size, which is what heading detection is measured against.
 *
 * Weighted by how many characters are set at each size, not by how many lines:
 * a title is one short line and a paragraph is many long ones, so counting
 * lines can crown the heading as "body" on a page that has few of them. Ties go
 * to the smaller size, because body text is the smaller of any two candidates.
 */
export function bodySize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.height * 2) / 2;
    const chars = line.pieces.reduce((n, p) => n + p.str.trim().length, 0);
    weight.set(key, (weight.get(key) ?? 0) + Math.max(chars, 1));
  }
  let best = 0;
  let most = -1;
  for (const [size, w] of [...weight.entries()].sort((a, b) => a[0] - b[0])) {
    if (w > most) {
      most = w;
      best = size;
    }
  }
  return best || 10;
}

/**
 * Infer blocks from the geometry of one page.
 *
 * The rules are deliberately conservative — each one is a thing that is almost
 * always true of a document, rather than a clever guess that is right slightly
 * more often than not:
 *
 *   - a line noticeably larger than body text is a heading
 *   - a line starting with a bullet or "1." is a list item
 *   - a bigger-than-usual vertical gap starts a new paragraph
 *   - so does a line that is indented relative to the one before it
 *   - a short line ends a paragraph, because full lines wrap and last ones do not
 */
export interface GeometryOptions {
  /**
   * How much larger than body text a line must be to count as a heading.
   *
   * Adjustable because no single number is right for every document, and the
   * page lets a reader nudge it when the result is visibly wrong — remembered
   * locally, so the next document from the same source starts out better.
   */
  headingRatio?: number;
}

export const DEFAULT_HEADING_RATIO = 1.18;

export function fromGeometry(page: PageInput, options: GeometryOptions = {}): Block[] {
  const ratio = options.headingRatio ?? DEFAULT_HEADING_RATIO;
  const lines = groupLines(page.pieces);
  if (!lines.length) return [];
  const body = bodySize(lines);
  const blocks: Block[] = [];

  let current: { runs: Run[]; kind: Block['kind']; level?: number; ordered?: boolean } | null = null;
  const flush = () => {
    if (current && current.runs.length) {
      blocks.push({
        kind: current.kind,
        ...(current.level ? { level: current.level } : {}),
        ...(current.kind === 'listItem' ? { ordered: Boolean(current.ordered) } : {}),
        runs: current.runs,
      });
    }
    current = null;
  };

  let previous: Line | null = null;
  const widest = Math.max(...lines.map((l) => l.right - l.x));

  for (const line of lines) {
    const text = lineText(line);
    if (!text) continue;

    const gap = previous ? previous.y - line.y : 0;
    const bigGap = previous !== null && gap > line.height * 1.8;
    const indented = previous !== null && line.x - previous.x > line.height * 0.8;
    const shortBefore = previous !== null && previous.right - previous.x < widest * 0.8;

    const bullet = BULLET.exec(text);
    const isHeading = line.height >= body * ratio && text.length < 120;
    const ordered = bullet ? /\d|[a-z][.)]/i.test(bullet[1] ?? '') : false;

    const kind: Block['kind'] = isHeading ? 'heading' : bullet ? 'listItem' : 'paragraph';
    const starts =
      current === null ||
      kind !== current.kind ||
      isHeading ||
      Boolean(bullet) ||
      bigGap ||
      indented ||
      (shortBefore && kind === 'paragraph');

    if (starts) {
      flush();
      current = {
        kind,
        runs: [],
        ...(isHeading
          ? { level: line.height >= body * (ratio + 0.42) ? 1 : line.height >= body * (ratio + 0.12) ? 2 : 3 }
          : {}),
        ...(bullet ? { ordered } : {}),
      };
    }

    const value = bullet ? text.slice(bullet[0].length) : text;
    const first = line.pieces[0];
    const run = first ? { ...runFrom(first), text: value } : { text: value };
    // Lines inside one paragraph are joined with a space, not a newline: the
    // break was the page's, not the author's.
    if (current!.runs.length) current!.runs.push({ ...run, text: ' ' + value });
    else current!.runs.push(run);

    previous = line;
  }

  flush();
  return blocks;
}

/** Build a document from every page's geometry, page breaks included. */
export function fromPages(pages: PageInput[], options: GeometryOptions = {}): Doc {
  const blocks: Block[] = [];
  pages.forEach((page, index) => {
    if (index > 0) blocks.push({ kind: 'pageBreak', runs: [] });
    blocks.push(...fromGeometry(page, options));
  });
  return tidy({ blocks });
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export interface Survey {
  tagged: boolean;
  /** Roles seen in the structure tree, if any. */
  roles?: string[];
  pages: number;
  /** Text pieces found across the document. Zero means a scan. */
  pieces: number;
  /** True when a page looks like it holds more than one column. */
  columns?: boolean;
  /** True when ruling lines suggest a real table. */
  ruledTables?: boolean;
}

/**
 * Say how well this will convert, before converting it.
 *
 * The tone matters as much as the accuracy: a person about to send a contract
 * to a lawyer needs to know whether to proofread the tables, and no other
 * converter tells them.
 */
export function grade(survey: Survey): Verdict {
  const findings: Finding[] = [];

  if (survey.pieces === 0) {
    return {
      confidence: 'low',
      summary: 'This PDF has no text in it — it is a scan, a photograph of a page.',
      findings: [
        { label: 'No selectable text anywhere in the file', good: false },
        { label: 'Converting needs OCR, which reads the letters off the picture', good: false },
        { label: 'Layout, tables and formatting will not survive', good: false },
      ],
    };
  }

  if (survey.tagged) {
    findings.push({ label: 'This PDF is tagged: it describes its own structure', good: true });
    findings.push({ label: 'Headings, paragraphs and reading order come from the file itself', good: true });
    const roles = new Set(survey.roles ?? []);
    if (roles.has('Table')) findings.push({ label: 'Tables are marked up in the file, so they convert as tables', good: true });
    if (roles.has('L') || roles.has('LI')) findings.push({ label: 'Lists are marked up, so numbering and bullets survive', good: true });
    findings.push({ label: 'Exact page layout is not reproduced — Word re-flows the text', good: false });
    return {
      confidence: 'high',
      summary: 'This should convert very well. The PDF carries its own structure, so this is a translation rather than a guess.',
      findings,
    };
  }

  findings.push({ label: 'This PDF is not tagged, so structure has to be inferred from the layout', good: false });
  findings.push({ label: 'Text, headings, paragraphs and lists are usually recovered well', good: true });
  if (survey.columns) findings.push({ label: 'More than one column detected — check the reading order', good: false });
  if (survey.ruledTables) findings.push({ label: 'Ruled tables detected — check every table before you rely on it', good: false });
  else findings.push({ label: 'Tables without drawn borders may come out as plain paragraphs', good: false });

  return {
    confidence: survey.columns ? 'low' : 'medium',
    summary: survey.columns
      ? 'This is a reconstruction, and the multiple columns make it a hard one. Expect to fix the reading order.'
      : 'This is a reconstruction rather than a translation. The words will all be there; check the tables and headings.',
    findings,
  };
}

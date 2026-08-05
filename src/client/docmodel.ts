/**
 * The shared document model.
 *
 * One neutral representation that both directions read and write: PDF and DOCX
 * each convert to and from this, rather than to each other. That is what keeps
 * a round trip honest — the same paragraph means the same thing whichever end
 * it came in from — and it is where the "how good will this be?" verdict is
 * computed, because the model knows what it managed to recover.
 *
 * It is deliberately small. A document model that tries to express everything
 * Word can express becomes Word; this expresses the things that survive a
 * conversion, and the page says plainly what does not.
 */

/** A stretch of text with uniform formatting. */
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Point size, when the source knew it. */
  size?: number;
}

export type BlockKind = 'heading' | 'paragraph' | 'listItem' | 'table' | 'pageBreak';

export interface TableCell {
  runs: Run[];
}

export interface Block {
  kind: BlockKind;
  /** 1–6 for a heading; nesting depth for a list item. */
  level?: number;
  /** A numbered list rather than a bulleted one. */
  ordered?: boolean;
  runs: Run[];
  /** Rows of cells, for a table. */
  rows?: TableCell[][];
}

export interface Doc {
  blocks: Block[];
  title?: string;
}

/** How much of the original structure a conversion expects to keep. */
export type Confidence = 'high' | 'medium' | 'low';

export interface Finding {
  /** Short label shown in the verdict list. */
  label: string;
  /** Whether this is reassuring or a caveat. */
  good: boolean;
}

/**
 * The verdict shown before anyone commits to a conversion.
 *
 * Every other converter takes the file and hands back whatever it managed.
 * This says up front which tier the document is in and what will suffer, so a
 * bad result is a known trade rather than a surprise.
 */
export interface Verdict {
  confidence: Confidence;
  /** One sentence, in plain words. */
  summary: string;
  findings: Finding[];
}

export const text = (runs: Run[]): string => runs.map((r) => r.text).join('');

export const blockText = (block: Block): string =>
  block.kind === 'table'
    ? (block.rows ?? []).map((row) => row.map((cell) => text(cell.runs)).join('\t')).join('\n')
    : text(block.runs);

/** The whole document as plain text, for counting and for tests. */
export const docText = (doc: Doc): string => doc.blocks.map(blockText).join('\n');

/**
 * Merge runs that are formatted identically and drop empty ones.
 *
 * A PDF hands over one run per positioned glyph group, so a single sentence can
 * arrive as thirty runs. Left alone they become thirty `<w:r>` elements, which
 * is valid but makes the Word document unpleasant to edit — every other
 * keystroke lands in a different run.
 */
export function tidyRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (last && !!last.bold === !!run.bold && !!last.italic === !!run.italic && last.size === run.size) {
      last.text += run.text;
    } else {
      out.push({ ...run });
    }
  }
  return out;
}

/** Tidy every block, and drop the ones that ended up with nothing in them. */
export function tidy(doc: Doc): Doc {
  const blocks: Block[] = [];
  for (const block of doc.blocks) {
    if (block.kind === 'pageBreak') {
      blocks.push(block);
      continue;
    }
    if (block.kind === 'table') {
      const rows = (block.rows ?? []).map((row) => row.map((cell) => ({ runs: tidyRuns(cell.runs) })));
      if (rows.some((row) => row.some((cell) => text(cell.runs).trim()))) blocks.push({ ...block, rows, runs: [] });
      continue;
    }
    const runs = tidyRuns(block.runs);
    if (text(runs).trim()) blocks.push({ ...block, runs });
  }
  return { ...doc, blocks };
}

/** A quick count of what the model holds, for the verdict and the summary. */
export function describe(doc: Doc): { headings: number; paragraphs: number; lists: number; tables: number; words: number } {
  let headings = 0;
  let paragraphs = 0;
  let lists = 0;
  let tables = 0;
  for (const block of doc.blocks) {
    if (block.kind === 'heading') headings++;
    else if (block.kind === 'paragraph') paragraphs++;
    else if (block.kind === 'listItem') lists++;
    else if (block.kind === 'table') tables++;
  }
  const words = docText(doc).split(/\s+/).filter(Boolean).length;
  return { headings, paragraphs, lists, tables, words };
}

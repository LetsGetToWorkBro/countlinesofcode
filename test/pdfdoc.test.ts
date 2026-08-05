/**
 * PDF to the document model.
 *
 * Two very different jobs are tested here. Reading a tagged PDF is a mapping,
 * and it should be exact. Reconstructing an untagged one is inference, and what
 * matters is that the rules behave the way a person reading the page would
 * expect — a bigger line is a heading, a wide gap starts a paragraph — and that
 * the tool is honest afterwards about which of the two it did.
 */

import { describe, expect, it } from 'vitest';
import {
  bodySize,
  fromGeometry,
  fromPages,
  fromStructure,
  grade,
  groupLines,
  lineText,
  type PageInput,
  type StructNode,
  type TextPiece,
} from '../src/client/pdfdoc';
import { docText } from '../src/client/docmodel';

const piece = (str: string, x: number, y: number, over: Partial<TextPiece> = {}): TextPiece => ({
  str,
  x,
  y,
  width: str.length * 5,
  height: 10,
  ...over,
});

describe('fromStructure (tagged PDFs)', () => {
  const textById = new Map([
    ['mc0', 'The Title'],
    ['mc1', 'A paragraph of body text.'],
    ['mc2', 'A Section'],
    ['mc3', 'Another paragraph.'],
  ]);

  const tree: StructNode = {
    role: 'Root',
    children: [
      {
        role: 'Document',
        children: [
          { role: 'H1', children: [{ type: 'content', id: 'mc0' }] },
          { role: 'P', children: [{ type: 'content', id: 'mc1' }] },
          { role: 'H2', children: [{ type: 'content', id: 'mc2' }] },
          { role: 'P', children: [{ type: 'content', id: 'mc3' }] },
        ],
      },
    ],
  };

  it('maps roles onto blocks, in reading order', () => {
    const doc = fromStructure(tree, textById);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'heading', 'paragraph']);
    expect(doc.blocks.map((b) => b.level ?? null)).toEqual([1, null, 2, null]);
    expect(docText(doc)).toBe('The Title\nA paragraph of body text.\nA Section\nAnother paragraph.');
  });

  it('descends through wrapper nodes that hold no text of their own', () => {
    // Word interposes NonStruct/Span elements constantly; treating one as a
    // block would drop everything under it.
    const wrapped: StructNode = {
      role: 'Root',
      children: [
        { role: 'P', children: [{ role: 'NonStruct', children: [{ type: 'content', id: 'mc1' }] }] },
      ],
    };
    expect(docText(fromStructure(wrapped, textById))).toBe('A paragraph of body text.');
  });

  it('builds a real table from TR and TD roles', () => {
    const cells = new Map([
      ['a', 'Name'], ['b', 'Value'], ['c', 'Widgets'], ['d', '42'],
    ]);
    const table: StructNode = {
      role: 'Table',
      children: [
        { role: 'TR', children: [
          { role: 'TH', children: [{ type: 'content', id: 'a' }] },
          { role: 'TH', children: [{ type: 'content', id: 'b' }] },
        ] },
        { role: 'TR', children: [
          { role: 'TD', children: [{ type: 'content', id: 'c' }] },
          { role: 'TD', children: [{ type: 'content', id: 'd' }] },
        ] },
      ],
    };
    const doc = fromStructure(table, cells);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]!.kind).toBe('table');
    expect(doc.blocks[0]!.rows?.map((r) => r.map((c) => c.runs[0]?.text))).toEqual([
      ['Name', 'Value'],
      ['Widgets', '42'],
    ]);
  });

  it('reads a list, nesting by how deep the L elements go', () => {
    const items = new Map([['i1', 'first'], ['i2', 'second']]);
    const list: StructNode = {
      role: 'L',
      children: [
        { role: 'LI', children: [{ type: 'content', id: 'i1' }] },
        { role: 'LI', children: [{ type: 'content', id: 'i2' }] },
      ],
    };
    const doc = fromStructure(list, items);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['listItem', 'listItem']);
  });

  it('treats an unknown role as a paragraph rather than losing its text', () => {
    const odd: StructNode = { role: 'Sect', children: [{ role: 'Whatever', children: [{ type: 'content', id: 'mc1' }] }] };
    expect(docText(fromStructure(odd, textById))).toContain('A paragraph of body text.');
  });

  it('returns nothing for a document with no tree, rather than throwing', () => {
    expect(fromStructure(null, textById).blocks).toEqual([]);
  });
});

describe('groupLines', () => {
  it('puts pieces sharing a baseline on one line, left to right', () => {
    const lines = groupLines([piece('world', 60, 700), piece('Hello', 20, 700), piece('next', 20, 680)]);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.pieces.map((p) => p.str)).toEqual(['Hello', 'world']);
  });

  it('tolerates a baseline that is off by a rounding error', () => {
    expect(groupLines([piece('a', 10, 700), piece('b', 30, 700.4)])).toHaveLength(1);
  });

  it('keeps genuinely different lines apart', () => {
    expect(groupLines([piece('a', 10, 700), piece('b', 10, 686)])).toHaveLength(2);
  });

  it('orders lines down the page', () => {
    const lines = groupLines([piece('bottom', 10, 100), piece('top', 10, 700)]);
    expect(lines.map((l) => l.pieces[0]!.str)).toEqual(['top', 'bottom']);
  });

  it('ignores whitespace-only pieces, which pdf.js emits freely', () => {
    expect(groupLines([piece('   ', 10, 700), piece('', 20, 700)])).toHaveLength(0);
  });
});

describe('lineText', () => {
  it('inserts a space where the glyphs were merely positioned apart', () => {
    // pdf.js commonly reports "Hello" and "world" with no space between them.
    const line = groupLines([piece('Hello', 20, 700), piece('world', 60, 700)])[0]!;
    expect(lineText(line)).toBe('Hello world');
  });

  it('does not invent a space inside a word split across pieces', () => {
    const line = groupLines([
      { ...piece('Hel', 20, 700), width: 15 },
      { ...piece('lo', 35, 700), width: 10 },
    ])[0]!;
    expect(lineText(line)).toBe('Hello');
  });
});

describe('fromGeometry (untagged PDFs)', () => {
  /** Body text at size 10, a heading at 16, laid out down a page. */
  const page = (lines: { text: string; y: number; size?: number; x?: number }[]): PageInput => ({
    width: 612,
    height: 792,
    pieces: lines.map((l) => piece(l.text, l.x ?? 60, l.y, { height: l.size ?? 10, width: l.text.length * 5 })),
  });

  it('calls a noticeably larger line a heading', () => {
    const blocks = fromGeometry(page([
      { text: 'Big Title', y: 700, size: 18 },
      { text: 'Ordinary body text here.', y: 670 },
    ]));
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[1]!.kind).toBe('paragraph');
  });

  it('joins wrapped lines into one paragraph, with spaces not newlines', () => {
    const blocks = fromGeometry(page([
      { text: 'This sentence runs on', y: 700 },
      { text: 'to a second line.', y: 688 },
    ]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.runs.map((r) => r.text).join('')).toBe('This sentence runs on to a second line.');
  });

  it('starts a new paragraph after a wide vertical gap', () => {
    const blocks = fromGeometry(page([
      { text: 'First paragraph line.', y: 700 },
      { text: 'Second paragraph, far below.', y: 640 },
    ]));
    expect(blocks).toHaveLength(2);
  });

  it('starts a new paragraph on an indent', () => {
    const blocks = fromGeometry(page([
      { text: 'A line at the margin.', y: 700 },
      { text: 'An indented new paragraph.', y: 688, x: 90 },
    ]));
    expect(blocks).toHaveLength(2);
  });

  it('recognises bullets and strips the marker', () => {
    const blocks = fromGeometry(page([
      { text: '• first item', y: 700 },
      { text: '• second item', y: 686 },
    ]));
    expect(blocks.map((b) => b.kind)).toEqual(['listItem', 'listItem']);
    expect(blocks[0]!.runs[0]!.text).toBe('first item');
  });

  it('tells a numbered list from a bulleted one', () => {
    const blocks = fromGeometry(page([
      { text: '1. first', y: 700 },
      { text: '2. second', y: 686 },
    ]));
    expect(blocks.every((b) => b.kind === 'listItem')).toBe(true);
    expect(blocks.map((b) => b.ordered)).toEqual([true, true]);
  });

  it('reads bold out of the font name', () => {
    const input: PageInput = {
      width: 612, height: 792,
      pieces: [piece('Strong words', 60, 700, { fontName: 'Helvetica-Bold' })],
    };
    expect(fromGeometry(input)[0]!.runs[0]!.bold).toBe(true);
  });

  it('gives an empty page no blocks rather than an empty paragraph', () => {
    expect(fromGeometry({ width: 612, height: 792, pieces: [] })).toEqual([]);
  });
});

describe('bodySize', () => {
  it('is the commonest line height, not the largest', () => {
    const lines = groupLines([
      piece('huge', 10, 700, { height: 30 }),
      piece('body one', 10, 660, { height: 10 }),
      piece('body two', 10, 640, { height: 10 }),
      piece('body three', 10, 620, { height: 10 }),
    ]);
    expect(bodySize(lines)).toBe(10);
  });
});

describe('fromPages', () => {
  it('separates pages with a page break', () => {
    const one: PageInput = { width: 612, height: 792, pieces: [piece('Page one.', 60, 700)] };
    const two: PageInput = { width: 612, height: 792, pieces: [piece('Page two.', 60, 700)] };
    const doc = fromPages([one, two]);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['paragraph', 'pageBreak', 'paragraph']);
  });
});

describe('grade', () => {
  it('calls a scan what it is, and does not pretend otherwise', () => {
    const verdict = grade({ tagged: false, pages: 3, pieces: 0 });
    expect(verdict.confidence).toBe('low');
    expect(verdict.summary).toMatch(/scan/i);
    expect(verdict.findings.some((f) => /OCR/i.test(f.label))).toBe(true);
  });

  it('is confident about a tagged document, and says why', () => {
    const verdict = grade({ tagged: true, roles: ['P', 'H1', 'Table'], pages: 2, pieces: 500 });
    expect(verdict.confidence).toBe('high');
    expect(verdict.findings.some((f) => f.good && /tagged/i.test(f.label))).toBe(true);
    expect(verdict.findings.some((f) => /table/i.test(f.label) && f.good)).toBe(true);
  });

  it('still admits what a tagged conversion cannot do', () => {
    // Confidence must never become a promise of pixel-perfect layout.
    const verdict = grade({ tagged: true, roles: ['P'], pages: 1, pieces: 100 });
    expect(verdict.findings.some((f) => !f.good && /layout/i.test(f.label))).toBe(true);
  });

  it('is middling about an untagged document and warns about tables', () => {
    const verdict = grade({ tagged: false, pages: 1, pieces: 400 });
    expect(verdict.confidence).toBe('medium');
    expect(verdict.findings.some((f) => !f.good && /table/i.test(f.label))).toBe(true);
  });

  it('drops to low confidence when columns are detected', () => {
    const verdict = grade({ tagged: false, pages: 1, pieces: 400, columns: true });
    expect(verdict.confidence).toBe('low');
    expect(verdict.summary).toMatch(/column|reading order/i);
  });
});

/**
 * The content-stream reader.
 *
 * This decides which bytes of somebody's document get deleted, so the failure
 * mode for a bug here is "the wrong sentence disappeared from a contract".
 * Every case below is a way a real PDF can be shaped.
 */

import { describe, expect, it } from 'vitest';
import { findTextOps, matchOpsToItems, multiply, removeTextOps, tokenize } from '../src/client/pdfstream';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder('latin1').decode(data);

describe('tokenize', () => {
  it('walks operators and operands', () => {
    const kinds = [...tokenize(bytes('1 0 0 1 60 700 Tm'))].map((t) => t.kind);
    expect(kinds).toEqual(['number', 'number', 'number', 'number', 'number', 'number', 'operator']);
  });

  it('keeps a literal string whole even when it contains an operator name', () => {
    // "(Tj)" is text, not an instruction. Reading it as one would desynchronise
    // everything after it.
    const tokens = [...tokenize(bytes('(Tj BT ET) Tj'))];
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.kind).toBe('string');
    expect(tokens[1]!.text).toBe('Tj');
  });

  it('handles escaped and nested parentheses inside a string', () => {
    const tokens = [...tokenize(bytes(String.raw`(a \) b (c) d) Tj`))];
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.kind).toBe('string');
    expect(tokens[1]!.text).toBe('Tj');
  });

  it('tells a hex string from a dictionary', () => {
    expect([...tokenize(bytes('<414243> Tj'))][0]!.kind).toBe('string');
    expect([...tokenize(bytes('<</Type /Page>> x'))][0]!.kind).toBe('dict');
  });

  it('skips comments to the end of the line', () => {
    const tokens = [...tokenize(bytes('% (not a string) Tj\n5 Tz'))];
    expect(tokens.map((t) => t.text ?? t.value)).toEqual([5, 'Tz']);
  });

  it('walks an array containing strings', () => {
    const tokens = [...tokenize(bytes('[(a) -200 (b)] TJ'))];
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.kind).toBe('array');
    expect(tokens[1]!.text).toBe('TJ');
  });
});

describe('multiply', () => {
  it('composes a translate onto a scale the way PDF does', () => {
    const scaled = multiply([1, 0, 0, 1, 10, 20], [2, 0, 0, 2, 0, 0]);
    expect(scaled).toEqual([2, 0, 0, 2, 20, 40]);
  });
});

describe('findTextOps', () => {
  it('locates a simple Tj at its text matrix position', () => {
    const ops = findTextOps(bytes('BT /F1 12 Tf 1 0 0 1 60 700 Tm (hello) Tj ET'));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ x: 60, y: 700, size: 12, operator: 'Tj', font: '/F1' });
  });

  it('follows Td and T* down the page', () => {
    const ops = findTextOps(
      bytes('BT /F1 10 Tf 14 TL 1 0 0 1 50 700 Tm (one) Tj T* (two) Tj 0 -30 Td (three) Tj ET'),
    );
    expect(ops.map((o) => Math.round(o.y))).toEqual([700, 686, 656]);
  });

  it('applies the graphics matrix, so a scaled page reports real positions', () => {
    // A `cm` of 2 doubles both the position and the effective font size.
    const ops = findTextOps(bytes('q 2 0 0 2 0 0 cm BT /F1 10 Tf 1 0 0 1 30 100 Tm (x) Tj ET Q'));
    expect(ops[0]).toMatchObject({ x: 60, y: 200, size: 20 });
  });

  it('restores the matrix at Q, so one block cannot leak into the next', () => {
    const ops = findTextOps(
      bytes('q 2 0 0 2 0 0 cm BT 1 0 0 1 10 10 Tm (a) Tj ET Q BT 1 0 0 1 10 10 Tm (b) Tj ET'),
    );
    expect(ops[0]).toMatchObject({ x: 20, y: 20 });
    expect(ops[1]).toMatchObject({ x: 10, y: 10 });
  });

  it('finds TJ, quote and double-quote operators too', () => {
    const ops = findTextOps(
      bytes("BT /F1 10 Tf 12 TL 1 0 0 1 0 500 Tm [(a) -120 (b)] TJ (c) ' 1 2 (d) \" ET"),
    );
    expect(ops.map((o) => o.operator)).toEqual(['TJ', "'", '"']);
    // ' and " both move to the next line first.
    expect(ops.map((o) => Math.round(o.y))).toEqual([500, 488, 476]);
  });

  it('numbers operators in stream order, which is what removal refers to', () => {
    const ops = findTextOps(bytes('BT (a) Tj (b) Tj (c) Tj ET'));
    expect(ops.map((o) => o.index)).toEqual([0, 1, 2]);
  });
});

describe('removeTextOps', () => {
  const stream = 'BT /F1 12 Tf 1 0 0 1 60 700 Tm (keep) Tj 0 -20 Td (secret) Tj 0 -20 Td (keep2) Tj ET';

  it('blanks only the operator asked for', () => {
    const out = text(removeTextOps(bytes(stream), [1]));
    expect(out).toContain('(keep)');
    expect(out).toContain('(keep2)');
    expect(out).not.toContain('(secret)');
  });

  it('leaves the stream the same length, so other offsets stay valid', () => {
    // Offsets are computed once and reused across several edits; cutting bytes
    // out would invalidate every one after the cut.
    const out = removeTextOps(bytes(stream), [1]);
    expect(out.length).toBe(bytes(stream).length);
  });

  it('keeps the positioning operators, so nothing after it shifts', () => {
    const out = text(removeTextOps(bytes(stream), [1]));
    expect(out).toContain('0 -20 Td');
    expect(out).toContain('BT');
    expect(out).toContain('ET');
  });

  it('removes several at once', () => {
    const out = text(removeTextOps(bytes(stream), [0, 2]));
    expect(out).not.toContain('(keep)');
    expect(out).toContain('(secret)');
    expect(out).not.toContain('(keep2)');
  });

  it('does nothing when asked for nothing', () => {
    expect(text(removeTextOps(bytes(stream), []))).toBe(stream);
  });

  it('ignores an index that is not there rather than throwing', () => {
    expect(text(removeTextOps(bytes(stream), [99]))).toBe(stream);
  });

  it("keeps the line advance of a ' operator, so following lines do not shift up", () => {
    // The ' operator does an implicit T* before showing text. Deleting the
    // middle line must not remove that advance, or line C jumps up over B.
    const quoteStream = 'BT /F1 12 Tf 14 TL 100 700 Td (A) \' (B) \' (C) \' ET';
    const out = text(removeTextOps(bytes(quoteStream), [1]));
    // The B text is gone, replaced by an empty literal...
    expect(out).not.toContain('(B)');
    expect(out).toContain('()');
    // ...but its ' operator survives, so C still advances a line as before.
    const ops = findTextOps(bytes(quoteStream));
    const after = findTextOps(new TextEncoder().encode(out));
    const cBefore = ops.find((o) => o.operator === "'" && o.index === 2);
    const cAfter = after.find((o) => o.operator === "'" && Math.abs(o.y - (cBefore!.y)) < 0.01);
    expect(cAfter, 'line C moved because a T* was lost').toBeTruthy();
  });

  it('keeps the line advance of a " operator too', () => {
    const dquote = 'BT /F1 12 Tf 14 TL 100 700 Td (A) \' 1 2 (B) " (C) \' ET';
    const out = text(removeTextOps(bytes(dquote), [1]));
    expect(out).not.toContain('(B)');
    // The " operator and its spacing operands remain.
    expect(out).toContain('"');
    expect(out).toContain('1 2');
  });
});

describe('matchOpsToItems', () => {
  const ops = [
    { index: 0, x: 60, y: 700 },
    { index: 1, x: 60, y: 680 },
    { index: 2, x: 200, y: 680 },
  ] as Parameters<typeof matchOpsToItems>[0];

  it('pairs each item with the operator drawn at the same spot', () => {
    const report = matchOpsToItems(ops, [{ x: 60, y: 680 }, { x: 60, y: 700 }]);
    expect(report.matched).toEqual([
      { opIndex: 1, itemIndex: 0 },
      { opIndex: 0, itemIndex: 1 },
    ]);
    expect(report.unmatchedItems).toEqual([]);
  });

  it('tolerates the rounding a renderer introduces', () => {
    const report = matchOpsToItems(ops, [{ x: 60.4, y: 699.7 }]);
    expect(report.matched[0]?.opIndex).toBe(0);
  });

  it('reports text it cannot place rather than guessing', () => {
    // This is the case that must never silently delete the wrong thing: a page
    // whose operators do not line up gets flagged so the caller can refuse.
    const report = matchOpsToItems(ops, [{ x: 400, y: 100 }]);
    expect(report.matched).toEqual([]);
    expect(report.unmatchedItems).toEqual([0]);
  });

  it('never hands the same operator to two items', () => {
    const report = matchOpsToItems(ops, [{ x: 60, y: 700 }, { x: 60, y: 700.2 }]);
    const used = report.matched.map((m) => m.opIndex);
    expect(new Set(used).size).toBe(used.length);
    expect(report.unmatchedItems.length + report.matched.length).toBe(2);
  });
});

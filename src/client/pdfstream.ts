/**
 * A small PDF content-stream reader, enough to find and remove text.
 *
 * This is what makes surgical deletion possible. A PDF page's content stream is
 * a sequence of operators, and the text on the page is drawn by show-text
 * operators (`Tj`, `TJ`, `'`, `"`). Delete the operator and the characters are
 * genuinely gone from the file — no black box over the top, no flattening the
 * page to pixels, and everything else on the page is untouched.
 *
 * What this deliberately does NOT do is decode the strings. In a subset-embedded
 * font the bytes inside `(...)` or `<...>` are glyph codes with a private
 * mapping, not text, so anything that reads them as ASCII is guessing. Instead
 * each operator is located by *position*, computed from the text and
 * transformation matrices exactly as a renderer would, and matched up with what
 * pdf.js reports for the same page. pdf.js has the fonts and can be trusted for
 * what a string says and how wide it is; this file can be trusted for where the
 * operator lives in the bytes. Neither guesses at the other's job.
 *
 * When the two disagree, the caller is told and offers to flatten the page
 * instead. Refusing is the right answer: quietly deleting the wrong operator
 * would damage a document somebody is about to rely on.
 */

/** A 2x3 affine matrix, in PDF order: [a, b, c, d, e, f]. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export interface ShowTextOp {
  /** Index among show-text operators on this page, in stream order. */
  index: number;
  /** Byte range of the whole operator, operands included. */
  start: number;
  end: number;
  operator: 'Tj' | 'TJ' | "'" | '"';
  /** Where the text starts, in unrotated PDF user space. */
  x: number;
  y: number;
  /** Effective font size after the text matrix's scale. */
  size: number;
  /** The resource name of the font, e.g. `/F1`. Useful for diagnostics. */
  font: string;
  /** Raw operand bytes, so a caller can rewrite the string if it dares. */
  operandStart: number;
  operandEnd: number;
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

interface Token {
  kind: 'number' | 'string' | 'name' | 'array' | 'dict' | 'operator';
  start: number;
  end: number;
  value?: number;
  text?: string;
}

/**
 * Walk the stream one token at a time.
 *
 * Strings and arrays are skipped over rather than parsed into values: nothing
 * here needs their contents, and not parsing them means never mis-parsing them.
 * Escapes and nesting inside literal strings are handled, because a `)` inside
 * a string would otherwise end the token early and desynchronise everything
 * after it.
 */
export function* tokenize(bytes: Uint8Array): Generator<Token> {
  let i = 0;
  const at = (k: number) => bytes[k] ?? -1;

  while (i < bytes.length) {
    const c = at(i);

    if (WHITESPACE.has(c)) {
      i++;
      continue;
    }

    // Comment: to end of line.
    if (c === 0x25) {
      while (i < bytes.length && at(i) !== 0x0a && at(i) !== 0x0d) i++;
      continue;
    }

    const start = i;

    // Literal string: (...) with backslash escapes and balanced parentheses.
    if (c === 0x28) {
      let depth = 0;
      for (; i < bytes.length; i++) {
        const b = at(i);
        if (b === 0x5c) {
          i++; // skip the escaped byte
          continue;
        }
        if (b === 0x28) depth++;
        else if (b === 0x29) {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      yield { kind: 'string', start, end: i };
      continue;
    }

    // Hex string <...>, or a dictionary <<...>>.
    if (c === 0x3c) {
      if (at(i + 1) === 0x3c) {
        let depth = 0;
        for (; i < bytes.length; i++) {
          if (at(i) === 0x3c && at(i + 1) === 0x3c) {
            depth++;
            i++;
          } else if (at(i) === 0x3e && at(i + 1) === 0x3e) {
            depth--;
            i++;
            if (depth === 0) {
              i++;
              break;
            }
          }
        }
        yield { kind: 'dict', start, end: i };
        continue;
      }
      while (i < bytes.length && at(i) !== 0x3e) i++;
      i++;
      yield { kind: 'string', start, end: i };
      continue;
    }

    // Array [...] — may contain strings, so it is walked, not scanned.
    if (c === 0x5b) {
      let depth = 0;
      for (; i < bytes.length; i++) {
        const b = at(i);
        if (b === 0x28) {
          // Skip a literal string wholesale.
          let sdepth = 0;
          for (; i < bytes.length; i++) {
            const s = at(i);
            if (s === 0x5c) {
              i++;
              continue;
            }
            if (s === 0x28) sdepth++;
            else if (s === 0x29) {
              sdepth--;
              if (sdepth === 0) break;
            }
          }
          continue;
        }
        if (b === 0x5b) depth++;
        else if (b === 0x5d) {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      yield { kind: 'array', start, end: i };
      continue;
    }

    // Name /Foo
    if (c === 0x2f) {
      i++;
      while (i < bytes.length && !WHITESPACE.has(at(i)) && !DELIMITERS.has(at(i))) i++;
      yield { kind: 'name', start, end: i, text: latin1(bytes, start, i) };
      continue;
    }

    // Number
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      i++;
      while (i < bytes.length && !WHITESPACE.has(at(i)) && !DELIMITERS.has(at(i))) i++;
      const raw = latin1(bytes, start, i);
      yield { kind: 'number', start, end: i, value: Number.parseFloat(raw) || 0 };
      continue;
    }

    // Anything else is an operator token.
    i++;
    while (i < bytes.length && !WHITESPACE.has(at(i)) && !DELIMITERS.has(at(i))) i++;
    yield { kind: 'operator', start, end: i, text: latin1(bytes, start, i) };
  }
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

/**
 * Find every show-text operator, with the position it draws at.
 *
 * The state machine tracks what a renderer would: the graphics matrix stack
 * (`q`/`Q`/`cm`), the text and line matrices (`Tm`/`Td`/`TD`/`T*`), leading
 * (`TL`) and the current font (`Tf`). That is the minimum needed to say where a
 * string lands on the page, which is how operators get matched to what the
 * reader sees.
 */
export function findTextOps(bytes: Uint8Array): ShowTextOp[] {
  const ops: ShowTextOp[] = [];
  let ctm: Matrix = [...IDENTITY];
  const stack: Matrix[] = [];
  let tm: Matrix = [...IDENTITY];
  let tlm: Matrix = [...IDENTITY];
  let leading = 0;
  let font = '';
  let fontSize = 0;

  // Operands accumulate until an operator consumes them.
  let operands: Token[] = [];
  const nums = () => operands.filter((t) => t.kind === 'number').map((t) => t.value ?? 0);

  for (const token of tokenize(bytes)) {
    if (token.kind !== 'operator') {
      operands.push(token);
      continue;
    }

    const op = token.text ?? '';
    const n = nums();

    switch (op) {
      case 'q':
        stack.push([...ctm] as Matrix);
        break;
      case 'Q':
        ctm = stack.pop() ?? [...IDENTITY];
        break;
      case 'cm':
        if (n.length >= 6) ctm = multiply(n.slice(0, 6) as Matrix, ctm);
        break;
      case 'BT':
        tm = [...IDENTITY];
        tlm = [...IDENTITY];
        break;
      case 'ET':
        break;
      case 'Tf':
        font = operands.find((t) => t.kind === 'name')?.text ?? font;
        if (n.length >= 1) fontSize = n[n.length - 1]!;
        break;
      case 'TL':
        if (n.length >= 1) leading = n[0]!;
        break;
      case 'Td':
        if (n.length >= 2) {
          tlm = multiply([1, 0, 0, 1, n[0]!, n[1]!], tlm);
          tm = [...tlm] as Matrix;
        }
        break;
      case 'TD':
        if (n.length >= 2) {
          leading = -n[1]!;
          tlm = multiply([1, 0, 0, 1, n[0]!, n[1]!], tlm);
          tm = [...tlm] as Matrix;
        }
        break;
      case 'Tm':
        if (n.length >= 6) {
          tlm = n.slice(0, 6) as Matrix;
          tm = [...tlm] as Matrix;
        }
        break;
      case 'T*':
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = [...tlm] as Matrix;
        break;
      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        if (op === "'" || op === '"') {
          tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
          tm = [...tlm] as Matrix;
        }
        const full = multiply(tm, ctm);
        const payload = operands.filter((t) => t.kind === 'string' || t.kind === 'array');
        const first = payload[0];
        ops.push({
          index: ops.length,
          start: operands.length ? operands[0]!.start : token.start,
          end: token.end,
          operator: op as ShowTextOp['operator'],
          x: full[4],
          y: full[5],
          // The vertical scale of the combined matrix is what actually sets the
          // rendered size; a 1pt font inside a 12x matrix is 12pt on the page.
          size: fontSize * Math.hypot(full[2], full[3]),
          font,
          operandStart: first ? first.start : token.start,
          operandEnd: first ? first.end : token.start,
        });
        break;
      }
      default:
        break;
    }

    operands = [];
  }

  return ops;
}

/**
 * Remove show-text operators, leaving everything else byte-for-byte intact.
 *
 * The operator and its operands are replaced with spaces rather than cut out,
 * so every other byte offset in the stream stays valid and a second edit does
 * not need the offsets recomputing. Content streams ignore extra whitespace, so
 * the result is a normal, valid stream.
 */
export function removeTextOps(bytes: Uint8Array, indices: number[]): Uint8Array {
  const ops = findTextOps(bytes);
  const wanted = new Set(indices);
  const out = new Uint8Array(bytes);

  for (const op of ops) {
    if (!wanted.has(op.index)) continue;
    for (let i = op.start; i < op.end; i++) out[i] = 0x20;
  }

  return out;
}

/** How well the operators line up with what a renderer reports for the page. */
export interface MatchReport {
  matched: { opIndex: number; itemIndex: number }[];
  /** Items no operator could be matched to, i.e. text this cannot safely remove. */
  unmatchedItems: number[];
}

/**
 * Match operators to a renderer's text items by position.
 *
 * Deliberately not by string content: in a subset font the operand bytes are
 * glyph codes, so comparing them to text would be comparing two different
 * alphabets. Position is the one thing both sides compute the same way.
 *
 * `tolerance` is in points. Renderers accumulate rounding differently, so exact
 * equality is not on the table; a point either way is far tighter than the gap
 * between two adjacent pieces of text.
 */
export function matchOpsToItems(
  ops: ShowTextOp[],
  items: { x: number; y: number }[],
  tolerance = 1.5,
): MatchReport {
  const matched: { opIndex: number; itemIndex: number }[] = [];
  const unmatchedItems: number[] = [];
  const usedOps = new Set<number>();

  items.forEach((item, itemIndex) => {
    let best = -1;
    let bestDistance = Infinity;
    for (const op of ops) {
      if (usedOps.has(op.index)) continue;
      const distance = Math.hypot(op.x - item.x, op.y - item.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = op.index;
      }
    }
    if (best >= 0 && bestDistance <= tolerance) {
      usedOps.add(best);
      matched.push({ opIndex: best, itemIndex });
    } else {
      unmatchedItems.push(itemIndex);
    }
  });

  return { matched, unmatchedItems };
}

const globalScope = globalThis as unknown as {
  LOC1999_STREAM?: {
    findTextOps: typeof findTextOps;
    removeTextOps: typeof removeTextOps;
    matchOpsToItems: typeof matchOpsToItems;
  };
};
globalScope.LOC1999_STREAM = { findTextOps, removeTextOps, matchOpsToItems };

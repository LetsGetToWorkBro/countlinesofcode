/**
 * A line-and-character diff, written here rather than pulled from a library.
 *
 * The algorithm is Myers' O(ND) diff (the one git and diff(1) use), which
 * finds the shortest edit script between two sequences. It runs first over the
 * lines of the two texts to decide which lines match, and then, on a pair of
 * lines that changed, again over their characters to show which part of the
 * line changed. That second pass is the whole reason the result reads like
 * WinMerge and not like two columns of red: the eye is pointed at the one word
 * that moved, not the whole line.
 *
 * Everything here is pure. The page draws the rows; the tests check the script.
 */

export type Op = 'equal' | 'delete' | 'insert';

export interface Edit<T> {
  op: Op;
  value: T;
  /** Index in the left sequence, when this token exists there. */
  a?: number;
  /** Index in the right sequence, when this token exists there. */
  b?: number;
}

/**
 * Myers' shortest-edit-script diff between two arrays.
 *
 * Returns the edit script as a flat list of equal/delete/insert operations in
 * order. `eq` decides token equality, defaulting to `===`, so the same routine
 * serves both the line pass (strings) and the character pass (code points).
 */
export function diffSequences<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): Edit<T>[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;

  // A degenerate side needs no search: everything is an insert or a delete.
  if (n === 0) return b.map((value, i) => ({ op: 'insert' as const, value, b: i }));
  if (m === 0) return a.map((value, i) => ({ op: 'delete' as const, value, a: i }));

  const offset = max;
  const v = new Int32Array(2 * max + 1);
  // The trace: one V array per edit distance d, so the path can be walked back.
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!; // move down (an insert from b)
      } else {
        x = v[offset + k - 1]! + 1; // move right (a delete from a)
      }
      let y = x - k;
      while (x < n && y < m && eq(a[x]!, b[y]!)) { x++; y++; } // slide the diagonal
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }

  // Walk the trace back from the end to reconstruct the operations.
  const edits: Edit<T>[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vPrev = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[offset + k - 1]! < vPrev[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--; y--;
      edits.push({ op: 'equal', value: a[x]!, a: x, b: y });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        edits.push({ op: 'insert', value: b[y]!, b: y });
      } else {
        x--;
        edits.push({ op: 'delete', value: a[x]!, a: x });
      }
    }
  }
  while (x > 0 && y > 0) { x--; y--; edits.push({ op: 'equal', value: a[x]!, a: x, b: y }); }
  while (x > 0) { x--; edits.push({ op: 'delete', value: a[x]!, a: x }); }
  while (y > 0) { y--; edits.push({ op: 'insert', value: b[y]!, b: y }); }

  edits.reverse();
  return edits;
}

/** Split a text into lines, keeping no trailing newline as an empty last line. */
export function splitLines(text: string): string[] {
  const normalised = String(text ?? '').replace(/\r\n?/g, '\n');
  return normalised.split('\n');
}

export interface DiffRow {
  /** 'same', 'change' (both sides, differing), 'delete' (left only),
   *  'insert' (right only). */
  kind: 'same' | 'change' | 'delete' | 'insert';
  left: string | null;
  right: string | null;
  /** 1-based source line numbers, when the side has a line here. */
  leftNo: number | null;
  rightNo: number | null;
}

/**
 * A side-by-side alignment of two texts.
 *
 * A run of deletes immediately followed by a run of inserts is the same thing
 * a person calls "these lines changed", so the two runs are zipped into
 * `change` rows that sit across from each other; any overhang stays a plain
 * delete or insert. That pairing is what lets the character diff have two
 * lines to compare.
 */
export function diffRows(leftText: string, rightText: string): DiffRow[] {
  const a = splitLines(leftText);
  const b = splitLines(rightText);
  const edits = diffSequences(a, b);

  const rows: DiffRow[] = [];
  let i = 0;
  while (i < edits.length) {
    const e = edits[i]!;
    if (e.op === 'equal') {
      rows.push({ kind: 'same', left: e.value, right: e.value, leftNo: e.a! + 1, rightNo: e.b! + 1 });
      i++;
      continue;
    }
    // Gather the contiguous block of non-equal edits.
    const dels: Edit<string>[] = [];
    const ins: Edit<string>[] = [];
    while (i < edits.length && edits[i]!.op !== 'equal') {
      if (edits[i]!.op === 'delete') dels.push(edits[i]!);
      else ins.push(edits[i]!);
      i++;
    }
    const paired = Math.min(dels.length, ins.length);
    for (let p = 0; p < paired; p++) {
      rows.push({
        kind: 'change',
        left: dels[p]!.value,
        right: ins[p]!.value,
        leftNo: dels[p]!.a! + 1,
        rightNo: ins[p]!.b! + 1,
      });
    }
    for (let p = paired; p < dels.length; p++) {
      rows.push({ kind: 'delete', left: dels[p]!.value, right: null, leftNo: dels[p]!.a! + 1, rightNo: null });
    }
    for (let p = paired; p < ins.length; p++) {
      rows.push({ kind: 'insert', left: null, right: ins[p]!.value, leftNo: null, rightNo: ins[p]!.b! + 1 });
    }
  }
  return rows;
}

export interface Span {
  value: string;
  changed: boolean;
}

/**
 * The character-level diff of one changed line, as spans for each side.
 *
 * Uses code points, not UTF-16 units, so an emoji or a combining pair is one
 * token and never splits down the middle. Equal runs are `changed:false`;
 * the parts unique to each side are `changed:true`, which the page tints.
 */
export function charSpans(left: string, right: string): { left: Span[]; right: Span[] } {
  const a = Array.from(String(left ?? ''));
  const b = Array.from(String(right ?? ''));
  const edits = diffSequences(a, b);

  const leftSpans: Span[] = [];
  const rightSpans: Span[] = [];
  const push = (spans: Span[], value: string, changed: boolean) => {
    const last = spans[spans.length - 1];
    if (last && last.changed === changed) last.value += value;
    else spans.push({ value, changed });
  };
  for (const e of edits) {
    if (e.op === 'equal') {
      push(leftSpans, e.value, false);
      push(rightSpans, e.value, false);
    } else if (e.op === 'delete') {
      push(leftSpans, e.value, true);
    } else {
      push(rightSpans, e.value, true);
    }
  }
  return { left: leftSpans, right: rightSpans };
}

export interface DiffStats {
  same: number;
  changed: number;
  deleted: number;
  inserted: number;
  identical: boolean;
}

export function diffStats(rows: DiffRow[]): DiffStats {
  let same = 0;
  let changed = 0;
  let deleted = 0;
  let inserted = 0;
  for (const row of rows) {
    if (row.kind === 'same') same++;
    else if (row.kind === 'change') changed++;
    else if (row.kind === 'delete') deleted++;
    else inserted++;
  }
  return { same, changed, deleted, inserted, identical: changed + deleted + inserted === 0 };
}

const globalScope = globalThis as unknown as { LOC1999_DIFF?: Record<string, unknown> };
globalScope.LOC1999_DIFF = {
  diffSequences,
  splitLines,
  diffRows,
  charSpans,
  diffStats,
};

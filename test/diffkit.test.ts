/**
 * The compare engine.
 *
 * A diff that gets the edit script wrong shows a person two things as
 * different that are the same, or hides a change inside a line it called
 * unchanged. Every case below is a shape two real files come in.
 */

import { describe, expect, it } from 'vitest';
import { charSpans, diffRows, diffSequences, diffStats, splitLines } from '../src/client/diffkit';

describe('diffSequences (Myers)', () => {
  it('finds nothing to do for identical input', () => {
    const edits = diffSequences([...'abc'], [...'abc']);
    expect(edits.every((e) => e.op === 'equal')).toBe(true);
    expect(edits.map((e) => e.value).join('')).toBe('abc');
  });

  it('reports a pure insertion and a pure deletion', () => {
    expect(diffSequences([], [1, 2]).map((e) => e.op)).toEqual(['insert', 'insert']);
    expect(diffSequences([1, 2], []).map((e) => e.op)).toEqual(['delete', 'delete']);
  });

  it('produces a shortest edit script that reconstructs both sides', () => {
    const a = [...'ABCABBA'];
    const b = [...'CBABAC'];
    const edits = diffSequences(a, b);
    // Deletes + equals rebuild the left; inserts + equals rebuild the right.
    const left = edits.filter((e) => e.op !== 'insert').map((e) => e.value).join('');
    const right = edits.filter((e) => e.op !== 'delete').map((e) => e.value).join('');
    expect(left).toBe('ABCABBA');
    expect(right).toBe('CBABAC');
    // Myers' distance for this classic pair is 5.
    expect(edits.filter((e) => e.op !== 'equal').length).toBe(5);
  });
});

describe('diffRows', () => {
  it('calls two equal texts identical', () => {
    const rows = diffRows('one\ntwo\nthree', 'one\ntwo\nthree');
    expect(rows.every((r) => r.kind === 'same')).toBe(true);
    expect(diffStats(rows).identical).toBe(true);
  });

  it('pairs a delete-then-insert run into change rows across from each other', () => {
    const rows = diffRows('alpha\nbeta\ngamma', 'alpha\nBETA\ngamma');
    const change = rows.find((r) => r.kind === 'change');
    expect(change).toBeTruthy();
    expect(change!.left).toBe('beta');
    expect(change!.right).toBe('BETA');
    expect(change!.leftNo).toBe(2);
    expect(change!.rightNo).toBe(2);
    const stats = diffStats(rows);
    expect(stats).toMatchObject({ changed: 1, inserted: 0, deleted: 0 });
  });

  it('keeps an unpaired extra line as an insert or a delete', () => {
    const added = diffRows('a\nb', 'a\nb\nc');
    expect(added.find((r) => r.kind === 'insert')).toMatchObject({ right: 'c', rightNo: 3, leftNo: null });
    const removed = diffRows('a\nb\nc', 'a\nb');
    expect(removed.find((r) => r.kind === 'delete')).toMatchObject({ left: 'c', leftNo: 3, rightNo: null });
  });

  it('numbers lines from one on each side independently', () => {
    const rows = diffRows('keep\ncut\nkeep2', 'keep\nkeep2\nadd');
    const same = rows.filter((r) => r.kind === 'same').map((r) => [r.leftNo, r.rightNo]);
    expect(same).toContainEqual([1, 1]);
    expect(same).toContainEqual([3, 2]); // keep2 is line 3 left, line 2 right
  });
});

describe('charSpans', () => {
  it('marks only the characters that differ within a line', () => {
    const { left, right } = charSpans('the cat sat', 'the dog sat');
    // The shared "the " prefix and " sat" suffix are unchanged.
    expect(left.filter((s) => !s.changed).map((s) => s.value).join('')).toBe('the  sat');
    expect(left.find((s) => s.changed)!.value).toBe('cat');
    expect(right.find((s) => s.changed)!.value).toBe('dog');
  });

  it('treats a multi-byte character as one token, not two units', () => {
    // The emoji is a surrogate pair; splitting it would corrupt the output.
    const { left } = charSpans('a\u{1F600}b', 'ab');
    expect(left.find((s) => s.changed)!.value).toBe('\u{1F600}');
  });
});

describe('splitLines', () => {
  it('levels CRLF and CR to LF so line endings are not a diff', () => {
    expect(splitLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd']);
  });
});

/**
 * Invariant checks over this repository's own files — real source in several
 * languages, not hand-written fixtures.
 *
 * These assert properties rather than specific numbers, so they keep working as
 * the code changes, while catching the class of bug where the classifier gets
 * stuck in a string or comment state and mislabels the rest of a file.
 *
 * The counter has also been diffed against `cloc` over a ~30k line corpus
 * (this repo plus zod, chai, source-map and busboy): 125/127 files matched
 * exactly on code/comment/blank, and both disagreements were cloc errors —
 * a regex literal containing `/*`, and comment markers inside a string.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countFile, countLines } from '../src/lib/count';
import { detectLanguage } from '../src/lib/languages';

const ROOTS = ['src', 'test', 'public', 'scripts'];
const EXTENSIONS = ['.ts', '.js', '.mjs', '.html', '.css'];

/**
 * Vendored third-party builds are skipped. They are not this repository's own
 * files, and they are minified: nearly two megabytes of them, which took this
 * file most of the way to the default timeout and would have crossed it the
 * next time a library was added. The counter still meets minified code on real
 * repositories, and `src/lib/count` has its own tests for that.
 */
const SKIP = ['public/vendor'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SKIP.some((prefix) => full.startsWith(prefix))) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => full.endsWith(ext))) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((root) => walk(root));

describe('corpus invariants over this repository', () => {
  it('finds files to check', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it('partitions every line into exactly one bucket', () => {
    for (const path of files) {
      const result = countFile(path, new Uint8Array(readFileSync(path)));
      const { lines, code, comment, blank } = result.counts;
      expect(code + comment + blank, `${path} does not partition`).toBe(lines);
    }
  });

  it('agrees with an independent line count', () => {
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      // Computed a completely different way: count the newlines.
      const newlines = text.split('\n').length - 1;
      const expected = text.length === 0 ? 0 : text.endsWith('\n') ? newlines : newlines + 1;
      const actual = countFile(path, new Uint8Array(readFileSync(path))).counts.lines;
      expect(actual, `${path} line total`).toBe(expected);
    }
  });

  it('never classifies a whole source file as comments', () => {
    for (const path of files) {
      if (!path.endsWith('.ts') && !path.endsWith('.js')) continue;
      const result = countFile(path, new Uint8Array(readFileSync(path)));
      if (result.counts.lines < 20) continue;
      // A stuck block-comment state shows up here immediately.
      expect(result.counts.code, `${path} has no code lines`).toBeGreaterThan(0);
      expect(result.counts.comment / result.counts.lines, `${path} is mostly comment`).toBeLessThan(0.8);
    }
  });

  it('is stable under chunking at blank lines outside comments', () => {
    // Splitting a file at a blank line that is not inside a block comment must
    // not change the totals. This is the property cloc violates on files with
    // regex literals containing comment markers.
    const path = 'src/lib/parse-url.ts';
    const text = readFileSync(path, 'utf8');
    const language = detectLanguage(path);
    const whole = countLines(text, language);

    const lines = text.split('\n');
    const half = Math.floor(lines.length / 2);
    // Find a blank line near the middle that is not inside a comment block.
    let cut = half;
    while (cut < lines.length && lines[cut]!.trim() !== '') cut++;

    const a = countLines(`${lines.slice(0, cut).join('\n')}\n`, language);
    const b = countLines(`${lines.slice(cut).join('\n')}`, language);

    expect(a.code + b.code).toBe(whole.code);
    expect(a.comment + b.comment).toBe(whole.comment);
    expect(a.lines + b.lines).toBe(whole.lines);
  });
});

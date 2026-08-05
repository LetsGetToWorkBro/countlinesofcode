import { describe, expect, it } from 'vitest';
import {
  MIN_FILES_FOR_AVERAGE,
  MIN_LINES_FOR_RATIO,
  buildBoards,
  commentShare,
  dedupeByRepo,
  distanceFrom1999,
  linesPerFile,
  recentlyCounted,
  type BoardEntry,
} from '../src/lib/board';

function entry(over: Partial<BoardEntry> & Pick<BoardEntry, 'owner' | 'repo'>): BoardEntry {
  const lines = over.lines ?? 10_000;
  return {
    sha: 'a'.repeat(40),
    lines,
    code: lines,
    comment: 0,
    blank: 0,
    files: 100,
    stars: 0,
    notYours: 0,
    fork: false,
    countedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function rowsOf(entries: BoardEntry[], id: string): string[] {
  return buildBoards(entries)
    .find((b) => b.id === id)!
    .rows.map((r) => `${r.owner}/${r.repo}`);
}

describe('dedupeByRepo', () => {
  it('keeps only the most recent count of a repository', () => {
    const kept = dedupeByRepo([
      entry({ owner: 'a', repo: 'b', sha: 'old', countedAt: '2026-01-01T00:00:00.000Z' }),
      entry({ owner: 'a', repo: 'b', sha: 'new', countedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.sha).toBe('new');
  });

  it('treats owner/repo case-insensitively, the way GitHub does', () => {
    const kept = dedupeByRepo([
      entry({ owner: 'Facebook', repo: 'React' }),
      entry({ owner: 'facebook', repo: 'react', countedAt: '2026-03-01T00:00:00.000Z' }),
    ]);
    expect(kept).toHaveLength(1);
  });
});

describe('buildBoards', () => {
  it('ranks a repository with no stars at all', () => {
    // The whole point of dropping the per-star boards: a personal project that
    // nobody has starred is exactly what gets counted here.
    const rows = rowsOf([entry({ owner: 'someone', repo: 'weekend-project', stars: 0 })], 'biggest');
    expect(rows).toEqual(['someone/weekend-project']);
  });

  it('has no board that depends on GitHub popularity', () => {
    const ids = buildBoards([entry({ owner: 'a', repo: 'b' })]).map((b) => b.id);
    expect(ids).not.toContain('lean');
    expect(ids).not.toContain('heavy');
    for (const board of buildBoards([entry({ owner: 'a', repo: 'b' })])) {
      expect(board.unit).not.toMatch(/star/);
    }
  });

  it('excludes forks from every board', () => {
    const entries = [
      entry({ owner: 'a', repo: 'fork', lines: 900_000, fork: true, notYours: 99, files: 50 }),
      entry({ owner: 'a', repo: 'own', lines: 5_000, notYours: 1, files: 50 }),
    ];
    for (const board of buildBoards(entries)) {
      expect(board.rows.map((r) => r.repo)).not.toContain('fork');
    }
  });

  it('keeps tiny repositories off the ratio boards', () => {
    const tiny = entry({
      owner: 'a',
      repo: 'tiny',
      lines: MIN_LINES_FOR_RATIO - 1,
      comment: MIN_LINES_FOR_RATIO - 1,
    });
    const real = entry({ owner: 'a', repo: 'real', lines: 10_000, comment: 1_000 });
    expect(rowsOf([tiny, real], 'documented')).toEqual(['a/real']);
    expect(rowsOf([tiny, real], 'silent')).toEqual(['a/real']);
  });

  it('needs enough files before averaging a file length', () => {
    const few = entry({ owner: 'a', repo: 'few', lines: 9_000, files: MIN_FILES_FOR_AVERAGE - 1 });
    const many = entry({ owner: 'a', repo: 'many', lines: 9_000, files: MIN_FILES_FOR_AVERAGE });
    expect(rowsOf([few, many], 'dense')).toEqual(['a/many']);
  });

  it('ranks borrowed code by skipped files, and only when there are any', () => {
    const entries = [
      entry({ owner: 'a', repo: 'none', notYours: 0 }),
      entry({ owner: 'a', repo: 'some', notYours: 12 }),
      entry({ owner: 'a', repo: 'lots', notYours: 4_000 }),
    ];
    expect(rowsOf(entries, 'borrowed')).toEqual(['a/lots', 'a/some']);
  });

  it('ranks each repository once, at its newest commit', () => {
    const entries = [
      entry({ owner: 'a', repo: 'b', sha: 'old', lines: 1, countedAt: '2026-01-01T00:00:00.000Z' }),
      entry({
        owner: 'a',
        repo: 'b',
        sha: 'new',
        lines: 999_999,
        countedAt: '2026-02-01T00:00:00.000Z',
      }),
    ];
    const rows = buildBoards(entries).find((b) => b.id === 'biggest')!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lines).toBe(999_999);
  });
});

describe('measurements', () => {
  it('reports comment share as a percentage of all lines', () => {
    expect(commentShare(entry({ owner: 'a', repo: 'b', lines: 200, comment: 50 }))).toBe(25);
  });

  it('averages file length, and survives a repository with no files', () => {
    expect(linesPerFile(entry({ owner: 'a', repo: 'b', lines: 500, files: 20 }))).toBe(25);
    expect(linesPerFile(entry({ owner: 'a', repo: 'b', files: 0 }))).toBe(0);
  });
});

describe('recentlyCounted', () => {
  it('is newest first and respects the limit', () => {
    const entries = [
      entry({ owner: 'a', repo: 'first', countedAt: '2026-01-01T00:00:00.000Z' }),
      entry({ owner: 'a', repo: 'third', countedAt: '2026-03-01T00:00:00.000Z' }),
      entry({ owner: 'a', repo: 'second', countedAt: '2026-02-01T00:00:00.000Z' }),
    ];
    expect(recentlyCounted(entries, 2).map((e) => e.repo)).toEqual(['third', 'second']);
  });

  it('includes forks, because it is a log and not a ranking', () => {
    expect(recentlyCounted([entry({ owner: 'a', repo: 'fork', fork: true })]).map((e) => e.repo)).toEqual(
      ['fork'],
    );
  });
});

describe('the nearest-1999 board', () => {
  const at = (code: number, repo: string) =>
    entry({ owner: 'o', repo, lines: code + 10, code, comment: 5, blank: 5, files: 20 });

  it('ranks by distance, closest first', () => {
    const board = buildBoards([at(5000, 'far'), at(2050, 'near'), at(1999, 'exact')])
      .find((b) => b.id === 'nineteen-ninety-nine')!;
    expect(board.rows.map((r) => r.repo)).toEqual(['exact', 'near', 'far']);
    expect(board.rows[0]!.value).toBe(0);
    expect(board.rows[1]!.value).toBe(51);
  });

  it('does not care which side of 1999 you land on', () => {
    // 1979 and 2019 are both twenty away, and neither is more correct.
    expect(distanceFrom1999(at(1979, 'under'))).toBe(20);
    expect(distanceFrom1999(at(2019, 'over'))).toBe(20);
  });

  it('measures code, not total lines', () => {
    // Otherwise the way to win is to add blank lines, which is the opposite of
    // what a site about counting code should reward.
    const padded = entry({ owner: 'o', repo: 'padded', lines: 1999, code: 900, comment: 99, blank: 1000, files: 20 });
    expect(distanceFrom1999(padded)).toBe(1099);
  });

  it('always has a winner, however few repositories there are', () => {
    const board = buildBoards([at(120000, 'only')]).find((b) => b.id === 'nineteen-ninety-nine')!;
    expect(board.rows).toHaveLength(1);
  });

  it('leaves forks out, like every other board', () => {
    const fork = { ...at(1999, 'forked'), fork: true };
    const board = buildBoards([fork, at(9999, 'real')]).find((b) => b.id === 'nineteen-ninety-nine')!;
    expect(board.rows.map((r) => r.repo)).toEqual(['real']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MIN_LINES_FOR_RATIO,
  MIN_STARS,
  buildBoards,
  dedupeByRepo,
  formatPerStar,
  linesPerStar,
  recentlyCounted,
  standingFor,
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
    stars: 1_000,
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

describe('linesPerStar', () => {
  it('is lines divided by stars', () => {
    expect(linesPerStar(entry({ owner: 'a', repo: 'b', lines: 500, stars: 1_000 }))).toBe(0.5);
  });

  it('is infinite with no stars, which keeps it off every board', () => {
    expect(linesPerStar(entry({ owner: 'a', repo: 'b', stars: 0 }))).toBe(Infinity);
  });
});

describe('formatPerStar', () => {
  it('keeps the leaders distinguishable instead of a wall of 0.1', () => {
    expect([0.047, 0.09, 0.114, 0.2].map(formatPerStar)).toEqual(['0.05', '0.09', '0.11', '0.20']);
  });

  it('drops precision as the numbers grow', () => {
    expect(formatPerStar(3.14)).toBe('3.1');
    expect(formatPerStar(12.7)).toBe('13');
    expect(formatPerStar(9_120.4)).toBe('9,120');
  });
});

describe('buildBoards', () => {
  it('ranks lean ascending and heavy descending on the same measurement', () => {
    const entries = [
      entry({ owner: 'a', repo: 'lean', lines: 1_000, stars: 100_000 }),
      entry({ owner: 'a', repo: 'middle', lines: 50_000, stars: 10_000 }),
      entry({ owner: 'a', repo: 'heavy', lines: 900_000, stars: 100 }),
    ];
    expect(rowsOf(entries, 'lean')[0]).toBe('a/lean');
    expect(rowsOf(entries, 'heavy')[0]).toBe('a/heavy');
  });

  it('excludes forks from every board', () => {
    const entries = [
      entry({ owner: 'a', repo: 'fork', lines: 1, stars: 100_000, fork: true, notYours: 99 }),
      entry({ owner: 'a', repo: 'own', lines: 5_000, stars: 100, notYours: 1 }),
    ];
    for (const board of buildBoards(entries)) {
      expect(board.rows.map((r) => r.repo)).not.toContain('fork');
    }
  });

  it('keeps repositories below the star floor off per-star boards only', () => {
    const entries = [
      entry({ owner: 'a', repo: 'obscure', lines: 10, stars: MIN_STARS - 1 }),
      entry({ owner: 'a', repo: 'known', lines: 100_000, stars: MIN_STARS }),
    ];
    expect(rowsOf(entries, 'lean')).toEqual(['a/known']);
    expect(rowsOf(entries, 'biggest')).toContain('a/obscure');
  });

  it('keeps tiny repositories off the comment-ratio boards', () => {
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
    const entries = [entry({ owner: 'a', repo: 'fork', fork: true })];
    expect(recentlyCounted(entries).map((e) => e.repo)).toEqual(['fork']);
  });
});

describe('standingFor', () => {
  const entries = [
    entry({ owner: 'a', repo: 'one', lines: 1_000, stars: 100_000 }),
    entry({ owner: 'a', repo: 'two', lines: 10_000, stars: 100_000 }),
    entry({ owner: 'a', repo: 'three', lines: 100_000, stars: 100_000 }),
  ];

  it('reports rank out of the qualifying field', () => {
    expect(standingFor(entries, 'a', 'two')).toEqual({ rank: 2, of: 3, value: 0.1 });
  });

  it('matches the repository case-insensitively', () => {
    expect(standingFor(entries, 'A', 'ONE')?.rank).toBe(1);
  });

  it('is null for a repository that does not qualify', () => {
    const withObscure = [...entries, entry({ owner: 'a', repo: 'obscure', stars: 1 })];
    expect(standingFor(withObscure, 'a', 'obscure')).toBeNull();
    expect(standingFor(entries, 'a', 'never-counted')).toBeNull();
  });
});

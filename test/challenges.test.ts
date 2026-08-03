import { describe, expect, it } from 'vitest';
import {
  CHALLENGES,
  MIN_CODE_LINES,
  buildChallengeBoards,
  findChallenge,
  placeOf,
  rankEntries,
  type GolfEntry,
} from '../src/lib/challenges';

function entry(over: Partial<GolfEntry> & Pick<GolfEntry, 'owner' | 'repo' | 'code'>): GolfEntry {
  return {
    challenge: 'markdown',
    sha: 'a'.repeat(40),
    lines: over.code + 10,
    bytes: over.code * 40,
    files: 1,
    language: 'JavaScript',
    countedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('the challenge list', () => {
  it('has unique, URL-safe ids', () => {
    const ids = CHALLENGES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('tells you what a solution has to do', () => {
    for (const challenge of CHALLENGES) {
      expect(challenge.rules.length).toBeGreaterThanOrEqual(2);
      expect(challenge.brief.length).toBeGreaterThan(10);
    }
  });

  it('only finds challenges that exist', () => {
    expect(findChallenge('markdown')?.title).toBe('Markdown to HTML');
    expect(findChallenge('../../etc/passwd')).toBeNull();
    expect(findChallenge('')).toBeNull();
  });
});

describe('rankEntries', () => {
  it('puts the fewest lines of code first', () => {
    const ranked = rankEntries([
      entry({ owner: 'a', repo: 'verbose', code: 400 }),
      entry({ owner: 'a', repo: 'tight', code: 40 }),
      entry({ owner: 'a', repo: 'middling', code: 120 }),
    ]);
    expect(ranked.map((e) => e.repo)).toEqual(['tight', 'middling', 'verbose']);
  });

  it('breaks ties on bytes, so a one-line program cannot hide', () => {
    const ranked = rankEntries([
      entry({ owner: 'a', repo: 'crammed', code: 20, bytes: 9_000 }),
      entry({ owner: 'a', repo: 'readable', code: 20, bytes: 700 }),
    ]);
    expect(ranked.map((e) => e.repo)).toEqual(['readable', 'crammed']);
  });

  it('ignores an empty repository trying to win by having nothing in it', () => {
    const ranked = rankEntries([
      entry({ owner: 'a', repo: 'empty', code: MIN_CODE_LINES - 1 }),
      entry({ owner: 'a', repo: 'real', code: 60 }),
    ]);
    expect(ranked.map((e) => e.repo)).toEqual(['real']);
  });

  it('keeps one entry per repository, at its most recent count', () => {
    const ranked = rankEntries([
      entry({ owner: 'a', repo: 'b', code: 90, countedAt: '2026-01-01T00:00:00.000Z' }),
      entry({ owner: 'a', repo: 'b', code: 30, countedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.code).toBe(30);
  });

  it('lets a later attempt lose ground, rather than keeping the best ever', () => {
    // Submitting again replaces: the board shows what the repository is now,
    // not the best it once was.
    const ranked = rankEntries([
      entry({ owner: 'a', repo: 'b', code: 30, countedAt: '2026-01-01T00:00:00.000Z' }),
      entry({ owner: 'a', repo: 'b', code: 300, countedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    expect(ranked[0]!.code).toBe(300);
  });
});

describe('buildChallengeBoards', () => {
  it('keeps each challenge to its own entries', () => {
    const boards = buildChallengeBoards([
      entry({ owner: 'a', repo: 'md', code: 50, challenge: 'markdown' }),
      entry({ owner: 'a', repo: 'short', code: 20, challenge: 'url-shortener' }),
    ]);
    const markdown = boards.find((b) => b.challenge.id === 'markdown')!;
    const shortener = boards.find((b) => b.challenge.id === 'url-shortener')!;
    expect(markdown.entries.map((e) => e.repo)).toEqual(['md']);
    expect(shortener.entries.map((e) => e.repo)).toEqual(['short']);
  });

  it('returns every challenge, even the empty ones', () => {
    expect(buildChallengeBoards([])).toHaveLength(CHALLENGES.length);
  });
});

describe('placeOf', () => {
  const entries = [
    entry({ owner: 'a', repo: 'first', code: 20 }),
    entry({ owner: 'a', repo: 'second', code: 50 }),
    entry({ owner: 'a', repo: 'third', code: 90 }),
  ];

  it('reports the place and the field size', () => {
    expect(placeOf(entries, 'markdown', 'a', 'second')).toEqual({ rank: 2, of: 3, code: 50 });
  });

  it('matches the repository case-insensitively', () => {
    expect(placeOf(entries, 'markdown', 'A', 'FIRST')?.rank).toBe(1);
  });

  it('is null for a repository that never entered', () => {
    expect(placeOf(entries, 'markdown', 'a', 'absent')).toBeNull();
    expect(placeOf(entries, 'url-shortener', 'a', 'first')).toBeNull();
  });
});

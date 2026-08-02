import { describe, expect, it } from 'vitest';
import { ParseError, isValidRef, parseRepoInput } from '../src/lib/parse-url';

describe('parseRepoInput', () => {
  const cases: [string, { owner: string; repo: string; ref?: string }][] = [
    ['owner/repo', { owner: 'owner', repo: 'repo' }],
    ['  owner/repo  ', { owner: 'owner', repo: 'repo' }],
    ['owner/repo@main', { owner: 'owner', repo: 'repo', ref: 'main' }],
    ['https://github.com/vercel/next.js', { owner: 'vercel', repo: 'next.js' }],
    ['https://github.com/vercel/next.js/', { owner: 'vercel', repo: 'next.js' }],
    ['https://github.com/torvalds/linux.git', { owner: 'torvalds', repo: 'linux' }],
    ['http://github.com/a/b', { owner: 'a', repo: 'b' }],
    ['https://www.github.com/a/b', { owner: 'a', repo: 'b' }],
    ['github.com/a/b', { owner: 'a', repo: 'b' }],
    ['www.github.com/a/b', { owner: 'a', repo: 'b' }],
    ['git@github.com:a/b.git', { owner: 'a', repo: 'b' }],
    ['ssh://git@github.com/a/b.git', { owner: 'a', repo: 'b' }],
    ['git://github.com/a/b.git', { owner: 'a', repo: 'b' }],
    ['https://github.com/a/b/tree/main', { owner: 'a', repo: 'b', ref: 'main' }],
    [
      'https://github.com/a/b/tree/feature/nested/name',
      { owner: 'a', repo: 'b', ref: 'feature/nested/name' },
    ],
    ['https://github.com/a/b/blob/main/src/index.ts', { owner: 'a', repo: 'b', ref: 'main' }],
    [
      'https://github.com/a/b/commit/1234567890abcdef1234567890abcdef12345678',
      { owner: 'a', repo: 'b', ref: '1234567890abcdef1234567890abcdef12345678' },
    ],
    [
      'https://github.com/a/b/tree/1234567890abcdef1234567890abcdef12345678/src',
      { owner: 'a', repo: 'b', ref: '1234567890abcdef1234567890abcdef12345678' },
    ],
    ['https://github.com/a/b/pull/42', { owner: 'a', repo: 'b' }],
    ['https://github.com/a/b?tab=readme', { owner: 'a', repo: 'b' }],
  ];

  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)}`, () => {
      expect(parseRepoInput(input)).toEqual(expected);
    });
  }

  const rejected = [
    '',
    '   ',
    'notarepo',
    'https://gitlab.com/a/b',
    'https://evil.com/github.com/a/b',
    'https://github.com.evil.com/a/b',
    'ftp://github.com/a/b',
    'file:///etc/passwd',
    'http://169.254.169.254/latest/meta-data/',
    'owner/repo@../../etc/passwd',
    '-bad/repo',
    'owner/re po',
  ];

  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => parseRepoInput(input)).toThrow(ParseError);
    });
  }

  it('rejects an owner longer than GitHub allows', () => {
    expect(() => parseRepoInput(`${'a'.repeat(40)}/repo`)).toThrow(ParseError);
  });
});

describe('isValidRef', () => {
  it('accepts ordinary refs', () => {
    for (const ref of ['main', 'v1.2.3', 'feature/thing', 'release-2024', 'abc123']) {
      expect(isValidRef(ref)).toBe(true);
    }
  });

  it('rejects traversal and git-illegal names', () => {
    for (const ref of ['../etc', 'a..b', '-lead', 'has space', 'ends/', 'x.lock', 'a?b', 'a\\b']) {
      expect(isValidRef(ref)).toBe(false);
    }
  });
});

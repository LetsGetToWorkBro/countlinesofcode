/**
 * Code golf: one task, fewest lines wins.
 *
 * Ranking whole repositories against each other never worked, because two
 * repositories are not attempting the same thing. A challenge fixes that: every
 * entry on a board below is a solution to the same stated problem, so the line
 * count finally means something.
 *
 * Challenges live in code rather than in storage. There is no admin page, no
 * moderation queue and no way for a challenge to appear without a commit —
 * which is the cheapest possible defence against a leaderboard filling up with
 * junk categories.
 */

export interface Challenge {
  /** URL-safe, permanent. Renaming one orphans its entries, so do not. */
  id: string;
  title: string;
  /** One line: what the program has to do. */
  brief: string;
  /** What a solution must actually handle, so entries are comparable. */
  rules: string[];
}

/**
 * Below this many lines of code a submission is not an attempt, it is an empty
 * repository. Deliberately low: a genuinely tiny solution is the whole point.
 */
export const MIN_CODE_LINES = 5;

export const CHALLENGES: Challenge[] = [
  {
    id: 'url-shortener',
    title: 'URL shortener',
    brief: 'Shorten a URL, then redirect it.',
    rules: [
      'An HTTP server, not a library',
      'Creating a short code for a URL, and redirecting to it',
      'Links survive a restart',
    ],
  },
  {
    id: 'markdown',
    title: 'Markdown to HTML',
    brief: 'Turn Markdown into HTML without a Markdown library.',
    rules: [
      'Headings, bold, italic, links, inline code',
      'Ordered and unordered lists, including nesting',
      'Fenced code blocks, left unformatted',
    ],
  },
  {
    id: 'json-parser',
    title: 'JSON parser',
    brief: "Parse JSON without your language's JSON parser.",
    rules: [
      'Objects, arrays, strings with escapes, numbers, true, false, null',
      'Malformed input is rejected rather than guessed at',
      'Returns real values, not a string',
    ],
  },
  {
    id: 'game-of-life',
    title: "Conway's Game of Life",
    brief: 'Run the Game of Life and show it running.',
    rules: [
      'A starting pattern you can change',
      'Correct neighbour rules on a bounded or wrapping grid',
      'Each generation is displayed',
    ],
  },
  {
    id: 'tictactoe',
    title: 'Unbeatable tic-tac-toe',
    brief: 'Tic-tac-toe that a human cannot beat.',
    rules: [
      'Playable against the computer',
      'The computer never loses, from any position',
      'Detects wins and draws',
    ],
  },
  {
    id: 'static-site',
    title: 'Static site generator',
    brief: 'Turn a folder of Markdown into a website.',
    rules: [
      'Reads a directory, writes HTML files',
      'An index page linking every page',
      'A shared template or layout',
    ],
  },
];

export function findChallenge(id: string): Challenge | null {
  return CHALLENGES.find((c) => c.id === id) ?? null;
}

export interface GolfEntry {
  challenge: string;
  owner: string;
  repo: string;
  sha: string;
  /** The ranked number: lines of code, ignoring comments and blanks. */
  code: number;
  lines: number;
  bytes: number;
  files: number;
  language: string;
  countedAt: string;
}

/**
 * Fewest lines of code wins.
 *
 * Comments and blank lines are excluded from the ranking on purpose: nobody
 * should have to strip their comments to compete, and nobody should gain by it.
 *
 * Bytes break ties, which also quietly discourages the obvious cheese of
 * putting an entire program on one line — it will win on lines and look
 * ridiculous in the byte column next to it.
 */
export function rankEntries(entries: GolfEntry[]): GolfEntry[] {
  const best = new Map<string, GolfEntry>();
  for (const entry of entries) {
    if (entry.code < MIN_CODE_LINES) continue;
    // One entry per repository, at its most recent count.
    const key = `${entry.owner}/${entry.repo}`.toLowerCase();
    const existing = best.get(key);
    if (!existing || entry.countedAt > existing.countedAt) best.set(key, entry);
  }
  return [...best.values()].sort(
    (a, b) => a.code - b.code || a.bytes - b.bytes || (a.countedAt < b.countedAt ? -1 : 1),
  );
}

export interface ChallengeBoard {
  challenge: Challenge;
  entries: GolfEntry[];
}

export function buildChallengeBoards(all: GolfEntry[]): ChallengeBoard[] {
  return CHALLENGES.map((challenge) => ({
    challenge,
    entries: rankEntries(all.filter((e) => e.challenge === challenge.id)),
  }));
}

/** Where one repository placed on a challenge, for its own result page. */
export function placeOf(
  all: GolfEntry[],
  challenge: string,
  owner: string,
  repo: string,
): { rank: number; of: number; code: number } | null {
  const ranked = rankEntries(all.filter((e) => e.challenge === challenge));
  const index = ranked.findIndex(
    (e) => e.owner.toLowerCase() === owner.toLowerCase() && e.repo.toLowerCase() === repo.toLowerCase(),
  );
  if (index === -1) return null;
  return { rank: index + 1, of: ranked.length, code: ranked[index]!.code };
}

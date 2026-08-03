/**
 * The Standings — leaderboards built from repositories people have counted.
 *
 * Every ranking here comes from one KV `list()` call. The numbers needed to
 * rank live in each cache entry's *metadata*, which `list()` returns for free,
 * so the whole board costs a single KV operation and no result reads. That is
 * what makes it affordable to render on every request on the free plan.
 *
 * Ranking rules exist to stop the boards being noise:
 *  - forks are excluded; ranking someone for code they copied is meaningless
 *  - per-star boards need a minimum star count, or every 1-star repo wins
 *  - ratio boards need a minimum size, or a 12-line repo tops every chart
 *  - a repository appears once, at its most recent commit
 */

export interface BoardEntry {
  owner: string;
  repo: string;
  sha: string;
  lines: number;
  code: number;
  comment: number;
  blank: number;
  files: number;
  stars: number;
  /** Files skipped as vendored or generated — i.e. present but not written here. */
  notYours: number;
  fork: boolean;
  countedAt: string;
}

export interface RankedEntry extends BoardEntry {
  /** The value this board ranked by, already computed. */
  value: number;
}

export interface Board {
  id: string;
  title: string;
  /** What the number in the last column means. */
  unit: string;
  /** Why this board exists, in one line. */
  note: string;
  rows: RankedEntry[];
}

/** Below this many stars, lines-per-star is noise rather than a ranking. */
export const MIN_STARS = 25;
/** Below this many lines, percentage boards are dominated by tiny repositories. */
export const MIN_LINES_FOR_RATIO = 1000;
export const ROWS_PER_BOARD = 10;

/** Newest commit wins, so a repository counted many times appears once. */
export function dedupeByRepo(entries: BoardEntry[]): BoardEntry[] {
  const best = new Map<string, BoardEntry>();
  for (const entry of entries) {
    const key = `${entry.owner}/${entry.repo}`.toLowerCase();
    const existing = best.get(key);
    if (!existing || entry.countedAt > existing.countedAt) best.set(key, entry);
  }
  return [...best.values()];
}

function build(
  id: string,
  title: string,
  unit: string,
  note: string,
  entries: BoardEntry[],
  eligible: (e: BoardEntry) => boolean,
  value: (e: BoardEntry) => number,
  direction: 'asc' | 'desc',
): Board {
  const rows = entries
    .filter((e) => !e.fork && eligible(e))
    .map((e) => ({ ...e, value: value(e) }))
    .filter((e) => Number.isFinite(e.value))
    .sort((a, b) => (direction === 'asc' ? a.value - b.value : b.value - a.value))
    .slice(0, ROWS_PER_BOARD);
  return { id, title, unit, note, rows };
}

export function linesPerStar(entry: BoardEntry): number {
  return entry.stars > 0 ? entry.lines / entry.stars : Infinity;
}

/**
 * How a lines-per-star figure is written. The leanest repositories cluster
 * below 1, where a single decimal makes the top of a board look like a tie, so
 * precision scales with the value. One rule, so a board and a repository's own
 * page never disagree about its number.
 */
export function formatPerStar(value: number): string {
  if (value < 1) return value.toFixed(2);
  if (value < 10) return value.toFixed(1);
  return Math.round(value).toLocaleString('en-US');
}

export function buildBoards(raw: BoardEntry[]): Board[] {
  const entries = dedupeByRepo(raw);
  const starred = (e: BoardEntry) => e.stars >= MIN_STARS;
  const sizeable = (e: BoardEntry) => e.lines >= MIN_LINES_FOR_RATIO;

  return [
    build(
      'lean',
      'Most popular per line',
      'lines / star',
      'Fewest lines of code per GitHub star. Earning attention cheaply.',
      entries,
      starred,
      linesPerStar,
      'asc',
    ),
    build(
      'heavy',
      'Most lines per fan',
      'lines / star',
      'The other end of the same measurement. No judgement. Some.',
      entries,
      starred,
      linesPerStar,
      'desc',
    ),
    build(
      'biggest',
      'Sheer tonnage',
      'lines',
      'Largest counted, unadjusted for anything. Pure spectacle.',
      entries,
      () => true,
      (e) => e.lines,
      'desc',
    ),
    build(
      'borrowed',
      'Least of it written here',
      'files skipped',
      'Vendored and generated files skipped — code that shipped but nobody typed.',
      entries,
      (e) => e.notYours > 0,
      (e) => e.notYours,
      'desc',
    ),
    build(
      'documented',
      'Actually commented',
      '% comments',
      `Highest share of comment lines, ${MIN_LINES_FOR_RATIO.toLocaleString()} lines minimum.`,
      entries,
      sizeable,
      (e) => (e.lines > 0 ? (e.comment / e.lines) * 100 : 0),
      'desc',
    ),
    build(
      'silent',
      'Self-documenting, allegedly',
      '% comments',
      `Lowest share of comment lines, ${MIN_LINES_FOR_RATIO.toLocaleString()} lines minimum.`,
      entries,
      sizeable,
      (e) => (e.lines > 0 ? (e.comment / e.lines) * 100 : 0),
      'asc',
    ),
  ];
}

/** Most recently counted first — makes the page feel alive, and links to /r/ pages. */
export function recentlyCounted(raw: BoardEntry[], limit = 15): BoardEntry[] {
  return dedupeByRepo(raw)
    .sort((a, b) => (a.countedAt < b.countedAt ? 1 : -1))
    .slice(0, limit);
}

/**
 * Where a single repository sits on the headline board, for the "you are
 * ranked Nth" line on its own result page. Null when it does not qualify.
 */
export function standingFor(
  raw: BoardEntry[],
  owner: string,
  repo: string,
): { rank: number; of: number; value: number } | null {
  const entries = dedupeByRepo(raw).filter((e) => !e.fork && e.stars >= MIN_STARS);
  const ranked = entries
    .map((e) => ({ ...e, value: linesPerStar(e) }))
    .filter((e) => Number.isFinite(e.value))
    .sort((a, b) => a.value - b.value);
  const index = ranked.findIndex(
    (e) => e.owner.toLowerCase() === owner.toLowerCase() && e.repo.toLowerCase() === repo.toLowerCase(),
  );
  if (index === -1) return null;
  return { rank: index + 1, of: ranked.length, value: ranked[index]!.value };
}

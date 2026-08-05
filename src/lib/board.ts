/**
 * The Standings — leaderboards built from repositories people counted here.
 *
 * Every ranking comes from one KV `list()` call. The numbers needed to rank
 * live in each cache entry's *metadata*, which `list()` returns for free, so
 * the whole board costs a single KV operation and no result reads.
 *
 * Nothing here ranks on GitHub stars. It used to, and it was wrong twice over:
 * the board only contains repositories somebody actually counted on this site,
 * and most of those are personal or obscure, so a per-star board sat empty
 * while excluding exactly the repositories it was supposed to celebrate. Every
 * measurement below comes from the counter itself, so a twelve-line repository
 * with no stars can top a board on the day it is written.
 *
 * The rankings that mean the most are not here at all — see /golf, where every
 * entry is solving the same stated problem.
 *
 * Ranking rules exist to stop the boards being noise:
 *  - forks are excluded; ranking someone for code they copied is meaningless
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

/** Below this many lines, percentage boards are dominated by tiny repositories. */
export const MIN_LINES_FOR_RATIO = 1000;
/** A "lines per file" average means nothing across three files. */
export const MIN_FILES_FOR_AVERAGE = 10;
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

export function commentShare(entry: BoardEntry): number {
  return entry.lines > 0 ? (entry.comment / entry.lines) * 100 : 0;
}

export function linesPerFile(entry: BoardEntry): number {
  return entry.files > 0 ? entry.lines / entry.files : 0;
}

export function buildBoards(raw: BoardEntry[]): Board[] {
  const entries = dedupeByRepo(raw);
  const sizeable = (e: BoardEntry) => e.lines >= MIN_LINES_FOR_RATIO;
  const manyFiles = (e: BoardEntry) => e.files >= MIN_FILES_FOR_AVERAGE;

  return [
    build(
      'biggest',
      'Sheer tonnage',
      'lines',
      'Largest counted here, unadjusted for anything. Pure spectacle.',
      entries,
      () => true,
      (e) => e.lines,
      'desc',
    ),
    build(
      'dense',
      'Longest files',
      'lines / file',
      `Highest average file length, ${MIN_FILES_FOR_AVERAGE} files minimum. Somebody has a favourite file.`,
      entries,
      manyFiles,
      linesPerFile,
      'desc',
    ),
    build(
      'documented',
      'Actually commented',
      '% comments',
      `Highest share of comment lines, ${MIN_LINES_FOR_RATIO.toLocaleString()} lines minimum.`,
      entries,
      sizeable,
      commentShare,
      'desc',
    ),
    build(
      'silent',
      'Self-documenting, allegedly',
      '% comments',
      `Lowest share of comment lines, ${MIN_LINES_FOR_RATIO.toLocaleString()} lines minimum.`,
      entries,
      sizeable,
      commentShare,
      'asc',
    ),
    build(
      'borrowed',
      'Least of it written here',
      'files skipped',
      'Vendored and generated files skipped: code that shipped but nobody typed.',
      entries,
      (e) => e.notYours > 0,
      (e) => e.notYours,
      'desc',
    ),
    build(
      'tidy',
      'Most breathing room',
      '% blank',
      `Highest share of blank lines, ${MIN_LINES_FOR_RATIO.toLocaleString()} lines minimum.`,
      entries,
      sizeable,
      (e) => (e.lines > 0 ? (e.blank / e.lines) * 100 : 0),
      'desc',
    ),
  ];
}

/** Most recently counted first — makes the page feel alive, and links to /r/ pages. */
export function recentlyCounted(raw: BoardEntry[], limit = 15): BoardEntry[] {
  return dedupeByRepo(raw)
    .sort((a, b) => (a.countedAt < b.countedAt ? 1 : -1))
    .slice(0, limit);
}

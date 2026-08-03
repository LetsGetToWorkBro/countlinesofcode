/**
 * The Standings page. Same plain tables as everything else — a leaderboard is
 * exactly the sort of thing a 1999 page was actually good at.
 */

import type { Board, BoardEntry } from '../lib/board';
import { MIN_STARS, formatPerStar } from '../lib/board';
import { escapeHtml, num, page, siteFooter } from './html';

function fmtValue(board: Board, value: number): string {
  if (board.unit === 'lines / star') return formatPerStar(value);
  if (board.unit === '% comments') return `${value.toFixed(1)}%`;
  return num(Math.round(value));
}

function repoCell(entry: BoardEntry): string {
  const path = `/r/${encodeURIComponent(entry.owner)}/${encodeURIComponent(entry.repo)}/${entry.sha}`;
  return `<a href="${escapeHtml(path)}">${escapeHtml(`${entry.owner}/${entry.repo}`)}</a>`;
}

function boardTable(board: Board): string {
  if (board.rows.length === 0) {
    return `<h3>${escapeHtml(board.title)}</h3>
<p class="note">${escapeHtml(board.note)}</p>
<p class="note">Nothing qualifies yet. Count something.</p>`;
  }
  const rows = board.rows
    .map(
      (entry, index) => `<tr>
<td class="n">${index + 1}</td>
<td>${repoCell(entry)}</td>
<td class="n">${num(entry.lines)}</td>
<td class="n">${num(entry.stars)}</td>
<td class="n"><strong>${escapeHtml(fmtValue(board, entry.value))}</strong></td>
</tr>`,
    )
    .join('\n');
  return `<h3 id="${escapeHtml(board.id)}">${escapeHtml(board.title)}</h3>
<p class="note">${escapeHtml(board.note)}</p>
<table>
<thead><tr><th class="n">#</th><th>Repository</th><th class="n">Lines</th><th class="n">Stars</th><th class="n">${escapeHtml(board.unit)}</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

export function boardPageHtml(
  boards: Board[],
  recent: BoardEntry[],
  counted: number,
  origin: string,
): string {
  const leader = boards.find((b) => b.id === 'lean')?.rows[0];
  const shareText = leader
    ? `${leader.owner}/${leader.repo} is leading the standings at ${formatPerStar(leader.value)} lines of code per star.`
    : 'Lines of code per GitHub star. The standings are open.';
  const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(`${origin}/board`)}`;

  const recentRows = recent
    .map(
      (entry) => `<tr><td>${repoCell(entry)}</td><td class="n">${num(entry.lines)}</td><td class="n">${num(entry.stars)}</td></tr>`,
    )
    .join('\n');

  return page(
    'The Standings — Lines of Code per Star — LOC.1999',
    `<h1>The Standings</h1>
<p class="tagline">Every repository anyone has counted, ranked by things that should not matter.</p>
<hr>

<p>
Lines of code per GitHub star. Low means a lot of attention for very little code.
High means the opposite. Neither is an achievement, which is the point.
</p>
<p class="note">
${num(counted)} repositories counted so far. Forks are excluded. Per-star boards need
${num(MIN_STARS)} stars. Anything counted through this site joins automatically &mdash;
<a href="/">count one</a> and see where it lands.
</p>

${boards.map(boardTable).join('\n\n')}

<h3>Counted recently</h3>
<table>
<thead><tr><th>Repository</th><th class="n">Lines</th><th class="n">Stars</th></tr></thead>
<tbody>
${recentRows || '<tr><td colspan="3">Nothing yet.</td></tr>'}
</tbody>
</table>

<p class="note">
Numbers come from the same counter as everything else here: pinned to a commit,
same rules for everyone, <a href="/how.html">documented</a>. Repositories too large
for the server are counted in your browser and are not ranked &mdash; the server
never sees those numbers, and it will not rank what it cannot verify.
</p>
<p><a href="${escapeHtml(shareUrl)}">Post the standings</a></p>
${siteFooter()}`,
    {
      description:
        'Every GitHub repository counted by LOC.1999, ranked by lines of code per star, ' +
        'sheer size, comment ratio and how much of it nobody actually wrote.',
      canonical: `${origin}/board`,
    },
  );
}

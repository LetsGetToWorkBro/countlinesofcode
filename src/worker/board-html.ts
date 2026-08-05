/**
 * The Standings page. Same plain tables as everything else — a leaderboard is
 * exactly the sort of thing a 1999 page was actually good at.
 */

import type { Board, BoardEntry } from '../lib/board';
import { escapeHtml, num, page, siteFooter, siteNav } from './html';

function fmtValue(board: Board, value: number): string {
  if (board.unit.startsWith('%')) return `${value.toFixed(1)}%`;
  if (board.unit === 'lines / file') return value.toFixed(1);
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
<td class="n">${num(entry.files)}</td>
<td class="n"><strong>${escapeHtml(fmtValue(board, entry.value))}</strong></td>
</tr>`,
    )
    .join('\n');
  return `<h3 id="${escapeHtml(board.id)}">${escapeHtml(board.title)}</h3>
<p class="note">${escapeHtml(board.note)}</p>
<table>
<thead><tr><th class="n">#</th><th>Repository</th><th class="n">Lines</th><th class="n">Files</th><th class="n">${escapeHtml(board.unit)}</th></tr></thead>
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
  const leader = boards.find((b) => b.id === 'biggest')?.rows[0];
  const shareText = leader
    ? `${leader.owner}/${leader.repo} is the biggest thing anyone has counted on LOC.1999: ${leader.lines.toLocaleString('en-US')} lines.`
    : 'Every repository counted on LOC.1999, ranked by things that should not matter.';
  const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(`${origin}/board`)}`;

  // Six identical "nothing here yet" tables read as a broken page. Before
  // anything has been counted, say it once.
  const tables = boards.some((b) => b.rows.length > 0)
    ? boards.map(boardTable).join('\n\n')
    : `<p class="note">Nothing has been counted yet, so there is nothing to rank.
<a href="/code.html">Count a repository</a> and it will be the whole leaderboard.</p>`;

  const recentRows = recent
    .map(
      (entry) => `<tr><td>${repoCell(entry)}</td><td class="n">${num(entry.lines)}</td><td class="n">${num(entry.files)}</td></tr>`,
    )
    .join('\n');

  return page(
    'The Standings — repositories counted on LOC.1999',
    `<h1>The Standings</h1>
<p class="tagline">Everything counted here, ranked by things that should not matter.</p>
${siteNav('golf')}

<p>
Only repositories somebody actually counted on this site appear below, and every
number comes from the counter itself &mdash; nothing here depends on how popular
a repository is. A twelve-line project with no stars can top a board on the day
it is written.
</p>
<p class="note">
${num(counted)} repositories counted so far. Forks are excluded. Counting one on the
<a href="/code.html">counter page</a> adds it; calling the API does not.
</p>
<p>
For rankings that actually mean something, see <a href="/golf">the golf course</a>
&mdash; there every entry is solving the same stated problem, so the line count is
worth arguing about.
</p>

${tables}

<h3>Counted recently</h3>
<table>
<thead><tr><th>Repository</th><th class="n">Lines</th><th class="n">Files</th></tr></thead>
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
        'Every GitHub repository counted on LOC.1999, ranked by sheer size, average ' +
        'file length, comment ratio and how much of it nobody actually wrote.',
      canonical: `${origin}/board`,
    },
  );
}

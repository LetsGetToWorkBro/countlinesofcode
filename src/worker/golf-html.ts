/**
 * The golf course: one page per challenge, plus an index of all of them.
 */

import type { Challenge, ChallengeBoard, GolfEntry } from '../lib/challenges';
import { MIN_CODE_LINES } from '../lib/challenges';
import { escapeHtml, num, page, siteFooter } from './html';

function entryRows(entries: GolfEntry[], limit: number): string {
  return entries
    .slice(0, limit)
    .map((entry, index) => {
      const repo = `${entry.owner}/${entry.repo}`;
      const href = `/r/${encodeURIComponent(entry.owner)}/${encodeURIComponent(entry.repo)}/${entry.sha}`;
      return `<tr>
<td class="n">${index + 1}</td>
<td><a href="${escapeHtml(href)}">${escapeHtml(repo)}</a></td>
<td>${escapeHtml(entry.language || '—')}</td>
<td class="n">${num(entry.files)}</td>
<td class="n">${num(entry.bytes)}</td>
<td class="n"><strong>${num(entry.code)}</strong></td>
</tr>`;
    })
    .join('\n');
}

function boardTable(entries: GolfEntry[], limit: number): string {
  if (entries.length === 0) {
    return `<p class="note">No entries yet. The first one wins by default.</p>`;
  }
  return `<table>
<thead><tr><th class="n">#</th><th>Repository</th><th>Language</th><th class="n">Files</th><th class="n">Bytes</th><th class="n">Lines of code</th></tr></thead>
<tbody>
${entryRows(entries, limit)}
</tbody>
</table>`;
}

function rulesList(challenge: Challenge): string {
  return `<ul>${challenge.rules.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`;
}

/** The shared explanation, so it reads the same on every golf page. */
function houseRules(): string {
  return `<p class="note">
Ranked by lines of code &mdash; comments and blank lines are excluded, so nobody
has to strip their comments to compete and nobody gains by it. Bytes break ties,
which is also why putting a whole program on one line wins the line column and
looks absurd in the byte column beside it. Minimum ${num(MIN_CODE_LINES)} lines,
one entry per repository, counted at whatever commit was current when you
submitted &mdash; push an improvement and submit again to replace it.
</p>
<p class="note">
Nothing here checks that your program works. The counter counts; the repository
is linked so anyone can look. That is the whole enforcement mechanism, and it is
the honest description of it.
</p>`;
}

export function golfIndexHtml(boards: ChallengeBoard[], origin: string): string {
  const sections = boards
    .map(
      ({ challenge, entries }) => `<h3><a href="/golf/${escapeHtml(challenge.id)}">${escapeHtml(challenge.title)}</a></h3>
<p>${escapeHtml(challenge.brief)}</p>
${
  entries.length
    ? `<p class="note">Leader: <strong>${num(entries[0]!.code)}</strong> lines of code &mdash;
${escapeHtml(`${entries[0]!.owner}/${entries[0]!.repo}`)}, ${num(entries.length)} ${entries.length === 1 ? 'entry' : 'entries'}.</p>`
    : `<p class="note">No entries yet.</p>`
}`,
    )
    .join('\n\n');

  return page(
    'Code Golf — one task, fewest lines wins — LOC.1999',
    `<h1>Code Golf</h1>
<p class="tagline">One task. Fewest lines wins. Pick a fight.</p>
<hr>

<p>
Ranking whole repositories against each other never meant anything, because two
repositories are not attempting the same thing. These are: every entry on a
board below solves the same stated problem, so the line count is finally worth
arguing about.
</p>
<p class="note">
To enter: build the thing, push it to a public GitHub repository, then count it
on the <a href="/">front page</a> with that challenge selected. Your line count
is whatever this counter says &mdash; same rules for everyone,
<a href="/how.html">documented</a>.
</p>

${sections}

<hr>
${houseRules()}
<p><a href="/board">The standings</a> rank everything counted here on things
that should not matter. This page is the one that does.</p>
${siteFooter()}`,
    {
      description:
        'Code golf challenges: build a URL shortener, a Markdown parser, a JSON parser or ' +
        'Conway’s Game of Life in the fewest lines of code. Ranked by a real counter.',
      canonical: `${origin}/golf`,
    },
  );
}

export function challengePageHtml(board: ChallengeBoard, origin: string): string {
  const { challenge, entries } = board;
  const leader = entries[0];
  const shareText = leader
    ? `${challenge.title} in ${leader.code} lines of code — ${leader.owner}/${leader.repo} is leading. Beat it.`
    : `${challenge.title}, fewest lines of code wins. No entries yet.`;
  const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(`${origin}/golf/${challenge.id}`)}`;

  return page(
    `${challenge.title} in the fewest lines of code — LOC.1999`,
    `<h1>${escapeHtml(challenge.title)}</h1>
<p class="tagline">${escapeHtml(challenge.brief)}</p>
<hr>

<h3>What counts as a solution</h3>
${rulesList(challenge)}

<h3>Standings</h3>
${boardTable(entries, 25)}

<p class="note">
To enter: push it to a public GitHub repository, then count it on the
<a href="/?challenge=${escapeHtml(challenge.id)}">front page</a> with
&ldquo;${escapeHtml(challenge.title)}&rdquo; selected.
</p>

<hr>
${houseRules()}
<p><a href="${escapeHtml(shareUrl)}">Post this challenge</a> &middot;
<a href="/golf">All challenges</a></p>
${siteFooter()}`,
    {
      description: `${challenge.brief} Ranked by lines of code, counted by LOC.1999. ${
        leader ? `Current leader: ${leader.code} lines.` : 'No entries yet.'
      }`,
      canonical: `${origin}/golf/${challenge.id}`,
    },
  );
}

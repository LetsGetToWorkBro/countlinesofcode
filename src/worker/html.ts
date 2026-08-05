/**
 * Server-rendered pages. Deliberately plain HTML — the markup here is the same
 * shape the client renders after a live count, so a shared /r/ link looks
 * exactly like the page the counter produced.
 */

import { findChallenge } from '../lib/challenges';
import type { CountResult } from '../lib/schema';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function num(value: number): string {
  return value.toLocaleString('en-US');
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '0.0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export interface PageOptions {
  description?: string;
  /** Absolute URL of this page, for <link rel="canonical"> and og:url. */
  canonical?: string;
  /** Keep a page out of search results (error pages). */
  noindex?: boolean;
}

export function page(title: string, body: string, options: PageOptions = {}): string {
  const description = options.description ?? 'Count the lines of code in any GitHub repository.';
  // Social/link-preview tags only — nothing here renders on the page itself.
  const social = `<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:site_name" content="LOC.1999">
${options.canonical ? `<meta property="og:url" content="${escapeHtml(options.canonical)}">` : ''}
<meta name="twitter:card" content="summary">`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
${options.noindex ? '<meta name="robots" content="noindex">' : ''}
${options.canonical ? `<link rel="canonical" href="${escapeHtml(options.canonical)}">` : ''}
${social}
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<div id="page">
${body}
</div>
</body>
</html>
`;
}

/**
 * The toolkit, in one place.
 *
 * Every page on this site and on delete.1999loc.com carries the same bar, so a
 * visitor who arrived for one tool can see the rest. Adding a tool means adding
 * a line here and the matching line in the static pages' copy of it — there is
 * no template engine, deliberately, and `test/integration.test.ts` checks the
 * two stay in step.
 */
export const SITE_TOOLS: { href: string; label: string; id: string }[] = [
  { href: '/code.html', label: 'count code', id: 'count' },
  { href: '/golf', label: 'golf', id: 'golf' },
  // The editor is the PDF tool now; the old merge/split page is retired and
  // /pdf.html redirects here. The URL stays /sign.html for the links already
  // out in the world.
  { href: '/sign.html', label: 'pdf', id: 'pdf' },
  { href: '/convert.html', label: 'convert', id: 'convert' },
  { href: '/inspect.html', label: 'inspect', id: 'inspect' },
  { href: '/sheet.html', label: 'sheets', id: 'sheets' },
  { href: '/image.html', label: 'images', id: 'images' },
  { href: 'https://delete.1999loc.com/', label: 'delete posts', id: 'delete' },
];

/** `current` renders as plain bold text rather than a link to the page you are on. */
export function siteNav(current?: string): string {
  const items = SITE_TOOLS.map((tool) =>
    tool.id === current
      ? `<strong>${escapeHtml(tool.label)}</strong>`
      : `<a href="${escapeHtml(tool.href)}">${escapeHtml(tool.label)}</a>`,
  ).join('\n|\n');
  return `<hr>
<p class="nav">
${items}
</p>
<hr>`;
}

export function siteHeader(current = 'count'): string {
  return `<h1>LOC.1999</h1>
<p class="tagline">Small tools. No accounts. Nothing leaves your browser.</p>
${siteNav(current)}`;
}

export function siteFooter(): string {
  return `<hr>
<p class="footer">
Hosted on Cloudflare &middot; Not affiliated with GitHub &middot; Made with spite for bloat<br>
<a href="/code.html">count something</a> |
<a href="/golf">code golf</a> |
<a href="/board">the standings</a> |
<a href="https://delete.1999loc.com/">delete your posts</a> |
<a href="/how.html">how we count</a> |
<a href="/security.html">connecting github</a> |
<a href="https://github.com/letsgettoworkbro/countlinesofcode">source</a>
</p>`;
}

export function errorPage(
  status: number,
  code: string,
  message: string,
  hint?: string,
  /** An offered way forward, when one exists. */
  action?: { href: string; label: string },
): string {
  return page(
    `LOC.1999 - ${escapeHtml(code)}`,
    `${siteHeader()}
<h2>Error</h2>
<p class="error">${escapeHtml(message)}</p>
${hint ? `<p>${escapeHtml(hint)}</p>` : ''}
${action ? `<p><a href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></p>` : ''}
<p><a href="/code.html">Back to the form</a></p>
${siteFooter()}`,
    { noindex: true },
  ) + `<!-- http status ${status} -->`;
}

/** The results block. Shared by /r/ pages; the client mirrors this markup. */
export function resultsHtml(result: CountResult): string {
  const t = result.totals;
  const shortSha = result.sha.slice(0, 10);
  const rows = result.by_language
    .map(
      (row) => `<tr>
<td>${escapeHtml(row.language)}</td>
<td class="n">${num(row.files)}</td>
<td class="n">${num(row.code)}</td>
<td class="n">${num(row.comment)}</td>
<td class="n">${num(row.blank)}</td>
<td class="n">${num(row.lines)}</td>
<td class="n">${pct(row.lines, t.lines)}</td>
</tr>`,
    )
    .join('\n');

  const warnings = result.warnings.length
    ? `<ul class="warnings">${result.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
    : '';

  const noRules = result.languages_without_comment_rules.length
    ? `<p class="note">Comment detection is not available for:
${escapeHtml(result.languages_without_comment_rules.join(', '))}.
For those files every non-blank line is counted as code.
<a href="/how.html">How we count</a>.</p>`
    : `<p class="note">Comment rules applied to every language in this result.
<a href="/how.html">How we count</a>.</p>`;

  const biggest = result.biggest_files.length
    ? `<h3>Biggest files</h3>
<table>
<thead><tr><th>File</th><th>Language</th><th class="n">Lines</th></tr></thead>
<tbody>
${result.biggest_files
  .map(
    (f) => `<tr><td><a href="https://github.com/${escapeHtml(result.owner)}/${escapeHtml(result.repo)}/blob/${escapeHtml(result.sha)}/${escapeHtml(f.path)}">${escapeHtml(f.path)}</a></td><td>${escapeHtml(f.language)}</td><td class="n">${num(f.lines)}</td></tr>`,
  )
  .join('\n')}
</tbody>
</table>`
    : '';

  return `<h2>${escapeHtml(result.full_name)}
<span class="badge ${result.cached ? 'cached' : 'fresh'}">${result.cached ? 'cached' : 'fresh'}</span>
</h2>
${warnings}
<table>
<caption>Totals</caption>
<tbody>
<tr><th scope="row">Total lines</th><td class="n big">${num(t.lines)}</td><td class="n">100.0%</td></tr>
<tr><th scope="row">Code</th><td class="n">${num(t.code)}</td><td class="n">${pct(t.code, t.lines)}</td></tr>
<tr><th scope="row">Comments</th><td class="n">${num(t.comment)}</td><td class="n">${pct(t.comment, t.lines)}</td></tr>
<tr><th scope="row">Blank</th><td class="n">${num(t.blank)}</td><td class="n">${pct(t.blank, t.lines)}</td></tr>
<tr><th scope="row">Files counted</th><td class="n">${num(t.files)}</td><td class="n">${bytes(t.bytes)}</td></tr>
</tbody>
</table>

<h3>By language</h3>
<table>
<thead>
<tr><th>Language</th><th class="n">Files</th><th class="n">Code</th><th class="n">Comment</th><th class="n">Blank</th><th class="n">Lines</th><th class="n">Share</th></tr>
</thead>
<tbody>
${rows || '<tr><td colspan="7">Nothing counted.</td></tr>'}
</tbody>
</table>
${noRules}

${biggest}

<h3>Repository</h3>
<table>
<tbody>
<tr><th scope="row">Repository</th><td><a href="${escapeHtml(result.repo_meta.html_url)}">${escapeHtml(result.full_name)}</a>${result.repo_meta.private ? ' (private)' : ''}</td></tr>
<tr><th scope="row">Ref</th><td>${escapeHtml(result.ref)}${result.ref === result.default_branch ? ' (default branch)' : ''}</td></tr>
<tr><th scope="row">Commit</th><td><a href="https://github.com/${escapeHtml(result.owner)}/${escapeHtml(result.repo)}/commit/${escapeHtml(result.sha)}"><code>${escapeHtml(shortSha)}</code></a></td></tr>
<tr><th scope="row">Stars</th><td>${num(result.repo_meta.stars)}</td></tr>
<tr><th scope="row">Repo size</th><td>${num(result.repo_meta.size_kb)} KB (git)</td></tr>
<tr><th scope="row">Counted in</th><td>${(result.duration_ms / 1000).toFixed(2)}s (${escapeHtml(result.strategy)} strategy, ${num(result.github_requests)} GitHub requests)</td></tr>
<tr><th scope="row">Counter version</th><td>${escapeHtml(result.counter_version)}</td></tr>
</tbody>
</table>

<h3>Skipped</h3>
<table>
<tbody>
<tr><th scope="row">Vendored / build output</th><td class="n">${num(result.skipped.vendored)}</td></tr>
<tr><th scope="row">Generated (incl. lockfiles)</th><td class="n">${num(result.skipped.generated)}</td></tr>
<tr><th scope="row">Binary</th><td class="n">${num(result.skipped.binary)}</td></tr>
<tr><th scope="row">Too large</th><td class="n">${num(result.skipped.too_large)}</td></tr>
<tr><th scope="row">Other</th><td class="n">${num(result.skipped.other)}</td></tr>
</tbody>
</table>

<p class="note">Permalink:
<a href="/r/${escapeHtml(result.owner)}/${escapeHtml(result.repo)}/${escapeHtml(result.sha)}">/r/${escapeHtml(result.owner)}/${escapeHtml(result.repo)}/${escapeHtml(shortSha)}</a>
&middot;
<a href="/api/count/${escapeHtml(result.owner)}/${escapeHtml(result.repo)}?ref=${escapeHtml(result.sha)}">JSON</a>
</p>`;
}

export interface Standing {
  challenge: string;
  rank: number;
  of: number;
  code: number;
}

/**
 * Where this repository placed on any golf challenge it was entered in.
 *
 * A repository nobody entered gets one line pointing at the challenges, because
 * that is the only ranking on this site that means anything: every entry on a
 * challenge board is solving the same stated problem.
 */
function standingNote(standings: Standing[]): string {
  if (standings.length === 0) {
    return `<p class="note">Not entered in any <a href="/golf">golf challenge</a>. One task,
fewest lines wins &mdash; that is the only board here where the number is worth arguing about.</p>`;
  }
  const lines = standings
    .map((standing) => {
      const challenge = findChallenge(standing.challenge);
      const title = challenge ? challenge.title : standing.challenge;
      return `<li><a href="/golf/${escapeHtml(standing.challenge)}">${escapeHtml(title)}</a>:
<strong>#${standing.rank}</strong> of ${num(standing.of)}, at ${num(standing.code)} lines of code</li>`;
    })
    .join('\n');
  return `<h3>Golf standings</h3>
<ul>
${lines}
</ul>`;
}

export function resultPageHtml(
  result: CountResult,
  origin?: string,
  standings: Standing[] = [],
): string {
  const t = result.totals;
  const perStar = standingNote(standings);
  return page(
    `${result.full_name} — ${num(t.lines)} lines of code · LOC.1999`,
    `${siteHeader()}
${resultsHtml(result)}
${perStar}
${siteFooter()}`,
    {
      description:
        `${result.full_name} has ${num(t.lines)} lines: ${num(t.code)} code, ` +
        `${num(t.comment)} comment and ${num(t.blank)} blank, across ${num(t.files)} files. ` +
        `Counted at commit ${result.sha.slice(0, 7)}.`,
      ...(origin ? { canonical: `${origin}/r/${result.owner}/${result.repo}/${result.sha}` } : {}),
    },
  );
}

/**
 * Renders the results page from a count of the local checkout, so the UI can be
 * worked on (and screenshotted) without spending GitHub API quota.
 *
 *   npm run preview -- public/__preview.html
 *
 * The numbers are real — produced by the same classifier and aggregator the
 * Worker uses — but the file list comes from `git ls-files` instead of the Git
 * Trees API, and the repository metadata is filled in from the local git repo.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { Aggregator, countFile } from '../src/lib/count';
import { decidePath, looksBinary } from '../src/lib/ignore';
import type { CountResult } from '../src/lib/schema';
import { COUNTER_VERSION } from '../src/lib/version';
import { resultPageHtml } from '../src/worker/html';

const output = process.argv.slice(2).filter((a) => a !== '--')[0] ?? 'preview.html';

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const sha = git('rev-parse', 'HEAD');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const tracked = git('ls-files').split('\n').filter(Boolean);

const aggregator = new Aggregator();
const skipped = { binary: 0, vendored: 0, generated: 0, too_large: 0, other: 0 };
const started = Date.now();

for (const path of tracked) {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    skipped.other++;
    continue;
  }
  const decision = decidePath(path, size, { maxFileBytes: 4 * 1024 * 1024 });
  if (decision.skip) {
    skipped[decision.reason]++;
    continue;
  }
  const bytes = new Uint8Array(readFileSync(path));
  if (looksBinary(bytes)) {
    skipped.binary++;
    continue;
  }
  const counted = countFile(path, bytes);
  aggregator.add(counted.path, counted.language, counted.bytes, counted.counts);
}

const result: CountResult = {
  owner: 'letsgettoworkbro',
  repo: 'countlinesofcode',
  full_name: 'letsgettoworkbro/countlinesofcode',
  sha,
  ref: branch,
  default_branch: 'main',
  cached: false,
  duration_ms: Date.now() - started,
  counted_at: new Date().toISOString(),
  totals: {
    files: aggregator.totals.files,
    bytes: aggregator.totals.bytes,
    lines: aggregator.totals.lines,
    code: aggregator.totals.code,
    comment: aggregator.totals.comment,
    blank: aggregator.totals.blank,
  },
  by_language: aggregator.languages(),
  biggest_files: aggregator.biggestFiles(),
  skipped,
  repo_meta: {
    stars: 0,
    size_kb: Math.round(aggregator.totals.bytes / 1024),
    private: false,
    archived: false,
    fork: false,
    description: 'Count the lines of code in any GitHub repository.',
    html_url: 'https://github.com/letsgettoworkbro/countlinesofcode',
  },
  options: { includeLockfiles: false, includeVendored: false },
  strategy: 'tarball',
  languages_without_comment_rules: [...aggregator.languagesWithoutCommentRules].sort(),
  warnings: [],
  timing: { resolve_ms: 0, tree_ms: 0, fetch_ms: 0, parse_ms: Date.now() - started },
  limits: {
    max_files: 20000,
    max_total_bytes: 67108864,
    max_file_bytes: 4194304,
    hit_file_limit: false,
    hit_byte_limit: false,
    tree_truncated: false,
  },
  github_requests: 0,
  rate_limit_remaining: null,
  counter_version: COUNTER_VERSION,
};

writeFileSync(output, resultPageHtml(result));
console.log(`wrote ${output}`);
console.log(
  `${result.totals.files} files, ${result.totals.lines} lines ` +
    `(${result.totals.code} code, ${result.totals.comment} comment, ${result.totals.blank} blank)`,
);

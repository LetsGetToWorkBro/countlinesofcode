/**
 * Live smoke test against the real GitHub API.
 *
 *   GITHUB_TOKEN=ghp_xxx npm run verify:live -- owner/repo [ref]
 *
 * Runs the exact production pipeline (resolve -> tree -> blobs or tarball ->
 * classify -> aggregate) outside the Worker, with no cache and no KV, and
 * prints what the UI would show. Use it to confirm a token works and to sanity
 * check totals against a repository you know.
 *
 * Without GITHUB_TOKEN it still runs, on GitHub's 60 requests/hour anonymous
 * allowance — which shared IPs routinely exhaust.
 */

import { runCount, resolveTarget, DEFAULT_LIMITS } from '../src/lib/counter';
import { GitHubClient, GitHubError } from '../src/lib/github';
import { parseRepoInput, ParseError } from '../src/lib/parse-url';

const args = process.argv.slice(2).filter((a) => a !== '--');
const input = args[0];
const refArg = args[1];

if (!input) {
  console.error('usage: npm run verify:live -- owner/repo [ref]');
  process.exit(2);
}

function num(value: number): string {
  return value.toLocaleString('en-US');
}

async function main(): Promise<void> {
  let target;
  try {
    target = parseRepoInput(input!);
  } catch (error) {
    if (error instanceof ParseError) {
      console.error(`Bad input: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  const token = process.env['GITHUB_TOKEN'];
  console.log(`repo:  ${target.owner}/${target.repo}`);
  console.log(`auth:  ${token ? `token ending …${token.slice(-4)}` : 'anonymous (60 req/hour)'}`);
  console.log('');

  const client = new GitHubClient(token);
  const started = Date.now();

  const resolved = await resolveTarget(client, target.owner, target.repo, refArg ?? target.ref);
  const result = await runCount(
    client,
    resolved,
    { options: { includeLockfiles: false, includeVendored: false } },
    DEFAULT_LIMITS,
    (progress) => console.log(`  [${progress.phase}] ${progress.message}`),
  );

  console.log('');
  console.log(`${result.full_name} @ ${result.sha.slice(0, 10)} (${result.ref})`);
  console.log(`strategy: ${result.strategy}   github requests: ${result.github_requests}`);
  console.log('');
  console.log(`  total lines  ${num(result.totals.lines).padStart(12)}`);
  console.log(`  code         ${num(result.totals.code).padStart(12)}`);
  console.log(`  comments     ${num(result.totals.comment).padStart(12)}`);
  console.log(`  blank        ${num(result.totals.blank).padStart(12)}`);
  console.log(`  files        ${num(result.totals.files).padStart(12)}`);
  console.log('');
  console.log('  top languages:');
  for (const row of result.by_language.slice(0, 8)) {
    console.log(`    ${row.language.padEnd(20)} ${num(row.code).padStart(9)} code  ${num(row.files).padStart(5)} files`);
  }
  console.log('');
  console.log(
    `  skipped: ${result.skipped.vendored} vendored, ${result.skipped.generated} generated, ` +
      `${result.skipped.binary} binary, ${result.skipped.too_large} too large`,
  );
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
  console.log('');
  console.log(`counted in ${((Date.now() - started) / 1000).toFixed(2)}s`);
  console.log(`rate limit remaining: ${result.rate_limit_remaining ?? 'unknown'}`);

  // The invariant the whole tool rests on.
  const { lines, code, comment, blank } = result.totals;
  if (code + comment + blank !== lines) {
    console.error(`\nINVARIANT VIOLATED: ${code} + ${comment} + ${blank} !== ${lines}`);
    process.exit(1);
  }
  console.log(`invariant ok: ${num(code)} + ${num(comment)} + ${num(blank)} === ${num(lines)}`);
}

main().catch((error: unknown) => {
  if (error instanceof GitHubError) {
    console.error(`\nGitHub error (${error.kind}): ${error.message}`);
    if (error.kind === 'rate_limited') {
      console.error('Set GITHUB_TOKEN to raise the limit from 60 to 5,000 requests per hour.');
    }
    if (error.kind === 'unauthorized' && process.env['GITHUB_TOKEN']) {
      console.error(
        'GITHUB_TOKEN is set but GitHub rejected it — expired, revoked, or a redacted\n' +
          'placeholder injected by the environment. Unset it to fall back to anonymous:\n' +
          '  env -u GITHUB_TOKEN npm run verify:live -- owner/repo',
      );
    }
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

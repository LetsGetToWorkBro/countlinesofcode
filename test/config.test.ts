/**
 * Guards on the deployed configuration itself.
 *
 * The pre-flight CPU cap is the one setting that fails badly when it is wrong:
 * set it above what the plan's CPU budget can finish and Cloudflare kills the
 * isolate mid-count, returning a raw `error code: 1102` that no handler in this
 * codebase can catch or explain.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BYTES_PER_CPU_MS } from '../src/lib/counter';

const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');

function varOf(name: string): number {
  const match = new RegExp(`^${name} = "(\\d+)"`, 'm').exec(wrangler);
  if (!match) throw new Error(`${name} is not set in wrangler.toml`);
  return Number(match[1]);
}

/**
 * What this deployment's isolate actually survives, measured rather than read
 * off a pricing page. 32 MiB was tried on 2026-08-03 and failed most requests
 * with `error code: 1102`; ~2 MiB of text is reliable. See the plan notes in
 * wrangler.toml for the full table.
 */
const MEASURED_SAFE_CPU_MS = 320;

describe('wrangler.toml', () => {
  it('caps counting at what this deployment can actually finish', () => {
    const estimatedMs = varOf('MAX_COUNT_BYTES') / BYTES_PER_CPU_MS;
    expect(estimatedMs).toBeLessThanOrEqual(MEASURED_SAFE_CPU_MS);
  });

  it('does not promise to count more text than it will read', () => {
    // Counting stops at MAX_TOTAL_BYTES, so a higher count cap is a cap that
    // can never be reached — it would only mislead the pre-flight estimate.
    expect(varOf('MAX_COUNT_BYTES')).toBeLessThanOrEqual(varOf('MAX_TOTAL_BYTES'));
  });

  it('stays under the free plan subrequest ceiling for blob fetches', () => {
    expect(varOf('MAX_BLOB_FETCHES')).toBeLessThan(50);
  });
});

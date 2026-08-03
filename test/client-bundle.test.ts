/**
 * The browser bundle is a committed build artifact, because Cloudflare serves
 * ./public verbatim and `wrangler deploy` runs no build step. That makes it
 * possible to change the counting rules and ship a stale bundle, so browser
 * counts would silently disagree with server counts.
 *
 * This rebuilds it and compares, which turns that into a failing test.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { BUILD_OPTIONS } from '../scripts/build-client.mjs';

describe('public/bigcount.js', () => {
  it('matches a fresh build of src/client/bigcount.ts', async () => {
    const result = await build({ ...BUILD_OPTIONS, write: false });
    const fresh = result.outputFiles?.[0]?.text ?? '';
    const committed = readFileSync('public/bigcount.js', 'utf8');

    expect(fresh.length).toBeGreaterThan(1000);
    expect(
      committed,
      'public/bigcount.js is stale — run `npm run build:client` and commit the result',
    ).toBe(fresh);
  });

  it('bundles the counting modules rather than importing them at runtime', () => {
    const committed = readFileSync('public/bigcount.js', 'utf8');
    // No bare imports left: everything must be inlined for a <script> tag.
    expect(committed).not.toMatch(/\bfrom\s*["']\.\.?\//);
    expect(committed).toContain('LOC1999_BIG');
  });

  it('stays small enough to load on demand', () => {
    const bytes = readFileSync('public/bigcount.js').length;
    expect(bytes).toBeLessThan(120 * 1024);
  });
});

/**
 * The browser bundles are committed build artifacts, because Cloudflare serves
 * ./public verbatim and `wrangler deploy` runs no build step. That makes it
 * possible to change the rules and ship a stale bundle, so a browser count
 * would silently disagree with a server count, or the PDF tool would run last
 * week's page maths.
 *
 * These rebuild and compare, which turns that into a failing test.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { BUNDLES, optionsFor } from '../scripts/build-client.mjs';

const spec = (outfile: string) => {
  const found = BUNDLES.find((b: { outfile: string }) => b.outfile === outfile);
  if (!found) throw new Error(`No bundle spec for ${outfile}`);
  return found;
};

async function freshBuild(outfile: string): Promise<string> {
  const result = await build({ ...optionsFor(spec(outfile)), write: false });
  return result.outputFiles?.[0]?.text ?? '';
}

describe('public/bigcount.js', () => {
  it('matches a fresh build of src/client/bigcount.ts', async () => {
    const fresh = await freshBuild('public/bigcount.js');
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
    expect(readFileSync('public/bigcount.js').length).toBeLessThan(120 * 1024);
  });
});

describe('public/pdfkit.js', () => {
  it('matches a fresh build of src/client/pdfkit.ts', async () => {
    const fresh = await freshBuild('public/pdfkit.js');
    const committed = readFileSync('public/pdfkit.js', 'utf8');
    expect(fresh.length).toBeGreaterThan(1000);
    expect(
      committed,
      'public/pdfkit.js is stale — run `npm run build:client` and commit the result',
    ).toBe(fresh);
  });

  it('inlines pdf-lib, because the CSP forbids loading it from a CDN', () => {
    const committed = readFileSync('public/pdfkit.js', 'utf8');
    expect(committed).not.toMatch(/\bfrom\s*["']pdf-lib["']/);
    expect(committed).not.toMatch(/https:\/\/(cdn|unpkg)/);
    expect(committed).toContain('LOC1999_PDF');
  });

  /**
   * This one is a budget, not a fact. pdf-lib is the single heaviest thing on
   * the site and the page states its size out loud; if a change doubles it,
   * that claim needs rewriting and this test is the reminder.
   */
  it('stays inside the size the page promises', () => {
    expect(readFileSync('public/pdfkit.js').length).toBeLessThan(600 * 1024);
  });
});

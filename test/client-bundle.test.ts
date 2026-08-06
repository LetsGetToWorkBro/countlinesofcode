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
import { BUNDLES, MONERO_LIB, buildMoneroLib, optionsFor } from '../scripts/build-client.mjs';

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

describe('public/pdfsign.js', () => {
  it('matches a fresh build of src/client/pdfedit.ts', async () => {
    const fresh = await freshBuild('public/pdfsign.js');
    const committed = readFileSync('public/pdfsign.js', 'utf8');
    expect(fresh.length).toBeGreaterThan(1000);
    expect(
      committed,
      'public/pdfsign.js is stale — run `npm run build:client` and commit the result',
    ).toBe(fresh);
  });

  it('inlines pdf-lib, because the CSP forbids loading it from a CDN', () => {
    const committed = readFileSync('public/pdfsign.js', 'utf8');
    expect(committed).not.toMatch(/\bfrom\s*["']pdf-lib["']/);
    expect(committed).not.toMatch(/https:\/\/(cdn|unpkg)/);
    expect(committed).toContain('LOC1999_SIGN');
  });

  /**
   * A budget, not a fact. pdf-lib is the single heaviest thing on the site and
   * the page states its size out loud; if a change doubles it, that claim needs
   * rewriting and this test is the reminder.
   */
  it('stays inside the size the page promises', () => {
    expect(readFileSync('public/pdfsign.js').length).toBeLessThan(600 * 1024);
  });
});

describe('public/walletkit.js', () => {
  it('matches a fresh build of src/client/walletkit.ts', async () => {
    const fresh = await freshBuild('public/walletkit.js');
    const committed = readFileSync('public/walletkit.js', 'utf8');
    expect(fresh.length).toBeGreaterThan(1000);
    expect(committed, 'public/walletkit.js is stale — run `npm run build:client`').toBe(fresh);
  });

  it('exposes its helpers and inlines its imports', () => {
    const committed = readFileSync('public/walletkit.js', 'utf8');
    expect(committed).toContain('LOC1999_WALLET');
    expect(committed).not.toMatch(/\bfrom\s*["']\.\.?\//);
  });
});

describe('public/xmrlib.js', () => {
  it('matches a fresh, eval-patched build of the Monero library', async () => {
    const fresh = await buildMoneroLib();
    const committed = readFileSync(MONERO_LIB.outfile, 'utf8');
    expect(fresh.length).toBeGreaterThan(100000);
    expect(committed, 'public/xmrlib.js is stale — run `npm run build:client`').toBe(fresh);
  });

  it('needs no eval under script-src self', () => {
    // The wallet page is the one that would hurt most if a string became code,
    // so this is asserted on the shipped bytes rather than trusted.
    const committed = readFileSync(MONERO_LIB.outfile, 'utf8');
    expect(committed, 'no new Function("...") probe').not.toMatch(/new Function\("/);
    expect(committed, 'no bare eval(').not.toMatch(/[^.\w]eval\(/);
    expect(committed).toContain('LOC1999_XMRLIB');
  });
});

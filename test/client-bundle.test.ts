/**
 * The browser bundles are committed build artifacts, because Cloudflare serves
 * ./public verbatim and `wrangler deploy` runs no build step. That makes it
 * possible to change the rules and ship a stale bundle, so a browser count
 * would silently disagree with a server count, or the PDF tool would run last
 * week's page maths.
 *
 * These rebuild and compare, which turns that into a failing test.
 */

import { readFileSync, readdirSync } from 'node:fs';
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

/**
 * The other way a bundle goes wrong.
 *
 * These modules are TypeScript with ordinary `export function`s, but the pages
 * that use them are plain scripts reaching a hand-written object hung off
 * `globalThis` at the bottom of each source file. Adding an export does not add
 * it to that object, so a page can call a function that exists, is tested, is
 * in the bundle — and is undefined at the point of use. That happened while
 * adding the address check to the PGP page and cost a debugging round; it is
 * exactly the sort of thing a test should notice instead.
 */
describe('what the pages can actually reach', () => {
  /** The keys of `LOC1999_X = { ... }` as the shipped bundle writes it. */
  function exportsOf(name: string): Set<string> | null {
    for (const file of readdirSync('public').filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(`public/${file}`, 'utf8');
      const map = new RegExp(`${name}\\s*=\\s*\\{([^}]*)\\}`).exec(source);
      if (!map) continue;
      return new Set(
        map[1]!.split(',')
          .map((pair) => pair.split(':')[0]!.trim())
          .filter((key) => /^[A-Za-z_$][\w$]*$/.test(key)),
      );
    }
    return null;
  }

  it('hands every page script a global that has the members it calls on it', () => {
    const pages = readdirSync('public')
      .filter((f) => f.endsWith('.js'))
      .filter((f) => !/^(pgpkit|walletkit|btcwallet|bigcount|pdfsign|zipkit|archive|email|monero|video|sheetkit|convert|proof|xmrlib)\.js$/.test(f));
    let checked = 0;

    for (const page of pages) {
      const source = readFileSync(`public/${page}`, 'utf8');
      // `var kit = null;  // window.LOC1999_PGP` is a comment, not an
      // assignment; only real assignments name an alias. The lookahead drops
      // `var ops = window.LOC1999_SIGN.pageTextOps(...)`, where what is being
      // named is a result rather than the module.
      const aliases = [...source.matchAll(/(?:var\s+)?([A-Za-z_$][\w$]*)\s*=\s*window\.(LOC1999_[A-Z]+)(?![\w.])/g)];
      for (const [, alias, global] of aliases) {
        const surface = exportsOf(global!);
        if (!surface || !surface.size) continue;   // not an object-literal export
        // The lookbehind keeps "/proof.js" in a script src out of it: a path
        // is not a property access, and an alias that shares a bundle's name
        // otherwise matches one.
        const used = new Set(
          [...source.matchAll(new RegExp(`(?<![/\\w$.'"])${alias}\\.([A-Za-z_$][\\w$]*)`, 'g'))].map((m) => m[1]!),
        );
        for (const member of used) {
          expect(
            surface.has(member),
            `${page} calls ${alias}.${member}(), but ${global} does not carry ${member} — ` +
              `add it to the object at the bottom of the source and rebuild`,
          ).toBe(true);
          checked += 1;
        }
      }

      // And the pages that skip the alias and reach through window directly.
      for (const [, global, member] of source.matchAll(/window\.(LOC1999_[A-Z]+)\.([A-Za-z_$][\w$]*)/g)) {
        const surface = exportsOf(global!);
        if (!surface || !surface.size) continue;
        expect(
          surface.has(member!),
          `${page} calls window.${global}.${member}(), but ${global} does not carry ${member}`,
        ).toBe(true);
        checked += 1;
      }
    }
    // A guard that checks nothing is worse than no guard, so say how much it saw.
    expect(checked, 'no page/global pairs were examined at all').toBeGreaterThan(20);
  });
});

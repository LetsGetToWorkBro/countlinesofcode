/**
 * House style for anything a visitor reads.
 *
 * No em dashes in page copy. They were taken out of every page by hand, and
 * the only way that holds is if adding one back fails here — otherwise the next
 * paragraph written anywhere on the site quietly reintroduces them.
 *
 * Two kinds of exception, both deliberate:
 *
 *   Comments are not pages. The rule is about what is served, not about how
 *   the source reads, so the scan below strips comments before looking.
 *
 *   Two modules handle the character as *data* rather than as punctuation:
 *   the PDF transliteration map turns one into `--` for a Latin-1 font, and
 *   the page-range parser accepts one where somebody typed `1—3`. Both have
 *   to contain it to do their job.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const EM_DASH = /—|&mdash;/;

/**
 * Files that must contain the character because they operate on it, and the
 * built bundles those two modules end up inside.
 */
const HANDLES_THE_CHARACTER = ['src/client/docpdf.ts', 'src/client/pdfpages.ts'];
const CARRY_THE_HANDLERS = ['pdfsign.js', 'convert.js'];

/**
 * Source with its comments removed, so a note to the next reader does not
 * count as page copy. Block comments go first, then whole-line `//`; a `//`
 * mid-line is left alone rather than risk cutting a URL out of a string.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

describe('page copy has no em dashes', () => {
  it('in any static page', () => {
    for (const name of readdirSync('public').filter((n) => n.endsWith('.html'))) {
      const html = readFileSync(`public/${name}`, 'utf8');
      expect(EM_DASH.test(html), `public/${name} has an em dash`).toBe(false);
    }
  });

  it('in the scripts that write text onto those pages', () => {
    const scripts = readdirSync('public')
      .filter((n) => n.endsWith('.js'))
      .filter((n) => !CARRY_THE_HANDLERS.includes(n));
    for (const name of scripts) {
      const code = withoutComments(readFileSync(`public/${name}`, 'utf8'));
      expect(EM_DASH.test(code), `public/${name} has an em dash outside a comment`).toBe(false);
    }
  });

  it('in the pages the Worker renders', () => {
    // /golf, /board, /r/… and the error pages never touch public/, so they
    // need checking separately or they drift back on their own.
    for (const name of ['html.ts', 'golf-html.ts', 'board-html.ts']) {
      const code = withoutComments(readFileSync(`src/worker/${name}`, 'utf8'));
      expect(EM_DASH.test(code), `src/worker/${name} has an em dash outside a comment`).toBe(false);
    }
  });

  it('in the strings the shared and client code hands to a page', () => {
    const files = [
      ...readdirSync('src/client').map((n) => `src/client/${n}`),
      ...readdirSync('src/lib').map((n) => `src/lib/${n}`),
    ].filter((path) => path.endsWith('.ts') && !HANDLES_THE_CHARACTER.includes(path));

    for (const path of files) {
      const code = withoutComments(readFileSync(path, 'utf8'));
      expect(EM_DASH.test(code), `${path} has an em dash outside a comment`).toBe(false);
    }
  });

  it('still lets the two modules that parse one keep it', () => {
    // Guards the exception itself: if these stop containing the character,
    // either they stopped handling it or the list above is now stale.
    for (const path of HANDLES_THE_CHARACTER) {
      expect(EM_DASH.test(readFileSync(path, 'utf8')), `${path} no longer handles an em dash`).toBe(true);
    }
  });
});

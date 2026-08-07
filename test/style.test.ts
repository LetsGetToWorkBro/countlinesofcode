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
import { BUNDLES, MONERO_LIB } from '../scripts/build-client.mjs';
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

/**
 * No emoji, anywhere a visitor can see one.
 *
 * The site draws its own pictures: sixteen inline SVGs for the desktop, the
 * window chrome in CSS. A colour cartoon among them is an immediate tell that
 * something was not drawn here, and it is not a choice the page gets to make
 * anyway, because the platform picks the glyph. Two got in this way and
 * neither was meant as an emoji: U+25B6, the arrow beside a submenu, is the
 * play-button emoji on iOS, and U+26A0, beside a bad address, is the warning
 * sign. Both were line art on a desktop and colour cartoons on a phone.
 *
 * Rather than enumerate the emoji, which grows every year, this is the other
 * way round: the handful of characters above U+2000 the site is allowed to
 * draw with. Every one is text presentation on every platform. Anything else
 * has to be added here deliberately, which is the moment to ask whether a
 * phone is going to colour it in.
 *
 * The built bundles are exempt for the same reason the em dash rule exempts
 * them: they carry Unicode tables as data, not as page copy.
 */
describe('no emoji anywhere on the site', () => {
  /** Text-presentation characters the site draws with, and why. */
  const ALLOWED = new Map<number, string>([
    [0x2013, 'en dash'],
    [0x2014, 'em dash (comments only; the rule above governs copy)'],
    [0x2018, 'left single quote'],
    [0x2019, 'right single quote'],
    [0x201c, 'left double quote'],
    [0x201d, 'right double quote'],
    [0x2022, 'bullet'],
    [0x2026, 'ellipsis'],
    [0x2192, 'rightwards arrow'],
    [0x2194, 'left right arrow, the convert and sheet titles'],
    [0x21c6, 'the swap page direction button'],
    [0x2212, 'minus sign, the mail client collapse marker'],
    [0x25ba, 'the Start menu submenu arrow, and NOT U+25B6 which is an emoji'],
    [0x2713, 'the tick beside a valid address, and NOT U+2714 which is an emoji'],
    [0x2717, 'the cross beside a bad one, and NOT U+2716 which is an emoji'],
    [0xfeff, 'byte order mark, handled as data by the spreadsheet tool'],
  ]);

  /** Files the build writes; they hold Unicode tables, not page copy. */
  const GENERATED = new Set<string>([
    ...BUNDLES.map((b: { outfile: string }) => b.outfile.replace('public/', '')),
    MONERO_LIB.outfile.replace('public/', ''),
  ]);

  /** Every codepoint a file serves: literal, &#1234; and \uXXXX alike. */
  function suspicious(source: string): { cp: number; how: string }[] {
    const found: { cp: number; how: string }[] = [];
    for (const ch of source) {
      const cp = ch.codePointAt(0)!;
      if (cp > 0x2000) found.push({ cp, how: `the character ${JSON.stringify(ch)}` });
    }
    for (const m of source.matchAll(/&#(\d+);/g)) {
      if (Number(m[1]) > 0x2000) found.push({ cp: Number(m[1]), how: m[0]! });
    }
    for (const m of source.matchAll(/\\u([0-9a-fA-F]{4})/g)) {
      const cp = parseInt(m[1]!, 16);
      if (cp > 0x2000) found.push({ cp, how: m[0]! });
    }
    return found;
  }

  const handWritten = [
    ...readdirSync('public').filter((n) => n.endsWith('.html')),
    ...readdirSync('public').filter((n) => n.endsWith('.js') && !GENERATED.has(n)),
  ].map((n) => `public/${n}`);

  it('in any page or hand-written script', () => {
    expect(handWritten.length).toBeGreaterThan(20);
    for (const path of handWritten) {
      for (const { cp, how } of suspicious(readFileSync(path, 'utf8'))) {
        expect(
          ALLOWED.has(cp),
          `${path} uses U+${cp.toString(16).toUpperCase().padStart(4, '0')} (${how}), which is not on the ` +
            'allowed list. If it is a picture, draw it as SVG; if it is punctuation, add it to ALLOWED in ' +
            'this test after checking a phone does not render it as a colour emoji.',
        ).toBe(true);
      }
    }
  });

  it('uses the tick and cross that are line art, not the ones that are emoji', () => {
    // One codepoint along from each is a colour emoji on a phone.
    for (const path of ['public/wallet-page.js', 'public/btc-page.js']) {
      const marker = readFileSync(path, 'utf8');
      expect(marker, path).toContain('\\u2713');
      expect(marker, path).not.toContain('\\u2714');
      expect(marker, path).not.toContain('\\u26A0');
    }
  });
});

/**
 * The tube's proportions.
 *
 * A 1999 monitor is four by three, and the screen is held to that by capping
 * the case's width against the viewport height. The cap carries two magic
 * numbers, and both are sums of things declared elsewhere in the same file:
 * one is everything between the top of the viewport and the top of the glass
 * doubled up for the bottom, the other is the same across. Change the bezel
 * or the padding without changing them and the screen quietly stops being
 * 4:3, which is the kind of drift nobody sees and everybody feels.
 */
describe('the monitor is four by three', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  /* Both declarations live in the #page rule that draws the case, and
     both names appear all over the file. There is more than one #page
     rule (an early one sets a width and nothing else), so take the block
     that actually carries the border. */
  const blocks = [...css.matchAll(/\n#page \{([^}]*)\}/g)].map((m) => m[1]);
  const caseRule = blocks.find((b) => b.includes('border-width'));
  if (!caseRule) throw new Error('no #page rule with a border-width in style.css');

  /** The px values of a shorthand like "28px 30px 54px 30px". */
  function shorthand(declaration: string): number[] {
    const match = new RegExp(`\\b${declaration}:\\s*([^;]+);`).exec(caseRule);
    if (!match) throw new Error(`no ${declaration} in the #page rule`);
    return match[1].trim().split(/\s+/).map((v) => Number(v.replace('px', '')));
  }

  it('caps the width against the height with the right constants', () => {
    const cap = /max-width:\s*min\(1120px,\s*calc\(\(100vh - (\d+)px\) \* 4 \/ 3 \+ (\d+)px\)\)/.exec(css);
    expect(cap, 'the 4:3 cap is gone from #page').not.toBeNull();
    const [vertical, horizontal] = [Number(cap![1]), Number(cap![2])];

    // The case: border-width is top/right/bottom/left, padding likewise.
    const [borderTop, borderRight, borderBottom, borderLeft] = shorthand('border-width');
    const [padTop, padRight, padBottom, padLeft] = shorthand('padding');

    // 172 is the room the page already reserves above and below the case:
    // the body's own padding plus the stand drawn under it.
    const ROOM = 172;
    expect(vertical, 'vertical constant must be the room plus the case top and bottom')
      .toBe(ROOM + borderTop + borderBottom + padTop + padBottom);
    expect(horizontal, 'horizontal constant must be the case left and right')
      .toBe(borderLeft + borderRight + padLeft + padRight);
  });
});

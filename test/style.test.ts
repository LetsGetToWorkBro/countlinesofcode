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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
    const cap = /max-width:\s*min\(1120px,\s*max\(\d+px,\s*calc\(\(100vh - (\d+)px\) \* 4 \/ 3 \+ (\d+)px\)\)\)/.exec(css);
    expect(cap, 'the 4:3 cap is gone from #page').not.toBeNull();
    const [vertical, horizontal] = [Number(cap![1]), Number(cap![2])];

    // The case: border-width is top/right/bottom/left, padding likewise.
    const [borderTop, borderRight, borderBottom, borderLeft] = shorthand('border-width');
    const [padTop, padRight, padBottom, padLeft] = shorthand('padding');

    // 172 is the room the page already reserves above and below the case:
    // the body's own padding plus the stand drawn under it.
    const ROOM = 290;
    expect(vertical, 'vertical constant must be the room plus the case top and bottom')
      .toBe(ROOM + borderTop + borderBottom + padTop + padBottom);
    expect(horizontal, 'horizontal constant must be the case left and right')
      .toBe(borderLeft + borderRight + padLeft + padRight);
  });
});

/**
 * The desktop's scale, its contrast, and where its spare height goes.
 *
 * Seven defects were measured on the live layout and fixed together. Four of
 * them can be guarded here, because their cause is a declaration: the icon
 * scale, the contrast of the two labels that sit on the teal, which box is
 * allowed to grow, and the clock agreeing with itself.
 *
 * Three of them cannot, because they are facts about a rendered page: the
 * proportion of wallpaper the icons cover, the dead space below the lowest
 * one, and whether the sticky notes clear the fold. Asserting those needs a
 * real browser at a real viewport, and Playwright is not a dependency of this
 * project. Putting one in the default test path would mean every checkout
 * downloads Chromium to run unit tests, on a site whose entire argument is
 * that it does not make you download things. They are measured instead by
 * scripts/measure-desktop.mjs, which is run by hand against `wrangler dev`
 * and prints all three. The declarations guarded below are what produce
 * them; if these hold, those numbers cannot drift far without someone
 * meaning it.
 */
describe('the desktop is drawn at 1999 scale', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  /** WCAG 2.1 relative luminance of a #rrggbb string. */
  function luminance(hex: string): number {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16));
    const channel = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }
  function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }
  /** What every one of these labels is read against. */
  const TEAL = '#008080';

  function declaration(selector: string, property: string): string {
    // Anchor at a line start and refuse a longer class name, or asking for
    // .desk-group hands back the .desk-groups rule.
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = new RegExp(`(?:^|\\n)${escaped}(?![-\\w])[^{]*\\{([^}]*)\\}`).exec(css);
    if (!rule) throw new Error(`no rule for ${selector}`);
    const found = new RegExp(`\\b${property}:\\s*([^;]+);`).exec(rule[1]);
    if (!found) throw new Error(`no ${property} in ${selector}`);
    return found[1].trim();
  }

  it('draws the icons near the physical size a 1999 icon was', () => {
    // A 32px icon on a 14 inch 640x480 CRT was about 1.3cm across. At 34px on
    // a modern display it was about 0.7cm, which is why the desktop read as a
    // scale model of itself.
    const glyph = Number(/width:\s*(\d+)px/.exec(declaration('.desk-icon svg', 'width') + 'px')?.[1] ?? declaration('.desk-icon svg', 'width').replace('px', ''));
    expect(glyph).toBeGreaterThanOrEqual(48);
  });

  it('keeps the cell and the grid track the same width', () => {
    // A cell wider than its track overlaps its neighbour; narrower and the
    // rows stop lining up. They are two numbers that must be one.
    const cell = declaration('.desk-icon', 'width');
    const track = /repeat\(auto-fill,\s*(\d+px)\)/.exec(declaration('.desk-group', 'grid-template-columns'));
    expect(track, 'the icon grid should still be a fixed auto-fill track').not.toBeNull();
    expect(cell).toBe(track![1]);
  });

  it('gives the spare height to the icons and not to an empty box', () => {
    // .desk-windows holds three windows that are display:none until one is
    // opened. Letting it grow was what reserved 160px of teal for nothing.
    expect(css).toMatch(/#page > \.desktop > \.desk-groups \{ flex: 1 1 auto; \}/);
    expect(css).toMatch(/#page > \.desktop > \.desk-windows \{ flex: 0 0 auto; \}/);
    // ...and hands it back the moment a window is actually open, which is
    // what gives that window its scroll box.
    expect(css).toMatch(/:has\(\.app-window\.is-open\) > \.desk-windows \{ flex: 1 1 auto/);
  });

  it('keeps the labels on the teal above 4.5:1', () => {
    // The ceiling here is 4.77:1, which is pure white on #008080. There is no
    // room to dim anything: a label one step off white already fails. If a
    // future palette wants a softer label it has to change the teal first.
    for (const selector of ['.desk-group-label', '#page:has(.desktop) > .tagline']) {
      const colour = declaration(selector, 'color');
      expect(colour, `${selector} should be a hex colour`).toMatch(/^#[0-9a-f]{6}$/i);
      const ratio = contrast(colour, TEAL);
      expect(ratio, `${selector} is ${ratio.toFixed(2)}:1 on ${TEAL}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('dissolves the groups into one icon field on a wide screen', () => {
    // Bands cost a heading plus a minimum row six times over, about 810px
    // against a wallpaper about 500px tall, and no two-column split of
    // groups sized 2, 3, 1, 6, 2 and 2 ends level. On a wide screen the
    // wrappers dissolve so every icon shares one grid, and the headings go
    // with them. Guarded because display:contents looks like a typo and is
    // the whole mechanism.
    const wide = /@media \(min-width: 900px\) \{([\s\S]*?)\n\}/.exec(css);
    expect(wide, 'the wide-screen block is gone').not.toBeNull();
    expect(wide![1]).toMatch(/\.desk-groups \.desk-group \{ display: contents; \}/);
    expect(wide![1]).toMatch(/\.desk-groups \.desk-group-label \{ display: none; \}/);
    expect(wide![1]).toMatch(/grid-template-columns:\s*repeat\(auto-fit/);
  });

  it('keeps the headings on a phone, where the bands are the right shape', () => {
    // The dissolve is inside a min-width query on purpose: a single column
    // of bands is correct on a narrow screen, and there the heading is the
    // only thing marking where one group ends and the next starts.
    const narrow = /@media \(max-width: 700px\) \{([\s\S]*?)\n\}/.exec(css);
    expect(narrow, 'the phone block is gone').not.toBeNull();
    expect(narrow![1]).not.toMatch(/\.desk-group-label \{ display: none/);
  });

  it('gives the case a width floor so a short window cannot collapse it', () => {
    // Without it: less height means a narrower case, a narrower case means
    // fewer icons per row, fewer per row means a taller field, and a taller
    // field means a taller case. At 1440x700 that settled at 1296px.
    expect(css).toMatch(/max-width:\s*min\(1120px,\s*max\(\d+px,\s*calc\(/);
  });
});

describe('the clock tells the time and never the year', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const start = readFileSync(new URL('../public/start.js', import.meta.url), 'utf8');
  const clockBlock = () => {
    const found = /var clock = bar\.querySelector\('\.task-clock'\);([\s\S]{0,900})/.exec(start);
    expect(found, 'the clock handling in start.js has moved').not.toBeNull();
    return found![1];
  };

  it('ships 1999 in the markup for the render without scripting', () => {
    // A stopped clock beats an empty box where there is no script to fill it.
    expect(html).toMatch(/<span class="task-clock">1999<\/span>/);
  });

  it('replaces it with the time of day once scripting runs', () => {
    expect(clockBlock()).toMatch(/clock\.textContent\s*=/);
    expect(clockBlock()).toMatch(/getHours\(\)/);
    expect(clockBlock()).toMatch(/getMinutes\(\)/);
  });

  it('never prints a year or a date', () => {
    // This is what lets the two renders coexist. The markup says 1999 and the
    // script says half past ten; they only contradict each other if the script
    // names a year, so it must not be able to.
    expect(clockBlock()).not.toMatch(/getFullYear|getDate\(\)|getMonth/);
  });
});

describe('the controls you tap repeatedly do not zoom the page', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

  it('gives up double-tap zoom on the d-pad, the buttons and the power switch', () => {
    // Two quick taps in one place is a zoom gesture, so stepping through the
    // d-pad zoomed the page instead of moving the cursor.
    const rule = /\.chin-dir,\s*\.chin-key,\s*\.chin-power\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'the touch-action rule for the chin controls has moved').not.toBeNull();
    expect(rule![1]).toMatch(/touch-action:\s*manipulation/);
  });

  it('does not take pinch zoom away from the page', () => {
    // `manipulation` gives up double-tap and keeps pinch. `none` would give up
    // both, and is right in exactly one place: the signature pad, which you
    // draw on with a finger and which must not pan under you.
    const strict = [...css.matchAll(/([.#][\w-]+)[^{}]*\{[^}]*touch-action:\s*none/g)];
    expect(strict.map((m) => m[1])).toEqual(['#sig-pad']);

    // A locked viewport would take pinch zoom off the whole site instead.
    for (const page of ['index', 'wallet', 'email']) {
      const html = readFileSync(new URL(`../public/${page}.html`, import.meta.url), 'utf8');
      expect(html, `${page}.html locks the viewport`).not.toMatch(/user-scalable|maximum-scale/);
    }
  });
});

describe('the palmtop power lamp sits on its button', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  // Anchored to the phone block that actually holds the lamp, not to the first
  // phone block in the file: the stylesheet has several, and slicing from the
  // first one picks up the desktop machine's power switch instead.
  const ledAt = css.indexOf('.chin-led {\n    right: calc(');
  const phone = ledAt < 0 ? '' : css.slice(css.lastIndexOf('@media (max-width: 700px)', ledAt));

  it('centres the lamp over the switch', () => {
    expect(ledAt, 'the phone .chin-led rule has moved').toBeGreaterThan(-1);
    const power = /\.chin-power\s*\{[^}]*right:\s*(\d+)px[^}]*width:\s*(\d+)px/.exec(phone);
    const led = /\.chin-led\s*\{[^}]*right:\s*calc\((\d+)px \+ \((\d+)px - (\d+)px\) \/ 2\)[^}]*width:\s*(\d+)px/.exec(phone);
    expect(power, 'the phone .chin-power rule has moved').not.toBeNull();
    expect(led, 'the phone .chin-led rule is no longer written as the arithmetic').not.toBeNull();

    const [, powerRight, powerWidth] = power!.map(Number);
    const [, base, outer, inner, ledWidth] = led!.map(Number);
    // The calc has to be made of the button's real numbers, or it is centred
    // on a button that no longer exists.
    expect([base, outer, inner]).toEqual([powerRight, powerWidth, ledWidth]);
    // Same centre line, measured from the right edge of the chin.
    expect(base + (outer - inner) / 2 + ledWidth / 2).toBe(powerRight + powerWidth / 2);
  });
});

describe('an app may have its own face, and it must stay in its own lane', () => {
  /* The convention: one stylesheet per tool, named app-<tool>.css, loaded only
   * by that tool's page, and scoped entirely under [data-app="<tool>"].
   * style.css owns the desktop, the window frame and the taskbar; an app owns
   * its client area and nothing else. These run over every app stylesheet
   * there is, so a fifth one is covered the moment it is added. */
  const FACES = readdirSync('public')
    .filter((n) => /^app-[a-z]+\.css$/.test(n))
    .map((n) => ({ file: n, app: n.slice(4, -4) }));

  /** Which pages carry which marker, read out of the pages themselves. */
  const PAGES = readdirSync('public')
    .filter((n) => n.endsWith('.html'))
    .map((n) => ({ name: n, html: readFileSync(`public/${n}`, 'utf8') }));

  it('has at least the four faces the site has drawn', () => {
    expect(FACES.map((f) => f.app).sort()).toEqual(['email', 'pdf', 'wallet', 'zip']);
  });

  for (const face of FACES) {
    describe(face.file, () => {
      const css = readFileSync(`public/${face.file}`, 'utf8');
      const selectors = css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('}')
        .flatMap((block) => block.split('{')[0]!.split(','))
        .map((s2) => s2.trim())
        .filter((s2) => s2 && !s2.startsWith('@'));

      it('is loaded by exactly one page, and that page claims it', () => {
        const wearing = PAGES.filter((p) => p.html.includes(`href="/${face.file}"`));
        expect(wearing.map((p) => p.name)).toHaveLength(1);
        expect(wearing[0]!.html).toMatch(new RegExp(`<body[^>]*data-app="${face.app}"`));
      });

      it('scopes every rule under its own marker', () => {
        // One unscoped selector and this is just global CSS with a longer
        // filename, free to reach the desktop and the other fifteen tools.
        const leaks = selectors.filter((s2) => !s2.startsWith(`[data-app="${face.app}"]`));
        expect(leaks, 'these selectors escape the app').toEqual([]);
      });

      it('says how each band hides, since it outranks .hidden', () => {
        // `.hidden` is one class; every rule here is an attribute plus a class
        // and beats it. A band given a display without a matching hidden rule
        // cannot be hidden at all, which is how the PDF app's drop target once
        // stayed on screen underneath the document it had just opened.
        const html = PAGES.find((p) => p.html.includes(`href="/${face.file}"`))!.html;
        const shown = new Set(
          [...css.matchAll(
            new RegExp(`\\[data-app="${face.app}"\\]\\s+\\.([\\w-]+)\\s*\\{[^}]*display:\\s*(flex|block|inline-flex)`, 'g'),
          )].map((m) => m[1]!),
        );
        const guarded = new Set(
          [...css.matchAll(
            new RegExp(`\\[data-app="${face.app}"\\]\\s+\\.([\\w-]+)\\.hidden`, 'g'),
          )].map((m) => m[1]!),
        );
        for (const band of shown) {
          const canHide = new RegExp(
            `class="[^"]*\\b${band}\\b[^"]*hidden|class="[^"]*hidden[^"]*\\b${band}\\b`,
          );
          if (canHide.test(html)) {
            expect(guarded.has(band), `.${band} can be given .hidden but no rule honours it`).toBe(true);
          }
        }
      });
    });
  }

  it('never lets one app wear the face of another', () => {
    for (const page of PAGES) {
      const worn = FACES.filter((f) => page.html.includes(`href="/${f.file}"`));
      expect(worn.length, `${page.name} loads ${worn.length} app stylesheets`).toBeLessThanOrEqual(1);
      const marker = /<body[^>]*data-app="([a-z]+)"/.exec(page.html);
      if (marker && worn.length) {
        expect(worn[0]!.app, `${page.name} is marked ${marker[1]} but wears ${worn[0]!.app}`).toBe(marker[1]);
      }
    }
  });
});

describe('the PDF editor is an application, not a form', () => {
  const html = readFileSync(new URL('../public/sign.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../public/sign.js', import.meta.url), 'utf8');

  it('has the bands a document window has', () => {
    for (const band of ['reader-menu', 'reader-tools', 'reader-options',
      'reader-rail', 'reader-stage', 'reader-status']) {
      expect(html, `no ${band}`).toContain(`class="${band}"`);
    }
  });

  it('picks tools with toolbar buttons, not radio bubbles', () => {
    expect(html).not.toMatch(/<input[^>]*type="radio"[^>]*name="tool"/);
    const tools = [...html.matchAll(/class="tbtn tool[^"]*"[^>]*data-tool="(\w+)"/g)].map((m) => m[1]);
    expect(tools.sort()).toEqual(['blackout', 'delete', 'form', 'image', 'stamp', 'text']);
  });

  it('has no numbered steps left in it', () => {
    // "1. Open a PDF / 2. Pick a tool / 3. The document / 4. Save it" is the
    // shape of a form. An editor has a toolbar and a document.
    expect(html).not.toMatch(/<h3>\d\.\s/);
  });

  it('is one application, with no tab strip and no second copy of itself', () => {
    // Editing a page and moving pages used to be separate tabs, each with the
    // file open in its own right. One document, one model, one place.
    expect(html).not.toMatch(/data-tabs|class="tool-tabs"|data-panel=/);
    expect(html).not.toContain('pages-page.js');
    expect(existsSync(new URL('../public/pages-page.js', import.meta.url))).toBe(false);
  });

  it('pins the menu bar to the window rather than burying it in the tool', () => {
    // Directly after the title bar and outside .app-body: a menu belongs to
    // the window, which is where every application of the era put it.
    expect(html).toMatch(/<\/div>\s*<p class="reader-menu"/);
    const menuAt = html.indexOf('class="reader-menu"');
    const bodyAt = html.indexOf('<div class="app-body">');
    expect(menuAt).toBeGreaterThan(-1);
    expect(menuAt).toBeLessThan(bodyAt);
  });

  it('puts the page commands on the rail', () => {
    for (const id of ['p-insert', 'p-delete', 'p-up', 'p-down', 'rail-count']) {
      expect(html, `no #${id}`).toContain(`id="${id}"`);
    }
    expect(js).toContain('function movePages');
    // Reordering must not strand a mark: they are keyed by which page of
    // which file they were put on, never by position.
    expect(js).toContain("function keyOf(ref) { return ref.doc + ':' + ref.page; }");
    expect(js).not.toMatch(/page:\s*pageIndex/);
  });

  it('can still merge and split, now without a second tab', () => {
    expect(html).toContain('id="insert-input"');
    expect(html).toContain('id="t-save-split"');
    expect(js).toContain('function insert(');
    expect(js).toContain('planSplit');
    // The archive writer's entries are {name, data}; {name, bytes} silently
    // produced an unreadable ZIP.
    expect(js).toMatch(/\{ name: f\.name, data: f\.bytes \}/);
  });

  it('types where you click instead of asking for the words first', () => {
    // The old flow had a text box you filled in before choosing the place.
    expect(html).not.toContain('id="text-value"');
    expect(js).toContain('function openCaret');
    expect(js).toMatch(/tool\(\)\s*===\s*'text'\)\s*return openCaret/);
  });

  it('can turn a page, and carries what is written on it through the turn', () => {
    expect(html).toContain('id="t-rot-l"');
    expect(html).toContain('id="t-rot-r"');
    expect(js).toContain('function turnMarks');
    // A turn is a number on the page in the ordered list, and the assembler
    // writes it. It used to be a separate list handed to applyEdits, which
    // meant the rotation existed in two places and they could disagree.
    expect(js).toMatch(/current\.rotation = /);
    expect(js).toContain('buildPdf(docs, order)');
    expect(js).not.toMatch(/applyEdits\([^)]*rotationList/);
  });

  it('lets the signature be dragged onto the page', () => {
    expect(html).toContain('id="sig-chip"');
    // Pointer events, not the native drag API, which never fires on touch.
    expect(js).toMatch(/chip\.addEventListener\('pointerdown'/);
    expect(js).toMatch(/chip\.addEventListener\('pointerup'/);
    expect(js).toContain('drag-ghost');
  });
});

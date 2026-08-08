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
 * The machine is the display.
 *
 * The case used to be a monitor standing in a room: held to four by three by
 * capping its width against the viewport height, centred, with a wooden desk
 * under it, a keyboard in front of it, a coiled cord between the two and a
 * stand beneath. It was the difference between a monitor and a beige
 * rectangle, and it cost the bottom third of every screen to say so. On a
 * phone that is most of the device given over to furniture.
 *
 * The case fills the viewport now. There is no room in front of the machine
 * to put a desk in, so none of the props can come back without taking that
 * space with them, and none of them can come back by accident either: every
 * one was a rule in this file.
 */
describe('the machine fills the display', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const start = readFileSync(new URL('../public/start.js', import.meta.url), 'utf8');

  /* There is more than one #page rule (an early one sets a width and
     nothing else), so take the block that actually carries the border. */
  const caseRule = [...css.matchAll(/\n#page \{([^}]*)\}/g)]
    .map((m) => m[1]!)
    .find((b) => b.includes('border-width'));
  if (!caseRule) throw new Error('no #page rule with a border-width in style.css');

  it('gives the case the whole viewport rather than a slice of it', () => {
    expect(caseRule).toMatch(/max-width:\s*none/);
    expect(caseRule).toMatch(/min-height:\s*100dvh/);
    // margin: 0, not 0 auto. Centring only means something inside a room.
    expect(caseRule).toMatch(/margin:\s*0;/);
  });

  it('leaves no room reserved around it', () => {
    // A body padding is a strip of room the case cannot reach into, which
    // is exactly the desk space that went.
    const body = /\nbody \{([^}]*)\}/.exec(css.slice(css.indexOf('background-attachment: fixed') - 2000));
    expect(body, 'no room-era body rule').not.toBeNull();
    expect(body![1]).toMatch(/padding:\s*0;/);
    expect(body![1], 'vh leaves the case under the phone browser chrome')
      .toMatch(/min-height:\s*100dvh/);
  });

  it('measures the desktop against the display and not against a room', () => {
    // Every one of these used to subtract the room's 290px.
    expect(css, 'a room-height constant is back').not.toMatch(/100vh\s*-\s*\d+px/);
    expect(css, 'the 4:3 cap is back, and it needs a room to sit in')
      .not.toMatch(/4\s*\/\s*3/);
  });

  it('keeps a measure on the prose the case used to give it for free', () => {
    /* Line length was a side effect of the 1120px cap: the case stopped,
     * so the words stopped. Taking the cap off took the measure with it
     * and put a paragraph of how.html at 1332px on a 1440 screen, about
     * two hundred characters a line. The case does not narrow again; the
     * words carry their own limit now. */
    const rule = /#page:not\(:has\(\.desktop\)\):not\(:has\(\.desk-shell\)\) > \*([^{]*)\{([^}]*)\}/.exec(css);
    expect(rule, 'the prose measure is gone').not.toBeNull();
    expect(rule![2]).toMatch(/max-width:\s*\d+ch/);
    // Tables squash rather than wrap, and a wrapped listing is a lie.
    expect(rule![1]).toContain(':not(table)');
    expect(rule![1]).toContain(':not(pre)');
  });

  it('has nothing left in the room to draw', () => {
    // The desk and the keyboard were body::before and body::after; the
    // stand was #page::after. All three drew below or in front of the case.
    expect(css, 'body::before is back').not.toMatch(/\nbody::before\s*\{/);
    expect(css, 'body::after is back').not.toMatch(/\nbody::after\s*\{/);
    expect(css, '#page::after is back').not.toMatch(/\n#page::after\s*\{/);
    for (const prop of ['kbd-lamp', 'kbd-cord', 'is-typing', 'is-caps']) {
      expect(css, `${prop} is back in the stylesheet`).not.toContain(prop);
      expect(start, `${prop} is back in start.js`).not.toContain(prop);
    }
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
    expect(wide![1]).toMatch(/grid-auto-flow:\s*column/);
  });

  it('fills the icon field down before across, in a counted number of rows', () => {
    /* Down a column then on to the next is how a desktop has always filled
     * itself, and it is the only arrangement that still looks like one now
     * the case is the whole display: row-major with 1fr rows put eleven
     * icons in a line across the top of a 1440 screen and left a gulf under
     * them.
     *
     * The row count is written out rather than auto-filled. auto-fill has to
     * know the height of the track area before it can decide how many rows
     * fit, and this box takes its height from a flex parent, which is not a
     * definite size when tracks are sized: it resolved to a single row of
     * sixteen, 1856px wide, and pushed the desktop out of the case. */
    const wide = /@media \(min-width: 900px\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
    expect(wide).toMatch(/grid-template-rows:\s*repeat\(\d+, \d+px\)/);
    expect(wide, 'auto-fill rows cannot resolve against a flex height')
      .not.toMatch(/grid-template-rows:\s*repeat\(auto-fill/);
    expect(wide, 'icons should start in the corner, not spread to fill')
      .toMatch(/align-content:\s*start/);
    // Four rows need about 700px of window. Below that the count drops
    // rather than the case overflowing.
    expect(css).toMatch(/@media \(min-width: 900px\) and \(max-height: \d+px\) \{\s*\.desk-groups \{ grid-template-rows: repeat\(3, \d+px\); \}/);
  });

  it('keeps the headings on a phone, where the bands are the right shape', () => {
    // The dissolve is inside a min-width query on purpose: a single column
    // of bands is correct on a narrow screen, and there the heading is the
    // only thing marking where one group ends and the next starts.
    const narrow = /@media \(max-width: 700px\) \{([\s\S]*?)\n\}/.exec(css);
    expect(narrow, 'the phone block is gone').not.toBeNull();
    expect(narrow![1]).not.toMatch(/\.desk-group-label \{ display: none/);
  });

  it('no longer needs a width floor, because nothing feeds back', () => {
    // The floor existed because 4:3 fed back on itself: less height meant a
    // narrower case, narrower meant fewer icons per row, fewer per row meant
    // a taller field, and a taller field meant a taller case. At 1440x700
    // that loop settled at 1296px. A case that is simply the display has no
    // loop to settle, so both the cap and its floor are gone.
    expect(css).not.toMatch(/max-width:\s*min\(1120px/);
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

  it('never lets an app face reach the machine it is running on', () => {
    /* The chin is part of the device: the d-pad, the four keys, the power
     * button. It lives inside #page, which is inside body[data-app], so
     * every `[data-app="x"] button` rule an app face writes was matching it.
     * Two of the new faces gave the d-pad a beige 2px outset border and
     * 3px 12px of padding, and the terminal one turned it black: the moulded
     * cross came out as a row of little raised rectangles.
     *
     * style.css states the chin with #page in the selector, and an id
     * outranks anything an app stylesheet is allowed to use, so the boundary
     * holds for faces that have not been written yet. */
    const chrome = readFileSync('public/style.css', 'utf8');
    for (const part of ['chin-dir', 'chin-key', 'chin-power']) {
      const rule = new RegExp(`#page \\.${part}[^{]*\\{`);
      expect(chrome, `${part} is stated below the weight an app face can reach`)
        .toMatch(rule);
    }

    // And no face may name the chin at all: it is not theirs to style.
    for (const face of FACES) {
      const css = readFileSync(`public/${face.file}`, 'utf8');
      expect(css, `${face.file} styles the machine's own controls`).not.toMatch(/\.chin-/);
    }
  });

  it('never paints a hint strip in the chrome ink', () => {
    /* Every face draws the same pale-yellow line at the top of its screen,
     * and every face also sets an ink for its own chrome. On the dark ones
     * that ink is light, and `.app-body p` is an attribute plus a class plus
     * an element while a plain `.x-hint` is an attribute plus a class: the
     * body rule wins and the strip comes out light grey on cream. Measured
     * at 1.02:1 on the Paint face before this was stated properly.
     *
     * So a hint's colour must be set at .app-body weight or higher, and it
     * must cover the children too, because the text is inside the <p>. */
    for (const face of FACES) {
      const css = readFileSync(`public/${face.file}`, 'utf8');
      const cls = /\[data-app="[a-z]+"\] \.app-body \.([a-z]+)-hint \{/.exec(css)?.[1];
      if (!cls) continue;   // wallet draws its hint per skin
      const rule = new RegExp(
        `\\[data-app="${face.app}"\\] \\.app-body \\.${cls}-hint,\\s*` +
        `\\[data-app="${face.app}"\\] \\.app-body \\.${cls}-hint \\* \\{[^}]*color:`);
      expect(css, `${face.file} sets its hint ink too weakly to beat .app-body p`)
        .toMatch(rule);
    }
  });

  it('draws a face for every page that claims one', () => {
    /* Was a hardcoded list of four, which meant every new identity broke a
     * test that had nothing to say about it. What actually matters is that
     * the two sides agree: a page carrying data-app="x" has an app-x.css to
     * carry, and an app-x.css has a page that wears it. A stylesheet nobody
     * loads is dead weight; a page pointing at one that does not exist is a
     * program with no face at all. */
    const claimed = [...new Set(
      PAGES.flatMap((p) => [...p.html.matchAll(/<body[^>]*data-app="([a-z]+)"/g)].map((m) => m[1]!)),
    )].sort();
    expect(claimed.length, 'no page claims an identity').toBeGreaterThanOrEqual(4);
    expect(FACES.map((f) => f.app).sort()).toEqual(claimed);

    // And each one links the sheet it claims, or it is styled by nothing.
    for (const page of PAGES) {
      const app = /<body[^>]*data-app="([a-z]+)"/.exec(page.html)?.[1];
      if (!app) continue;
      expect(page.html, `${page.name} claims ${app} without loading app-${app}.css`)
        .toContain(`/app-${app}.css`);
    }
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
        /* Whole class tokens, not substrings. `\b${band}\b` looked right and
         * was not: a hyphen is a word boundary, so "reader" matched inside
         * "reader-body" and the test asked for a hidden rule the markup never
         * needs. Split the attribute and compare names. */
        const wearsBoth = (band: string) =>
          [...html.matchAll(/class="([^"]*)"/g)].some((m) => {
            const names = m[1]!.split(/\s+/);
            return names.includes(band) && names.includes('hidden');
          });
        for (const band of shown) {
          if (wearsBoth(band)) {
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
      // Matched as a class name rather than as the whole attribute: the menu
      // bar carries `menubar` too now that its titles open menus.
      expect(html, `no ${band}`).toMatch(new RegExp(`class="[^"]*\\b${band}\\b`));
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
    expect(html).toMatch(/<\/div>\s*(<!--[\s\S]*?-->\s*)?<p class="reader-menu/);
    const menuAt = html.indexOf('class="reader-menu');
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

describe('an app is one app, not two behind tabs', () => {
  /* The rule the site is converging on: a window holds one program. Two
   * programs behind a tab strip is two mental models for one thing, and it
   * showed up as a second row of tabs inside the first, which is the shape
   * this test actually forbids. What is allowed is a program's own
   * navigation, of which it may have exactly one row.
   *
   * The PDF editor lost its Edit/Pages split, the encryption tool merged two
   * strips into one row of seven operations, the mail client's folder rail
   * became the navigation, and the wallets' strip became a labelled switcher
   * that says which of the two is a tool. */
  const PAGES = readdirSync('public')
    .filter((n) => n.endsWith('.html'))
    .map((n) => ({ name: n, html: readFileSync(`public/${n}`, 'utf8') }));

  it('never nests one tab strip inside another', () => {
    for (const page of PAGES) {
      // Every region a tab strip switches to, and whether it holds a strip.
      for (const m of page.html.matchAll(/<div data-panel="[^"]*"[^>]*>([\s\S]*?)(?=<div data-panel=|<hr>\n<h3>Is this actually private)/g)) {
        expect(
          /class="(tool-tabs|wl-switch)"/.test(m[1]!),
          `${page.name} has a tab strip inside a tab panel, which is two programs in one window`,
        ).toBe(false);
      }
    }
  });

  it('left the consolidated apps with no panel machinery at all', () => {
    for (const name of ['sign.html', 'lock.html', 'email.html']) {
      const html = PAGES.find((p) => p.name === name)!.html;
      expect(html, `${name} still splits itself into panels`).not.toMatch(/data-tabs|data-panel=/);
    }
  });

  it('says which of the wallets is a wallet and which is somewhere else', () => {
    /* The one page that keeps a switcher, because it genuinely holds two
     * wallets. It used to carry a Tools group as well, holding the paper
     * wallet generator: a thing you use once, in the spot beside the two
     * you use every time. Swap has that spot now, because moving between
     * the two coins you are holding is the likeliest next thing, and it is
     * a link rather than a tab because it is the next program along. */
    const html = PAGES.find((p) => p.name === 'wallet.html')!.html;
    expect(html).toContain('class="wl-switch"');
    expect(html).toMatch(/<span class="wl-switch-label">Wallet<\/span>/);
    expect(html, 'the Tools group is back in the toolbar')
      .not.toMatch(/<span class="wl-switch-label">Tools<\/span>/);
    expect(html).not.toMatch(/class="tool-tabs"/);
    // A link, not a tab: it leaves rather than switching a panel.
    expect(html).toMatch(/<a class="sheet-tab wl-go" href="\/swap\.html">/);
    expect(html, 'Swap became a panel of this window').not.toMatch(/data-tab="swap"/);
  });

  it('drops the tab driver from pages that no longer have tabs', () => {
    for (const page of PAGES) {
      if (page.html.includes('tabs.js')) {
        expect(page.html, `${page.name} loads tabs.js with nothing to drive`).toMatch(/data-tabs/);
      }
    }
  });
});

describe('an application owns the device', () => {
  /* A tool page used to be a screenful of program followed by four
   * screenfuls of reading, and on a phone the reading sat between you and
   * the Back button. A program does not do that: it opens at the size of the
   * screen, and what it has to say about itself is in Help. */
  const css = readFileSync('public/style.css', 'utf8');
  const APPS = readdirSync('public')
    .filter((n) => n.endsWith('.html'))
    .map((n) => ({ name: n, html: readFileSync(`public/${n}`, 'utf8') }))
    .filter((p) => /<body[^>]*data-app=/.test(p.html));

  it('sizes an app page to the viewport and stops it scrolling', () => {
    expect(css).toMatch(/body\[data-app\]\s*\{[^}]*height:\s*100dvh/);
    expect(css).toMatch(/body\[data-app\]\s*\{[^}]*overflow:\s*hidden/);
    // dvh, not vh: on a phone vh is the tallest the viewport ever gets, so
    // the bottom of the app would sit under the browser's own chrome.
    expect(css).not.toMatch(/body\[data-app\]\s*\{[^}]*height:\s*100vh/);
  });

  it('lets a minimised application actually disappear', () => {
    /* The desktop hides a window with no .is-open on it, and the rule that
     * lets an application fill the machine gives it display:flex. That rule
     * is an attribute plus two classes plus an element, which outranks the
     * desktop's three classes, so pressing _ took the class off, flipped the
     * taskbar button back to its out state, and left the program sitting
     * there with the desk shortcuts drawn underneath it. Both at once, and
     * no way to put the application away.
     *
     * Same shape as the .hidden trap this file has hit before. A rule that
     * sets display on something the desktop also hides must say what happens
     * when it is hidden, in its own voice, at its own weight. */
    expect(css, 'a minimised app has nothing to hide it again')
      .toMatch(/body\[data-app\][^{]*\.app-window:not\(\.is-open\)\s*\{[^}]*display:\s*none/);

    // And the rule it is there to answer is still the one that needs it.
    expect(css).toMatch(/body\[data-app\] \.desk-shell > \.app-window \{[^}]*display:\s*flex/);
  });

  it('gives every app a first-run dialog and a way back to it', () => {
    expect(APPS.length).toBeGreaterThanOrEqual(4);
    for (const page of APPS) {
      expect(page.html, `${page.name} has no first-run block`).toContain('id="first-run"');
      expect(page.html, `${page.name} never loads firstrun.js`).toContain('firstrun.js');
      expect(page.html, `${page.name} has no Help that opens it`).toMatch(/data-help/);
      const steps = page.html.match(/data-step="/g) || [];
      expect(steps.length, `${page.name} has too few steps to be worth a dialog`).toBeGreaterThan(1);
    }
  });

  it('leaves no teal showing around a maximised window', () => {
    /* The desktop insets its glass so icons do not sit hard against the
     * bezel. Under a maximised window that inset is a strip of wallpaper
     * down either side of the application, and the gap above the taskbar
     * is one more.
     *
     * It cannot go to nought, though, and that is the trap: #page::before
     * paints the tube's black inner frame eight pixels wide over
     * everything in the glass, so a window with no padding does not reach
     * the edge of the picture, it runs under the edge of the picture. On a
     * phone that took the right-hand end of the document toolbar with it.
     * Nine clears the frame by one. */
    const rule = /body\[data-app\] #page \{([^}]*)\}/.exec(css);
    expect(rule, 'the app page rule is gone').not.toBeNull();
    const pad = /padding:\s*(\d+)px;/.exec(rule![1]!);
    expect(pad, 'an app page should set its own glass padding').not.toBeNull();
    const frame = /inset 0 0 0 (\d+)px #0a0d0f/.exec(css);
    expect(frame, 'the tube frame is gone from #page::before').not.toBeNull();
    expect(Number(pad![1]), 'the window would run under the tube frame')
      .toBeGreaterThan(Number(frame![1]));
    expect(Number(pad![1]), 'more padding than the frame needs is teal')
      .toBeLessThanOrEqual(Number(frame![1]) + 4);
    // The taskbar bleeds to the same edge, with no wallpaper above it.
    expect(css).toMatch(/body\[data-app\] #page > \.taskbar \{ margin: 0 -\d+px/);
  });

  it('keeps Help reachable on a phone', () => {
    /* Every app trims its menu bar by position on a narrow screen, and Help
     * is last in every one of them, so a naive nth-child rule hides exactly
     * the thing a phone needs most. Both rules that do this must spare it. */
    for (const file of readdirSync('public').filter((n) => /^app-[a-z]+\.css$/.test(n))) {
      const sheet = readFileSync(`public/${file}`, 'utf8');
      for (const rule of sheet.matchAll(/([^\n{}]*menu[^\n{}]*nth-child[^\n{}]*)\{([^}]*)\}/g)) {
        if (!/display:\s*none/.test(rule[2]!)) continue;
        expect(rule[1], `${file} hides menu items by position without sparing [data-help]`)
          .toMatch(/:not\(\[data-help\]\)/);
      }
    }
  });

  it('does not leave the prose on the page as well as in the dialog', () => {
    // One copy, or the ids inside it exist twice and the live proof panel is
    // wired to whichever the browser found first.
    for (const page of APPS) {
      const ids = [...page.html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size, `${page.name} has duplicate ids`).toBe(ids.length);
    }
  });

  it('still ships the prose in the markup rather than building it in script', () => {
    // The dialog moves it; it does not invent it. Anything reading the source
    // or indexing the page still finds every word.
    for (const page of APPS) {
      const block = /<div id="first-run"[^>]*>([\s\S]*?)\n<\/div>/.exec(page.html);
      expect(block, `${page.name} has no first-run content`).not.toBeNull();
      expect(block![1]!.length, `${page.name} moved its prose somewhere else`).toBeGreaterThan(800);
    }
  });
});

describe('the desktop explains itself once', () => {
  /* The landing page had two sticky notes taped under the machine and a
   * yellow "Click here to begin" callout pointing at Start. Both talked at
   * you: the notes were four paragraphs of standing prose that every repeat
   * visitor scrolled past forever, and the callout fired on a timer whether
   * anyone was looking or not. The desktop now says what it is the same way
   * the apps do, in a dialog you can page through, close, and reopen from
   * Start > Help. */
  const landing = readFileSync('public/index.html', 'utf8');
  const css = readFileSync('public/style.css', 'utf8');
  const start = readFileSync('public/start.js', 'utf8');

  it('has a first-run dialog with something to page through', () => {
    expect(landing).toContain('id="first-run"');
    expect(landing).toContain('firstrun.js');
    const steps = landing.match(/data-step="/g) || [];
    expect(steps.length, 'too few steps to be worth a dialog').toBeGreaterThan(1);
  });

  it('keys it as the desktop without turning the desktop into an app', () => {
    /* data-first-run, not data-app. The fill shell clips a page to the
     * viewport and hides everything past it, which on the landing page is
     * the desk, the keyboard and the cord: the machine would be sitting on
     * nothing. The landing page is a room, not a program. */
    expect(landing).toMatch(/<body[^>]*data-first-run="desktop"/);
    expect(landing, 'the desktop is not an application').not.toMatch(/<body[^>]*data-app=/);
  });

  it('reopens from Start, and only when there is something to reopen', () => {
    expect(start).toContain("getElementById('first-run')");
    expect(start).toContain("setAttribute('data-help'");
    expect(start, 'no fallback for pages without a dialog').toContain('/how.html');
  });

  it('reads without scripting rather than hiding the footer it replaced', () => {
    /* The cross-links and the donation address used to be a visible footer.
     * They live in the dialog now, and a dialog is built by script, so with
     * scripting off the block has to come back on its own. */
    expect(css).toMatch(/body\[data-first-run\]\s+#first-run\[hidden\]\s*\{\s*display:\s*block/);
    expect(landing, 'the donation address left the page').toMatch(/4[0-9A-HJ-NP-Za-km-z]{50,}/);
  });

  it('leaves no sticky notes and no callout behind', () => {
    for (const gone of ['desk-note', 'room-footer', 'begin-hint']) {
      expect(css, `${gone} is still styled`).not.toContain(gone);
      expect(landing, `${gone} is still in the markup`).not.toContain(gone);
    }
  });

  it('keeps one copy of every id', () => {
    // firstrun.js moves the sections rather than copying them; two of any id
    // would leave whichever the browser found first wired to nothing.
    const ids = [...landing.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a menu bar opens menus', () => {
  /* Every app grew a bar reading File / Edit / View / Help and none of them
   * opened anything. The stylesheet called it "a label rather than a
   * promise", which was a nice way of saying the first thing anybody taps
   * does nothing, and on a phone it was worse: the titles were spans with a
   * hover style, and a span with a hover style on iOS takes one tap to hover
   * and a second to fire, so even Help read as broken. */
  const PAGES = readdirSync('public')
    .filter((n) => n.endsWith('.html'))
    .map((n) => ({ name: n, html: readFileSync(`public/${n}`, 'utf8') }))
    .filter((p) => /<body[^>]*data-app=/.test(p.html));

  it('makes every title a button, not a span', () => {
    for (const page of PAGES) {
      // A span is why the first tap was a hover. A button is a thing a
      // touchscreen presses.
      expect(page.html, `${page.name} has a menu title that is not a button`)
        .not.toMatch(/<span[^>]*class="[^"]*menu-title/);
      const titles = page.html.match(/<button[^>]*class="menu-title"/g) || [];
      expect(titles.length, `${page.name} has no menu titles`).toBeGreaterThan(1);
    }
  });

  it('gives every menu something in it', () => {
    for (const page of PAGES) {
      for (const menu of page.html.matchAll(/<span class="menu[^"]*">([\s\S]*?)<\/span><\/span>/g)) {
        const items = menu[1]!.match(/<button/g) || [];
        // The title plus at least one command.
        expect(items.length, `${page.name} has a menu with no commands in it`).toBeGreaterThan(1);
      }
    }
  });

  it('points every command at a control that exists', () => {
    // The menu is a second way to reach a button that is already there, so
    // an item cannot drift away from what it claims to do. If the id is
    // wrong the item is dead, which is the bug this whole change is about.
    for (const page of PAGES) {
      for (const m of page.html.matchAll(/data-cmd="([^"]+)"/g)) {
        expect(page.html, `${page.name}: menu points at #${m[1]} which does not exist`)
          .toContain(`id="${m[1]}"`);
      }
    }
  });

  it('always keeps Help, and never hides menus by counting', () => {
    for (const page of PAGES) {
      expect(page.html, `${page.name} has no Help menu`).toMatch(/menu-title">Help<\/button>/);
    }
    /* Named, not counted. This rule was written by position twice and hid
     * Help both times: once because a hyphen is a word boundary so "reader"
     * matched inside "reader-body", and once because the app badge is also a
     * span so :last-of-type was the badge rather than Help. */
    for (const file of readdirSync('public').filter((n) => /^app-[a-z]+\.css$/.test(n))) {
      const sheet = readFileSync(`public/${file}`, 'utf8');
      for (const rule of sheet.matchAll(/([^\n{}]*menu[^\n{}]*)\{([^}]*)\}/g)) {
        if (!/display:\s*none/.test(rule[2]!)) continue;
        expect(rule[1], `${file} hides menus by position; mark them .menu-optional instead`)
          .not.toMatch(/nth-child|nth-of-type/);
      }
    }
  });

  it('gives a title a target a thumb can hit', () => {
    const css = readFileSync('public/style.css', 'utf8');
    expect(css).toMatch(/\.menu-title\s*\{[^}]*touch-action:\s*manipulation/);
    for (const file of readdirSync('public').filter((n) => /^app-[a-z]+\.css$/.test(n))) {
      const sheet = readFileSync(`public/${file}`, 'utf8');
      if (!/\.menu-title/.test(sheet)) continue;
      expect(sheet, `${file} does not give its menu titles a minimum height`)
        .toMatch(/\.menu-title\s*\{[^}]*min-height/);
    }
  });
});

describe('the document is drawn at the screen it is on', () => {
  const js = readFileSync('public/sign.js', 'utf8');

  it('sizes the canvas backing store by devicePixelRatio', () => {
    /* A canvas has two sizes: how many pixels it holds and how big it is on
     * the page. Setting only the first and letting CSS stretch it handed a
     * 3x phone a 1x rendering, which is why a document on a phone was
     * unreadable. */
    expect(js).toMatch(/dpr\s*=\s*Math\.min\(window\.devicePixelRatio/);
    expect(js).toMatch(/canvas\.width\s*=\s*Math\.floor\(viewW \* dpr\)/);
    expect(js).toMatch(/canvas\.style\.width\s*=\s*viewW \+ 'px'/);
    expect(js).toMatch(/scale:\s*viewport\.scale \* dpr/);
  });

  it('keeps every other measurement in layout pixels', () => {
    // The overlay's context is scaled once so the drawing code never sees
    // the ratio, and a click is converted against the CSS box. Reading
    // canvas.width anywhere else would be reading device pixels by mistake.
    expect(js).toMatch(/ctx\.setTransform\(dpr, 0, 0, dpr, 0, 0\)/);
    expect(js).not.toMatch(/overlay\.width|overlay\.height/);
  });
});

describe('the app has room for the document', () => {
  const html = readFileSync('public/sign.html', 'utf8');
  const css = readFileSync('public/app-pdf.css', 'utf8');
  const shared = readFileSync('public/style.css', 'utf8');

  it('lets the page thumbnails fold away', () => {
    // On a phone the rail is a filmstrip across the top, and between it, two
    // toolbars and two strips there was nothing left for the document.
    expect(html).toContain('id="p-fold"');
    expect(css).toMatch(/\.reader\.is-folded \.reader-rail/);
    expect(readFileSync('public/sign.js', 'utf8')).toContain("classList.toggle('is-folded')");
  });

  it('scrolls the toolbar sideways rather than wrapping it', () => {
    // A toolbar that wraps is two toolbars, and it costs a row of document
    // to say the same thing.
    const phone = css.slice(css.indexOf('@media (max-width: 700px)'));
    expect(phone).toMatch(/\.reader-tools \{[^}]*flex-wrap:\s*nowrap/);
    expect(phone).toMatch(/\.reader-tools \{[^}]*overflow-y:\s*hidden/);
  });

  it('runs the window edge to edge, with no desktop showing round it', () => {
    expect(shared).toMatch(/body\[data-app\] \.desk-shell > \.app-window \{[^}]*margin:\s*0/);
    expect(shared).toMatch(/body\[data-app\] #page > \.desk-shell \{[^}]*background:\s*none/);
  });
});

describe('a warning you have read can be put away', () => {
  const js = readFileSync('public/dismiss.js', 'utf8');
  const PAGES = readdirSync('public')
    .filter((n) => n.endsWith('.html'))
    .map((n) => ({ name: n, html: readFileSync(`public/${n}`, 'utf8') }))
    .filter((p) => p.html.includes('notice-box'));

  it('ships the dismisser to every page that has a warning on it', () => {
    for (const page of PAGES) {
      expect(page.html, `${page.name} has warnings but cannot dismiss them`).toContain('dismiss.js');
    }
  });

  it('remembers by what the warning says, not where it is', () => {
    // Keyed by position, adding a warning above an existing one would either
    // un-dismiss it or dismiss the new one on its behalf.
    expect(js).toMatch(/summary\.textContent/);
    expect(js).toMatch(/localStorage\.setItem/);
  });

  it('leaves the copy in the first-run dialog alone', () => {
    // In there the warning is the explanation itself and already has a Close.
    expect(js).toMatch(/closest\('#first-run'\)/);
  });
});

describe('the wallets get out of their own way', () => {
  /* Three complaints, all the same complaint: the program was arranged for
   * the person who wrote it rather than the person using it.
   *
   * The node picker was a folded box near the bottom of the panel, so the
   * one setting a wallet cannot work without sat behind a disclosure
   * triangle, below the button that needs it. The safety warnings sat open
   * in the middle of each wallet, between the tabs you press and the
   * buttons you press, every visit forever. And the address checker led
   * with nine rows of cryptographic evidence before it would show you the
   * box you paste an address into.
   */
  const html = readFileSync(new URL('../public/wallet.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/app-wallet.css', import.meta.url), 'utf8');

  /** The markup of one [data-panel] block, by name. */
  function panel(name: string): string {
    const at = html.indexOf(`<div data-panel="${name}"`);
    expect(at, `no ${name} panel`).toBeGreaterThan(-1);
    const next = html.indexOf('<div data-panel="', at + 10);
    return html.slice(at, next === -1 ? html.indexOf('<div class="warn-sources">') : next);
  }

  it('keeps the connection open in the toolbar, next to the tools', () => {
    const bar = /<p class="wl-switch"[\s\S]*?<\/p>/.exec(html);
    expect(bar, 'the toolbar is gone').not.toBeNull();
    // The controls themselves, not a summary of them behind a triangle.
    expect(bar![0]).toContain('<select id="node">');
    expect(bar![0]).toContain('<select id="btc-server">');
    expect(bar![0], 'the wallets it should sit beside').toContain('data-tab="btc"');
    // Next to them, rather than flung to the far edge of a 1440px bar.
    // Comments stripped first: this file explains why margin-left:auto was
    // wrong, and a note about a mistake is not the mistake.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations, 'the picker is pushed away from the tools again')
      .not.toMatch(/#node-box[\s\S]{0,400}margin-left:\s*auto/);
  });

  it('keeps the paper wallet reachable after taking it out of the toolbar', () => {
    /* This is the part that could go wrong quietly. tabs.js used to gather
     * its controls from inside the tab container only, so deleting the
     * toolbar button would have left the panel with nothing that could
     * reach it: the File item was a data-pick proxy that clicked that very
     * button, and a hash link would have fallen back to the first tab
     * because 'addresses' was no longer a name it knew.
     *
     * So the menu item is the tab control now, rather than a proxy for
     * one, and tabs.js accepts a control that lives outside the strip. */
    expect(html, 'the paper wallet lost its way in')
      .toMatch(/<button type="button" data-tab="addresses">/);
    expect(html, 'the menu item is a proxy for a button that no longer exists')
      .not.toMatch(/data-pick="[^"]*addresses/);
    // The panel it opens is still there.
    expect(html).toContain('<div data-panel="addresses"');

    const tabs = readFileSync(new URL('../public/tabs.js', import.meta.url), 'utf8');
    expect(tabs, 'tab controls are gathered from the strip only again')
      .toMatch(/document\.querySelectorAll\('\[data-tab\]'\)/);

    /* And the page still boots on the first panel rather than on whichever
     * control happens to come first in the file. Those were the same thing
     * while every control lived in the strip in panel order; the moment a
     * menu item became one they were not, and because the menu bar sits
     * above the strip the wallet page booted on the paper wallet. */
    expect(tabs, 'the default tab follows the controls again, not the panels')
      .not.toMatch(/name = buttons\[0\]/);
    expect(tabs).toMatch(/name = names\[0\]/);
  });

  it('keeps the ! on the same line as the control it explains', () => {
    /* It was its own flex item, so on a phone the bar ran out of width
     * after the select and carried a single 20px button onto a line of its
     * own: a whole extra row of toolbar for one character. Label, control
     * and ! are one non-wrapping group now, and the select is the only
     * thing in it allowed to give up width. */
    const bangs = [...html.matchAll(/<button[^>]*class="wl-info"[^>]*>/g)];
    expect(bangs.length, 'the ! buttons are gone').toBeGreaterThanOrEqual(2);
    for (const bang of bangs) {
      // Everything between the group this button is in and the button
      // itself. These groups hold a label, a control and the button and
      // nothing nested, so an unclosed </span> in that slice would mean the
      // button is outside the group rather than in it.
      const at = bang.index!;
      const opens = html.lastIndexOf('<span class="wl-pick">', at);
      expect(opens, 'a ! sits outside any wl-pick group').toBeGreaterThan(-1);
      const inside = html.slice(opens, at);
      expect(inside, 'a ! is not grouped with a control').toContain('<select');
      expect(inside, 'the group closed before the ! got into it').not.toContain('</span>');
    }
    const rule = /\[data-app="wallet"\] \.wl-pick \{([^}]*)\}/.exec(css);
    expect(rule, 'the group is gone').not.toBeNull();
    expect(rule![1], 'the group may wrap, which is the bug').toMatch(/flex-wrap:\s*nowrap/);
    // Only the select shrinks; a squeezed label reads as a broken control.
    expect(css).toMatch(/\.wl-pick > \.wl-node-label \{ flex: 0 0 auto; \}/);
    expect(css).toMatch(/\.wl-pick > \.wl-info \{ flex: 0 0 auto; \}/);
  });

  it('never folds the node picker away again', () => {
    for (const id of ['node', 'btc-server']) {
      const before = html.slice(0, html.indexOf(`<select id="${id}">`));
      const open = (before.match(/<details/g) || []).length;
      const shut = (before.match(/<\/details>/g) || []).length;
      expect(open, `the ${id} picker is inside a <details> again`).toBe(shut);
    }
  });

  it('shows the right picker for the wallet that is open', () => {
    // CSS, not script: the panel already carries its own name.
    expect(css).toMatch(/\[data-panel="wallet"\]:not\(\.hidden\)\)\s*#node-box/);
    expect(css).toMatch(/\[data-panel="btc"\]:not\(\.hidden\)\)\s*#btc-server-box/);
    expect(css).toMatch(/\[data-app="wallet"\] \.wl-node \{ display: none; \}/);
  });

  it('has no warning left standing in the middle of a wallet', () => {
    for (const name of ['wallet', 'btc', 'addresses']) {
      const body = panel(name);
      expect(body, `${name} still carries a warning block`).not.toContain('warn-source');
      /* The big ones are the three that opened with "Read this". Small
       * closed notes attached to a control are a different thing and are
       * meant to stay: a folded line beside the box it is about is not a
       * wall of text between you and the program. */
      expect(body, `${name} still leads with a Read this warning`).not.toMatch(/<summary>[^<]*<strong>Read this/);
      for (const box of body.matchAll(/<details([^>]*)class="notice-box"/g)) {
        expect(box[1], `${name} has a notice box forced open`).not.toContain('open');
      }
    }
    // They are not deleted, they are moved: warn.js builds a dialog per block.
    const sources = html.match(/class="warn-source"/g) || [];
    expect(sources.length, 'the warnings went missing rather than moving').toBeGreaterThanOrEqual(5);
    for (const block of html.matchAll(/<div class="warn-source"([^>]*)>/g)) {
      expect(block[1], 'a warning with no key cannot be dismissed on its own').toMatch(/data-warn="/);
      expect(block[1], 'a warning with no title gets a generic dialog').toMatch(/data-warn-title="/);
    }
  });

  it('loads warn.js before the tabs that fire at it', () => {
    /* tabs.js fires tab:shown for the panel it opens on load, and that is
     * the event that opens a wallet's warning the first time you look at
     * it. Load them the other way round and the listener is registered
     * after the only event it will ever miss. */
    expect(html.indexOf('/warn.js')).toBeGreaterThan(-1);
    expect(html.indexOf('/warn.js'), 'warn.js loads after tabs.js and misses the first show')
      .toBeLessThan(html.indexOf('/tabs.js'));
  });

  it('tells you what to do on every screen', () => {
    // A class token, not the whole attribute: the wallets carry a second
    // class on theirs so the line can follow whether a wallet is open.
    for (const name of ['wallet', 'btc', 'addresses']) {
      expect(panel(name), `${name} opens with no hint`).toMatch(/class="wl-hint[ "]/);
    }
  });

  it('folds the evidence instead of leading with it', () => {
    // The nine checks are the reason to trust the generator, not the first
    // thing to read on the way to the tool.
    const paper = panel('addresses');
    const proof = paper.indexOf('id="proof-checks"');
    expect(proof, 'the proof panel is gone').toBeGreaterThan(-1);
    expect(paper.slice(0, proof), 'the proof table is not folded').toContain('<details');
    expect(paper.indexOf('id="mode-make"'), 'the generator is gone').toBeGreaterThan(-1);
  });

  it('builds the checker into each wallet instead of giving it a tab', () => {
    /* Checking an address is something you want while you are looking at a
     * wallet, and as a third tab it meant leaving the one you were in. It
     * handles no secrets and makes no request, so it can simply sit in the
     * corner of both, and both had most of a display of nothing beside
     * them. */
    for (const [name, prefix] of [['wallet', 'xmr-'], ['btc', 'btc-']] as const) {
      const body = panel(name);
      expect(body, `${name} has no checker`).toContain(`id="${prefix}check-text"`);
      expect(body, `${name}'s checker has no button`).toContain(`id="${prefix}check"`);
      expect(body, `${name}'s checker has nowhere to answer`).toContain(`id="${prefix}check-result"`);
      expect(body, `${name} does not lay one out beside the wallet`).toContain('class="wl-side"');
    }
    // And it is no longer a destination of its own.
    expect(html, 'the old single-instance checker is still here').not.toContain('id="check-text"');
    expect(html, 'the checker still has a tab').not.toContain('id="tab-check"');
    expect(html, 'the tab is still named for the checker')
      .not.toMatch(/data-tab="addresses"[^>]*>Check an address</);
  });

  it('lays the wallet and the checker side by side once there is room', () => {
    expect(css).toMatch(/@media \(min-width: 900px\) \{\s*\[data-app="wallet"\] \.wl-split \{[^}]*grid-template-columns/);
    // One column on a phone: the wallet first, the checker under it.
    expect(css).toMatch(/\[data-app="wallet"\] \.wl-split \{ display: block; \}/);
  });

  it('gives the column the log when a wallet is open and the checker when not', () => {
    /* The log used to be a tab you had to press while an entire column sat
     * empty beside it, and the checker held that column permanently whether
     * it was the useful thing there or not. Now the column is never idle:
     * transactions while a wallet is open, the checker while none is, which
     * is when a loose address is what you actually arrived with. */
    expect(css).toMatch(/:has\(#wallet:not\(\.hidden\)\) \.wl-check/);
    expect(css).toMatch(/:has\(#btc-wallet:not\(\.hidden\)\) \.wl-check/);
    expect(css).toMatch(/:has\(#wallet\.hidden\) \.wl-log/);
    expect(css).toMatch(/:has\(#btc-wallet\.hidden\) \.wl-log/);
    for (const name of ['wallet', 'btc']) {
      expect(panel(name), `${name} has no log column`).toContain('class="wl-log"');
      expect(panel(name), `${name} has no checker column`).toContain('class="wl-check"');
    }
    // And it is not also still a tab.
    expect(html, 'History is still in the Monero tab strip').not.toContain('id="wtab-history"');
    expect(html, 'History is still in the Bitcoin tab strip').not.toContain('id="btw-history"');
  });

  it('does not tell somebody with a wallet open to make one', () => {
    for (const name of ['wallet', 'btc']) {
      expect(panel(name), `${name} has no open-wallet hint`).toContain('wl-hint-open');
      expect(panel(name), `${name} has no setup hint`).toContain('wl-hint-setup');
    }
    expect(css).toMatch(/\[data-app="wallet"\] \.wl-hint-open \{ display: none; \}/);
    expect(css).toMatch(/:has\(#wallet:not\(\.hidden\)\) \.wl-hint-setup/);
  });

  it('makes a paper wallet for either coin, with the steps in the open', () => {
    /* It made Monero wallets and nothing else, which was a strange gap next
     * to a Bitcoin wallet in the tab beside it. And the instructions for
     * doing it safely were folded behind a triangle, one click further away
     * than the button that does it unsafely. */
    const paper = panel('addresses');
    expect(paper, 'the steps are gone').toContain('class="wl-steps"');
    const steps = paper.match(/<li><strong>/g) || [];
    expect(steps.length, 'too few steps to be a procedure').toBeGreaterThanOrEqual(5);
    // Out in the open: the list must not sit inside a <details>.
    const at = paper.indexOf('class="wl-steps"');
    const before = paper.slice(0, at);
    expect((before.match(/<details/g) || []).length,
      'the steps went back behind a disclosure triangle')
      .toBe((before.match(/<\/details>/g) || []).length);
    // Both coins.
    expect(paper).toContain('id="pw-xmr"');
    expect(paper).toContain('id="pw-btc"');
    expect(paper, 'no Bitcoin generator').toContain('id="btc-generate"');
    expect(paper, 'nowhere to print a Bitcoin wallet').toContain('id="btc-paper-out"');
  });

  it('states both ends of a colour on the dark panel', () => {
    /* A table's row headings carry a #f0f0f0 background from the base
     * stylesheet. That was invisible while this table only ever appeared on
     * white paper; on the Monero panel it is a light heading colour over a
     * light background, which is a row nobody can read. */
    const rule = /\[data-app="wallet"\] \.skin-xmr th\[scope="row"\] \{([^}]*)\}/.exec(css);
    expect(rule, 'the dark panel does not restate the row heading').not.toBeNull();
    expect(rule![1]).toMatch(/background:\s*#/);
    expect(rule![1]).toMatch(/color:\s*#/);
  });

  it('keeps the controls to a measure the window no longer sets', () => {
    // The case is the whole display, so without this a wallet is a row of
    // small controls with a field of nothing beside them.
    expect(css).toMatch(/max-width:\s*620px/);
    expect(css).toMatch(/\[data-app="wallet"\] \.app-body > \[data-panel\] \{ flex: 1 1 auto; \}/);
  });
});

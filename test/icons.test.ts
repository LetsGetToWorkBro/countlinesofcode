/**
 * The desktop icons.
 *
 * They have to exist twice: inline in public/index.html, because that page
 * draws its desktop with no JavaScript at all, and in public/icons.js, because
 * start.js lays the same shortcuts on a tool page's desk. Two hand-drawn
 * copies of sixteen SVGs would drift, so the landing page is the source and
 * icons.js is generated from it. This regenerates and compares: an icon
 * changed in the page and not rebuilt fails here instead of quietly going
 * stale on half the site.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildIcons, iconsFromLanding } from '../scripts/build-icons.mjs';
import { SITE_TOOLS } from '../src/worker/html';

const landing = () => readFileSync('public/index.html', 'utf8');

describe('the icons on the landing page', () => {
  it('draws one for every tool in the toolkit', () => {
    // A tool with no icon is a hole on the desktop.
    const icons = iconsFromLanding(landing());
    for (const tool of SITE_TOOLS) {
      expect(icons[tool.href], `no desktop icon for ${tool.label}`).toBeTruthy();
    }
  });

  it('gives each one a picture and a name', () => {
    for (const [href, icon] of Object.entries(iconsFromLanding(landing()))) {
      expect(icon.svg, href).toMatch(/^<svg[\s\S]*<\/svg>$/);
      expect(icon.label.length, href).toBeGreaterThan(1);
    }
  });
});

describe('public/icons.js', () => {
  it('is exactly what the landing page says, rebuilt', () => {
    // `npm run build:icons` after changing an icon, or this fails.
    const committed = readFileSync('public/icons.js', 'utf8');
    expect(committed, 'public/icons.js is stale: run `npm run build:icons`').toBe(buildIcons().text);
  });

  it('hands the scripts a usable map', () => {
    const scope: { LOC1999_ICONS?: Record<string, { svg: string; label: string }> } = {};
    new Function('window', readFileSync('public/icons.js', 'utf8'))(scope);
    const icons = scope.LOC1999_ICONS!;
    expect(Object.keys(icons).length).toBeGreaterThanOrEqual(SITE_TOOLS.length);
    expect(icons['/wallet.html']!.label).toBe('Wallet');
    expect(icons['/wallet.html']!.svg).toContain('<svg');
  });
});

describe('the pages that draw shortcuts', () => {
  it('load the icons before the script that uses them', () => {
    // start.js reads window.LOC1999_ICONS at load, so the order is not
    // decoration: icons.js second would leave every shortcut a blank window.
    const pages = ['wallet.html', 'swap.html', 'email.html', 'lock.html', 'code.html'];
    for (const page of pages) {
      const html = readFileSync(`public/${page}`, 'utf8');
      const icons = html.indexOf('/icons.js');
      const start = html.indexOf('/start.js');
      expect(icons, `${page} does not load icons.js`).toBeGreaterThan(-1);
      expect(icons, `${page} loads icons.js after start.js`).toBeLessThan(start);
    }
  });
});

describe('a label is text, not markup', () => {
  /* The labels are lifted out of index.html, which is hand-written HTML and
   * uses entities where it must: an ASCII <=> has to be written &lt;=&gt; or
   * it is not valid markup. start.js escapes a label before inserting it, so
   * an entity carried through verbatim would be escaped a second time and
   * printed as its own source: a shortcut reading `PDF &lt;=&gt; Word`. */
  const built = readFileSync('public/icons.js', 'utf8');

  it('carries no HTML entity through to the script', () => {
    for (const match of built.matchAll(/"label":"([^"]*)"/g)) {
      expect(match[1], `${match[1]} still holds an entity`).not.toMatch(/&[a-z]+;|&#\d+;/);
    }
  });

  it('kept the arrows the two converter names use, and the space that holds them', () => {
    /* An equals rather than a hyphen, because a hyphen is a legal place to
     * break a line and Safari takes it: "Excel <-" on one line and "> CSV"
     * on the next, which is what a 54px desktop caption on a phone gives you.
     * Nothing may break inside <=>, on any engine, because none of the three
     * characters offers a break.
     *
     * The non-breaking space then decides where it does break, so both
     * captions break in the same place instead of one before the arrow and
     * one after. Written as an escape in the generated file so it is not an
     * invisible character in somebody's editor. */
    expect(built).toContain('PDF <=>\\u00a0Word');
    expect(built).toContain('Excel <=>\\u00a0CSV');
    expect(built, 'a hyphen is back in an arrow that has to wrap').not.toMatch(/label":"[^"]*<-/);
  });
});

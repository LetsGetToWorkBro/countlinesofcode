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

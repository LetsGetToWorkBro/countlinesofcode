/**
 * The toolkit bar exists in two places that cannot import each other: the
 * server pages build it from SITE_TOOLS, and the static pages in ./public each
 * carry a copy, because they have no template engine on purpose.
 *
 * That is a drift risk with no runtime symptom — a tool added to one and not
 * the other simply becomes invisible from half the site, which had already
 * happened once. The copies are now written by `npm run sync:nav` rather than
 * by hand, and the first test below compares them character for character, so
 * a hand-edited nav fails the suite instead of drifting quietly.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SITE_TOOLS, TOOL_GROUPS, siteNav } from '../src/worker/html';
import { currentFor, navBlockFor, staticPages } from '../scripts/sync-nav';

/** Static pages that carry the bar. Anything else in ./public is not a page. */
const STATIC_PAGES = readdirSync('public')
  .filter((name) => name.endsWith('.html'))
  .map((name) => `public/${name}`);

const navOf = (html: string) => /<p class="nav">[\s\S]*?<\/p>/.exec(html)?.[0] ?? '';

describe('the toolkit bar', () => {
  it('is on every static page', () => {
    expect(STATIC_PAGES.length).toBeGreaterThan(2);
    for (const path of STATIC_PAGES) {
      expect(readFileSync(path, 'utf8'), path).toContain('class="nav"');
    }
  });

  it('is character for character what siteNav produces, on every page', () => {
    // The strong form of "they list the same tools": there is one source, and
    // the pages hold its output verbatim. Anything else — a hand edit, a tool
    // added to the server list only — fails here.
    for (const file of staticPages()) {
      const nav = navOf(readFileSync(`public/${file}`, 'utf8'));
      expect(nav, `public/${file} is out of step — run \`npm run sync:nav\``).toBe(navBlockFor(file));
    }
  });

  it('knows which page is which, so each highlights itself', () => {
    expect(currentFor('video.html')).toBe('video');
    expect(currentFor('sign.html')).toBe('pdf');
    // Pages that carry the bar without being in it highlight nothing.
    expect(currentFor('index.html')).toBeUndefined();
    expect(currentFor('unlock.html')).toBeUndefined();
  });

  it('puts every tool in a group that exists', () => {
    const known = new Set(TOOL_GROUPS.map((g) => g.id));
    for (const tool of SITE_TOOLS) {
      expect(known.has(tool.group), `${tool.label} is in the unknown group "${tool.group}"`).toBe(true);
    }
  });

  it('leaves no group empty, and none so long it defeats the grouping', () => {
    for (const group of TOOL_GROUPS) {
      const size = SITE_TOOLS.filter((t) => t.group === group.id).length;
      expect(size, `the "${group.label}" group is empty`).toBeGreaterThan(0);
      expect(size, `the "${group.label}" group has ${size} tools, which is a flat list again`).toBeLessThan(7);
    }
  });

  it('names every group in the rendered bar', () => {
    const rendered = siteNav();
    for (const group of TOOL_GROUPS) expect(rendered).toContain(`>${group.label}<`);
  });

  it('marks at most one entry as the current page', () => {
    for (const path of STATIC_PAGES) {
      const html = readFileSync(path, 'utf8');
      const nav = /<p class="nav">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
      const bold = [...nav.matchAll(/<strong>/g)].length;
      // The landing page is not a tool, and neither are how/security or the
      // secondary PDF utilities (unlock/shrink), which carry the bar but are
      // not in it. Those highlight nothing; every top-nav tool page highlights
      // itself.
      const isToolPage = !/index\.html|how\.html|security\.html|unlock\.html|shrink\.html/.test(path);
      expect(bold, `${path} highlights ${bold} entries`).toBe(isToolPage ? 1 : 0);
    }
  });

  it('leads every page except the landing one back to it', () => {
    // The wordmark is the way home. Without it the landing page is only
    // reachable by deleting the path out of the address bar.
    for (const path of STATIC_PAGES) {
      const html = readFileSync(path, 'utf8');
      if (path.endsWith('index.html')) {
        // The landing page must not link its wordmark back to itself. The
        // "1999" in it does go somewhere — to the page that is exactly 1999
        // bytes — which is the point of the link and not a way home.
        expect(html, 'the landing page links its wordmark to itself').not.toContain('<h1><a href="/">');
        expect(html, 'the landing page lost its wordmark').toMatch(/<h1>.*1999.*\.LOC<\/h1>/);
      } else {
        expect(html, `${path} has no way back to the landing page`).toContain('<h1><a href="/">1999.LOC</a></h1>');
      }
    }
  });

  it('introduces every tool on the landing page', () => {
    // The landing page is the only page whose job is to say what else exists,
    // so a tool missing from it is invisible to anyone arriving cold.
    const landing = readFileSync('public/index.html', 'utf8');
    for (const tool of SITE_TOOLS) {
      expect(landing, `the landing page never links ${tool.label}`).toContain(tool.href);
    }
    expect(landing).toContain('The tools');
  });

  it('groups the tools on the landing page under the same categories as the nav', () => {
    // The landing page and the nav bar describe the same toolkit; letting
    // their groupings drift apart is how a visitor learns two mental maps.
    const landing = readFileSync('public/index.html', 'utf8');
    const section = landing.slice(landing.indexOf('<h2>The tools</h2>'), landing.indexOf('<h2>Why it looks like this</h2>'));
    const categories = [...section.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]!.toLowerCase());
    expect(categories).toEqual(TOOL_GROUPS.map((g) => g.label.toLowerCase()));
  });

  it('leaves no tool sitting outside a category', () => {
    // A tool added above the first heading would render as an orphan, which is
    // exactly the drift the grouping exists to prevent.
    const landing = readFileSync('public/index.html', 'utf8');
    const section = landing.slice(landing.indexOf('<h2>The tools</h2>'), landing.indexOf('<h2>Why it looks like this</h2>'));
    const firstCategory = section.indexOf('<h3>');
    const beforeAnyCategory = section.slice(0, firstCategory);
    expect(beforeAnyCategory, 'a tool is listed before the first category heading').not.toContain('scope="row"');

    // And every tool in the bar is somewhere in the grouped section.
    for (const tool of SITE_TOOLS) {
      expect(section, `${tool.label} is missing from the categorised tools`).toContain(tool.href);
    }
  });

  it('needs no JavaScript to list the tools', () => {
    // A landing page that renders nothing without JS is the thing this site
    // exists to be the opposite of. Every script it carries is pure
    // enhancement: desk.js minimises the info windows into the taskbar,
    // start.js builds the Start menu and the DOS prompt out of what the page
    // already says, firstrun.js folds the standing prose into a dialog behind
    // Help, dismiss.js puts an x on the warning boxes. None may pre-hide
    // anything, so with scripting off every window and every tool listing is
    // simply there.
    const landing = readFileSync('public/index.html', 'utf8');
    const scripts = [...landing.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual(['/desk.js', '/start.js', '/firstrun.js', '/dismiss.js']);
    expect(landing).not.toMatch(/<script[^>]*>[^<]/);           // no inline code
    expect(landing).not.toMatch(/app-window[^"]*(hidden|is-open)/); // nothing pre-hidden
  });

  it('boots every tool from the taskbar, but only when scripting runs', () => {
    // Each tool page's app window starts minimised under desk.js, restored
    // from its taskbar button. Without JavaScript none of that happens, so
    // the markup must show the window open (never pre-hidden) with its
    // button already pressed.
    const shellPages = STATIC_PAGES.filter((p) => readFileSync(p, 'utf8').includes('desk-shell'));
    expect(shellPages.length).toBeGreaterThan(10);
    for (const path of shellPages) {
      const html = readFileSync(path, 'utf8');
      expect(html, `${path} does not load desk.js`).toContain('<script src="/desk.js">');
      expect(html, `${path} does not load start.js`).toContain('<script src="/start.js">');
      expect(html, `${path} has no window for the taskbar to restore`).toContain('<div class="app-window" id="app">');
      expect(html, `${path} has no taskbar toggle for its window`).toContain('href="#app"');
      expect(html, `${path} has no minimise control`).toContain('class="win-min"');
      expect(html, `${path} pre-hides its app window`).not.toMatch(/app-window[^"]*(hidden|is-open)/);
    }
  });

  it('sends the counter to its own page, not to the landing page', () => {
    // "/" stopped being the counter when the landing page took the slot; a
    // stale link here would put people on a page with no form on it.
    const counter = SITE_TOOLS.find((t) => t.id === 'count');
    expect(counter?.href).toBe('/code.html');
  });

  it('does not link a page to itself', () => {
    const rendered = siteNav('pdf');
    expect(rendered).toContain('<strong>pdf</strong>');
    expect(rendered).not.toContain('href="/pdf.html"');
    expect(rendered).toContain('href="/golf"');
  });

  it('renders every tool as a link when no page is current', () => {
    const rendered = siteNav();
    for (const tool of SITE_TOOLS) expect(rendered).toContain(`href="${tool.href}"`);
    expect(rendered).not.toContain('<strong>');
  });
});

/**
 * The toolkit bar exists in two places that cannot import each other: the
 * server pages build it from SITE_TOOLS, and the static pages in ./public each
 * carry a hand-written copy, because they have no template engine on purpose.
 *
 * That is a drift risk with no runtime symptom — a tool added to one and not
 * the other simply becomes invisible from half the site. These tests are the
 * thing that notices.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SITE_TOOLS, siteNav } from '../src/worker/html';

/** Static pages that carry the bar. Anything else in ./public is not a page. */
const STATIC_PAGES = readdirSync('public')
  .filter((name) => name.endsWith('.html'))
  .map((name) => `public/${name}`);

describe('the toolkit bar', () => {
  it('is on every static page', () => {
    expect(STATIC_PAGES.length).toBeGreaterThan(2);
    for (const path of STATIC_PAGES) {
      expect(readFileSync(path, 'utf8'), path).toContain('class="nav"');
    }
  });

  it('lists exactly the same tools everywhere', () => {
    for (const path of STATIC_PAGES) {
      const html = readFileSync(path, 'utf8');
      const nav = /<p class="nav">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
      expect(nav, `${path} has no nav block`).not.toBe('');

      for (const tool of SITE_TOOLS) {
        expect(nav, `${path} is missing the "${tool.label}" tool`).toContain(tool.label);
        // The page you are on is bold text, so only the others need the href.
        const isSelf = new RegExp(`<strong>${tool.label}</strong>`).test(nav);
        if (!isSelf) {
          expect(nav, `${path} links "${tool.label}" somewhere unexpected`).toContain(tool.href);
        }
      }
    }
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
        expect(html, 'the landing page should not link its own wordmark').toContain('<h1>LOC.1999</h1>');
      } else {
        expect(html, `${path} has no way back to the landing page`).toContain('<h1><a href="/">LOC.1999</a></h1>');
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

  it('needs no JavaScript to list the tools', () => {
    // A landing page that renders nothing without JS is the thing this site
    // exists to be the opposite of.
    expect(readFileSync('public/index.html', 'utf8')).not.toContain('<script');
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

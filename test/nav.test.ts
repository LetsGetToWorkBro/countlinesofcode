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

  it('marks exactly one entry as the current page', () => {
    for (const path of STATIC_PAGES) {
      const html = readFileSync(path, 'utf8');
      const nav = /<p class="nav">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
      const bold = [...nav.matchAll(/<strong>/g)].length;
      // how.html and security.html are not tools, so they highlight nothing.
      const isToolPage = !/how\.html|security\.html/.test(path);
      expect(bold, `${path} highlights ${bold} entries`).toBe(isToolPage ? 1 : 0);
    }
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

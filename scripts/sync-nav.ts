/**
 * Writes the toolkit bar into every static page.
 *
 *   npm run sync:nav
 *
 * The bar exists in two worlds that cannot import each other: the server pages
 * build it from SITE_TOOLS, and the pages in ./public are plain HTML with no
 * template engine — on purpose, because a static page that needs a build step
 * to render its own navigation is the kind of thing this site exists to be the
 * opposite of.
 *
 * That was fine at six tools and hand-editable at eight. At thirteen, across
 * fifteen pages, editing them by hand is how a tool ends up invisible from half
 * the site — which had already happened once. So the markup is generated from
 * the same SITE_TOOLS the server uses, written in, and then compared character
 * for character by test/nav.test.ts. Hand-editing a nav block now fails the
 * suite rather than drifting quietly.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE_TOOLS, siteNav } from '../src/worker/html';

const PUBLIC = 'public';

/**
 * Which tool a page *is*, so it can render itself as bold text rather than as a
 * link to where the visitor already is.
 *
 * Pages that carry the bar without being in it — the landing page, the how and
 * security notes, and the secondary PDF utilities — highlight nothing.
 */
export function currentFor(file: string): string | undefined {
  return SITE_TOOLS.find((tool) => tool.href === `/${file}`)?.id;
}

/** The `<p class="nav">…</p>` block, without the rules around it. */
export function navBlockFor(file: string): string {
  const rendered = siteNav(currentFor(file));
  const match = /<p class="nav">[\s\S]*?<\/p>/.exec(rendered);
  if (!match) throw new Error('siteNav no longer produces a recognisable nav block');
  return match[0];
}

export function staticPages(): string[] {
  return readdirSync(PUBLIC).filter((name) => name.endsWith('.html'));
}

/** Replace the nav in one page. Returns whether anything changed. */
export function syncPage(file: string): boolean {
  const path = join(PUBLIC, file);
  const html = readFileSync(path, 'utf8');
  const existing = /<p class="nav">[\s\S]*?<\/p>/.exec(html);
  if (!existing) {
    throw new Error(`${file} has no nav block to replace`);
  }
  const wanted = navBlockFor(file);
  if (existing[0] === wanted) return false;
  writeFileSync(path, html.slice(0, existing.index) + wanted + html.slice(existing.index + existing[0].length));
  return true;
}

/* Gated on an explicit flag rather than on being the main module: under
   vite-node argv[1] is the runner's own binary and import.meta.url is the same
   whether this file was run or imported, so neither of the usual checks can
   tell the difference. It needs one — test/nav.test.ts imports this module, and
   rewriting fifteen pages as a side effect of running the tests would be worse
   than the drift it prevents. */
if (process.argv.includes('--write')) {
  let changed = 0;
  for (const file of staticPages()) {
    if (syncPage(file)) {
      changed++;
      console.log(`updated ${file}`);
    }
  }
  console.log(changed ? `${changed} page(s) updated` : 'every page was already in step');
}

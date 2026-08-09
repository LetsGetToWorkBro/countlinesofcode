/**
 * Lift the desktop icons out of the landing page into a file the scripts can
 * read.
 *
 * The icons have to be inline in public/index.html: that page draws the
 * desktop with no JavaScript at all, so its shortcuts cannot come from a
 * script. But the shortcuts start.js lays on a tool page's desk want the same
 * pictures, and a second hand-drawn copy of sixteen SVGs is a second copy to
 * keep in step.
 *
 * So the landing page stays the one source and this generates the other:
 * public/icons.js, a plain map of href to markup. test/icons.test.ts
 * regenerates and compares, so an icon changed in the page and not rebuilt
 * fails the suite instead of drifting quietly.
 *
 *   npm run build:icons
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANDING = join(root, 'public', 'index.html');
const OUT = join(root, 'public', 'icons.js');

const BANNER =
  '/* 1999.LOC desktop icons. Built from the landing page by\n' +
  ' * scripts/build-icons.mjs. Do not edit: change the icon in\n' +
  ' * public/index.html and run `npm run build:icons`.\n' +
  ' *\n' +
  ' * The landing page needs them inline (it draws its desktop with no\n' +
  ' * JavaScript); start.js needs them for the shortcuts it lays on a tool\n' +
  ' * page. One source, two forms.\n' +
  ' */\n';

/**
 * The handful of named entities a hand-written page uses, turned back into
 * characters.
 *
 * The label ends up in a JavaScript string that start.js escapes before
 * inserting, so an entity carried through verbatim would be escaped a second
 * time and printed as its own source: a shortcut reading `PDF &lt;=&gt; Word`
 * rather than `PDF <=> Word`.
 *
 * &nbsp; is in the list for a different reason. A desktop caption is 54px
 * wide on a phone and has to wrap, and the non-breaking space is what
 * decides where: without it "Excel <=> CSV" breaks after the arrow and
 * "PDF <=> Word" before it, which reads as two captions rather than a pair.
 */
function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&middot;/g, '\u00b7')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&amp;/g, '&');   // last, so &amp;lt; does not become <
}

/**
 * The one-line description printed beside each tool in the landing page's
 * directory, keyed by where it points.
 *
 * The Info key on the machine's chin says what the selected program is for,
 * and that sentence has to come from somewhere. Writing it twice is how the
 * two copies end up disagreeing, so it is lifted from the table that already
 * prints it rather than kept in a second list.
 */
export function notesFromLanding(html) {
  const notes = {};
  const re = /<tr><td><a href="([^"]+)">[^<]*<\/a><\/td><td>([\s\S]*?)<\/td><\/tr>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const [, href, cell] = match;
    // The cell carries a <span class="srv">server</span> badge on the two
    // tools that talk to one. That is a note about hosting, not about what
    // the program does, so it does not travel.
    const plain = cell.replace(/<span class="srv">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '');
    notes[href] = decodeEntities(plain.replace(/\s+/g, ' ').trim());
  }
  return notes;
}

/** Every `<a class="desk-icon" href="...">` on the landing page. */
export function iconsFromLanding(html) {
  const icons = {};
  const notes = notesFromLanding(html);
  const re = /<a class="desk-icon" href="([^"]+)">\s*(<svg[\s\S]*?<\/svg>)\s*<span>([^<]*)<\/span>\s*<\/a>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const [, href, svg, label] = match;
    icons[href] = {
      svg: svg.replace(/\s+/g, ' ').trim(),
      label: decodeEntities(label),
      note: notes[href] || '',
    };
  }
  return icons;
}

export function renderIcons(icons) {
  const entries = Object.entries(icons)
    .map(([href, { svg, label, note }]) =>
      `  ${JSON.stringify(href)}: ${JSON.stringify({ svg, label, note }).replace(/\u00a0/g, '\\u00a0')},`)
    .join('\n');
  return `${BANNER}window.LOC1999_ICONS = {\n${entries}\n};\n`;
}

export function buildIcons() {
  const icons = iconsFromLanding(readFileSync(LANDING, 'utf8'));
  const count = Object.keys(icons).length;
  if (count < 10) throw new Error(`only found ${count} icons on the landing page; the markup must have changed`);
  return { text: renderIcons(icons), count };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { text, count } = buildIcons();
  writeFileSync(OUT, text);
  console.log(`public/icons.js  ${count} icons, ${(text.length / 1024).toFixed(1)} KB`);
}

/**
 * pdf.js is copied into public/vendor rather than bundled, and the copies are
 * committed because `wrangler deploy` runs no build step. That makes it
 * possible to bump pdfjs-dist and ship last version's renderer, so this
 * compares the committed bytes against node_modules.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TESSDATA } from '../scripts/fetch-tessdata.mjs';
import {
  VENDORED,
  VENDORED_DIRS,
  VENDORED_LIBS,
  dirTarget,
  libSource,
  libTarget,
  libheifVersion,
  mediabunnyVersion,
  openpgpVersion,
  pdfjsVersion,
  sourcePath,
  vendoredPath,
} from '../scripts/vendor-pdfjs.mjs';

describe('public/vendor', () => {
  it('matches the installed pdfjs-dist', () => {
    for (const spec of VENDORED) {
      const source = readFileSync(sourcePath(spec));
      const committed = readFileSync(vendoredPath(spec));
      expect(
        committed.equals(source),
        `${spec.to} is stale — run \`npm run vendor:pdfjs\` and commit the result`,
      ).toBe(true);
    }
  });

  it("ships the minified builds, not the source ones", () => {
    // The unminified builds are roughly three times the size, and this page
    // already costs a megabyte.
    for (const spec of VENDORED) {
      expect(spec.from).toContain('.min.');
      expect(statSync(vendoredPath(spec)).size).toBeLessThan(2 * 1024 * 1024);
    }
  });

  it('ships the font metrics and cmaps pdf.js needs at render time', () => {
    // Without these pdf.js substitutes fonts and blanks CJK text. In a viewer
    // that is cosmetic; here a redacted page *becomes* its render, so a wrong
    // render would be baked into the output permanently.
    for (const spec of VENDORED_DIRS) {
      const files = readdirSync(dirTarget(spec));
      expect(files.length, `${spec.to} is empty — run \`npm run vendor:pdfjs\``).toBeGreaterThan(10);
    }
  });

  it("records a version, so the honest notes can cite one", () => {
    expect(pdfjsVersion()).toMatch(/^\d+\.\d+/);
    expect(libheifVersion()).toMatch(/^\d+\.\d+/);
    expect(mediabunnyVersion()).toMatch(/^\d+\.\d+/);
    expect(openpgpVersion()).toMatch(/^\d+\.\d+/);
  });

  it('ships the OCR language data, which is not in any package', () => {
    // tesseract.js fetches this from a CDN by default; connect-src 'self'
    // forbids that, and telling a third party that somebody is OCR'ing a
    // payslip is the opposite of the point. So it is committed.
    const size = statSync(join('.', TESSDATA.to)).size;
    expect(size, `${TESSDATA.to} is missing — run node scripts/fetch-tessdata.mjs`).toBeGreaterThan(TESSDATA.minBytes);
  });

  it('pins one OCR core rather than shipping every variant', () => {
    // Letting tesseract.js auto-select means vendoring all of them, which is
    // twelve megabytes. SIMD covers every major browser since 2021.
    const cores = VENDORED_LIBS.filter((l) => l.to.includes('tesseract-core'));
    expect(cores).toHaveLength(1);
    expect(cores[0]!.to).toContain('simd');
  });

  it('matches the installed packages for every vendored library', () => {
    for (const spec of VENDORED_LIBS) {
      const source = readFileSync(libSource(spec));
      const committed = readFileSync(libTarget(spec));
      expect(
        committed.equals(source),
        `${spec.to} is stale — run \`npm run vendor:pdfjs\` and commit the result`,
      ).toBe(true);
    }
  });

  it('ships mediabunny as one pre-bundled module', () => {
    // The published module tree is hundreds of files that import each other;
    // serving those means every one of them is a separate fetch on a page
    // someone opened to trim a holiday video. The bundle is one file.
    const video = VENDORED_LIBS.find((l) => l.pkg === 'mediabunny');
    expect(video?.to).toMatch(/\.mjs$/);
    expect(statSync(libTarget(video!)).size).toBeLessThan(1024 * 1024);
  });

  it('ships the cryptography rather than writing it out', () => {
    // The one library here that exists because writing it ourselves would be
    // irresponsible: a cipher that is subtly wrong looks exactly like one that
    // is right. Served unmodified as its own file, which is also what LGPL asks.
    const pgp = VENDORED_LIBS.find((l) => l.pkg === 'openpgp');
    expect(pgp?.to).toMatch(/\.mjs$/);
    const source = readFileSync(libTarget(pgp!), 'utf8');
    expect(source, 'openpgp must not need eval under script-src self').not.toMatch(/[^.\w]eval\(/);
    expect(source).not.toContain('new Function');
  });

  it('ships libheif as the self-contained bundle', () => {
    // The wasm has to ride inside the .js: a separate .wasm fetch is one more
    // thing to get wrong under the CSP.
    const heif = VENDORED_LIBS.find((l) => l.pkg === 'libheif-js');
    expect(heif?.from).toContain('bundle');
  });
});

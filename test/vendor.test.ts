/**
 * pdf.js is copied into public/vendor rather than bundled, and the copies are
 * committed because `wrangler deploy` runs no build step. That makes it
 * possible to bump pdfjs-dist and ship last version's renderer, so this
 * compares the committed bytes against node_modules.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VENDORED, VENDORED_DIRS, dirTarget, pdfjsVersion, sourcePath, vendoredPath } from '../scripts/vendor-pdfjs.mjs';

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
  });
});

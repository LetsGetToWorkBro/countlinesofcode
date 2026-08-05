/**
 * Copies pdf.js out of node_modules into public/vendor.
 *
 *   npm run vendor:pdfjs
 *
 * Copied rather than bundled, for three reasons:
 *
 *  - pdf.js ships its renderer as a separate Web Worker file, and running it
 *    through a bundler is a well-known way to break it subtly.
 *  - the site's CSP is `script-src 'self'`, so it has to be served from this
 *    origin anyway. A CDN tag on a page handling someone's contracts is the
 *    opposite of the point.
 *  - keeping the files pristine means updating pdf.js is `npm update` plus this
 *    script, with no bundler config to re-learn.
 *
 * The copies are committed, because `wrangler deploy` runs no build step.
 * test/vendor.test.ts compares them against node_modules so a stale copy fails
 * the suite rather than shipping quietly.
 */
import { cpSync, copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);

/**
 * The *legacy*, *minified* builds.
 *
 * Minified because the plain ones are three times the size. Legacy because the
 * modern build assumes a very recent JavaScript engine — pdf.js 6 calls
 * `Map.prototype.getOrInsertComputed`, which is a current TC39 proposal, and on
 * a browser even slightly behind it fails at render with
 * "getOrInsertComputed is not a function". That was caught here by an actual
 * browser, not by reading the docs, and it would have looked like a broken
 * tool to anyone not running this month's Chrome. The legacy build carries the
 * polyfills; it costs about 50 KB more and works.
 */
export const VENDORED = [
  { from: 'pdfjs-dist/legacy/build/pdf.min.mjs', to: 'public/vendor/pdf.min.mjs' },
  { from: 'pdfjs-dist/legacy/build/pdf.worker.min.mjs', to: 'public/vendor/pdf.worker.min.mjs' },
];

/**
 * Directories pdf.js loads at render time, not import time.
 *
 * `standard_fonts` holds metrics for the 14 fonts every PDF may use without
 * embedding them (Helvetica, Times, Courier…). Without it pdf.js warns and
 * substitutes, which normally means slightly wrong-looking text — but here it
 * would be baked in permanently, because a redacted page *becomes* its render.
 * A redaction that silently reflows the surrounding text is not acceptable.
 *
 * `cmaps` does the same job for CJK encodings. Without it a Chinese, Japanese
 * or Korean document renders as blanks, and flattening that would destroy the
 * page rather than redact it.
 *
 * Together they are about 2.5 MB on disk, but they are fetched per file, only
 * when a document actually needs one — most Latin-alphabet PDFs pull a handful
 * of kilobytes and no cmap at all.
 */
export const VENDORED_DIRS = [
  { from: 'pdfjs-dist/standard_fonts', to: 'public/vendor/standard_fonts' },
  { from: 'pdfjs-dist/cmaps', to: 'public/vendor/cmaps' },
];

export function dirSource(spec) {
  return join(dirname(require.resolve('pdfjs-dist/package.json')), spec.from.replace('pdfjs-dist/', ''));
}

export function dirTarget(spec) {
  return join(root, spec.to);
}

export function sourcePath(spec) {
  return require.resolve(spec.from);
}

export function vendoredPath(spec) {
  return join(root, spec.to);
}

export function pdfjsVersion() {
  return require('pdfjs-dist/package.json').version;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(join(root, 'public/vendor'), { recursive: true });
  for (const spec of VENDORED) {
    copyFileSync(sourcePath(spec), vendoredPath(spec));
    const kb = statSync(vendoredPath(spec)).size / 1024;
    console.log(`${spec.to.padEnd(32)} ${kb.toFixed(0)} KB`);
  }
  for (const spec of VENDORED_DIRS) {
    cpSync(dirSource(spec), dirTarget(spec), { recursive: true });
    const files = readdirSync(dirTarget(spec));
    const kb = files.reduce((sum, f) => sum + statSync(join(dirTarget(spec), f)).size, 0) / 1024;
    console.log(`${spec.to.padEnd(32)} ${kb.toFixed(0)} KB in ${files.length} files`);
  }
  console.log(`pdf.js ${pdfjsVersion()}`);
  // Touched only to prove the files are readable after copying.
  readFileSync(vendoredPath(VENDORED[0]), 'utf8');
}

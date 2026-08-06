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
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * libheif, the HEIC decoder, as a single self-contained file.
 *
 * The `-bundle` build embeds the WebAssembly binary inside the JavaScript as
 * base64, so there is one file to serve and no second fetch for a .wasm — which
 * keeps it simple under `connect-src 'self'`. It is loaded with a plain
 * `<script>` tag, exposing a `libheif` global, and only when someone actually
 * converts a HEIC photo. Decoding needs `'wasm-unsafe-eval'` in the CSP; see
 * SECURITY_HEADERS. Committed like the pdf.js copies, for the same reason.
 */
export const VENDORED_LIBS = [
  { pkg: 'libheif-js', from: 'libheif-wasm/libheif-bundle.js', to: 'public/vendor/libheif/libheif-bundle.js' },
  /* Tesseract, for reading scanned pages. Three pieces and one deliberate
   * choice: the core is *pinned* to the SIMD build rather than letting
   * tesseract.js pick, because auto-selection asks for whichever variant the
   * browser supports and vendoring all of them would be twelve megabytes.
   * SIMD has been in every major browser since 2021.
   *
   * The language data is not in the package — tesseract.js fetches it from a
   * CDN by default, which connect-src 'self' forbids — so it is downloaded
   * once by scripts/fetch-tessdata.mjs and committed like everything else. */
  { pkg: 'tesseract.js', from: 'dist/tesseract.min.js', to: 'public/vendor/tesseract/tesseract.min.js' },
  { pkg: 'tesseract.js', from: 'dist/worker.min.js', to: 'public/vendor/tesseract/worker.min.js' },
  {
    pkg: 'tesseract.js-core',
    from: 'tesseract-core-simd-lstm.wasm.js',
    to: 'public/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  },
  /* mediabunny, for reading and writing video containers.
   *
   * WebCodecs gives a browser the codecs — it will decode and encode frames —
   * but it does not read or write MP4 and WebM files. Everything between the
   * codec and the file is missing, and that is most of the work. This is the
   * one library that does both halves, in one file, with no WebAssembly and no
   * ffmpeg. The pre-bundled ESM build is used rather than the module tree so
   * there is a single file to serve under script-src 'self'. */
  { pkg: 'mediabunny', from: 'dist/bundles/mediabunny.min.mjs', to: 'public/vendor/mediabunny/mediabunny.min.mjs' },
  /* OpenPGP.js, for the encryption tools.
   *
   * The one place on this site where writing it out would be irresponsible
   * rather than admirable. A GIF encoder that is subtly wrong produces a
   * visibly broken picture; a cipher that is subtly wrong produces something
   * that looks encrypted and is not, and the person holding it has no way to
   * tell. This is the implementation the rest of the world reviews.
   *
   * LGPL-3.0, served unmodified as its own file rather than bundled into ours,
   * which is what that licence asks for. It needs no eval and no worker —
   * measured against the real policy, not assumed. */
  { pkg: 'openpgp', from: 'dist/openpgp.min.mjs', to: 'public/vendor/openpgp/openpgp.min.mjs' },
];

/**
 * monero-ts's wallet worker: the full Monero wallet, WebAssembly inlined, run
 * as a Web Worker so the cryptography never blocks the page. Vendored WITH the
 * eval patches from scripts/eval-patches.mjs applied, because the worker runs
 * under the same CSP as everything else on this origin and the stock file
 * probes its environment through `new Function(...)`. test/vendor.test.ts
 * re-applies the patches to a pristine node_modules copy and compares, so the
 * committed file can be neither stale nor hand-edited.
 */
export const VENDORED_PATCHED = [
  { pkg: 'monero-ts', from: 'dist/monero.worker.js', to: 'public/vendor/monero-ts/monero.worker.js' },
  { pkg: 'monero-ts', from: 'LICENSE.txt', to: 'public/vendor/monero-ts/LICENSE.txt' },
];

/**
 * Where a package lives on disk.
 *
 * `require.resolve('pkg/package.json')` is the obvious way and works for most
 * packages, but a package with an `exports` map that does not list
 * `./package.json` refuses it outright — mediabunny is one. So fall back to
 * resolving the package's own entry point and walking up to the directory that
 * holds its manifest.
 */
export function packageRoot(pkg) {
  try {
    return dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    let dir = dirname(require.resolve(pkg));
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, 'package.json'))) return dir;
      dir = dirname(dir);
    }
    throw new Error(`cannot locate ${pkg} on disk`);
  }
}

export function libSource(spec) {
  return join(packageRoot(spec.pkg), spec.from);
}

export function libTarget(spec) {
  return join(root, spec.to);
}

export function libheifVersion() {
  return require('libheif-js/package.json').version;
}

export function openpgpVersion() {
  return JSON.parse(readFileSync(join(packageRoot('openpgp'), 'package.json'), 'utf8')).version;
}

export function mediabunnyVersion() {
  return JSON.parse(readFileSync(join(packageRoot('mediabunny'), 'package.json'), 'utf8')).version;
}

export function moneroTsVersion() {
  return JSON.parse(readFileSync(join(packageRoot('monero-ts'), 'package.json'), 'utf8')).version;
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
  for (const spec of VENDORED_LIBS) {
    mkdirSync(dirname(libTarget(spec)), { recursive: true });
    copyFileSync(libSource(spec), libTarget(spec));
    const kb = statSync(libTarget(spec)).size / 1024;
    console.log(`${spec.to.padEnd(32)} ${kb.toFixed(0)} KB`);
  }
  {
    const { applyEvalPatches } = await import('./eval-patches.mjs');
    for (const spec of VENDORED_PATCHED) {
      mkdirSync(dirname(libTarget(spec)), { recursive: true });
      const patched = applyEvalPatches(readFileSync(libSource(spec), 'utf8'));
      writeFileSync(libTarget(spec), patched);
      const kb = statSync(libTarget(spec)).size / 1024;
      console.log(`${spec.to.padEnd(32)} ${kb.toFixed(0)} KB (eval patches applied)`);
    }
  }
  console.log(`pdf.js ${pdfjsVersion()} · libheif-js ${libheifVersion()} · mediabunny ${mediabunnyVersion()} · openpgp ${openpgpVersion()} · monero-ts ${moneroTsVersion()}`);
  // Touched only to prove the files are readable after copying.
  readFileSync(vendoredPath(VENDORED[0]), 'utf8');
}

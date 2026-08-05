/**
 * Bundles the browser-side engines into ./public.
 *
 *   npm run build:client
 *
 * The outputs are committed, because Cloudflare serves ./public verbatim and
 * `wrangler deploy` does not run a build step. test/client-bundle.test.ts
 * rebuilds and compares, so a stale committed bundle fails the suite rather
 * than silently shipping old rules.
 *
 * Both bundles exist because the site's Content-Security-Policy is
 * `script-src 'self'`: nothing may be pulled from a CDN. For the PDF tool that
 * is the whole point — a third-party script tag on a page handling someone's
 * bank statements is exactly what this site refuses to do.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const COMMON = {
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  platform: 'browser',
  minify: true,
  legalComments: 'none',
};

/** entry -> output, with the banner stamped on each. */
export const BUNDLES = [
  {
    entry: 'src/client/bigcount.ts',
    outfile: 'public/bigcount.js',
    banner: '/* LOC.1999 big-repo counter. Built from src/client/bigcount.ts — do not edit. */',
  },
  {
    entry: 'src/client/convert.ts',
    outfile: 'public/convert.js',
    banner: '/* LOC.1999 PDF/Word converter. Built from src/client/convert.ts — do not edit. Bundles pdf-lib (MIT). */',
  },
  {
    entry: 'src/client/sheetkit.ts',
    outfile: 'public/sheetkit.js',
    banner: '/* LOC.1999 spreadsheet engine. Built from src/client/sheetkit.ts — do not edit. */',
  },
  {
    entry: 'src/client/pdfedit.ts',
    outfile: 'public/pdfsign.js',
    banner: '/* LOC.1999 PDF editor engine. Built from src/client/pdfedit.ts — do not edit. Bundles pdf-lib (MIT). */',
  },
];

/** Kept for callers that only care about the counter bundle's options. */
export const BUILD_OPTIONS = {
  ...COMMON,
  entryPoints: [join(root, BUNDLES[0].entry)],
  banner: { js: BUNDLES[0].banner },
};

export function optionsFor(spec) {
  return {
    ...COMMON,
    entryPoints: [join(root, spec.entry)],
    banner: { js: spec.banner },
  };
}

export async function bundle(outfile, spec = BUNDLES[0]) {
  return build({ ...optionsFor(spec), outfile, write: outfile !== undefined, metafile: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const spec of BUNDLES) {
    const result = await bundle(join(root, spec.outfile), spec);
    const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
    console.log(`${spec.outfile.padEnd(20)} ${(bytes / 1024).toFixed(1)} KB`);
  }
}

/**
 * Bundles the browser-side counter to public/bigcount.js.
 *
 *   npm run build:client
 *
 * The output is committed, because Cloudflare serves ./public verbatim and
 * `wrangler deploy` does not run a build step. test/client-bundle.test.ts
 * rebuilds and compares, so a stale committed bundle fails the suite rather
 * than silently shipping old counting rules.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export const BUILD_OPTIONS = {
  entryPoints: [join(root, 'src/client/bigcount.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  banner: {
    js: '/* LOC.1999 big-repo counter. Built from src/client/bigcount.ts — do not edit. */',
  },
};

export async function bundle(outfile) {
  const result = await build({ ...BUILD_OPTIONS, outfile, write: outfile !== undefined, metafile: true });
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outfile = join(root, 'public/bigcount.js');
  const result = await bundle(outfile);
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  console.log(`public/bigcount.js  ${(bytes / 1024).toFixed(1)} KB`);
}

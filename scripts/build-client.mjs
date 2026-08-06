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
    banner: '/* 1999.LOC big-repo counter. Built from src/client/bigcount.ts. Do not edit. */',
  },
  {
    entry: 'src/client/convert.ts',
    outfile: 'public/convert.js',
    banner: '/* 1999.LOC PDF/Word converter. Built from src/client/convert.ts. Do not edit. Bundles pdf-lib (MIT). */',
  },
  {
    entry: 'src/client/sheetkit.ts',
    outfile: 'public/sheetkit.js',
    banner: '/* 1999.LOC spreadsheet engine. Built from src/client/sheetkit.ts. Do not edit. */',
  },
  {
    entry: 'src/client/pdfedit.ts',
    outfile: 'public/pdfsign.js',
    banner: '/* 1999.LOC PDF editor engine. Built from src/client/pdfedit.ts. Do not edit. Bundles pdf-lib (MIT). */',
  },
  {
    entry: 'src/client/proof.ts',
    outfile: 'public/proof.js',
    banner: '/* 1999.LOC proof panel logic. Built from src/client/proof.ts. Do not edit. */',
  },
  {
    entry: 'src/client/pgpkit.ts',
    outfile: 'public/pgpkit.js',
    banner: '/* 1999.LOC encryption helpers. Built from src/client/pgpkit.ts. Do not edit. The cryptography itself is OpenPGP.js, served from /vendor. */',
  },
  {
    entry: 'src/client/zipkit.ts',
    outfile: 'public/zipkit.js',
    banner: '/* 1999.LOC archive engine. Built from src/client/zipkit.ts. Do not edit. */',
  },
  {
    entry: 'src/client/email.ts',
    outfile: 'public/email.js',
    banner: '/* 1999.LOC email checker. Built from src/client/email.ts. Do not edit. */',
  },
  {
    entry: 'src/client/monero.ts',
    outfile: 'public/monero.js',
    banner: '/* 1999.LOC Monero keys and addresses. Built from src/client/monero.ts. Do not edit. Bundles @noble/hashes and @noble/curves (MIT). */',
  },
  {
    // The planner only. mediabunny itself is served from /vendor as a module,
    // because it is 600 KB and the page loads it after a file is opened.
    entry: 'src/client/video.ts',
    outfile: 'public/video.js',
    banner: '/* 1999.LOC video planner. Built from src/client/video.ts. Do not edit. */',
  },
  {
    entry: 'src/client/walletkit.ts',
    outfile: 'public/walletkit.js',
    banner: '/* 1999.LOC wallet helpers. Built from src/client/walletkit.ts. Do not edit. */',
  },
];

/**
 * The Monero wallet library itself, on its own terms.
 *
 * monero-ts is a large CommonJS package that reaches for a handful of Node
 * built-ins behind isNode checks the browser never takes. esbuild bundles it
 * into one IIFE with those built-ins aliased to browser shims (scripts/shims),
 * and then applyEvalPatches removes the `new Function(...)` environment probes
 * so the file runs under `script-src 'self'` with no 'unsafe-eval'. The wallet
 * cryptography runs in the vendored Web Worker; this is the main-thread API that
 * drives it. Kept out of BUNDLES because it needs the aliases and the eval pass,
 * and test/client-bundle.test.ts rebuilds it the same way to catch a stale copy.
 */
export const MONERO_LIB = {
  entry: 'src/client/xmrlib.js',
  outfile: 'public/xmrlib.js',
  banner: '/* 1999.LOC Monero wallet library (monero-ts, MIT). Bundled with browser shims and eval probes removed. Do not edit. */',
};

const SHIM = (name) => join(root, 'scripts/shims', name);
export const MONERO_ALIAS = {
  assert: SHIM('assert.js'),
  path: SHIM('path.js'),
  fs: SHIM('empty.js'),
  http: SHIM('empty.js'),
  https: SHIM('empty.js'),
  url: SHIM('empty.js'),
  util: SHIM('empty.js'),
  stream: SHIM('empty.js'),
  zlib: SHIM('empty.js'),
  crypto: SHIM('empty.js'),
  os: SHIM('empty.js'),
  net: SHIM('empty.js'),
  tls: SHIM('empty.js'),
  child_process: SHIM('empty.js'),
  worker_threads: SHIM('empty.js'),
  module: SHIM('empty.js'),
  events: SHIM('empty.js'),
  buffer: SHIM('empty.js'),
  tty: SHIM('empty.js'),
};

export function moneroLibOptions() {
  return {
    ...COMMON,
    entryPoints: [join(root, MONERO_LIB.entry)],
    banner: { js: MONERO_LIB.banner },
    alias: MONERO_ALIAS,
    // The library detects its environment; keep it honest about being a browser.
    define: { 'process.env.NODE_ENV': '"production"' },
  };
}

/** Build the Monero library bundle and return its final (eval-patched) text.
 *  esbuild already stamps the banner, so this only removes the eval probes. */
export async function buildMoneroLib() {
  const { applyEvalPatches } = await import('./eval-patches.mjs');
  const result = await build({ ...moneroLibOptions(), write: false });
  return applyEvalPatches(result.outputFiles?.[0]?.text ?? '');
}

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
  const { writeFileSync } = await import('node:fs');
  for (const spec of BUNDLES) {
    const result = await bundle(join(root, spec.outfile), spec);
    const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
    console.log(`${spec.outfile.padEnd(20)} ${(bytes / 1024).toFixed(1)} KB`);
  }
  const moneroLib = await buildMoneroLib();
  writeFileSync(join(root, MONERO_LIB.outfile), moneroLib);
  console.log(`${MONERO_LIB.outfile.padEnd(20)} ${(Buffer.byteLength(moneroLib) / 1024).toFixed(1)} KB`);
}

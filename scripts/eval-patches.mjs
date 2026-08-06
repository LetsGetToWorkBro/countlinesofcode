/**
 * Rewrites the eval-shaped constructs in the Monero wallet library so it runs
 * under this site's Content-Security-Policy.
 *
 * The CSP is `script-src 'self' 'wasm-unsafe-eval'` with no `'unsafe-eval'`,
 * and that is not negotiable: a wallet page is exactly where an injected
 * string-to-code path would be worth money to somebody. monero-ts and its
 * dependencies contain a handful of `new Function("...")` environment probes,
 * two of which actually execute at load time and would throw under the policy.
 * Every one of them is a way of asking "what is the global object" or "which
 * environment is this", and every one has a direct answer on the platforms
 * this site supports (es2022 browsers), so they are rewritten rather than the
 * policy loosened.
 *
 * Applied in two places, by design the SAME list: the vendored
 * monero.worker.js copy, and the esbuild output of the walletkit bundle.
 * test/vendor.test.ts and test/client-bundle.test.ts both re-apply these to a
 * fresh copy and compare, so a patch that stops matching the library fails the
 * suite instead of silently shipping an unpatched eval.
 */

export const EVAL_PATCHES = [
  // GenUtils.isBrowser(): runs at module load. `this` in sloppy Function-code
  // is the global object; globalThis is the same answer without the eval.
  [
    'new Function("try {return this===window;}catch(e){return false;}")',
    '(()=>{try{return globalThis===window}catch(e){return false}})',
  ],
  // GenUtils' jsdom sniff: also runs at load when in a browser.
  [
    'new Function("try {return window.navigator.userAgent.includes(\'jsdom\');}catch(e){return false;}")',
    '(()=>{try{return window.navigator.userAgent.includes("jsdom")}catch(e){return false}})',
  ],
  // Global-object shims (lodash-style, webpack-style). Guarded fallbacks that
  // never run where globalThis exists, but a dead eval is still an eval to a
  // reviewer; globalThis is the exact value they compute. The `new` form is
  // replaced first so the bare form cannot leave a dangling `new (globalThis)`.
  ['new Function("return this")()', '(globalThis)'],
  ['Function("return this")()', '(globalThis)'],
];

/**
 * Prepare the vendored file: apply every eval patch, and drop the trailing
 * `//# sourceMappingURL=...` comment. The .map it points at is not vendored, so
 * left in it makes the browser fetch a file that 404s on every worker start.
 * Both transforms are deterministic, so the vendor script and the test that
 * re-derives the committed bytes stay in lock step.
 */
export function applyEvalPatches(source) {
  let out = source;
  for (const [from, to] of EVAL_PATCHES) out = out.split(from).join(to);
  out = out.replace(/\n?\/\/# sourceMappingURL=[^\n]*\n?$/, '\n');
  return out;
}

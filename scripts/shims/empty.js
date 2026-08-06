/**
 * Empty stand-in for Node built-ins monero-ts imports but never uses in a
 * browser (fs, http, net, child_process and friends). Every import from one
 * of these sits behind an isNode/isBrowser check; the browser paths use fetch
 * and Web Workers. An empty object makes an unexpected use fail loudly at the
 * property access instead of pretending to work.
 */
export default {};

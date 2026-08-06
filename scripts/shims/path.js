/**
 * Browser stand-in for Node's `path`, for bundling monero-ts.
 *
 * Reached only from the library's Node-specific branches (wallet files on
 * disk), which the wallet page never takes: browser wallets live in memory.
 * Implemented anyway rather than stubbed empty, so an unexpected call
 * produces a sensible string instead of a crash inside a dead branch.
 */
export function join(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}
export function dirname(p) {
  const s = String(p).replace(/\/+$/, '');
  return s.includes('/') ? s.slice(0, s.lastIndexOf('/')) || '/' : '.';
}
export function basename(p) {
  const s = String(p).replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
}
export default { join, dirname, basename };

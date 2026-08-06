/* Entry point for the bundled Monero wallet library.
 *
 * This exists only to pull monero-ts into one IIFE and hang its API off a
 * global the wallet page can reach, the same pattern every other engine on this
 * site uses. The heavy cryptography is not here: it runs in the vendored Web
 * Worker (public/vendor/monero-ts/monero.worker.js), which this library spawns
 * once the page points it there. Built by scripts/build-client.mjs with Node
 * built-ins shimmed and the eval-shaped environment probes removed, so it runs
 * under script-src 'self' with no 'unsafe-eval'.
 */
import moneroTs from 'monero-ts';

window.LOC1999_XMRLIB = moneroTs;

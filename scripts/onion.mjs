/**
 * Wire (or unwire) the Tor onion mirror in one command.
 *
 *   npm run onion:set <56-char-address>.onion
 *   npm run onion:clear
 *
 * The address has to be written in two places, because the site is served
 * from two: `public/_headers` covers the static pages, which the asset
 * router serves at the edge without ever waking the Worker, and the
 * ONION_HOST var in `wrangler.toml` covers the pages the Worker renders
 * (/golf, /board, /r/..., the error pages). Doing it by hand means doing
 * half of it, so this does both or neither.
 *
 * Nothing here contacts Tor. Generating the address and running the service
 * is docs/onion.md; this is only the clearnet site's half, the advertisement
 * that lets Tor Browser find it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADERS = join(root, 'public', '_headers');
const WRANGLER = join(root, 'wrangler.toml');
const ONION = /^[a-z2-7]{56}\.onion$/;

const MARK = '  # Onion-Location:';
const LIVE = '  Onion-Location: ';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The address, cleaned of a scheme, a path or a stray capital. */
function clean(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

function setHeaders(host) {
  const text = readFileSync(HEADERS, 'utf8');
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(MARK) || l.startsWith(LIVE));
  const line = host
    ? `${LIVE}http://${host}/`
    : `${MARK} set by \`npm run onion:set <address>.onion\``;
  if (at >= 0) {
    lines[at] = line;
  } else {
    // Straight after the /* block's last header, so it applies to every page.
    const csp = lines.findIndex((l) => l.trim().startsWith('Content-Security-Policy:'));
    if (csp < 0) fail('public/_headers has no /* block to add the header to.');
    lines.splice(csp + 1, 0, line);
  }
  writeFileSync(HEADERS, lines.join('\n'));
}

function setWrangler(host) {
  const text = readFileSync(WRANGLER, 'utf8');
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^\s*#?\s*ONION_HOST\s*=/.test(l));
  const line = host ? `ONION_HOST = "${host}"` : '# ONION_HOST = "set by `npm run onion:set`"';
  if (at >= 0) {
    lines[at] = line;
    writeFileSync(WRANGLER, lines.join('\n'));
    return;
  }
  const vars = lines.findIndex((l) => l.trim() === '[vars]');
  if (vars < 0) fail('wrangler.toml has no [vars] block; add one and run this again.');
  lines.splice(vars + 1, 0, line);
  writeFileSync(WRANGLER, lines.join('\n'));
}

const [, , command, argument] = process.argv;

if (command === 'set') {
  const host = clean(argument);
  if (!ONION.test(host)) {
    fail(
      `Not a v3 onion address: ${argument ?? '(nothing given)'}\n` +
        'It is 56 characters of lowercase a-z and 2-7, then ".onion".\n' +
        'Generate one with mkp224o or take it from the hostname file Tor wrote.\n' +
        'See docs/onion.md.',
    );
  }
  setHeaders(host);
  setWrangler(host);
  console.log(`Onion mirror advertised as ${host}`);
  console.log('  public/_headers  static pages');
  console.log('  wrangler.toml    the pages the Worker renders');
  console.log('Deploy, then load the site in Tor Browser: it should offer ".onion available".');
} else if (command === 'clear') {
  setHeaders(null);
  setWrangler(null);
  console.log('Onion mirror no longer advertised. Deploy to make that live.');
} else {
  fail('Usage: npm run onion:set <address>.onion   |   npm run onion:clear');
}

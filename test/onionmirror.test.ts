/**
 * The onion mirror's nginx configuration.
 *
 * The config in ops/onion/ is not code this repository runs, so nothing else
 * would notice if somebody tidied a line out of it. Three of those lines are
 * the difference between a private mirror and a broken one, and the checks
 * here are for those three and for the assumption underneath the whole
 * arrangement: that the site never links to itself absolutely.
 *
 * See docs/onion.md.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const CONF = readFileSync(join(ROOT, 'ops/onion/nginx-onion.conf'), 'utf8');
const INSTALL = readFileSync(join(ROOT, 'ops/onion/install.sh'), 'utf8');

/** Comments explain the rules; they are not the rules. */
const directives = CONF.split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
  .join('\n');

describe('the mirror strips what must not cross', () => {
  it('hides Strict-Transport-Security, which the onion cannot honour', () => {
    // The onion is plain http and can never hold a certificate. HSTS would
    // tell the browser to demand one.
    expect(directives).toMatch(/proxy_hide_header\s+Strict-Transport-Security\s*;/i);
  });

  it('hides Onion-Location, so the mirror cannot advertise itself to itself', () => {
    expect(directives).toMatch(/proxy_hide_header\s+Onion-Location\s*;/i);
  });
});

describe('the mirror tells the origin nothing about the visitor', () => {
  it('never sets an X-Forwarded-For or X-Real-IP to a value', () => {
    // Blanking them is fine and is what the config does. Setting them to
    // $remote_addr or $proxy_add_x_forwarded_for would be handing the origin
    // an address the onion exists to withhold -- and on a mirror the only
    // address available is 127.0.0.1, so it would be a lie as well as a leak.
    for (const header of ['X-Forwarded-For', 'X-Real-IP']) {
      const set = new RegExp(`proxy_set_header\\s+${header}\\s+(.+);`, 'gi');
      for (const match of directives.matchAll(set)) {
        expect(match[1].trim(), `${header} must be blanked, not populated`).toBe('""');
      }
    }
  });

  it('keeps no access log', () => {
    expect(directives).toMatch(/access_log\s+off\s*;/);
  });

  it('has no shared cache, which would leak one visitor to another', () => {
    expect(directives).not.toMatch(/proxy_cache\b/);
  });
});

describe('the hop to the origin is a real HTTPS hop', () => {
  it('verifies the origin certificate against a trust store', () => {
    expect(directives).toMatch(/proxy_ssl_verify\s+on\s*;/);
    expect(directives).toMatch(/proxy_ssl_trusted_certificate\s+\S+;/);
  });

  it('sends SNI and the Host the origin routes on', () => {
    expect(directives).toMatch(/proxy_ssl_server_name\s+on\s*;/);
    expect(directives).toMatch(/proxy_ssl_name\s+1999loc\.com\s*;/);
    expect(directives).toMatch(/proxy_set_header\s+Host\s+1999loc\.com\s*;/);
  });

  it('binds to loopback only, because Tor is the only thing allowed in', () => {
    expect(directives).toMatch(/listen\s+127\.0\.0\.1:8080\s*;/);
    expect(directives).not.toMatch(/listen\s+(?!127\.0\.0\.1)/);
  });

  it('is the port the torrc forwards to', () => {
    const torrc = readFileSync(join(ROOT, 'ops/onion/torrc'), 'utf8');
    expect(torrc).toMatch(/^HiddenServicePort\s+80\s+127\.0\.0\.1:8080$/m);
  });
});

describe('the installer', () => {
  it('refuses to leave the hidden service directory readable', () => {
    // Tor will not start if anyone but its own user can read the key, and
    // the failure mode if this line goes missing is a service that silently
    // never comes up.
    expect(INSTALL).toMatch(/chmod\s+700\s+"\$SERVICE_DIR"/);
    expect(INSTALL).toMatch(/chown\s+-R\s+"\$TORUSER:\$TORUSER"/);
  });

  it('removes the stock nginx site, which listens to the world', () => {
    expect(INSTALL).toMatch(/rm\s+-f\s+\/etc\/nginx\/sites-enabled\/default/);
  });
});

describe('the assumption the whole mirror rests on', () => {
  it('finds no absolute self-link in the HTML except canonical and og:url', () => {
    // A hardcoded https://1999loc.com/... link would be a door out of the
    // onion for anyone who clicked it, and a CSP failure for anything the
    // page fetched. canonical and og:url are metadata for search engines and
    // are meant to point at the clearnet original.
    const dir = join(ROOT, 'public');
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.html')) continue;
      const lines = readFileSync(join(dir, name), 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Prose naming the domain is fine and there is a lot of it; what
        // matters is a URL, which needs a scheme or a scheme-relative slash.
        if (!line.includes('//1999loc.com')) return;
        if (line.includes('rel="canonical"') || line.includes('og:url')) return;
        // delete.1999loc.com is a separate application on a separate domain,
        // and is documented as the one tool kept off this one.
        if (line.includes('delete.1999loc.com')) return;
        offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

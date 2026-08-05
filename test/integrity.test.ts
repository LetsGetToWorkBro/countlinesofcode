/**
 * The things that would let somebody else's code run here.
 *
 * The site's whole claim is that your file never leaves the tab. Every tool
 * can be honest and the claim still fails if a script that is not ours ends up
 * executing on this origin, and after the Monero page that stops being an
 * abstract worry: a wallet generator is the one page where a single altered
 * line is worth money to somebody.
 *
 * So this file guards the ways that could happen, in rough order of how likely
 * they are:
 *
 *   1. A vendored library quietly changing. Five third-party bundles are
 *      served from this origin and they are the only outside code that runs.
 *   2. The policy that forbids everything else being loosened by accident.
 *   3. An inline style or script creeping into a page, which is both a CSP
 *      violation and the shape an injection takes.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VENDORED_HASHES } from '../src/lib/vendor-hashes';
import { SECURITY_HEADERS } from '../src/worker/index';

const pages = () => readdirSync('public').filter((n) => n.endsWith('.html'));

describe('the vendored libraries', () => {
  it('are exactly the bytes that were vendored', () => {
    // A mismatch is either an intentional update, in which case run
    // `npm run hash:vendor` and say so in the commit, or something changed
    // public/vendor without going through the vendoring script.
    for (const [file, expected] of Object.entries(VENDORED_HASHES)) {
      const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
      expect(actual, `${file} is not the file that was vendored`).toBe(expected);
    }
  });

  it('covers every executable file in public/vendor', () => {
    // A new library that nobody hashed is a new library nobody is watching.
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        entry.isDirectory() ? walk(full, out) : out.push(full);
      }
      return out;
    };
    const executable = walk('public/vendor').filter((f) => /\.(js|mjs|wasm)$/.test(f)).sort();
    expect(executable).toEqual(Object.keys(VENDORED_HASHES).sort());
  });

  it('has something to check', () => {
    expect(Object.keys(VENDORED_HASHES).length).toBeGreaterThan(4);
  });
});

describe('the policy that keeps everything else out', () => {
  const policy = SECURITY_HEADERS['content-security-policy']!;

  it('permits scripts from this origin and nowhere else', () => {
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toMatch(/script-src[^;]*https?:/);
  });

  it('does not permit eval, only WebAssembly', () => {
    // 'wasm-unsafe-eval' reads alarmingly and is not 'unsafe-eval'. This
    // asserts the difference rather than trusting the comment about it.
    expect(policy).toContain("'wasm-unsafe-eval'");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it('still forbids talking to anywhere else', () => {
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("base-uri 'none'");
  });

  it('carries the isolation headers as well as the policy', () => {
    expect(SECURITY_HEADERS['cross-origin-opener-policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['cross-origin-resource-policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['strict-transport-security']).toMatch(/max-age=\d{7,}/);
    expect(SECURITY_HEADERS['referrer-policy']).toBe('no-referrer');
  });

  it('turns off the browser features this site never uses', () => {
    const permissions = SECURITY_HEADERS['permissions-policy']!;
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial', 'browsing-topics']) {
      expect(permissions, feature).toContain(`${feature}=()`);
    }
  });
});

describe('the pages themselves', () => {
  it('carry no inline styles', () => {
    // Found live: three labels on the counter page had style attributes, which
    // style-src 'self' had been silently refusing since the policy went in.
    // They looked wrong and nothing said so. An inline style is also the shape
    // an injection takes, so the rule is worth keeping rather than relaxing.
    for (const page of pages()) {
      const html = readFileSync(`public/${page}`, 'utf8');
      expect(html.includes(' style="'), `public/${page} has an inline style`).toBe(false);
    }
  });

  it('carry no inline script', () => {
    for (const page of pages()) {
      const html = readFileSync(`public/${page}`, 'utf8');
      // A <script> with a body rather than a src would never execute here.
      expect(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html),
        `public/${page} has an inline script`).toBe(false);
    }
  });

  it('load every script from this origin', () => {
    for (const page of pages()) {
      const html = readFileSync(`public/${page}`, 'utf8');
      for (const match of html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) {
        expect(match[1]!.startsWith('/'), `public/${page} loads ${match[1]} from elsewhere`).toBe(true);
      }
    }
  });

  it('load every stylesheet from this origin', () => {
    for (const page of pages()) {
      const html = readFileSync(`public/${page}`, 'utf8');
      for (const match of html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g)) {
        expect(match[1]!.startsWith('/'), `public/${page} loads ${match[1]} from elsewhere`).toBe(true);
      }
    }
  });
});

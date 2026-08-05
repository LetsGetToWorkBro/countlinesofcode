/**
 * The security headers are written twice: once in the Worker, once in
 * public/_headers for assets the Worker never sees. Two copies of a policy
 * drift, and this one drifted — the Worker gained `font-src 'self'` and the
 * static files did not, so every page the PDF tools actually live on kept the
 * policy that broke them. The failure was invisible: pdf.js substitutes a
 * system font rather than complaining.
 *
 * So the two are compared here rather than asked politely to match.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from '../src/worker/index';

/** The `/*` block of a Cloudflare _headers file, as name -> value. */
function staticHeaders(): Record<string, string> {
  const lines = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8').split('\n');
  const out: Record<string, string> = {};
  let inGlobal = false;
  for (const line of lines) {
    if (line.startsWith('#') || !line.trim()) continue;
    if (!line.startsWith(' ')) {
      inGlobal = line.trim() === '/*';
      continue;
    }
    if (!inGlobal) continue;
    const at = line.indexOf(':');
    out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}

describe('security headers', () => {
  const fromFile = staticHeaders();

  it('gives static assets every header the Worker sets', () => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(fromFile[name], `public/_headers is missing ${name}`).toBe(value);
    }
  });

  it('sets the same content security policy in both places', () => {
    // Called out on its own because it is the one that breaks features rather
    // than merely weakening them.
    expect(fromFile['content-security-policy']).toBe(SECURITY_HEADERS['content-security-policy']);
  });

  it('allows the PDF tools their fonts, images and nothing more', () => {
    const csp = SECURITY_HEADERS['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("font-src 'self'"); // vendored standard-14 font data
    expect(csp).toContain("img-src 'self' data:"); // signature previews
    expect(csp).toContain("script-src 'self'"); // no CDNs, deliberately
    expect(csp).not.toMatch(/(script|font|connect)-src[^;]*\*/);
  });

  it('lets a tool show the image it just made, without a base64 detour', () => {
    // A multi-megabyte GIF as a data: URL is a third larger again and has to be
    // built as a JavaScript string first. blob: names bytes the tab already
    // holds; no remote scheme is admitted.
    const csp = SECURITY_HEADERS['content-security-policy'] ?? '';
    expect(csp).toContain('img-src');
    expect(csp).toMatch(/img-src[^;]*blob:/);
    expect(csp).not.toMatch(/img-src[^;]*(\*|https?:)/);
  });

  it('lets the video tool play the file you opened, and nothing else', () => {
    // Without media-src the <video> preview is refused outright, and a trim
    // control you cannot see through is useless. blob: names data this tab
    // already holds — it reaches no network — so 'self' is deliberately absent
    // as well: no media is served from this origin.
    const csp = SECURITY_HEADERS['content-security-policy'] ?? '';
    expect(csp).toContain('media-src blob:');
    expect(csp).not.toMatch(/media-src[^;]*(\*|https?:)/);
  });

  it('permits WebAssembly without permitting eval', () => {
    // 'wasm-unsafe-eval' lets a same-origin WASM codec (HEIC decode) compile;
    // 'unsafe-eval' — which would also unlock eval() and new Function() — must
    // never appear. The narrow token is the whole point.
    const csp = SECURITY_HEADERS['content-security-policy'] ?? '';
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");
  });
});

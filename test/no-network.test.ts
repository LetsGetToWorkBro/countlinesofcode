/**
 * The claim on the front of this project, checked instead of asserted.
 *
 * The README says the vault has no network code in it. That is the sentence
 * everything else rests on, and it is exactly the sort of sentence that is
 * true when it is written and false eighteen months later, after somebody adds
 * a price lookup "just for the confirmation screen" and nobody rereads the
 * README.
 *
 * So it is a test. It walks the actual source and fails on anything that could
 * open a socket, touch a browser API, or reach the filesystem. It is a coarse
 * check and it is meant to be: the point is not to catch a determined author,
 * it is to make the absence something CI notices, and to make adding one an
 * argument rather than an accident.
 *
 * If a future version genuinely needs one of these, the honest move is to
 * delete the entry here in the same commit and say why. Not to work around it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Every .ts file under src, with its text. */
function sources(dir = 'src'): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (entry.name.endsWith('.ts')) out.push({ path, text: readFileSync(path, 'utf8') });
  }
  return out;
}

/* Shaped so that prose does not match. "A UI that re-fetches" is a sentence in
 * psbt.ts and should stay one; `fetch(` is a call. */
const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  { pattern: /\bfetch\s*\(/, what: 'fetch()' },
  { pattern: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, what: 'WebSocket' },
  { pattern: /\bEventSource\b/, what: 'EventSource' },
  { pattern: /\bnavigator\s*\.\s*[a-zA-Z_]/, what: 'navigator' },
  { pattern: /\b(localStorage|sessionStorage|indexedDB)\b/, what: 'browser storage' },
  { pattern: /\bdocument\s*\.\s*[a-zA-Z_]/, what: 'the DOM' },
  { pattern: /\bwindow\s*\.\s*[a-zA-Z_]/, what: 'window' },
  { pattern: /\bprocess\s*\.\s*[a-zA-Z_]/, what: 'the Node process object' },
  { pattern: /from\s+['"]node:/, what: 'a Node built-in' },
  { pattern: /\brequire\s*\(/, what: 'require()' },
];

describe('the vault has no network code in it', () => {
  const files = sources();

  it('found the source to check, so a passing run means something', () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(8);
    expect(files.some((file) => file.path.includes('psbt'))).toBe(true);
  });

  for (const { pattern, what } of FORBIDDEN) {
    it(`does not reach for ${what}`, () => {
      const guilty = files.filter((file) => pattern.test(file.text)).map((file) => file.path);
      expect(guilty, `${what} appears in these files`).toEqual([]);
    });
  }

  it('depends only on cryptography, never on transport', () => {
    /* The dependency list is part of the same claim. An HTTP client in here
     * would not be caught by the patterns above, because it would arrive as an
     * import of something innocuous-looking. */
    const allowed = /^(@noble\/|@scure\/|\.{1,2}\/)/;
    for (const file of files) {
      for (const match of file.text.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
        expect(match[1], `${file.path} imports ${match[1]}`).toMatch(allowed);
      }
    }
  });
});

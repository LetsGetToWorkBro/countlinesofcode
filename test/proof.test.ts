/**
 * The proof panel.
 *
 * The panel's job is to let a visitor check a claim rather than believe it, so
 * the thing worth testing hardest is that it cannot quietly report good news:
 * a request to another domain has to be called out, an undocumented storage key
 * has to be called out, and a leak that got through has to be called a serious
 * bug in those words rather than softened.
 *
 * There is also a third copy of the Content-Security-Policy now — the panel
 * prints it — and the last test here holds it to the other two. Two copies
 * drifted apart once already and shipped a fix that changed nothing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_STORAGE,
  REPO,
  classify,
  describeNetwork,
  describeStorage,
  hostOf,
  leakVerdict,
  networkNote,
  sourceLink,
  sourcesFor,
  storageVerdict,
  type LeakResult,
} from '../src/client/proof';
import { SECURITY_HEADERS } from '../src/worker/index';

const request = (url: string, kind = 'fetch') => ({ url, kind });

describe('hostOf', () => {
  it('reads the host out of a URL', () => {
    expect(hostOf('https://1999loc.com/video.js')).toBe('1999loc.com');
    expect(hostOf('https://evil.example:8443/x')).toBe('evil.example:8443');
  });

  it('is empty rather than throwing on nonsense', () => {
    expect(hostOf('')).toBe('');
    expect(hostOf('   ')).toBe('');
    expect(hostOf('not a url')).toBe('');
  });

  it('does not hand back the base host for an empty URL', () => {
    // new URL('', base) succeeds and returns the base's host, which would make
    // a blank entry look like it belonged here — the wrong way to be wrong in
    // a panel whose job is spotting requests that went somewhere unexpected.
    expect(hostOf('', 'https://1999loc.com')).toBe('');
  });

  it('resolves a relative URL against the page it came from', () => {
    expect(hostOf('/video.js', 'https://1999loc.com')).toBe('1999loc.com');
  });
});

describe('classify', () => {
  const origin = 'https://1999loc.com';

  it('separates this site from everywhere else', () => {
    const audit = classify(
      [request('https://1999loc.com/a.js'), request('https://tracker.example/beacon')],
      origin,
    );
    expect(audit.own).toHaveLength(1);
    expect(audit.foreign).toHaveLength(1);
  });

  it('ignores data: and blob:, which never touch the network', () => {
    // Counting them would inflate the number; calling them foreign would be a
    // false alarm on every tool that previews a file.
    const audit = classify([request('data:image/png;base64,AAAA'), request('blob:https://1999loc.com/abc')], origin);
    expect(audit.own).toHaveLength(0);
    expect(audit.foreign).toHaveLength(0);
  });

  it('treats a subdomain as somewhere else, because it is', () => {
    expect(classify([request('https://cdn.1999loc.com/x.js')], origin).foreign).toHaveLength(1);
  });

  it('counts a relative URL as ours, because it is', () => {
    expect(classify([request('/video.js')], origin).own).toHaveLength(1);
  });

  it('has nothing to say about nothing', () => {
    expect(classify([], origin)).toEqual({ own: [], foreign: [] });
  });
});

describe('describeNetwork', () => {
  it('says plainly when everything stayed put', () => {
    const audit = classify([request('https://1999loc.com/a.js')], 'https://1999loc.com');
    expect(describeNetwork(audit, '1999loc.com')).toMatch(/Nothing has been sent anywhere else/);
  });

  it('raises the alarm rather than burying it', () => {
    // The panel exists to catch this case. It must not read like a footnote.
    const audit = classify([request('https://tracker.example/x')], 'https://1999loc.com');
    const line = describeNetwork(audit, '1999loc.com');
    expect(line).toMatch(/should never happen/i);
    expect(line).toMatch(/report it/i);
  });

  it('counts in the singular when there is one', () => {
    const audit = classify([request('https://1999loc.com/a.js')], 'https://1999loc.com');
    expect(describeNetwork(audit, '1999loc.com')).toContain('1 request,');
  });
});

describe('storage', () => {
  it('explains every key this site is known to write', () => {
    const things = describeStorage(Object.keys(KNOWN_STORAGE).map((key) => ({ key, size: 100 })));
    expect(things.every((t) => t.purpose)).toBe(true);
  });

  it('flags a key nobody documented rather than explaining it away', () => {
    // A key here that is not on the list would mean something is storing data
    // that was never written down. That is the interesting case.
    const things = describeStorage([{ key: 'mystery-tracker-id', size: 40 }]);
    expect(things[0]!.purpose).toBeNull();
    expect(storageVerdict(things)).toMatch(/worth reporting/i);
  });

  it('recognises the shell\'s own per-program flags instead of accusing them', () => {
    // loc1999:seen/read/warned are written by the first-run dialog, the
    // dismiss-a-note code and the one-time warnings. Before prefix matching,
    // the honest-arbiter panel red-flagged them as "worth reporting" the moment
    // you dismissed the auto-opening first-run dialog — accusing the site's own
    // UI state.
    const things = describeStorage([
      { key: 'loc1999:seen:audio', size: 4 },
      { key: 'loc1999:read:zip:1a2b', size: 2 },
      { key: 'loc1999:warned:send', size: 1 },
    ]);
    expect(things.every((t) => t.purpose), 'a shell flag went undocumented').toBe(true);
    expect(storageVerdict(things)).not.toMatch(/report/i);
  });

  it('says nothing is stored when nothing is', () => {
    expect(storageVerdict([])).toMatch(/stored no data/i);
  });

  it('describes a normal keyring without alarm', () => {
    const things = describeStorage([{ key: 'loc1999:pgp-keys', size: 2000 }]);
    expect(storageVerdict(things)).not.toMatch(/report/i);
    expect(storageVerdict(things)).toMatch(/delete them/i);
  });

  it('says what the keys actually hold, including the uncomfortable one', () => {
    // The PGP entry has to admit a private key may be in there.
    expect(KNOWN_STORAGE['loc1999:pgp-keys']).toMatch(/private key/i);
    expect(KNOWN_STORAGE['loc1999:convert-profiles']).toMatch(/no document text/i);
  });
});

describe('leakVerdict', () => {
  const blocked = (route: string): LeakResult => ({ route, outcome: 'blocked', detail: 'refused' });

  it('is satisfied only when nothing got out', () => {
    const verdict = leakVerdict([blocked('fetch()'), blocked('an image URL')]);
    expect(verdict.ok).toBe(true);
    expect(verdict.summary).toMatch(/All 2 attempts failed/);
  });

  it('counts how many the browser itself refused, which is the strong evidence', () => {
    const results: LeakResult[] = [blocked('fetch()'), { route: 'x', outcome: 'failed', detail: '' }];
    expect(leakVerdict(results).summary).toMatch(/1 of them were refused by your browser/);
  });

  it('calls a leak a serious bug, in those words', () => {
    // Softening this would defeat the whole panel.
    const verdict = leakVerdict([{ route: 'fetch()', outcome: 'sent', detail: 'it went' }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.summary).toMatch(/serious bug/i);
    expect(verdict.summary).toMatch(/report it/i);
  });
});

describe('sources', () => {
  it('points at the files behind the tool, not just the repository', () => {
    expect(sourcesFor('/video.html')).toContain('src/client/video.ts');
    // PGP folded into the encrypt page; its sources moved with it.
    expect(sourcesFor('/lock.html')).toContain('src/client/pgpkit.ts');
    expect(sourcesFor('/lock.html')).toContain('public/pgp-page.js');
  });

  it('falls back rather than showing nothing', () => {
    expect(sourcesFor('/nowhere.html').length).toBeGreaterThan(0);
  });

  it('builds a link that lands on the file', () => {
    expect(sourceLink('src/client/video.ts')).toBe(`${REPO}/blob/main/src/client/video.ts`);
  });

  it('names files that actually exist', () => {
    // A proof panel linking to a file that is not there would be worse than
    // not linking at all.
    for (const path of ['/video.html', '/zip.html', '/pages.html', '/lock.html', '/pgp.html', '/convert.html',
                        '/inspect.html', '/sheet.html', '/sign.html', '/image.html', '/unlock.html',
                        '/shrink.html', '/code.html', '/nowhere.html']) {
      for (const file of sourcesFor(path)) {
        expect(() => readFileSync(file), `${path} points at missing ${file}`).not.toThrow();
      }
    }
  });
});

describe('networkNote', () => {
  it('admits the pages that do use the server', () => {
    // The counter is the honest exception. Pretending otherwise would make
    // every other claim on the site worth less.
    expect(networkNote('/code.html')).toMatch(/fetching it/i);
    expect(networkNote('/golf')).toBeTruthy();
  });

  it('has nothing to add for a tool that genuinely stays put', () => {
    expect(networkNote('/video.html')).toBeNull();
    expect(networkNote('/lock.html')).toBeNull();
  });
});

describe('the policy the panel prints', () => {
  /* There are three copies now: the Worker's headers, public/_headers for the
     static assets, and the string the panel shows a visitor. The first two
     drifted apart once and shipped a "fix" that changed nothing live; a third
     copy that lies to someone checking a privacy claim would be worse. */
  const panelPolicy = (): string => {
    const source = readFileSync('public/proof-panel.js', 'utf8');
    const match = /var POLICY = ([\s\S]*?);\n/.exec(source);
    if (!match) throw new Error('the panel no longer declares a POLICY string');
    // The string is written as concatenated literals for line length.
    return [...match[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
  };

  it('is exactly what the Worker sends', () => {
    expect(panelPolicy()).toBe(SECURITY_HEADERS['content-security-policy']);
  });

  it('is exactly what the static assets send', () => {
    const headers = readFileSync('public/_headers', 'utf8');
    const served = /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1]?.trim();
    expect(panelPolicy()).toBe(served);
  });

  it('still forbids the things the panel tells people it forbids', () => {
    const policy = panelPolicy();
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("default-src 'none'");
  });
});

describe('the panel is actually on the pages', () => {
  const pages = readdirSync('public').filter((n) => n.endsWith('.html'));

  it('is on every tool page', () => {
    // A proof panel nobody can reach proves nothing.
    for (const page of pages) {
      if (page === 'index.html') continue;
      const html = readFileSync(`public/${page}`, 'utf8');
      expect(html, `public/${page} has no proof panel`).toContain('proof-panel.js');
      expect(html, `public/${page} has nowhere to put it`).toContain('id="proof"');
    }
  });

  it('is not on the landing page, which stays readable with no JavaScript', () => {
    // The landing page carries only the desktop scripts, every one of them
    // pure enhancement, and no proof panel, because the page makes no claims a
    // panel would need to prove.
    const landing = readFileSync('public/index.html', 'utf8');
    const scripts = [...landing.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual(['/desk.js', '/start.js', '/firstrun.js', '/dismiss.js']);
    expect(landing).not.toContain('proof-panel.js');
  });

  it('is mounted before the script that fills it', () => {
    // The panel bails out silently if its mount point is missing, so the order
    // matters and a page with them the wrong way round would show nothing.
    for (const page of pages) {
      if (page === 'index.html') continue;
      const html = readFileSync(`public/${page}`, 'utf8');
      expect(html.indexOf('id="proof"'), page).toBeLessThan(html.indexOf('proof-panel.js'));
    }
  });
});

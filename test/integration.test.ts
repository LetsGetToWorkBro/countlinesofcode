/**
 * End-to-end tests against the Worker's fetch handler with a recorded GitHub
 * fixture. No live network: `globalThis.fetch` is replaced for the duration.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/env';
import { CountResultSchema, type CountResult } from '../src/lib/schema';
import {
  SAMPLE_EXPECTED,
  SAMPLE_REPO,
  fakeCtx,
  fakeKv,
  installFakeGitHub,
  type FakeGitHub,
} from './fixtures/fake-github';

let github: FakeGitHub;
let env: Env;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    LOC_KV: fakeKv(),
    APP_BASE_URL: 'https://loc.example',
    MAX_BLOB_FETCHES: '40',
    RATE_LIMIT_PER_MINUTE: '100',
    CANONICAL_ORIGIN: 'https://loc.example',
    ...overrides,
  };
}

function makeRequest(path: string, init: RequestInit): Request {
  return new Request(`https://loc.example${path}`, {
    headers: { 'cf-connecting-ip': '203.0.113.7', ...(init.headers ?? {}) },
    ...init,
  });
}

async function call(path: string, init: RequestInit = {}, useEnv: Env = env) {
  const ctx = fakeCtx();
  const response = await worker.fetch(makeRequest(path, init), useEnv, ctx);
  await ctx.settled();
  return response;
}

/**
 * Streaming endpoints must be drained *while* the background work runs — the
 * response body is the only consumer of the writer, so settling first would
 * deadlock. Real clients read concurrently; this mirrors that.
 */
async function callStream(path: string, useEnv: Env = env): Promise<{ response: Response; text: string }> {
  const ctx = fakeCtx();
  const response = await worker.fetch(makeRequest(path, {}), useEnv, ctx);
  const text = response.body ? await response.text() : '';
  await ctx.settled();
  return { response, text };
}

async function countJson(path: string, useEnv: Env = env): Promise<CountResult> {
  const response = await call(path, {}, useEnv);
  const body = (await response.json()) as CountResult;
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

beforeEach(() => {
  github = installFakeGitHub([SAMPLE_REPO]);
  env = makeEnv();
});

afterEach(() => {
  github.restore();
});

describe('GET /api/count/:owner/:repo', () => {
  it('counts the fixture repository correctly', async () => {
    const result = await countJson('/api/count/acme/widget');

    expect(CountResultSchema.safeParse(result).success).toBe(true);
    expect(result.totals).toMatchObject(SAMPLE_EXPECTED);
    expect(result.totals.code + result.totals.comment + result.totals.blank).toBe(result.totals.lines);
    expect(result.sha).toBe(SAMPLE_REPO.sha);
    expect(result.ref).toBe('main');
    expect(result.default_branch).toBe('main');
    expect(result.cached).toBe(false);
    expect(result.strategy).toBe('blobs');
  });

  it('reports skipped files by reason', async () => {
    const result = await countJson('/api/count/acme/widget');
    expect(result.skipped.vendored).toBe(2); // node_modules/, dist/
    expect(result.skipped.generated).toBe(1); // package-lock.json
    expect(result.skipped.binary).toBe(1); // assets/logo.png
  });

  it('breaks results down by language', async () => {
    const result = await countJson('/api/count/acme/widget');
    const languages = Object.fromEntries(result.by_language.map((row) => [row.language, row]));
    expect(languages['TypeScript']).toMatchObject({ files: 2, code: 4, comment: 2, blank: 1 });
    expect(languages['Python']).toMatchObject({ files: 1, code: 2, comment: 1, blank: 1 });
    expect(languages['JSON']).toMatchObject({ files: 1, code: 3, comment: 0 });
    expect(result.languages_without_comment_rules).toContain('JSON');
  });

  it('counts lockfiles when asked', async () => {
    const base = await countJson('/api/count/acme/widget');
    const withLocks = await countJson('/api/count/acme/widget?lockfiles=1');
    expect(withLocks.totals.files).toBe(base.totals.files + 1);
    expect(withLocks.skipped.generated).toBe(0);
  });

  it('counts vendored directories when asked', async () => {
    const withVendor = await countJson('/api/count/acme/widget?vendored=1');
    expect(withVendor.totals.files).toBeGreaterThan(SAMPLE_EXPECTED.files);
    expect(withVendor.skipped.vendored).toBe(0);
  });

  it('validates the ref parameter', async () => {
    const response = await call('/api/count/acme/widget?ref=..%2F..%2Fetc');
    expect(response.status).toBe(400);
  });

  it('rejects a malformed owner', async () => {
    const response = await call('/api/count/-bad/widget');
    expect(response.status).toBe(400);
  });
});

describe('caching', () => {
  it('serves the second identical count from KV', async () => {
    const first = await countJson('/api/count/acme/widget');
    expect(first.cached).toBe(false);
    const before = github.requests.length;

    const second = await countJson('/api/count/acme/widget');
    expect(second.cached).toBe(true);
    expect(second.totals).toEqual(first.totals);

    // Only the repo lookup happens again; the tree and blobs come from cache.
    expect(github.requests.length - before).toBeLessThanOrEqual(2);
  });

  it('keys the cache on the option flags', async () => {
    await countJson('/api/count/acme/widget');
    const other = await countJson('/api/count/acme/widget?lockfiles=1');
    expect(other.cached).toBe(false);
  });

  it('recounts when fresh=1', async () => {
    await countJson('/api/count/acme/widget');
    const fresh = await countJson('/api/count/acme/widget?fresh=1');
    expect(fresh.cached).toBe(false);
  });

  it('serves a cached sha with no GitHub requests at all', async () => {
    await countJson('/api/count/acme/widget');
    const before = github.requests.length;

    const bySha = await countJson(`/api/count/acme/widget?ref=${SAMPLE_REPO.sha}`);
    expect(bySha.cached).toBe(true);
    // Shared /r/ links must not spend rate-limit quota.
    expect(github.requests.length).toBe(before);
  });

  it('still authorises private repositories on the cached fast path', async () => {
    github.restore();
    github = installFakeGitHub([{ ...SAMPLE_REPO, private: true }]);

    const first = await countJson('/api/count/acme/widget', makeEnv());
    expect(first.repo_meta.private).toBe(true);

    // Same KV, but the repo is now unreachable for this caller: the fast path
    // must not hand back the cached private result.
    const sharedEnv = env;
    await countJson('/api/count/acme/widget', sharedEnv).catch(() => undefined);
    github.restore();
    github = installFakeGitHub([]); // caller can no longer see the repo

    const response = await call(`/api/count/acme/widget?ref=${SAMPLE_REPO.sha}`, {}, sharedEnv);
    expect(response.status).toBe(404);
  });

  it('caches under the immutable sha, so a sha request hits the branch entry', async () => {
    const branch = await countJson('/api/count/acme/widget');
    const bySha = await countJson(`/api/count/acme/widget?ref=${branch.sha}`);
    expect(bySha.cached).toBe(true);
    expect(bySha.totals).toEqual(branch.totals);
  });
});

describe('tarball strategy', () => {
  it('produces identical totals to the blob strategy', async () => {
    const viaBlobs = await countJson('/api/count/acme/widget');

    const tarEnv = makeEnv({ MAX_BLOB_FETCHES: '1' });
    const viaTarball = await countJson('/api/count/acme/widget', tarEnv);

    expect(viaTarball.strategy).toBe('tarball');
    expect(viaTarball.totals).toEqual(viaBlobs.totals);
    expect(viaTarball.by_language).toEqual(viaBlobs.by_language);
  });

  it('falls back to the archive and warns when the tree is truncated', async () => {
    github.restore();
    github = installFakeGitHub([{ ...SAMPLE_REPO, truncated: true }]);

    const result = await countJson('/api/count/acme/widget', makeEnv());
    expect(result.strategy).toBe('tarball');
    expect(result.limits.tree_truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/truncated/i);
    expect(result.totals).toMatchObject(SAMPLE_EXPECTED);
  });
});

describe('POST /api/count', () => {
  it('accepts a full GitHub URL', async () => {
    const response = await call('/api/count', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/acme/widget' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as CountResult;
    expect(body.full_name).toBe('acme/widget');
  });

  it('accepts owner + repo', async () => {
    const response = await call('/api/count', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'acme', repo: 'widget', ref: 'main' }),
    });
    expect(response.status).toBe(200);
  });

  it('rejects a non-GitHub URL', async () => {
    const response = await call('/api/count', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://gitlab.com/a/b' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_input');
  });

  it('rejects an empty body', async () => {
    const response = await call('/api/count', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(400);
  });

  it('rejects non-JSON', async () => {
    const response = await call('/api/count', { method: 'POST', body: 'not json' });
    expect(response.status).toBe(400);
  });
});

describe('errors', () => {
  it('maps a missing repository to 404 with a hint', async () => {
    const response = await call('/api/count/acme/nope');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; hint?: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.hint).toMatch(/private/i);
  });

  it('maps a GitHub rate limit to 429', async () => {
    github.failNext(403, 'API rate limit exceeded');
    const response = await call('/api/count/acme/widget');
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string; hint?: string } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.hint).toMatch(/resets in about 60s/);
  });

  it('rate limits anonymous callers per IP', async () => {
    const limited = makeEnv({ RATE_LIMIT_PER_MINUTE: '1' });
    const first = await call('/api/count/acme/widget', {}, limited);
    expect(first.status).toBe(200);
    const second = await call('/api/count/acme/widget', {}, limited);
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');
  });

  it('404s unknown API endpoints', async () => {
    const response = await call('/api/nope');
    expect(response.status).toBe(404);
  });
});

describe('GET /api/stream (server-sent events)', () => {
  it('emits progress then a result event', async () => {
    const { response, text } = await callStream('/api/stream?input=acme/widget');
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    expect(text).toContain('event: progress');
    expect(text).toContain('event: result');

    const resultLine = text
      .split('\n\n')
      .map((chunk) => chunk.split('\n'))
      .find((lines) => lines[0] === 'event: result');
    expect(resultLine).toBeDefined();
    const payload = JSON.parse(resultLine![1]!.slice('data: '.length)) as CountResult;
    expect(payload.totals).toMatchObject(SAMPLE_EXPECTED);
  });

  it('emits a failure event for a missing repository', async () => {
    const { text } = await callStream('/api/stream?input=acme/missing');
    expect(text).toContain('event: failure');
    expect(text).toContain('not_found');
  });

  it('rejects an invalid input without opening a stream', async () => {
    const response = await call('/api/stream?input=https://gitlab.com/a/b');
    expect(response.status).toBe(400);
  });
});

describe('GET /r/:owner/:repo/:sha', () => {
  it('renders a shareable HTML result page', async () => {
    const response = await call(`/r/acme/widget/${SAMPLE_REPO.sha}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('acme/widget');
    expect(html).toContain('Total lines');
    expect(html).toContain(String(SAMPLE_EXPECTED.lines));
    expect(html).toContain('How we count');
  });

  it('rejects a non-sha path segment', async () => {
    const response = await call('/r/acme/widget/not-a-sha');
    expect(response.status).toBe(400);
  });

  it('sets security headers', async () => {
    const response = await call(`/r/acme/widget/${SAMPLE_REPO.sha}`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('lets the PDF tools load their own font data', async () => {
    // Without font-src the standard-14 fonts are refused and pdf.js quietly
    // substitutes a system font — which then gets baked into any flattened
    // page. It fails silently, so it needs a test rather than an eyeball.
    const csp = (await call('/')).headers.get('content-security-policy') ?? '';
    expect(csp).toContain("font-src 'self'");
    expect(csp).not.toContain('font-src *');
  });
});

describe('GET /api/meta', () => {
  it('reports limits and versions', async () => {
    const response = await call('/api/meta');
    const body = (await response.json()) as {
      counter_version: string;
      oauth_available: boolean;
      limits: { max_files: number };
    };
    expect(body.counter_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.oauth_available).toBe(false);
    expect(body.limits.max_files).toBeGreaterThan(0);
  });
});

describe('auth endpoints', () => {
  it('reports unauthenticated when no session cookie is present', async () => {
    const response = await call('/api/auth/me');
    const body = (await response.json()) as { authenticated: boolean };
    expect(body.authenticated).toBe(false);
  });

  it('refuses the repo list without a session', async () => {
    const response = await call('/api/auth/repos');
    expect(response.status).toBe(401);
  });

  it('returns 501 for login when OAuth is unconfigured', async () => {
    const response = await call('/api/auth/login');
    expect(response.status).toBe(501);
  });

  it('redirects to GitHub when OAuth is configured', async () => {
    const configured = makeEnv({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'secret' });
    const response = await call('/api/auth/login', {}, configured);
    expect(response.status).toBe(302);
    const location = response.headers.get('location')!;
    expect(location.startsWith('https://github.com/login/oauth/authorize')).toBe(true);
    expect(location).toContain('state=');
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
  });

  it('rejects a callback with a mismatched state', async () => {
    const configured = makeEnv({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'secret' });
    const response = await call(
      '/api/auth/callback?code=abc&state=deadbeef',
      { headers: { cookie: 'loc_state=somethingelse' } },
      configured,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('error=');
  });
});

describe('SSRF posture', () => {
  it('never contacts a host other than GitHub', async () => {
    await countJson('/api/count/acme/widget');
    const tarEnv = makeEnv({ MAX_BLOB_FETCHES: '1' });
    await countJson('/api/count/acme/widget', tarEnv);
    for (const url of github.requests) {
      expect(new URL(url).hostname).toMatch(/^(api|codeload)\.github\.com$/);
    }
  });
});

describe('oversized repositories', () => {
  it('refuses before fetching content, with a specific message', async () => {
    // Budget below the fixture's size: the guard must fire on the tree alone.
    const tiny = makeEnv({ MAX_COUNT_BYTES: '10' });
    const response = await call('/api/count/acme/widget', {}, tiny);

    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string; message: string; hint?: string } };
    expect(body.error.code).toBe('too_large');
    expect(body.error.message).toMatch(/countable text/);
    expect(body.error.message).toMatch(/s of CPU/);
    expect(body.error.hint).toMatch(/browser/i);
  });

  it('does not fetch any blobs when refusing', async () => {
    const tiny = makeEnv({ MAX_COUNT_BYTES: '10' });
    const before = github.requests.length;
    await call('/api/count/acme/widget', {}, tiny);
    const made = github.requests.slice(before);
    // repo + sha + tree only: no blob or tarball request.
    expect(made.some((u) => u.includes('/git/blobs/') || u.includes('/tarball/'))).toBe(false);
  });

  it('reports the guard in /api/meta', async () => {
    const response = await call('/api/meta');
    const body = (await response.json()) as { limits: { max_count_bytes: number } };
    expect(body.limits.max_count_bytes).toBeGreaterThan(0);
  });
});

describe('browser counting support', () => {
  it('resolves a repository from free-form input without counting', async () => {
    const before = github.requests.length;
    const response = await call('/api/resolve?input=https://github.com/acme/widget');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sha: string; full_name: string; repo_meta: { stars: number } };
    expect(body.sha).toBe(SAMPLE_REPO.sha);
    expect(body.full_name).toBe('acme/widget');
    expect(body.repo_meta.stars).toBeGreaterThan(0);

    // Resolve must not fetch a tree, blobs or the archive.
    const made = github.requests.slice(before);
    expect(made.some((u) => u.includes('/git/trees/') || u.includes('/git/blobs/') || u.includes('/tarball/'))).toBe(false);
  });

  it('rejects a non-GitHub input on resolve', async () => {
    const response = await call('/api/resolve?input=https://gitlab.com/a/b');
    expect(response.status).toBe(400);
  });

  it('streams the archive for a pinned sha', async () => {
    const response = await call(`/api/archive/acme/widget/${SAMPLE_REPO.sha}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('gzip');
    const bytes = new Uint8Array(await response.arrayBuffer());
    // gzip magic number: the real archive, streamed through untouched.
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });

  it('refuses an archive request without a valid sha', async () => {
    expect((await call('/api/archive/acme/widget/main')).status).toBe(400);
    expect((await call('/api/archive/acme/widget')).status).toBe(400);
    expect((await call('/api/archive/-bad/widget/' + SAMPLE_REPO.sha)).status).toBe(400);
  });

  it('rate limits the archive endpoint like everything else', async () => {
    const limited = makeEnv({ RATE_LIMIT_PER_MINUTE: '1' });
    expect((await call(`/api/archive/acme/widget/${SAMPLE_REPO.sha}`, {}, limited)).status).toBe(200);
    expect((await call(`/api/archive/acme/widget/${SAMPLE_REPO.sha}`, {}, limited)).status).toBe(429);
  });
});

describe('renamed repositories', () => {
  // GitHub 301s /repos/facebook/react to /repos/react/react, on api.github.com
  // itself, before the archive request ever reaches codeload.
  beforeEach(() => {
    github.restore();
    github = installFakeGitHub([{ ...SAMPLE_REPO, renamedFrom: ['old/widget'] }]);
  });

  it('streams the archive through an api.github.com redirect', async () => {
    const response = await call(`/api/archive/old/widget/${SAMPLE_REPO.sha}`);
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });

  it('never sends the token to the archive host', async () => {
    await call(`/api/archive/old/widget/${SAMPLE_REPO.sha}`, {}, makeEnv({ GITHUB_TOKEN: 'ghp_secret' }));
    const authByHost = github.authHeaders;
    expect(authByHost.some((h) => h.host === 'codeload.github.com' && h.authorization !== null)).toBe(false);
    expect(authByHost.some((h) => h.host === 'api.github.com' && h.authorization !== null)).toBe(true);
  });
});

describe('search engine plumbing', () => {
  it('lists the static pages in the sitemap', async () => {
    const response = await call('/sitemap.xml');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('xml');
    const xml = await response.text();
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<loc>https://loc.example/</loc>');
    expect(xml).toContain('<loc>https://loc.example/how.html</loc>');
  });

  it('adds result pages to the sitemap once they are cached', async () => {
    const before = await (await call('/sitemap.xml')).text();
    expect(before).not.toContain('/r/acme/widget/');

    await countJson('/api/count/acme/widget');

    const after = await (await call('/sitemap.xml')).text();
    expect(after).toContain(`<loc>https://loc.example/r/acme/widget/${SAMPLE_REPO.sha}</loc>`);
    expect(after).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  });

  it('never advertises a URL that is not already cached', async () => {
    // Every /r/ URL in the sitemap must render from cache, so crawling costs
    // no GitHub quota.
    await countJson('/api/count/acme/widget');
    const xml = await (await call('/sitemap.xml')).text();
    const locs = [...xml.matchAll(/<loc>([^<]+\/r\/[^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(locs.length).toBeGreaterThan(0);

    for (const loc of locs) {
      const before = github.requests.length;
      const page = await call(new URL(loc).pathname);
      expect(page.status).toBe(200);
      expect(github.requests.length).toBe(before);
    }
  });

  it('advertises the canonical casing, matching each page\'s canonical tag', async () => {
    github.restore();
    github = installFakeGitHub([{ ...SAMPLE_REPO, owner: 'Acme', repo: 'Widget' }]);

    // Request it in lowercase, the way a user might type it.
    await countJson('/api/count/acme/widget');
    const xml = await (await call('/sitemap.xml')).text();
    expect(xml).toContain(`/r/Acme/Widget/${SAMPLE_REPO.sha}`);
    expect(xml).not.toContain(`/r/acme/widget/${SAMPLE_REPO.sha}`);

    // And the page that URL points at agrees.
    const html = await (await call(`/r/Acme/Widget/${SAMPLE_REPO.sha}`)).text();
    expect(html).toContain(`<link rel="canonical" href="https://loc.example/r/Acme/Widget/${SAMPLE_REPO.sha}">`);
  });

  it('does not list option variants twice', async () => {
    await countJson('/api/count/acme/widget');
    await countJson('/api/count/acme/widget?lockfiles=1');
    const xml = await (await call('/sitemap.xml')).text();
    const count = [...xml.matchAll(/\/r\/acme\/widget\//g)].length;
    expect(count).toBe(1);
  });

  it('gives result pages a descriptive title and canonical URL', async () => {
    await countJson('/api/count/acme/widget');
    const html = await (await call(`/r/acme/widget/${SAMPLE_REPO.sha}`)).text();
    expect(html).toMatch(/<title>acme\/widget — [\d,]+ lines of code · LOC\.1999<\/title>/);
    expect(html).toContain(`<link rel="canonical" href="https://loc.example/r/acme/widget/${SAMPLE_REPO.sha}">`);
    expect(html).toContain('<meta property="og:title"');
  });

  it('keeps error pages out of the index', async () => {
    const html = await (await call('/r/acme/widget/not-a-sha')).text();
    expect(html).toContain('<meta name="robots" content="noindex">');
  });
});

describe('www handling', () => {
  async function get(url: string, useEnv: Env = env) {
    const ctx = fakeCtx();
    const response = await worker.fetch(new Request(url, { headers: { 'cf-connecting-ip': '203.0.113.7' } }), useEnv, ctx);
    await ctx.settled();
    return response;
  }

  it('301s www to the apex, keeping path and query', async () => {
    const response = await get('https://www.loc.example/r/acme/widget/' + SAMPLE_REPO.sha + '?lockfiles=1');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(
      `https://loc.example/r/acme/widget/${SAMPLE_REPO.sha}?lockfiles=1`,
    );
  });

  it('serves the apex normally', async () => {
    const response = await get('https://loc.example/api/meta');
    expect(response.status).toBe(200);
  });

  it('301s the retired /pdf.html to the editor', async () => {
    // The merge/split page is gone; its links must not 404.
    const response = await get('https://loc.example/pdf.html');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://loc.example/sign.html');
  });

  it('leaves other hosts alone, so workers.dev and previews keep working', async () => {
    for (const host of ['loc1999.someone.workers.dev', '1a2b3c-loc1999.someone.workers.dev', 'localhost:8787']) {
      const response = await get(`https://${host}/api/meta`);
      expect(response.status, host).toBe(200);
    }
  });

  it('does nothing when no canonical origin is configured', async () => {
    const noCanonical = makeEnv({ CANONICAL_ORIGIN: undefined });
    const response = await get('https://www.loc.example/api/meta', noCanonical);
    expect(response.status).toBe(200);
  });
});

describe('GitHub connection privileges', () => {
  it('never requests private-repo access by default', async () => {
    const configured = makeEnv({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'secret' });
    const response = await call('/api/auth/login', {}, configured);
    const location = new URL(response.headers.get('location')!);
    const scope = location.searchParams.get('scope');

    expect(scope).toBe('read:user');
    // `repo` is read AND write on every private repository. It must never be
    // requested unless a deployment explicitly opts in.
    expect(scope).not.toContain('repo');
  });

  it('omits the scope entirely in GitHub App mode', async () => {
    const app = makeEnv({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'secret', GITHUB_OAUTH_SCOPES: '' });
    const response = await call('/api/auth/login', {}, app);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.has('scope')).toBe(false);
  });

  it('honours an explicit opt-in to private repositories', async () => {
    const optedIn = makeEnv({
      GITHUB_CLIENT_ID: 'cid',
      GITHUB_CLIENT_SECRET: 'secret',
      GITHUB_OAUTH_SCOPES: 'read:user repo',
    });
    const response = await call('/api/auth/login', {}, optedIn);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('scope')).toBe('read:user repo');
  });

  it('tells the page what will be requested, before any click', async () => {
    const configured = makeEnv({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'secret' });
    const body = (await (await call('/api/auth/me', {}, configured)).json()) as {
      scopes: string | null;
      private_repos: boolean;
    };
    expect(body.scopes).toBe('read:user');
    expect(body.private_repos).toBe(false);
  });

  it('reports the running commit so the deployed build can be checked', async () => {
    const built = makeEnv({ SOURCE_COMMIT: 'abc1234' });
    const body = (await (await call('/api/meta', {}, built)).json()) as { source_commit: string | null };
    expect(body.source_commit).toBe('abc1234');
  });

  it('only ever issues GET requests to GitHub', async () => {
    // The security page claims the app never writes. Hold it to that.
    await countJson('/api/count/acme/widget');
    const methods = github.methods;
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m) => m === 'GET')).toBe(true);
  });
});

describe('oversized repositories, from a user\'s point of view', () => {
  const tiny = () => makeEnv({ MAX_COUNT_BYTES: '10' });

  it('tells the visitor what to do, not the operator', async () => {
    const body = (await (await call('/api/count/acme/widget', {}, tiny())).json()) as {
      error: { hint: string };
    };
    // The hint is shown to visitors, so it must not name internal config.
    expect(body.error.hint).not.toMatch(/MAX_COUNT_BYTES/);
    expect(body.error.hint).toMatch(/browser/i);
  });

  it('offers a way forward on a shared link instead of dead-ending', async () => {
    const html = await (await call(`/r/acme/widget/${SAMPLE_REPO.sha}`, {}, tiny())).text();
    expect(html).toContain('Count it in my browser');
    // Pre-filled, so the front page starts on the right repository.
    expect(html).toContain('href="/?repo=acme%2Fwidget"');
  });

  it('still explains the actual numbers', async () => {
    const html = await (await call(`/r/acme/widget/${SAMPLE_REPO.sha}`, {}, tiny())).text();
    expect(html).toMatch(/countable text/);
    expect(html).toMatch(/s of CPU/);
  });
});

describe('the landing page', () => {
  it('forwards counter links that still point at "/"', async () => {
    // Golf pages, screenshots and bookmarks all carry /?challenge= and /?repo=
    // from when the counter lived at the root. Dropping the query would land
    // people on a page with no form on it.
    for (const query of ['?repo=acme/widget', '?challenge=markdown', '?repo=a/b&ref=main']) {
      const response = await call('/' + query);
      expect(response.status, query).toBe(302);
      const to = new URL(response.headers.get('location')!);
      expect(to.pathname, query).toBe('/code.html');
      expect(to.search, query).toBe(query);
    }
  });

  it('lists both the landing page and the counter in the sitemap', async () => {
    const xml = await (await call('/sitemap.xml')).text();
    expect(xml).toContain('<loc>https://loc.example/</loc>');
    expect(xml).toContain('<loc>https://loc.example/code.html</loc>');
  });
});

describe('the standings', () => {
  it('lists a repository counted through the page', async () => {
    await callStream('/api/stream?input=acme/widget');
    const html = await (await call('/board')).text();
    expect(html).toContain('The Standings');
    expect(html).toContain('acme/widget');
  });

  it('ignores repositories counted through the API', async () => {
    // The board is what people looked up here, not what a script walked through.
    await countJson('/api/count/acme/widget');
    const body = (await (await call('/api/board')).json()) as {
      counted: number;
      boards: { rows: unknown[] }[];
    };
    expect(body.counted).toBe(0);
    expect(body.boards.every((b) => b.rows.length === 0)).toBe(true);
  });

  it('promotes an API-counted repository once somebody visits it', async () => {
    // The page count is a cache hit, so nothing would be rewritten without help.
    await countJson('/api/count/acme/widget');
    await callStream('/api/stream?input=acme/widget');
    const body = (await (await call('/api/board')).json()) as { counted: number };
    expect(body.counted).toBe(1);
  });

  it('ranks on the counter, never on stars', async () => {
    github.restore();
    github = installFakeGitHub([{ ...SAMPLE_REPO, stars: 0 }]);
    await callStream('/api/stream?input=acme/widget');
    const body = (await (await call('/api/board')).json()) as {
      boards: { id: string; rows: { repo: string }[] }[];
    };
    // A repository with no stars at all still ranks: nothing here uses them.
    const biggest = body.boards.find((b) => b.id === 'biggest')!;
    expect(biggest.rows.map((r) => r.repo)).toContain('widget');
    expect(body.boards.some((b) => b.id === 'lean' || b.id === 'heavy')).toBe(false);
  });

  it('costs one KV list and no GitHub requests', async () => {
    await callStream('/api/stream?input=acme/widget');
    const before = github.requests.length;
    await call('/board');
    expect(github.requests.length).toBe(before);
  });

  it('lets the edge serve the boards, so a homepage visit is not a KV list', async () => {
    for (const path of ['/board', '/api/board', '/golf', '/api/golf']) {
      const response = await call(path);
      expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    }
  });

  it('says so once when there is nothing to rank', async () => {
    const html = await (await call('/board')).text();
    expect(html).toContain('Nothing has been counted yet');
    expect([...html.matchAll(/Nothing has been counted yet/g)]).toHaveLength(1);
  });

  it('never publishes a private repository', async () => {
    github.restore();
    github = installFakeGitHub([
      { ...SAMPLE_REPO, owner: 'acme', repo: 'secret', stars: 500, private: true },
    ]);
    await callStream('/api/stream?input=acme/secret');

    const html = await (await call('/board')).text();
    expect(html).not.toContain('secret');

    const body = (await (await call('/api/board')).json()) as { counted: number };
    expect(body.counted).toBe(0);

    const xml = await (await call('/sitemap.xml')).text();
    expect(xml).not.toContain('secret');
  });

  it('is reachable and indexable', async () => {
    expect((await call('/board')).status).toBe(200);
    const xml = await (await call('/sitemap.xml')).text();
    expect(xml).toContain('<loc>https://loc.example/board</loc>');
  });
});

describe('code golf', () => {
  it('lists the challenges', async () => {
    const html = await (await call('/golf')).text();
    expect(html).toContain('Code Golf');
    expect(html).toContain('URL shortener');
    expect(html).toContain('No entries yet.');
  });

  it('serves a page per challenge and 404s the rest', async () => {
    const html = await (await call('/golf/markdown')).text();
    expect(html).toContain('Markdown to HTML');
    expect((await call('/golf/not-a-challenge')).status).toBe(404);
  });

  it('records an entry counted through the page with a challenge selected', async () => {
    await callStream('/api/stream?input=acme/widget&challenge=markdown');
    const body = (await (await call('/api/golf')).json()) as {
      challenges: { id: string; entries: number; rows: { repo: string; code: number }[] }[];
    };
    const markdown = body.challenges.find((c) => c.id === 'markdown')!;
    expect(markdown.entries).toBe(1);
    expect(markdown.rows[0]!.repo).toBe('widget');
  });

  it('rejects a challenge that does not exist', async () => {
    const { response } = await callStream('/api/stream?input=acme/widget&challenge=nope');
    expect(response.status).toBe(400);
  });

  it('does not enter a repository nobody submitted', async () => {
    await callStream('/api/stream?input=acme/widget');
    const body = (await (await call('/api/golf')).json()) as {
      challenges: { entries: number }[];
    };
    expect(body.challenges.every((c) => c.entries === 0)).toBe(true);
  });

  it('shows a repository where it placed, on its own page', async () => {
    await callStream('/api/stream?input=acme/widget&challenge=markdown');
    const html = await (await call(`/r/acme/widget/${SAMPLE_REPO.sha}`)).text();
    expect(html).toContain('Golf standings');
    expect(html).toMatch(/<strong>#1<\/strong> of 1/);
    expect(html).toContain('Markdown to HTML');
  });

  it('points an unentered repository at the challenges', async () => {
    await countJson('/api/count/acme/widget');
    const html = await (await call(`/r/acme/widget/${SAMPLE_REPO.sha}`)).text();
    expect(html).toContain('Not entered in any');
    expect(html).toContain('/golf');
  });

  it('keeps private repositories and forks off the challenge boards', async () => {
    github.restore();
    github = installFakeGitHub([{ ...SAMPLE_REPO, repo: 'hidden', private: true }]);
    await callStream('/api/stream?input=acme/hidden&challenge=markdown');

    github.restore();
    github = installFakeGitHub([{ ...SAMPLE_REPO, repo: 'copied', fork: true }]);
    await callStream('/api/stream?input=acme/copied&challenge=markdown');

    const body = (await (await call('/api/golf')).json()) as {
      challenges: { id: string; entries: number }[];
    };
    expect(body.challenges.find((c) => c.id === 'markdown')!.entries).toBe(0);
  });

  it('is reachable and indexable', async () => {
    const xml = await (await call('/sitemap.xml')).text();
    expect(xml).toContain('<loc>https://loc.example/golf</loc>');
    expect(xml).toContain('<loc>https://loc.example/golf/markdown</loc>');
  });
});

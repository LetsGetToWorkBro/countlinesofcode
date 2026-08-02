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
    expect(body.error.hint).toMatch(/MAX_COUNT_BYTES/);
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

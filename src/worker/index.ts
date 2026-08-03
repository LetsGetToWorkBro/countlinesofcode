/**
 * LOC.1999 Worker.
 *
 * Routes:
 *   POST /api/count                       { url | owner+repo, ref?, ... } -> result
 *   GET  /api/count/:owner/:repo?ref=     idempotent, shareable
 *   GET  /api/stream?owner&repo&ref       Server-Sent Events with progress
 *   GET  /api/auth/{login,callback,me,repos}, POST /api/auth/logout
 *   GET  /api/resolve?input= | /:owner/:repo   repo + pinned sha, no counting
 *   GET  /api/archive/:owner/:repo/:sha   tarball passthrough for browser mode
 *   GET  /r/:owner/:repo/:sha             server-rendered 1999 results page
 *   *                                     static assets from ./public
 */

import { buildBoards, dedupeByRepo, recentlyCounted, standingFor } from '../lib/board';
import { ResultCache } from '../lib/cache';
import { resolveTarget, runCount, TooLargeError, type ProgressEvent } from '../lib/counter';
import { GitHubClient, GitHubError } from '../lib/github';
import { ParseError, parseRepoInput, isValidOwner, isValidRepo, isValidRef } from '../lib/parse-url';
import { checkRateLimit, clientIp } from '../lib/ratelimit';
import { CountOptionsSchema, CountRequestSchema, ShaSchema, type CountOptions, type CountResult } from '../lib/schema';
import { COUNTER_VERSION } from '../lib/version';
import { handleCallback, handleLogin, handleLogout, handleMe, handleMyRepos, loadSession, oauthConfigured, scopesFor } from './auth';
import { limitsFromEnv, rateLimitPerMinute, type Env } from './env';
import { boardPageHtml } from './board-html';
import { errorPage, resultPageHtml } from './html';

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

interface ApiError {
  status: number;
  code: string;
  message: string;
  hint?: string;
  /** Structured detail, so clients can act rather than parse the message. */
  details?: Record<string, number>;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // www -> apex, so the bare domain stays the single canonical address and
    // anyone who types www still arrives. Deliberately narrow: only the www
    // form of CANONICAL_ORIGIN redirects, so *.workers.dev and per-deploy
    // preview URLs keep serving normally.
    const wwwRedirect = redirectFromWww(url, env);
    if (wwwRedirect) return wwwRedirect;

    try {
      if (path === '/api/count' && request.method === 'POST') return await postCount(request, env, ctx);
      if (path.startsWith('/api/count/') && request.method === 'GET') return await getCount(request, env, ctx, path);
      if (path === '/api/stream' && request.method === 'GET') return await streamCount(request, env, ctx);
      if (path === '/api/meta' && request.method === 'GET') return metaResponse(env);
      if (path === '/sitemap.xml' && request.method === 'GET') return await sitemap(request, env);
      if (path === '/board' && request.method === 'GET') return await standings(request, env, ctx);
      if (path === '/api/board' && request.method === 'GET') return await standingsJson(request, env, ctx);
      if (path === '/api/resolve' && request.method === 'GET') return await resolveOnly(request, env, path);
      if (path.startsWith('/api/resolve/') && request.method === 'GET') return await resolveOnly(request, env, path);
      if (path.startsWith('/api/archive/') && request.method === 'GET') return await streamArchive(request, env, path);

      if (path === '/api/auth/login' && request.method === 'GET') return await handleLogin(request, env);
      if (path === '/api/auth/callback' && request.method === 'GET') return await handleCallback(request, env);
      if (path === '/api/auth/logout' && request.method === 'POST') return await handleLogout(request, env);
      if (path === '/api/auth/me' && request.method === 'GET') return await handleMe(request, env);
      if (path === '/api/auth/repos' && request.method === 'GET') return await handleMyRepos(request, env);

      if (path.startsWith('/r/') && request.method === 'GET') return await resultPage(request, env, ctx, path);

      if (path.startsWith('/api/')) {
        return jsonError({ status: 404, code: 'not_found', message: 'No such endpoint.' });
      }

      return await serveAsset(request, env);
    } catch (error) {
      const mapped = toApiError(error);
      logEvent({ event: 'unhandled', path, code: mapped.code, message: mapped.message });
      if (path.startsWith('/api/')) return jsonError(mapped);
      return htmlResponse(errorPage(mapped.status, mapped.code, mapped.message, mapped.hint), mapped.status);
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Counting endpoints
// ---------------------------------------------------------------------------

interface Target {
  owner: string;
  repo: string;
  ref?: string;
  options: CountOptions;
  fresh: boolean;
}

async function postCount(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError({ status: 400, code: 'bad_request', message: 'Body must be JSON.' });
  }
  const parsed = CountRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError({
      status: 400,
      code: 'bad_request',
      message: parsed.error.issues[0]?.message ?? 'Invalid request.',
    });
  }

  let target: Target;
  try {
    const input = parsed.data;
    const base = input.url
      ? parseRepoInput(input.url)
      : { owner: input.owner!, repo: input.repo!, ref: input.ref };
    target = {
      owner: base.owner,
      repo: base.repo,
      ref: input.ref ?? base.ref,
      options: CountOptionsSchema.parse({
        includeLockfiles: input.includeLockfiles ?? false,
        includeVendored: input.includeVendored ?? false,
      }),
      fresh: input.fresh ?? false,
    };
  } catch (error) {
    if (error instanceof ParseError) {
      return jsonError({ status: 400, code: 'bad_input', message: error.message });
    }
    throw error;
  }

  const result = await performCount(request, env, ctx, target);
  return jsonResponse(result, 200, {
    'cache-control': result.cached ? 'public, max-age=300' : 'public, max-age=60',
  });
}

async function getCount(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const segments = path.split('/').filter(Boolean); // api, count, owner, repo
  const owner = segments[2];
  const repo = segments[3];
  if (!owner || !repo || segments.length > 4) {
    return jsonError({ status: 400, code: 'bad_input', message: 'Use /api/count/{owner}/{repo}?ref=' });
  }
  const target = targetFromQuery(new URL(request.url), owner, repo);
  if ('status' in target) return jsonError(target);

  const result = await performCount(request, env, ctx, target);
  return jsonResponse(result, 200, {
    'cache-control': result.cached ? 'public, max-age=300' : 'public, max-age=60',
  });
}

function targetFromQuery(url: URL, owner: string, repo: string): Target | ApiError {
  if (!isValidOwner(owner)) return { status: 400, code: 'bad_input', message: `Bad owner: ${owner}` };
  if (!isValidRepo(repo)) return { status: 400, code: 'bad_input', message: `Bad repository: ${repo}` };
  const rawRef = url.searchParams.get('ref') ?? undefined;
  if (rawRef !== undefined && !isValidRef(rawRef)) {
    return { status: 400, code: 'bad_input', message: `Bad ref: ${rawRef}` };
  }
  return {
    owner,
    repo,
    ref: rawRef,
    options: CountOptionsSchema.parse({
      includeLockfiles: url.searchParams.get('lockfiles') === '1',
      includeVendored: url.searchParams.get('vendored') === '1',
    }),
    fresh: url.searchParams.get('fresh') === '1',
  };
}

/** Resolve -> cache lookup -> count -> cache store. */
async function performCount(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  target: Target,
  onProgress?: (event: ProgressEvent) => void,
): Promise<CountResult> {
  const started = Date.now();
  const session = await loadSession(request, env);
  const token = session?.token ?? env.GITHUB_TOKEN;

  if (!session) {
    const limit = rateLimitPerMinute(env);
    const check = await checkRateLimit(env.LOC_KV, clientIp(request), limit);
    if (!check.allowed) {
      throw new ApiErrorException({
        status: 429,
        code: 'rate_limited',
        message: `Too many counts from this address (${limit}/min).`,
        hint: `Try again in ${check.resetSeconds}s, or connect GitHub for your own quota.`,
      });
    }
  }

  const client = new GitHubClient(token);
  const cache = new ResultCache(env.LOC_KV);

  // Fast path: an explicit 40-hex ref is already immutable, so a cached result
  // is served without touching GitHub at all. This is what makes shared /r/
  // links free — they cost no rate-limit quota even with no token configured.
  //
  // Restricted to public repositories: for a private one the `getRepo` call in
  // resolveTarget is what proves the caller may see it, and skipping it would
  // leak a cached private result to anyone holding the URL.
  if (!target.fresh && target.ref && /^[0-9a-f]{40}$/i.test(target.ref)) {
    const hit = await cache.get(target.owner, target.repo, target.ref.toLowerCase(), target.options);
    if (hit && !hit.repo_meta.private) {
      logEvent({ event: 'count', cached: true, repo: hit.full_name, sha: hit.sha, ms: Date.now() - started, github_requests: 0 });
      onProgress?.({ phase: 'done', message: 'Served from cache.' });
      return { ...hit, cached: true, duration_ms: Date.now() - started };
    }
  }

  onProgress?.({ phase: 'resolve', message: 'Resolving repository…' });
  const resolved = await resolveTarget(client, target.owner, target.repo, target.ref, cache);
  onProgress?.({ phase: 'resolve', message: `Pinned to ${resolved.sha.slice(0, 10)}…` });

  if (!target.fresh) {
    const hit = await cache.get(resolved.repoInfo.owner, resolved.repoInfo.repo, resolved.sha, target.options);
    if (hit) {
      logEvent({
        event: 'count',
        cached: true,
        repo: hit.full_name,
        sha: resolved.sha,
        ms: Date.now() - started,
      });
      onProgress?.({ phase: 'done', message: 'Served from cache.' });
      return { ...hit, cached: true, ref: resolved.ref, duration_ms: Date.now() - started };
    }
  }

  const result = await runCount(client, resolved, { options: target.options }, limitsFromEnv(env), onProgress);
  ctx.waitUntil(cache.put(result).catch(() => undefined));
  logEvent({
    event: 'count',
    cached: false,
    repo: result.full_name,
    sha: result.sha,
    strategy: result.strategy,
    files: result.totals.files,
    lines: result.totals.lines,
    ms: result.duration_ms,
    resolve_ms: result.timing.resolve_ms,
    tree_ms: result.timing.tree_ms,
    fetch_ms: result.timing.fetch_ms,
    parse_ms: result.timing.parse_ms,
    github_requests: result.github_requests,
  });
  return result;
}

/**
 * SSE progress stream. The whole count runs inside one request; progress events
 * are pushed as they happen and the final `result` event carries the payload.
 */
async function streamCount(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const rawInput = url.searchParams.get('input');
  let target: Target | ApiError;
  if (rawInput) {
    try {
      const parsed = parseRepoInput(rawInput);
      const refOverride = url.searchParams.get('ref') ?? undefined;
      if (refOverride !== undefined && !isValidRef(refOverride)) {
        target = { status: 400, code: 'bad_input', message: `Bad ref: ${refOverride}` };
      } else {
        target = {
          owner: parsed.owner,
          repo: parsed.repo,
          ref: refOverride ?? parsed.ref,
          options: CountOptionsSchema.parse({
            includeLockfiles: url.searchParams.get('lockfiles') === '1',
            includeVendored: url.searchParams.get('vendored') === '1',
          }),
          fresh: url.searchParams.get('fresh') === '1',
        };
      }
    } catch (error) {
      target = {
        status: 400,
        code: 'bad_input',
        message: error instanceof ParseError ? error.message : 'Could not parse that input.',
      };
    }
  } else {
    const owner = url.searchParams.get('owner') ?? '';
    const repo = url.searchParams.get('repo') ?? '';
    target = targetFromQuery(url, owner, repo);
  }

  if ('status' in target) return jsonError(target);
  const resolvedTarget = target;

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const send = async (event: string, data: unknown): Promise<void> => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  const work = (async () => {
    try {
      const result = await performCount(request, env, ctx, resolvedTarget, (progress) => {
        void send('progress', progress).catch(() => undefined);
      });
      await send('result', result);
    } catch (error) {
      const mapped = toApiError(error);
      logEvent({ event: 'stream_error', code: mapped.code, message: mapped.message });
      await send('failure', {
        error: {
          code: mapped.code,
          message: mapped.message,
          hint: mapped.hint,
          ...(mapped.details ? { details: mapped.details } : {}),
        },
      }).catch(
        () => undefined,
      );
    } finally {
      await writer.close().catch(() => undefined);
    }
  })();
  ctx.waitUntil(work);

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      ...SECURITY_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// Shareable result page
// ---------------------------------------------------------------------------

async function resultPage(request: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const segments = path.split('/').filter(Boolean); // r, owner, repo, sha?
  const [, owner, repo, sha] = segments;
  if (!owner || !repo || segments.length > 4) {
    return htmlResponse(errorPage(404, 'not_found', 'Expected /r/{owner}/{repo}/{sha}.'), 404);
  }
  if (!isValidOwner(owner) || !isValidRepo(repo)) {
    return htmlResponse(errorPage(400, 'bad_input', 'That owner/repository name is not valid.'), 400);
  }
  if (sha !== undefined && !ShaSchema.safeParse(sha).success) {
    return htmlResponse(errorPage(400, 'bad_input', 'The commit sha must be 40 hex characters.'), 400);
  }

  const url = new URL(request.url);
  const options = CountOptionsSchema.parse({
    includeLockfiles: url.searchParams.get('lockfiles') === '1',
    includeVendored: url.searchParams.get('vendored') === '1',
  });

  try {
    const result = await performCount(request, env, ctx, {
      owner,
      repo,
      ref: sha,
      options,
      fresh: false,
    });
    const standing = standingFor(
      await new ResultCache(env.LOC_KV).listForBoard(),
      result.owner,
      result.repo,
    );
    return htmlResponse(resultPageHtml(result, canonicalOrigin(env, request), standing), 200, {
      'cache-control': sha ? 'public, max-age=86400' : 'public, max-age=300',
    });
  } catch (error) {
    const mapped = toApiError(error);
    // Oversized repositories can still be counted in the browser, so send the
    // visitor to the form with the repository pre-filled rather than stopping.
    const action =
      mapped.code === 'too_large'
        ? { href: `/?repo=${encodeURIComponent(`${owner}/${repo}`)}`, label: 'Count it in my browser' }
        : undefined;
    return htmlResponse(
      errorPage(mapped.status, mapped.code, mapped.message, mapped.hint, action),
      mapped.status,
    );
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Browser-side counting support
//
// Counting is CPU-bound, and Cloudflare caps CPU per request (10 ms free,
// 30 s paid). Streaming bytes through a Worker, by contrast, costs essentially
// no CPU — the runtime pipes the body without JavaScript touching it. So for
// repositories too large for the server budget we hand the archive to the
// browser, which runs the identical counting code with no limit at all.
//
// Two endpoints support that: one cheap resolve, and one pure passthrough.
// ---------------------------------------------------------------------------

/** Repository metadata + pinned sha. No content is fetched, so no real CPU. */
async function resolveOnly(request: Request, env: Env, path: string): Promise<Response> {
  const url = new URL(request.url);
  const segments = path.split('/').filter(Boolean); // api, resolve[, owner, repo]
  let owner = segments[2];
  let repo = segments[3];

  // `?input=` accepts anything the main form accepts (URL, owner/repo, ssh).
  const raw = url.searchParams.get('input');
  if (raw !== null) {
    try {
      const parsed = parseRepoInput(raw);
      owner = parsed.owner;
      repo = parsed.repo;
      if (!url.searchParams.get('ref') && parsed.ref) url.searchParams.set('ref', parsed.ref);
    } catch (error) {
      return jsonError({
        status: 400,
        code: 'bad_input',
        message: error instanceof ParseError ? error.message : 'Could not parse that input.',
      });
    }
  }

  if (!owner || !repo || !isValidOwner(owner) || !isValidRepo(repo)) {
    return jsonError({ status: 400, code: 'bad_input', message: 'Use /api/resolve?input= or /api/resolve/{owner}/{repo}' });
  }
  const ref = url.searchParams.get('ref') ?? undefined;
  if (ref !== undefined && !isValidRef(ref)) {
    return jsonError({ status: 400, code: 'bad_input', message: `Bad ref: ${ref}` });
  }

  const session = await loadSession(request, env);
  if (!session) {
    const limit = rateLimitPerMinute(env);
    const check = await checkRateLimit(env.LOC_KV, clientIp(request), limit);
    if (!check.allowed) {
      return jsonError({
        status: 429,
        code: 'rate_limited',
        message: `Too many requests from this address (${limit}/min).`,
        hint: `Try again in ${check.resetSeconds}s.`,
      });
    }
  }

  const client = new GitHubClient(session?.token ?? env.GITHUB_TOKEN);
  const resolved = await resolveTarget(client, owner, repo, ref, new ResultCache(env.LOC_KV));
  return jsonResponse(
    {
      owner: resolved.repoInfo.owner,
      repo: resolved.repoInfo.repo,
      full_name: resolved.repoInfo.full_name,
      sha: resolved.sha,
      ref: resolved.ref,
      default_branch: resolved.repoInfo.default_branch,
      repo_meta: {
        stars: resolved.repoInfo.stars,
        size_kb: resolved.repoInfo.size_kb,
        private: resolved.repoInfo.private,
        archived: resolved.repoInfo.archived,
        fork: resolved.repoInfo.fork,
        description: resolved.repoInfo.description,
        html_url: resolved.repoInfo.html_url,
      },
      counter_version: COUNTER_VERSION,
    },
    200,
    { 'cache-control': 'public, max-age=60' },
  );
}

/**
 * Passthrough of the repository tarball at a pinned sha.
 *
 * The response body is the upstream body, unread: no decompression, no
 * parsing, no buffering in the isolate. That is what keeps this within the
 * free plan's CPU budget no matter how large the repository is.
 *
 * The GitHub token never reaches the client — this Worker is what holds it, and
 * the archive redirect is followed server-side to an allowlisted host.
 */
async function streamArchive(request: Request, env: Env, path: string): Promise<Response> {
  const segments = path.split('/').filter(Boolean); // api, archive, owner, repo, sha
  const [, , owner, repo, sha] = segments;
  if (!owner || !repo || !sha || segments.length !== 5) {
    return jsonError({ status: 400, code: 'bad_input', message: 'Use /api/archive/{owner}/{repo}/{sha}' });
  }
  if (!isValidOwner(owner) || !isValidRepo(repo) || !ShaSchema.safeParse(sha).success) {
    return jsonError({ status: 400, code: 'bad_input', message: 'Bad owner, repository or sha.' });
  }

  const session = await loadSession(request, env);
  if (!session) {
    const limit = rateLimitPerMinute(env);
    const check = await checkRateLimit(env.LOC_KV, clientIp(request), limit);
    if (!check.allowed) {
      return jsonError({
        status: 429,
        code: 'rate_limited',
        message: `Too many requests from this address (${limit}/min).`,
        hint: `Try again in ${check.resetSeconds}s.`,
      });
    }
  }

  const client = new GitHubClient(session?.token ?? env.GITHUB_TOKEN);
  const body = await client.openTarball(owner, repo, sha);
  logEvent({ event: 'archive_stream', repo: `${owner}/${repo}`, sha });

  return new Response(body, {
    headers: {
      'content-type': 'application/gzip',
      // Immutable: the sha pins the content.
      'cache-control': 'private, max-age=3600',
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * The Standings. One KV list() call feeds every board: the ranking numbers live
 * in each entry's metadata, so this costs no result reads and stays inside the
 * free plan's CPU budget however many repositories are cached.
 *
 * That one call still has to be paid for on every request, and the homepage now
 * asks for these rankings on load — so both routes go through the edge cache.
 * A minute of staleness is free: KV listings are eventually consistent by about
 * the same margin, so a shorter TTL would buy nothing but KV operations.
 */
async function standings(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return atEdge(request, ctx, async () => {
    const entries = await new ResultCache(env.LOC_KV).listForBoard();
    const boards = buildBoards(entries);
    const recent = recentlyCounted(entries);
    const origin = canonicalOrigin(env, request);
    return htmlResponse(boardPageHtml(boards, recent, dedupeByRepo(entries).length, origin), 200, {
      'cache-control': `public, max-age=${BOARD_TTL_SECONDS}`,
    });
  });
}

/** The same rankings as data, for anyone who would rather plot them. */
async function standingsJson(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return atEdge(request, ctx, async () => {
    const entries = await new ResultCache(env.LOC_KV).listForBoard();
    return jsonResponse(
      {
        counted: dedupeByRepo(entries).length,
        boards: buildBoards(entries).map((board) => ({
          id: board.id,
          title: board.title,
          unit: board.unit,
          rows: board.rows.map((row) => ({
            owner: row.owner,
            repo: row.repo,
            sha: row.sha,
            lines: row.lines,
            stars: row.stars,
            value: Number(row.value.toFixed(4)),
          })),
        })),
      },
      200,
      { 'cache-control': `public, max-age=${BOARD_TTL_SECONDS}` },
    );
  });
}

/**
 * Sitemap of the two static pages plus every cached result page.
 *
 * The /r/ pages are the interesting ones: each is server-rendered, needs no
 * JavaScript, and carries real numbers for a specific commit — exactly the kind
 * of page someone reaches by searching for a repository's size. They are only
 * linked from results, so without a sitemap a crawler would never find them.
 *
 * Listing cached results also means the sitemap can never advertise a page that
 * costs a GitHub round trip to render: every URL here is already a cache hit.
 */
async function sitemap(request: Request, env: Env): Promise<Response> {
  const origin = canonicalOrigin(env, request);
  const entries: string[] = [
    `<url><loc>${escapeXml(origin)}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${escapeXml(origin)}/how.html</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`,
    `<url><loc>${escapeXml(origin)}/security.html</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>`,
    `<url><loc>${escapeXml(origin)}/board</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
  ];

  const cached = await new ResultCache(env.LOC_KV).listForSitemap(1000);
  for (const entry of cached) {
    const loc = `${origin}/r/${entry.owner}/${entry.repo}/${entry.sha}`;
    const lastmod = entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod.slice(0, 10))}</lastmod>` : '';
    entries.push(`<url><loc>${escapeXml(loc)}</loc>${lastmod}<changefreq>monthly</changefreq><priority>0.6</priority></url>`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`;
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      ...SECURITY_HEADERS,
    },
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * If this request arrived on `www.<canonical host>`, send it to the apex.
 * Returns null when there is nothing to do — including when CANONICAL_ORIGIN is
 * unset, which is the case for local development.
 */
function redirectFromWww(url: URL, env: Env): Response | null {
  const configured = env.CANONICAL_ORIGIN;
  if (!configured || !/^https?:\/\//.test(configured)) return null;

  let canonical: URL;
  try {
    canonical = new URL(configured);
  } catch {
    return null;
  }
  if (url.hostname !== `www.${canonical.hostname}`) return null;

  const target = new URL(url.pathname + url.search, canonical.origin);
  return new Response(null, {
    status: 301,
    headers: {
      location: target.toString(),
      'cache-control': 'public, max-age=3600',
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * Origin used in canonical URLs and the sitemap. CANONICAL_ORIGIN pins it to
 * the primary domain so the *.workers.dev copy does not compete with it; unset,
 * it falls back to whatever host served the request.
 */
function canonicalOrigin(env: Env, request: Request): string {
  const configured = env.CANONICAL_ORIGIN;
  if (configured && /^https?:\/\//.test(configured)) return configured.replace(/\/$/, '');
  return new URL(request.url).origin;
}

function metaResponse(env: Env): Response {
  const limits = limitsFromEnv(env);
  return jsonResponse(
    {
      counter_version: COUNTER_VERSION,
      // The commit this build came from, so anyone can check the running code
      // against the public repository. Set at deploy time; see DEPLOY.md.
      source_commit: env.SOURCE_COMMIT ?? null,
      oauth_available: oauthConfigured(env),
      oauth_scopes: scopesFor(env),
      server_token: Boolean(env.GITHUB_TOKEN),
      limits: {
        max_files: limits.maxFiles,
        max_total_bytes: limits.maxTotalBytes,
        max_file_bytes: limits.maxFileBytes,
        blob_strategy_max_files: limits.maxBlobFetches,
        max_count_bytes: limits.maxCountBytes,
      },
      rate_limit_per_minute: rateLimitPerMinute(env),
    },
    200,
    { 'cache-control': 'public, max-age=300' },
  );
}

async function serveAsset(request: Request, env: Env): Promise<Response> {
  if (!env.ASSETS) {
    return htmlResponse(errorPage(404, 'not_found', 'Static assets are not bound in this environment.'), 404);
  }
  // `html_handling = "none"` keeps /how.html at /how.html (no 307 to /how), so
  // the directory index has to be mapped here.
  const url = new URL(request.url);
  const assetRequest =
    url.pathname === '/' ? new Request(new URL('/index.html', url), request) : request;
  const response = await env.ASSETS.fetch(assetRequest);
  if (response.status === 404) {
    return htmlResponse(errorPage(404, 'not_found', 'There is no page here.'), 404);
  }
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

class ApiErrorException extends Error {
  override readonly name = 'ApiErrorException';
  constructor(readonly api: ApiError) {
    super(api.message);
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiErrorException) return error.api;
  if (error instanceof ParseError) {
    return { status: 400, code: 'bad_input', message: error.message };
  }
  if (error instanceof GitHubError) {
    switch (error.kind) {
      case 'not_found':
        return {
          status: 404,
          code: 'not_found',
          message: 'Repository, branch or commit not found.',
          hint: 'If it is private, connect GitHub first. Check the spelling of the branch too.',
        };
      case 'unauthorized':
        return {
          status: 403,
          code: 'forbidden',
          message: error.message || 'GitHub refused that request.',
          hint: 'Private repositories need a connected GitHub account with access.',
        };
      case 'rate_limited':
        return {
          status: 429,
          code: 'rate_limited',
          message: error.message,
          hint: error.retryAfterSeconds
            ? `Rate limit resets in about ${error.retryAfterSeconds}s.`
            : 'Connect GitHub to use your own quota.',
        };
      case 'empty_repo':
        return { status: 422, code: 'empty_repo', message: 'That repository has no commits to count.' };
      case 'too_large':
        return {
          status: 413,
          code: 'too_large',
          message: error.message,
          // The page uses these to decide whether switching to browser counting
          // is polite (a small download) or should be offered as a choice.
          details: error instanceof TooLargeError ? { bytes: error.bytes, limit: error.limit } : {},
          hint:
            'Count it from the front page instead: your browser has no such limit, ' +
            'and it will offer to do the counting there.',
        };
      case 'server':
        return { status: 502, code: 'github_down', message: 'GitHub returned a server error. Try again.' };
      case 'network':
        return { status: 502, code: 'network', message: 'Could not reach GitHub. Try again.' };
      default:
        return { status: 502, code: 'github_error', message: error.message };
    }
  }
  const message = error instanceof Error ? error.message : 'Unexpected error.';
  return { status: 500, code: 'internal', message };
}

/** How long a rendered board may be served from the edge without rebuilding. */
const BOARD_TTL_SECONDS = 60;

/**
 * Serve a GET response from Cloudflare's edge cache, building it on a miss.
 *
 * Worker responses are not cached automatically, so without this every visitor
 * to the homepage would spend a KV list operation on the leaderboard. With it,
 * one visitor per minute per colo does, and the rest are served bytes.
 *
 * `caches` does not exist outside the Workers runtime (tests, `vite-node`), and
 * a cache is an optimisation, never a correctness requirement — so an absent or
 * failing cache degrades to simply building the response.
 */
async function atEdge(
  request: Request,
  ctx: ExecutionContext,
  build: () => Promise<Response>,
): Promise<Response> {
  const cache = typeof caches !== 'undefined' ? caches.default : undefined;
  if (!cache) return build();

  const hit = await cache.match(request).catch(() => undefined);
  if (hit) return hit;

  const fresh = await build();
  if (fresh.ok) ctx.waitUntil(cache.put(request, fresh.clone()).catch(() => undefined));
  return fresh;
}

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

function jsonError(error: ApiError): Response {
  return jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.hint ? { hint: error.hint } : {}),
        ...(error.details ? { details: error.details } : {}),
      },
    },
    error.status,
    { 'cache-control': 'no-store' },
  );
}

function htmlResponse(html: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

/** Structured, token-free logging. */
function logEvent(fields: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
  } catch {
    /* logging must never throw */
  }
}

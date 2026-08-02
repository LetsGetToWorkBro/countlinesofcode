/**
 * LOC.1999 Worker.
 *
 * Routes:
 *   POST /api/count                       { url | owner+repo, ref?, ... } -> result
 *   GET  /api/count/:owner/:repo?ref=     idempotent, shareable
 *   GET  /api/stream?owner&repo&ref       Server-Sent Events with progress
 *   GET  /api/auth/{login,callback,me,repos}, POST /api/auth/logout
 *   GET  /r/:owner/:repo/:sha             server-rendered 1999 results page
 *   *                                     static assets from ./public
 */

import { ResultCache } from '../lib/cache';
import { resolveTarget, runCount, type ProgressEvent } from '../lib/counter';
import { GitHubClient, GitHubError } from '../lib/github';
import { ParseError, parseRepoInput, isValidOwner, isValidRepo, isValidRef } from '../lib/parse-url';
import { checkRateLimit, clientIp } from '../lib/ratelimit';
import { CountOptionsSchema, CountRequestSchema, ShaSchema, type CountOptions, type CountResult } from '../lib/schema';
import { COUNTER_VERSION } from '../lib/version';
import { handleCallback, handleLogin, handleLogout, handleMe, handleMyRepos, loadSession, oauthConfigured } from './auth';
import { limitsFromEnv, rateLimitPerMinute, type Env } from './env';
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
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/count' && request.method === 'POST') return await postCount(request, env, ctx);
      if (path.startsWith('/api/count/') && request.method === 'GET') return await getCount(request, env, ctx, path);
      if (path === '/api/stream' && request.method === 'GET') return await streamCount(request, env, ctx);
      if (path === '/api/meta' && request.method === 'GET') return metaResponse(env);

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
      await send('failure', { error: { code: mapped.code, message: mapped.message, hint: mapped.hint } }).catch(
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
    return htmlResponse(resultPageHtml(result), 200, {
      'cache-control': sha ? 'public, max-age=86400' : 'public, max-age=300',
    });
  } catch (error) {
    const mapped = toApiError(error);
    return htmlResponse(errorPage(mapped.status, mapped.code, mapped.message, mapped.hint), mapped.status);
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function metaResponse(env: Env): Response {
  const limits = limitsFromEnv(env);
  return jsonResponse(
    {
      counter_version: COUNTER_VERSION,
      oauth_available: oauthConfigured(env),
      server_token: Boolean(env.GITHUB_TOKEN),
      limits: {
        max_files: limits.maxFiles,
        max_total_bytes: limits.maxTotalBytes,
        max_file_bytes: limits.maxFileBytes,
        blob_strategy_max_files: limits.maxBlobFetches,
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
          message: 'That repository is too large for a single request.',
          hint: 'Try a smaller ref, or count a subdirectory-heavy fork.',
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
    { error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) } },
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

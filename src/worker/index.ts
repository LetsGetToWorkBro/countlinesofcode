/**
 * 1999.LOC Worker.
 *
 * Routes:
 *   POST /api/count                       { url | owner+repo, ref?, ... } -> result
 *   GET  /api/count/:owner/:repo?ref=     idempotent, shareable
 *   GET  /api/stream?owner&repo&ref       Server-Sent Events with progress
 *   GET  /api/auth/{login,callback,me,repos}, POST /api/auth/logout
 *   GET  /api/resolve?input= | /:owner/:repo   repo + pinned sha, no counting
 *   GET  /api/archive/:owner/:repo/:sha   tarball passthrough for browser mode
 *   GET  /r/:owner/:repo/:sha             server-rendered 1999 results page
 *   GET  /golf | /golf/:challenge         code golf: one task, fewest lines wins
 *   *                                     static assets from ./public
 */

import { buildBoards, dedupeByRepo, recentlyCounted } from '../lib/board';
import { ResultCache } from '../lib/cache';
import { buildChallengeBoards, findChallenge, placeOf, rankEntries, CHALLENGES, MIN_CODE_LINES, type GolfEntry } from '../lib/challenges';
import { resolveTarget, runCount, TooLargeError, type ProgressEvent } from '../lib/counter';
import { GitHubClient, GitHubError } from '../lib/github';
import { ParseError, parseRepoInput, isValidOwner, isValidRepo, isValidRef } from '../lib/parse-url';
import { checkRateLimit, clientIp } from '../lib/ratelimit';
import { CountOptionsSchema, CountRequestSchema, ShaSchema, type CountOptions, type CountResult } from '../lib/schema';
import { resolveTarget as resolveXmrTarget } from '../lib/xmrproxy';
import { COUNTER_VERSION } from '../lib/version';
import { handleCallback, handleLogin, handleLogout, handleMe, handleMyRepos, loadSession, oauthConfigured, scopesFor } from './auth';
import { limitsFromEnv, rateLimitPerMinute, type Env } from './env';
import { boardPageHtml } from './board-html';
import { EXACTLY_1999 } from './exact1999';
import { challengePageHtml, golfIndexHtml } from './golf-html';
import { errorPage, resultPageHtml, type Standing } from './html';

/* Exported so a test can hold public/_headers to it. Static assets are served
 * by the assets binding, which never reaches this file, so the same policy has
 * to be written twice — and a comment asking the next person to keep them in
 * sync did not stop them drifting apart. */
export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  /* no-referrer, not strict-origin-when-cross-origin, which is what this was.
   * The difference only shows on an outbound link, and that is exactly where
   * it matters: clicking through to getmonero.org or gnupg.org from here used
   * to tell them which page you left, and "1999loc.com/monero.html" is a
   * sentence about you. Nothing here needs a referrer to work. */
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  /* Two years, and every subdomain. Everything under 1999loc.com is already
   * HTTPS-only through Cloudflare, so this costs nothing and closes the
   * first-visit downgrade. Not sent with `preload`: that is a one-way door
   * requiring a manual submission, and it should be a deliberate decision
   * rather than a side effect of a commit. */
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  /* Severs this page from anything that opened it and anything it opens, so a
   * window handle cannot be used to poke at it across origins. */
  'cross-origin-opener-policy': 'same-origin',
  /* No other site may load these bytes as a subresource. On a page that
   * generates keys, "somebody else can embed our script" is not a thing worth
   * permitting for the sake of nobody who was doing it. */
  'cross-origin-resource-policy': 'same-origin',
  /* Everything this site could ask a browser for and never does. A tool that
   * has no business reading your location or opening your camera should not be
   * able to start, and this is the difference between not doing it and not
   * being permitted to. */
  'permissions-policy':
    'accelerometer=(), autoplay=(), browsing-topics=(), camera=(), display-capture=(), ' +
    'encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), ' +
    'local-fonts=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), ' +
    'screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()',
  /* font-src is 'self' for the PDF tools: pdf.js loads the standard-14 font
   * data from /vendor/standard_fonts/ as a real font face, and default-src
   * 'none' was refusing it. The refusal was silent — the page still rendered,
   * with a substituted system font and the wrong glyph metrics, which then got
   * baked in permanently on any page flattened for a blackout. Embedded fonts
   * need nothing here (measured), so 'self' is the whole widening.
   *
   * script-src carries 'wasm-unsafe-eval'. This is NOT 'unsafe-eval': it
   * permits compiling and instantiating WebAssembly and nothing else — eval()
   * and new Function() stay blocked, which was measured, not assumed. It is
   * what lets the image tool decode a HEIC photo with a WASM codec served from
   * this origin. No wasm is loaded until a tool that needs it runs.
   *
   * img-src carries blob: for the same reason as media-src: the video tool
   * shows the GIF it just made, and a multi-megabyte animation as a base64
   * data: URL is a third again as large and has to be built as a string first.
   * blob: names bytes this tab already holds and reaches no network.
   *
   * media-src is 'blob:' for the video tool, and blob: only. You cannot trim a
   * video you cannot see, and the preview plays the file the visitor just
   * opened — held in the tab as a blob, never fetched. Without this the
   * <video> element is refused with "Media load rejected by URL safety check",
   * which was measured here rather than guessed. blob: cannot reach the
   * network: it names data this page already holds, so the widening admits
   * nothing that was not already in the tab.
   *
   * worker-src is 'self' for the Monero wallet: monero-ts runs the wallet in a
   * dedicated Web Worker (/vendor/monero-ts/monero.worker.js) so the scanning
   * cryptography never freezes the page. worker-src otherwise falls back to
   * default-src 'none', which refuses the worker outright and leaves the wallet
   * dead on load; it names this origin only, so nothing off-origin can spawn. */
  'content-security-policy':
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; " +
    "font-src 'self'; connect-src 'self'; media-src blob:; worker-src 'self'; form-action 'self'; base-uri 'none'; " +
    "frame-ancestors 'none'",
};

/**
 * The Cache-Control for a repository response.
 *
 * A private-repo count carries real line totals, real file paths and the repo
 * description; served `public`, a shared cache anywhere in the TLS path (a
 * corporate intercepting proxy, or a later Cloudflare cache rule) could store
 * it keyed on the URL and hand it to a second user who has no access to that
 * repository. So a private repo is always `private, no-store`; a public one
 * keeps its cacheable value.
 */
function repoCacheControl(isPrivate: boolean, publicValue: string): string {
  return isPrivate ? 'private, no-store' : publicValue;
}

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
      // The counter used to live at "/". Links to it are out in the world —
      // golf pages, shared screenshots, anyone's bookmarks — so a request to the
      // landing page carrying counter parameters is forwarded rather than
      // silently ignoring them and showing a page with no form on it.
      const movedCounter = redirectMovedCounter(url);
      if (movedCounter) return movedCounter;

      const retired = redirectRetiredPage(url);
      if (retired) return retired;

      if (path === '/api/count' && request.method === 'POST') return await postCount(request, env, ctx);
      if (path.startsWith('/api/count/') && request.method === 'GET') return await getCount(request, env, ctx, path);
      if (path === '/api/stream' && request.method === 'GET') return await streamCount(request, env, ctx);
      if (path === '/api/meta' && request.method === 'GET') return metaResponse(env);
      if (path === '/sitemap.xml' && request.method === 'GET') return await sitemap(request, env);
      if (path === '/board' && request.method === 'GET') return await standings(request, env, ctx);
      if (path === '/1999' && request.method === 'GET') return exactly1999();
      if (path === '/api/board' && request.method === 'GET') return await standingsJson(request, env, ctx);
      if (path === '/golf' && request.method === 'GET') return await golfIndex(request, env, ctx);
      if (path.startsWith('/golf/') && request.method === 'GET') return await golfChallenge(request, env, ctx, path);
      if (path === '/api/golf' && request.method === 'GET') return await golfJson(request, env, ctx);
      if (path === '/api/resolve' && request.method === 'GET') return await resolveOnly(request, env, path);
      if (path.startsWith('/api/resolve/') && request.method === 'GET') return await resolveOnly(request, env, path);
      if (path.startsWith('/api/archive/') && request.method === 'GET') return await streamArchive(request, env, path);

      if (path === '/api/auth/login' && request.method === 'GET') return await handleLogin(request, env);
      if (path === '/api/auth/callback' && request.method === 'GET') return await handleCallback(request, env);
      if (path === '/api/auth/logout' && request.method === 'POST') return await handleLogout(request, env);
      if (path === '/api/auth/me' && request.method === 'GET') return await handleMe(request, env);
      if (path === '/api/auth/repos' && request.method === 'GET') return await handleMyRepos(request, env);

      if (path.startsWith('/r/') && request.method === 'GET') return await resultPage(request, env, ctx, path);

      if (path.startsWith('/api/xmr/')) return await proxyXmr(request, path);

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
  /**
   * Whether a person drove this from the page or something called the API.
   * Only `site` counts reach the leaderboards — see ResultCache's `via`.
   */
  via: 'site' | 'api';
  /** Golf challenge this count is being submitted to, if any. */
  challenge?: string;
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
      // The page posts here when the browser has no EventSource. Anything else
      // posting here is indistinguishable from that, which is stated plainly in
      // ResultCache's `via`: this is a speed bump, not authentication.
      via: 'site',
      ...(input.challenge ? { challenge: input.challenge } : {}),
    };
  } catch (error) {
    if (error instanceof ParseError) {
      return jsonError({ status: 400, code: 'bad_input', message: error.message });
    }
    throw error;
  }

  const result = await performCount(request, env, ctx, target);
  return jsonResponse(result, 200, {
    'cache-control': repoCacheControl(result.repo_meta.private, result.cached ? 'public, max-age=300' : 'public, max-age=60'),
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
    'cache-control': repoCacheControl(result.repo_meta.private, result.cached ? 'public, max-age=300' : 'public, max-age=60'),
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
    // The shareable, scriptable endpoint. Counting through it is entirely fine;
    // it just does not put anything on a leaderboard.
    via: 'api',
  };
}

/**
 * A repository counted through the API and then visited on the page would never
 * qualify for the boards: the second count is a cache hit, so nothing is
 * rewritten. This promotes the cached entry and records any golf submission.
 */
async function afterSiteCount(env: Env, target: Target, hit: CountResult): Promise<void> {
  const cache = new ResultCache(env.LOC_KV);
  await cache.markFromSite(hit).catch(() => undefined);
  if (target.challenge) await submitToChallenge(env, target.challenge, hit);
}

/**
 * Record a golf entry, if the result is one a challenge board may show.
 *
 * Private repositories are excluded for the same reason they are excluded
 * everywhere else, and forks because entering someone else's solution is not
 * entering. Anything under the minimum is an empty repository, not an attempt.
 */
async function submitToChallenge(env: Env, challenge: string, result: CountResult): Promise<void> {
  if (!findChallenge(challenge)) return;
  if (result.repo_meta.private || result.repo_meta.fork) return;
  if (result.totals.code < MIN_CODE_LINES) return;

  const top = [...result.by_language].sort((a, b) => b.code - a.code)[0];
  await new ResultCache(env.LOC_KV)
    .putGolf({
      challenge,
      owner: result.owner,
      repo: result.repo,
      sha: result.sha,
      code: result.totals.code,
      lines: result.totals.lines,
      bytes: result.totals.bytes,
      files: result.totals.files,
      language: top?.language ?? '',
      countedAt: result.counted_at,
    })
    .catch(() => undefined);
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
      if (target.via === 'site') ctx.waitUntil(afterSiteCount(env, target, hit));
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
      if (target.via === 'site') ctx.waitUntil(afterSiteCount(env, target, hit));
      return { ...hit, cached: true, ref: resolved.ref, duration_ms: Date.now() - started };
    }
  }

  const result = await runCount(client, resolved, { options: target.options }, limitsFromEnv(env), onProgress);
  ctx.waitUntil(cache.put(result, target.via).catch(() => undefined));
  if (target.challenge) ctx.waitUntil(submitToChallenge(env, target.challenge, result));
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
          via: 'site',
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

  // This endpoint is what the page uses, so everything through it is a person
  // counting something, and eligible for the boards.
  const challenge = url.searchParams.get('challenge');
  if (challenge !== null && !findChallenge(challenge)) {
    return jsonError({ status: 400, code: 'bad_input', message: `No such challenge: ${challenge}` });
  }
  const resolvedTarget: Target = {
    ...target,
    via: 'site',
    ...(challenge ? { challenge } : {}),
  };

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
      // A shared permalink is not somebody entering a competition.
      via: 'api',
    });
    // One KV list, same as before — it just answers a better question now:
    // which challenges this repository was entered in, and where it placed.
    const standings = placementsFor(
      await new ResultCache(env.LOC_KV).listGolf(),
      result.owner,
      result.repo,
    );
    return htmlResponse(resultPageHtml(result, canonicalOrigin(env, request), standings), 200, {
      'cache-control': repoCacheControl(result.repo_meta.private, sha ? 'public, max-age=86400' : 'public, max-age=300'),
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
    { 'cache-control': repoCacheControl(resolved.repoInfo.private, 'public, max-age=60') },
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

/** Every challenge this repository is entered in, with its place on each. */
function placementsFor(entries: GolfEntry[], owner: string, repo: string): Standing[] {
  const out: Standing[] = [];
  for (const challenge of CHALLENGES) {
    const place = placeOf(entries, challenge.id, owner, repo);
    if (place) out.push({ challenge: challenge.id, ...place });
  }
  return out;
}

/**
 * The golf course. One KV list() feeds every challenge board, and the whole
 * thing is edge-cached like the standings — a challenge page is the sort of
 * link that arrives all at once or not at all.
 */
async function golfIndex(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return atEdge(request, ctx, async () => {
    const entries = await new ResultCache(env.LOC_KV).listGolf();
    return htmlResponse(golfIndexHtml(buildChallengeBoards(entries), canonicalOrigin(env, request)), 200, {
      'cache-control': `public, max-age=${BOARD_TTL_SECONDS}`,
    });
  });
}

async function golfChallenge(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
): Promise<Response> {
  const id = path.slice('/golf/'.length).replace(/\/$/, '');
  const challenge = findChallenge(id);
  if (!challenge) {
    return htmlResponse(
      errorPage(404, 'not_found', 'No such challenge.', 'See /golf for the ones that exist.'),
      404,
    );
  }
  return atEdge(request, ctx, async () => {
    const entries = await new ResultCache(env.LOC_KV).listGolf();
    const board = { challenge, entries: rankEntries(entries.filter((e) => e.challenge === id)) };
    return htmlResponse(challengePageHtml(board, canonicalOrigin(env, request)), 200, {
      'cache-control': `public, max-age=${BOARD_TTL_SECONDS}`,
    });
  });
}

/** Challenges and their standings as data, including for the front page. */
async function golfJson(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return atEdge(request, ctx, async () => {
    const entries = await new ResultCache(env.LOC_KV).listGolf();
    return jsonResponse(
      {
        min_code_lines: MIN_CODE_LINES,
        challenges: buildChallengeBoards(entries).map(({ challenge, entries: rows }) => ({
          id: challenge.id,
          title: challenge.title,
          brief: challenge.brief,
          entries: rows.length,
          rows: rows.slice(0, 10).map((row) => ({
            owner: row.owner,
            repo: row.repo,
            sha: row.sha,
            code: row.code,
            bytes: row.bytes,
            language: row.language,
          })),
        })),
      },
      200,
      { 'cache-control': `public, max-age=${BOARD_TTL_SECONDS}` },
    );
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
    `<url><loc>${escapeXml(origin)}/code.html</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${escapeXml(origin)}/how.html</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`,
    `<url><loc>${escapeXml(origin)}/sign.html</loc><changefreq>monthly</changefreq><priority>0.9</priority></url>`,
    `<url><loc>${escapeXml(origin)}/pages.html</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${escapeXml(origin)}/convert.html</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${escapeXml(origin)}/inspect.html</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${escapeXml(origin)}/sheet.html</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${escapeXml(origin)}/image.html</loc><changefreq>monthly</changefreq><priority>0.9</priority></url>`,
    `<url><loc>${escapeXml(origin)}/video.html</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${escapeXml(origin)}/zip.html</loc><changefreq>monthly</changefreq><priority>0.9</priority></url>`,
    `<url><loc>${escapeXml(origin)}/lock.html</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${escapeXml(origin)}/pgp.html</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${escapeXml(origin)}/unlock.html</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`,
    `<url><loc>${escapeXml(origin)}/shrink.html</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`,
    `<url><loc>${escapeXml(origin)}/security.html</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>`,
    `<url><loc>${escapeXml(origin)}/board</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
    `<url><loc>${escapeXml(origin)}/golf</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
    // Each challenge is a page someone might search for by name — "url shortener
    // in the fewest lines of code" is a real thing people look up.
    ...CHALLENGES.map(
      (c) =>
        `<url><loc>${escapeXml(origin)}/golf/${escapeXml(c.id)}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    ),
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
/**
 * `/?repo=x` and `/?challenge=y` used to open the counter with something filled
 * in. The landing page has no form, so those go to /code.html with the query
 * intact. A bare "/" is left alone — that is the landing page now.
 */
export function redirectMovedCounter(url: URL): Response | null {
  if (url.pathname !== '/') return null;
  if (!url.searchParams.has('repo') && !url.searchParams.has('challenge')) return null;
  const to = new URL(url);
  to.pathname = '/code.html';
  return Response.redirect(to.toString(), 302);
}

/**
 * Pages that no longer exist but have links out in the world.
 *
 * /pdf.html was merge/split/reorder; it is retired in favour of the editor,
 * which is now the PDF tool. A permanent redirect keeps old links, shared
 * screenshots and search results landing somewhere useful instead of on a 404.
 */
const RETIRED_PAGES: Record<string, string> = {
  '/pdf.html': '/sign.html',
};

export function redirectRetiredPage(url: URL): Response | null {
  const to = RETIRED_PAGES[url.pathname];
  if (!to) return null;
  const target = new URL(url);
  target.pathname = to;
  return new Response(null, {
    status: 301,
    headers: {
      location: target.toString(),
      'cache-control': 'public, max-age=3600',
      ...SECURITY_HEADERS,
    },
  });
}

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

/**
 * The page that is exactly 1999 bytes long.
 *
 * Served from a string rather than from public/ so that what a visitor counts
 * with `curl | wc -c` is this exact constant, with no build step, no editor's
 * trailing newline and no asset pipeline able to get between the claim and the
 * thing claimed.
 *
 * Content-Length is set here for honesty rather than for the visitor: the edge
 * re-encodes the response and drops it before anyone sees it, which was checked
 * against the live site rather than assumed. Counting the body is the check
 * that works, and it is the one the page asks for.
 */
function exactly1999(): Response {
  const body = new TextEncoder().encode(EXACTLY_1999);
  return new Response(body, {
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'public, max-age=3600',
    },
  });
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

// ---------------------------------------------------------------------------
// Monero node proxy
// ---------------------------------------------------------------------------

/** Response headers common to every proxied reply: the site policy, plus a hard
 *  no-store so a wallet's sync data never lingers in a shared cache. */
const XMR_PROXY_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
};

/**
 * Forward a wallet's RPC call to the chosen Monero node.
 *
 * The wallet page can only reach this origin (connect-src 'self'), so it points
 * monero-ts at `/api/xmr/<mode>/<node>` and the library appends the RPC method.
 * resolveXmrTarget does all the deciding: it turns the path into a concrete node
 * URL or refuses it, gating both the node (curated id or a validated custom
 * https host, never a private address) and the method (a single daemon
 * endpoint). This function is only plumbing: stream the body across, hand back
 * the node's status and bytes, and let nothing be cached.
 */
async function proxyXmr(request: Request, path: string): Promise<Response> {
  if (request.method !== 'POST' && request.method !== 'GET') {
    return jsonError({ status: 405, code: 'method_not_allowed', message: 'Use GET or POST.' });
  }

  const segments = path.replace(/^\/api\/xmr\//, '').split('/').filter(Boolean).map(decodeURIComponent);
  const target = resolveXmrTarget(segments);
  if (!target.ok || !target.url) {
    return new Response(JSON.stringify({ error: { code: 'bad_node', message: target.problem ?? 'Cannot forward that.' } }), {
      status: target.status ?? 400,
      headers: { 'content-type': 'application/json; charset=utf-8', ...XMR_PROXY_HEADERS },
    });
  }

  // A generous but finite ceiling on a request body, so the proxy cannot be
  // pushed into forwarding something enormous. A real signed transaction is a
  // few kilobytes; wallet sync requests are smaller.
  const body = request.method === 'POST' ? await request.arrayBuffer() : undefined;
  if (body && body.byteLength > 1_000_000) {
    return jsonError({ status: 413, code: 'too_large', message: 'That request body is too large to forward.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const upstream = await fetch(target.url, {
      method: request.method,
      // Only the content type is forwarded. The visitor's cookies, referrer,
      // user-agent and IP are deliberately NOT: that privacy is the point of
      // proxying rather than letting the browser hit the node directly.
      headers: { 'content-type': request.headers.get('content-type') ?? 'application/octet-stream' },
      body,
      signal: controller.signal,
      // 'manual', not 'error': the Workers runtime rejects redirect: 'error'
      // (it threw on every request, so no node was ever reachable), and 'manual'
      // still does NOT follow a redirect, which is the SSRF property we want. A
      // node has no business redirecting an RPC call, so a 3xx is refused rather
      // than chased toward wherever it points.
      redirect: 'manual',
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      return new Response(
        JSON.stringify({ error: { code: 'node_redirected', message: 'That node answered with a redirect, which this will not follow.' } }),
        { status: 502, headers: { 'content-type': 'application/json; charset=utf-8', ...XMR_PROXY_HEADERS } },
      );
    }

    // Pass the node's own content type through (json_rpc is JSON, the sync
    // endpoints are binary), but replace every other header with our own.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        ...XMR_PROXY_HEADERS,
      },
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return new Response(
      JSON.stringify({ error: { code: aborted ? 'node_timeout' : 'node_unreachable', message: aborted ? 'The node did not answer in time.' : 'Could not reach that node.' } }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8', ...XMR_PROXY_HEADERS } },
    );
  } finally {
    clearTimeout(timeout);
  }
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

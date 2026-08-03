/**
 * Direct GitHub OAuth (no Supabase — see README "Why not Supabase").
 *
 * The user's GitHub access token never leaves the Worker: it is stored in KV
 * under an opaque session id, and the browser only ever holds that id in an
 * HttpOnly cookie. Nothing token-shaped is logged or rendered.
 */

import { exchangeOAuthCode, GitHubClient } from '../lib/github';
import { baseUrl, type Env } from './env';

const SESSION_COOKIE = 'loc_sid';
const STATE_COOKIE = 'loc_state';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATE_TTL_SECONDS = 600;

/**
 * Least privilege by default.
 *
 * A classic OAuth App has no read-only scope for private repositories: the only
 * option is `repo`, which grants read AND WRITE to every private repository the
 * user can reach. For a tool that counts lines, that is an absurd amount of
 * power to hold, so it is never requested unless a deployment opts in.
 *
 * The right way to support private repositories is a GitHub App with
 * `contents: read`, which the user installs on selected repositories. GitHub
 * Apps carry no scope parameter — permissions live on the app — so setting
 * GITHUB_OAUTH_SCOPES to an empty string selects that mode.
 *
 *   unset            "read:user"    public repositories, higher rate limit
 *   ""               (none sent)    GitHub App: permissions come from the app
 *   "read:user repo" as written     OAuth App with full private read/write
 */
const DEFAULT_SCOPES = 'read:user';

export function scopesFor(env: Env): string | null {
  const configured = env.GITHUB_OAUTH_SCOPES;
  if (configured === undefined) return DEFAULT_SCOPES;
  const trimmed = configured.trim();
  return trimmed === '' ? null : trimmed;
}

export interface Session {
  token: string;
  login: string;
  avatar_url: string;
  created_at: number;
}

function randomId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie');
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  const attrs = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

export function sessionKey(id: string): string {
  return `sess:${id}`;
}

export async function loadSession(request: Request, env: Env): Promise<Session | null> {
  if (!env.LOC_KV) return null;
  const id = parseCookies(request)[SESSION_COOKIE];
  if (!id || !/^[0-9a-f]{64}$/.test(id)) return null;
  const raw = await env.LOC_KV.get(sessionKey(id), 'json');
  if (!raw) return null;
  const session = raw as Session;
  if (typeof session.token !== 'string' || typeof session.login !== 'string') return null;
  return session;
}

export function oauthConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.LOC_KV);
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (!oauthConfigured(env)) {
    return new Response('GitHub OAuth is not configured on this deployment.', {
      status: 501,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const state = randomId();
  const redirectUri = `${baseUrl(env, request)}/api/auth/callback`;
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID!);
  authorize.searchParams.set('redirect_uri', redirectUri);
  const scopes = scopesFor(env);
  if (scopes !== null) authorize.searchParams.set('scope', scopes);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('allow_signup', 'false');

  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      'set-cookie': cookie(STATE_COOKIE, state, STATE_TTL_SECONDS, isSecure(request)),
      'cache-control': 'no-store',
    },
  });
}

export async function handleCallback(request: Request, env: Env): Promise<Response> {
  if (!oauthConfigured(env)) return new Response('OAuth not configured.', { status: 501 });

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = parseCookies(request)[STATE_COOKIE];

  const fail = (message: string) =>
    new Response(null, {
      status: 302,
      headers: {
        location: `/?error=${encodeURIComponent(message)}`,
        'set-cookie': cookie(STATE_COOKIE, '', 0, isSecure(request)),
      },
    });

  if (url.searchParams.get('error')) {
    return fail(url.searchParams.get('error_description') ?? 'GitHub denied the authorization.');
  }
  if (!code || !state || !expected || state !== expected) {
    return fail('OAuth state mismatch. Try connecting again.');
  }

  try {
    const token = await exchangeOAuthCode(
      env.GITHUB_CLIENT_ID!,
      env.GITHUB_CLIENT_SECRET!,
      code,
      `${baseUrl(env, request)}/api/auth/callback`,
    );
    const user = await new GitHubClient(token).getAuthenticatedUser();
    const id = randomId();
    const session: Session = {
      token,
      login: user.login,
      avatar_url: user.avatar_url,
      created_at: Date.now(),
    };
    await env.LOC_KV!.put(sessionKey(id), JSON.stringify(session), {
      expirationTtl: SESSION_TTL_SECONDS,
    });

    const headers = new Headers({ location: '/', 'cache-control': 'no-store' });
    headers.append('set-cookie', cookie(SESSION_COOKIE, id, SESSION_TTL_SECONDS, isSecure(request)));
    headers.append('set-cookie', cookie(STATE_COOKIE, '', 0, isSecure(request)));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    // Never surface the raw error: it can contain the code or client secret.
    console.log(JSON.stringify({ event: 'oauth_error', message: (error as Error).message }));
    return fail('Could not complete the GitHub sign-in.');
  }
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const id = parseCookies(request)[SESSION_COOKIE];
  if (id && env.LOC_KV && /^[0-9a-f]{64}$/.test(id)) {
    await env.LOC_KV.delete(sessionKey(id));
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': cookie(SESSION_COOKIE, '', 0, isSecure(request)),
      'cache-control': 'no-store',
    },
  });
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  const session = await loadSession(request, env);
  // The scope is reported so the page can state exactly what connecting grants,
  // before the user clicks anything.
  const body = session
    ? { authenticated: true, login: session.login, avatar_url: session.avatar_url }
    : {
        authenticated: false,
        oauth_available: oauthConfigured(env),
        scopes: scopesFor(env),
        private_repos: (scopesFor(env) ?? '').split(/\s+/).includes('repo') || scopesFor(env) === null,
      };
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function handleMyRepos(request: Request, env: Env): Promise<Response> {
  const session = await loadSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: { code: 'unauthenticated', message: 'Connect GitHub first.' } }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const repos = await new GitHubClient(session.token).listUserRepos(50);
  return new Response(JSON.stringify({ repos }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

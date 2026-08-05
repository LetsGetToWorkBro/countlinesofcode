/**
 * GitHub REST client.
 *
 * SSRF posture: the base URL is a constant, every path segment is built from
 * values that already passed the validators in parse-url.ts, and the only other
 * host we ever fetch is the codeload.github.com redirect target for archives —
 * which is verified against an allowlist before the second request is made.
 * User input never reaches `new URL()` as a whole URL.
 */

import { sleep } from './pool';

export const GITHUB_API = 'https://api.github.com';
const ARCHIVE_HOSTS = new Set(['codeload.github.com', 'objects.githubusercontent.com']);
const USER_AGENT = '1999.LOC (+https://github.com/letsgettoworkbro/countlinesofcode)';

export type GitHubErrorKind =
  | 'not_found'
  | 'unauthorized'
  | 'rate_limited'
  | 'too_large'
  | 'empty_repo'
  | 'server'
  | 'network'
  | 'bad_response';

export class GitHubError extends Error {
  override readonly name = 'GitHubError';
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    readonly status = 0,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  resetEpochSeconds: number | null;
}

export interface RepoInfo {
  full_name: string;
  owner: string;
  repo: string;
  default_branch: string;
  private: boolean;
  /** Repository size in KiB, as reported by GitHub. */
  size_kb: number;
  stars: number;
  html_url: string;
  archived: boolean;
  fork: boolean;
  description: string | null;
}

export interface TreeEntry {
  path: string;
  /** 'blob' | 'tree' | 'commit' (submodule) */
  type: string;
  sha: string;
  size: number;
  mode: string;
}

export interface RepoTree {
  entries: TreeEntry[];
  truncated: boolean;
}

export interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
}

export interface UserRepoSummary {
  full_name: string;
  private: boolean;
  updated_at: string;
}

interface RequestOptions {
  accept?: string;
  method?: string;
  body?: string;
  contentType?: string;
  /** Retries on 429/403-secondary/5xx. Default 3. */
  retries?: number;
  signal?: AbortSignal;
}

const MAX_BACKOFF_MS = 8000;

export class GitHubClient {
  readonly rateLimit: RateLimitInfo = { limit: null, remaining: null, resetEpochSeconds: null };
  /** Number of outbound requests made, for the timing/observability payload. */
  requestCount = 0;

  constructor(private readonly token?: string) {}

  get authenticated(): boolean {
    return Boolean(this.token);
  }

  private headers(accept: string): HeadersInit {
    const headers: Record<string, string> = {
      Accept: accept,
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return headers;
  }

  private captureRateLimit(response: Response): void {
    const limit = response.headers.get('x-ratelimit-limit');
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    if (limit !== null) this.rateLimit.limit = Number(limit);
    if (remaining !== null) this.rateLimit.remaining = Number(remaining);
    if (reset !== null) this.rateLimit.resetEpochSeconds = Number(reset);
  }

  /** Raw request with retry/backoff. Path must already be encoded. */
  async fetchRaw(path: string, options: RequestOptions = {}): Promise<Response> {
    const url = `${GITHUB_API}${path}`;
    const retries = options.retries ?? 3;
    const accept = options.accept ?? 'application/vnd.github+json';

    let attempt = 0;
    for (;;) {
      let response: Response;
      this.requestCount++;
      try {
        const headers = new Headers(this.headers(accept));
        if (options.contentType) headers.set('Content-Type', options.contentType);
        response = await fetch(url, {
          method: options.method ?? 'GET',
          headers,
          body: options.body,
          signal: options.signal,
          redirect: 'follow',
        });
      } catch (error) {
        if (attempt < retries) {
          await sleep(backoffMs(attempt));
          attempt++;
          continue;
        }
        throw new GitHubError('network', `Network error talking to GitHub: ${String(error)}`);
      }

      this.captureRateLimit(response);

      if (response.ok) return response;

      const retryAfter = numberOrNull(response.headers.get('retry-after'));

      if (response.status === 429 || (response.status === 403 && this.isRateLimited(response))) {
        const waitMs = this.rateLimitWaitMs(retryAfter);
        if (attempt < retries && waitMs !== null && waitMs <= MAX_BACKOFF_MS) {
          await sleep(waitMs);
          attempt++;
          continue;
        }
        await response.body?.cancel();
        throw new GitHubError(
          'rate_limited',
          this.token
            ? 'GitHub rate limit reached for this token. Try again shortly.'
            : 'GitHub rate limit reached for anonymous requests. Connect GitHub for a much higher limit.',
          response.status,
          retryAfter ?? this.secondsUntilReset() ?? undefined,
        );
      }

      if (response.status >= 500 && attempt < retries) {
        await response.body?.cancel();
        await sleep(backoffMs(attempt));
        attempt++;
        continue;
      }

      const detail = await safeErrorMessage(response);
      throw new GitHubError(kindForStatus(response.status), detail, response.status);
    }
  }

  private isRateLimited(response: Response): boolean {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === '0') return true;
    return response.headers.has('retry-after');
  }

  private secondsUntilReset(): number | null {
    const reset = this.rateLimit.resetEpochSeconds;
    if (reset === null) return null;
    return Math.max(0, reset - Math.floor(Date.now() / 1000));
  }

  private rateLimitWaitMs(retryAfter: number | null): number | null {
    if (retryAfter !== null) return retryAfter * 1000;
    const seconds = this.secondsUntilReset();
    if (seconds === null) return null;
    return seconds * 1000;
  }

  private async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.fetchRaw(path, options);
    try {
      return (await response.json()) as T;
    } catch {
      throw new GitHubError('bad_response', 'GitHub returned a response we could not parse.');
    }
  }

  async getRepo(owner: string, repo: string): Promise<RepoInfo> {
    const data = await this.json<{
      full_name: string;
      default_branch: string;
      private: boolean;
      size: number;
      stargazers_count: number;
      html_url: string;
      archived: boolean;
      fork: boolean;
      description: string | null;
      owner: { login: string };
      name: string;
    }>(`/repos/${owner}/${repo}`);
    return {
      full_name: data.full_name,
      owner: data.owner?.login ?? owner,
      repo: data.name ?? repo,
      default_branch: data.default_branch,
      private: data.private,
      size_kb: data.size ?? 0,
      stars: data.stargazers_count ?? 0,
      html_url: data.html_url,
      archived: Boolean(data.archived),
      fork: Boolean(data.fork),
      description: data.description ?? null,
    };
  }

  /**
   * Resolve a branch/tag/sha to a full commit sha. `application/vnd.github.sha`
   * returns the bare sha as text, which is the cheapest form of this call.
   */
  async resolveSha(owner: string, repo: string, ref: string): Promise<string> {
    const response = await this.fetchRaw(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
      { accept: 'application/vnd.github.sha' },
    );
    const text = (await response.text()).trim();
    if (/^[0-9a-f]{40}$/i.test(text)) return text.toLowerCase();
    // Some proxies ignore the media type and hand back JSON.
    try {
      const parsed = JSON.parse(text) as { sha?: string };
      if (parsed.sha && /^[0-9a-f]{40}$/i.test(parsed.sha)) return parsed.sha.toLowerCase();
    } catch {
      /* fall through */
    }
    throw new GitHubError('bad_response', `Could not resolve "${ref}" to a commit.`);
  }

  async getTree(owner: string, repo: string, sha: string): Promise<RepoTree> {
    const data = await this.json<{
      tree?: { path: string; type: string; sha: string; size?: number; mode: string }[];
      truncated?: boolean;
    }>(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
    if (!Array.isArray(data.tree)) {
      throw new GitHubError('bad_response', 'GitHub returned an unexpected tree payload.');
    }
    return {
      truncated: Boolean(data.truncated),
      entries: data.tree.map((entry) => ({
        path: entry.path,
        type: entry.type,
        sha: entry.sha,
        size: entry.size ?? 0,
        mode: entry.mode,
      })),
    };
  }

  /** Fetch a blob's raw bytes by its object sha. */
  async getBlob(owner: string, repo: string, blobSha: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.fetchRaw(`/repos/${owner}/${repo}/git/blobs/${blobSha}`, {
      accept: 'application/vnd.github.raw',
      signal,
    });
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /**
   * Open the repository tarball at a pinned sha.
   *
   * The API 302s to codeload.github.com. We follow it manually and drop the
   * Authorization header on the second hop: codeload authenticates via the
   * signed URL, and sending both mechanisms is an error.
   */
  async openTarball(owner: string, repo: string, sha: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    let url = `${GITHUB_API}/repos/${owner}/${repo}/tarball/${sha}`;
    // Renamed or transferred repositories 301 within the API first
    // (/repos/facebook/react -> /repos/react/react), and only then 302 out to
    // codeload. So follow redirects manually, deciding per hop whether the
    // Authorization header may travel: yes to GitHub's API, never to the
    // archive host, which authenticates via its signed URL and rejects both.
    let sendAuth = true;

    for (let hop = 0; hop < 5; hop++) {
      this.requestCount++;
      const response = await fetch(url, {
        headers: sendAuth
          ? this.headers('application/vnd.github+json')
          : { 'User-Agent': USER_AGENT, Accept: 'application/x-gzip' },
        redirect: 'manual',
        signal,
      });
      this.captureRateLimit(response);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new GitHubError('bad_response', 'GitHub archive redirect had no location.');
        let target: URL;
        try {
          target = new URL(location, url);
        } catch {
          throw new GitHubError('bad_response', 'GitHub archive redirect was not a URL.');
        }
        if (target.protocol !== 'https:') {
          throw new GitHubError('bad_response', 'Refusing to follow a non-HTTPS archive redirect.');
        }
        if (target.hostname === 'api.github.com') {
          sendAuth = true;
        } else if (ARCHIVE_HOSTS.has(target.hostname)) {
          sendAuth = false;
        } else {
          throw new GitHubError('bad_response', `Refusing to follow archive redirect to ${target.hostname}.`);
        }
        url = target.toString();
        continue;
      }

      if (!response.ok) {
        const detail = await safeErrorMessage(response);
        throw new GitHubError(kindForStatus(response.status), detail, response.status);
      }
      if (!response.body) throw new GitHubError('bad_response', 'GitHub archive response had no body.');
      return response.body;
    }

    throw new GitHubError('bad_response', 'Too many redirects fetching the repository archive.');
  }

  async getAuthenticatedUser(): Promise<GitHubUser> {
    const data = await this.json<{ login: string; avatar_url: string; name: string | null }>('/user');
    return { login: data.login, avatar_url: data.avatar_url, name: data.name ?? null };
  }

  async listUserRepos(limit = 50): Promise<UserRepoSummary[]> {
    const perPage = Math.min(100, Math.max(1, limit));
    const data = await this.json<
      { full_name: string; private: boolean; updated_at: string }[]
    >(`/user/repos?per_page=${perPage}&sort=updated&affiliation=owner,collaborator,organization_member`);
    if (!Array.isArray(data)) return [];
    return data.slice(0, limit).map((r) => ({
      full_name: r.full_name,
      private: r.private,
      updated_at: r.updated_at,
    }));
  }
}

function backoffMs(attempt: number): number {
  // 250ms, 500ms, 1000ms, ... with jitter, capped.
  const base = Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function kindForStatus(status: number): GitHubErrorKind {
  if (status === 404) return 'not_found';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'unauthorized';
  if (status === 409) return 'empty_repo';
  if (status === 413) return 'too_large';
  if (status >= 500) return 'server';
  return 'bad_response';
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return `GitHub returned HTTP ${response.status}.`;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) return parsed.message;
    } catch {
      /* not json */
    }
    return text.slice(0, 200);
  } catch {
    return `GitHub returned HTTP ${response.status}.`;
  }
}

/** Exchange an OAuth code for a user access token. */
export async function exchangeOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<string> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    throw new GitHubError('unauthorized', `Token exchange failed with HTTP ${response.status}.`);
  }
  const data = (await response.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!data.access_token) {
    throw new GitHubError('unauthorized', data.error_description ?? data.error ?? 'Token exchange failed.');
  }
  return data.access_token;
}

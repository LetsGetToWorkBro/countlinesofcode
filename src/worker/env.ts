import { DEFAULT_LIMITS, type CountLimits } from '../lib/counter';

export interface Env {
  ASSETS?: Fetcher;
  LOC_KV?: KVNamespace;
  /** Storage for the temporary-inbox tool (D1). */
  MAIL_DB?: D1Database;
  /** The domain throwaway addresses are handed out on. */
  MAIL_DOMAIN?: string;
  /** Free partner key from changenow.io; unset means the swap page quotes
   *  the two keyless desks, Exolix and Godex. Set with
   *  `npx wrangler secret put CHANGENOW_API_KEY`. */
  CHANGENOW_API_KEY?: string;

  APP_BASE_URL?: string;
  CANONICAL_ORIGIN?: string;
  MAX_FILES?: string;
  MAX_TOTAL_BYTES?: string;
  MAX_FILE_BYTES?: string;
  MAX_BLOB_FETCHES?: string;
  MAX_COUNT_BYTES?: string;
  FETCH_CONCURRENCY?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  PROXY_RATE_LIMIT_PER_MINUTE?: string;
  SWAP_RATE_LIMIT_PER_MINUTE?: string;

  /** Optional server token used for anonymous requests. */
  GITHUB_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** See scopesFor() in auth.ts. Unset = read:user. Empty string = GitHub App. */
  GITHUB_OAUTH_SCOPES?: string;
  /** The site's Tor onion mirror, advertised with Onion-Location. Set with
   *  `npm run onion:set <host>.onion`; unset means no mirror is announced. */
  ONION_HOST?: string;

  /** Commit the running build came from, for verifiability. */
  SOURCE_COMMIT?: string;
}

function intVar(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function limitsFromEnv(env: Env): CountLimits {
  return {
    maxFiles: intVar(env.MAX_FILES, DEFAULT_LIMITS.maxFiles),
    maxTotalBytes: intVar(env.MAX_TOTAL_BYTES, DEFAULT_LIMITS.maxTotalBytes),
    maxFileBytes: intVar(env.MAX_FILE_BYTES, DEFAULT_LIMITS.maxFileBytes),
    maxBlobFetches: intVar(env.MAX_BLOB_FETCHES, DEFAULT_LIMITS.maxBlobFetches),
    maxCountBytes: intVar(env.MAX_COUNT_BYTES, DEFAULT_LIMITS.maxCountBytes),
    concurrency: intVar(env.FETCH_CONCURRENCY, DEFAULT_LIMITS.concurrency),
  };
}

export function rateLimitPerMinute(env: Env): number {
  return intVar(env.RATE_LIMIT_PER_MINUTE, 20);
}

/** The node proxies: a wallet sync legitimately makes a burst of RPC calls,
 *  so the ceiling is high; it exists to stop request-flooding through the
 *  relay, not to meter a wallet. */
export function proxyRateLimitPerMinute(env: Env): number {
  return intVar(env.PROXY_RATE_LIMIT_PER_MINUTE, 240);
}

/** The swap endpoints spend the deployment's ChangeNOW key upstream, so the
 *  cap is conservative: quoting and a status poll fit well inside it. */
export function swapRateLimitPerMinute(env: Env): number {
  return intVar(env.SWAP_RATE_LIMIT_PER_MINUTE, 30);
}

/**
 * Base URL for OAuth redirects. Falls back to the request's own origin so
 * `wrangler dev` and preview deployments work without extra configuration.
 */
export function baseUrl(env: Env, request: Request): string {
  if (env.APP_BASE_URL && /^https?:\/\//.test(env.APP_BASE_URL)) {
    return env.APP_BASE_URL.replace(/\/$/, '');
  }
  return new URL(request.url).origin;
}

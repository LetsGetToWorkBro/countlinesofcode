import { DEFAULT_LIMITS, type CountLimits } from '../lib/counter';

export interface Env {
  ASSETS?: Fetcher;
  LOC_KV?: KVNamespace;
  /** Storage for the temporary-inbox tool (D1). */
  MAIL_DB?: D1Database;
  /** The domain throwaway addresses are handed out on. */
  MAIL_DOMAIN?: string;

  APP_BASE_URL?: string;
  CANONICAL_ORIGIN?: string;
  MAX_FILES?: string;
  MAX_TOTAL_BYTES?: string;
  MAX_FILE_BYTES?: string;
  MAX_BLOB_FETCHES?: string;
  MAX_COUNT_BYTES?: string;
  FETCH_CONCURRENCY?: string;
  RATE_LIMIT_PER_MINUTE?: string;

  /** Optional server token used for anonymous requests. */
  GITHUB_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** See scopesFor() in auth.ts. Unset = read:user. Empty string = GitHub App. */
  GITHUB_OAUTH_SCOPES?: string;
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

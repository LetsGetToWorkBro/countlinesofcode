/**
 * KV-backed caches.
 *
 * Results are keyed by the *immutable* commit sha, never by branch name, so a
 * cached entry can never go stale. Branch -> sha resolution is cached
 * separately for a short window purely to save one API call on repeat hits.
 *
 * The counter version and the option flags are part of the key: bumping the
 * version or flipping "include lockfiles" produces a different entry rather
 * than a wrong hit.
 */

import type { CountOptions, CountResult } from './schema';
import { CountResultSchema } from './schema';
import { COUNTER_VERSION } from './version';

/** 7 days — sha-pinned results are immutable, this is just a size bound. */
export const RESULT_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Branch heads move; 60s is enough to absorb a reload without going stale. */
export const REF_TTL_SECONDS = 60;

function optionSuffix(options: CountOptions): string {
  return `L${options.includeLockfiles ? 1 : 0}V${options.includeVendored ? 1 : 0}`;
}

export function resultKey(owner: string, repo: string, sha: string, options: CountOptions): string {
  return `res:${COUNTER_VERSION}:${owner.toLowerCase()}/${repo.toLowerCase()}@${sha.toLowerCase()}:${optionSuffix(options)}`;
}

export function refKey(owner: string, repo: string, ref: string): string {
  return `ref:${owner.toLowerCase()}/${repo.toLowerCase()}@${ref}`;
}

export class ResultCache {
  constructor(private readonly kv: KVNamespace | undefined) {}

  get enabled(): boolean {
    return this.kv !== undefined;
  }

  async get(owner: string, repo: string, sha: string, options: CountOptions): Promise<CountResult | null> {
    if (!this.kv) return null;
    const raw = await this.kv.get(resultKey(owner, repo, sha, options), 'json');
    if (raw === null) return null;
    const parsed = CountResultSchema.safeParse(raw);
    if (!parsed.success) return null; // shape drifted: treat as a miss
    return parsed.data;
  }

  async put(result: CountResult): Promise<void> {
    if (!this.kv) return;
    const key = resultKey(result.owner, result.repo, result.sha, result.options);
    await this.kv.put(key, JSON.stringify(result), { expirationTtl: RESULT_TTL_SECONDS });
  }

  async getRefSha(owner: string, repo: string, ref: string): Promise<string | null> {
    if (!this.kv) return null;
    const value = await this.kv.get(refKey(owner, repo, ref), 'text');
    return value && /^[0-9a-f]{40}$/.test(value) ? value : null;
  }

  async putRefSha(owner: string, repo: string, ref: string, sha: string): Promise<void> {
    if (!this.kv) return;
    await this.kv.put(refKey(owner, repo, ref), sha, { expirationTtl: REF_TTL_SECONDS });
  }
}

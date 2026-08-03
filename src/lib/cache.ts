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

import type { BoardEntry } from './board';
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

interface ResultMetadata {
  counted_at?: string;
  owner?: string;
  repo?: string;
  lines?: number;
  code?: number;
  comment?: number;
  blank?: number;
  files?: number;
  stars?: number;
  fork?: boolean;
  not_yours?: number;
  /**
   * Private repositories share this prefix, so anything that enumerates the
   * cache has to know which entries may never be shown to the public. Absent on
   * entries written before this field existed, which is why the public listings
   * below fail closed rather than assuming public.
   */
  private?: boolean;
}

/** Inverse of `resultKey`, for default-option entries only. */
export function parseResultKey(key: string): { owner: string; repo: string; sha: string } | null {
  const match = new RegExp(
    `^res:${COUNTER_VERSION.replace(/\./g, '\\.')}:([^/]+)/([^@]+)@([0-9a-f]{40}):L0V0$`,
  ).exec(key);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, sha: match[3]! };
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
    await this.kv.put(key, JSON.stringify(result), {
      expirationTtl: RESULT_TTL_SECONDS,
      // Everything the sitemap and the leaderboards need, kept in metadata so
      // both can be built from a single list() call rather than reading back
      // every cached result. owner/repo are stored because the key lowercases
      // them, and a sitemap advertising different casing from a page's own
      // canonical tag wastes crawl budget.
      metadata: {
        counted_at: result.counted_at,
        owner: result.owner,
        repo: result.repo,
        lines: result.totals.lines,
        code: result.totals.code,
        comment: result.totals.comment,
        blank: result.totals.blank,
        files: result.totals.files,
        stars: result.repo_meta.stars,
        fork: result.repo_meta.fork,
        // Files present but not written here: vendored plus generated.
        not_yours: result.skipped.vendored + result.skipped.generated,
        private: result.repo_meta.private,
      },
    });
  }

  /**
   * Cached results, newest-listing-first, for the sitemap. Only entries counted
   * with the default options are returned: the option variants render the same
   * page at the same URL, so including them would emit duplicates.
   *
   * Private repositories are excluded — a sitemap advertising `owner/secret`
   * leaks the repository's existence even though the page itself refuses to
   * render for anyone without access.
   */
  async listForSitemap(limit = 1000): Promise<{ owner: string; repo: string; sha: string; lastmod?: string }[]> {
    if (!this.kv) return [];
    const listed = await this.kv.list<ResultMetadata>({
      prefix: `res:${COUNTER_VERSION}:`,
      limit: Math.min(1000, limit),
    });
    const out: { owner: string; repo: string; sha: string; lastmod?: string }[] = [];
    for (const key of listed.keys) {
      const parsed = parseResultKey(key.name);
      // Fail closed: an entry written before `private` was recorded is skipped
      // rather than assumed public. It costs at most one result TTL of sitemap
      // coverage, which is the cheaper mistake by a wide margin.
      if (!parsed || key.metadata?.private !== false) continue;
      // Prefer the stored casing; the key itself is normalised to lowercase.
      const owner = key.metadata?.owner ?? parsed.owner;
      const repo = key.metadata?.repo ?? parsed.repo;
      out.push({
        owner,
        repo,
        sha: parsed.sha,
        ...(key.metadata?.counted_at ? { lastmod: key.metadata.counted_at } : {}),
      });
    }
    return out;
  }

  /**
   * Every cached result, as leaderboard rows, from one list() call. Entries
   * written before the metadata existed are skipped rather than guessed at,
   * and private repositories never appear: the boards are public, and someone
   * counting their own private repository is not publishing it.
   */
  async listForBoard(limit = 1000): Promise<BoardEntry[]> {
    if (!this.kv) return [];
    const listed = await this.kv.list<ResultMetadata>({
      prefix: `res:${COUNTER_VERSION}:`,
      limit: Math.min(1000, limit),
    });
    const out: BoardEntry[] = [];
    for (const key of listed.keys) {
      const parsed = parseResultKey(key.name);
      const meta = key.metadata;
      if (!parsed || !meta || typeof meta.lines !== 'number') continue;
      if (meta.private !== false) continue;
      out.push({
        owner: meta.owner ?? parsed.owner,
        repo: meta.repo ?? parsed.repo,
        sha: parsed.sha,
        lines: meta.lines,
        code: meta.code ?? 0,
        comment: meta.comment ?? 0,
        blank: meta.blank ?? 0,
        files: meta.files ?? 0,
        stars: meta.stars ?? 0,
        notYours: meta.not_yours ?? 0,
        fork: meta.fork === true,
        countedAt: meta.counted_at ?? '',
      });
    }
    return out;
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

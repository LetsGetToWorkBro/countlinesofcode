/**
 * The pipeline: repo -> sha -> tree -> filter -> content -> classify -> totals.
 *
 * Two content strategies, picked automatically:
 *
 *   blobs    one Git Blobs API request per file, run through a concurrency
 *            pool. Lowest latency for small repos; costs one subrequest each.
 *   tarball  a single request for the repository archive at the pinned sha,
 *            gunzipped and parsed as a stream. Cloudflare caps subrequests per
 *            request (50 free / 1000 paid), so anything past a few dozen files
 *            has to go this way — and it is faster anyway.
 *
 * The tarball path also rescues repositories whose recursive tree came back
 * truncated (GitHub caps that at ~100k entries / 7 MB): the archive enumerates
 * everything, so we fall back to filtering archive paths directly and say so
 * in `warnings`.
 */

import { Aggregator, countFile } from './count';
import { GitHubClient, GitHubError, type RepoInfo, type TreeEntry } from './github';
import { decidePath, looksBinary, type SkipReason } from './ignore';
import { mapPool } from './pool';
import { gunzipStream, readTar, stripArchiveRoot } from './tar';
import type { CountOptions, CountResult } from './schema';
import { COUNTER_VERSION } from './version';

export interface CountLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  /** Above this many candidate files we switch from blobs to the tarball. */
  maxBlobFetches: number;
  concurrency: number;
}

export const DEFAULT_LIMITS: CountLimits = {
  maxFiles: 20000,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxBlobFetches: 40,
  concurrency: 12,
};

export type ProgressPhase = 'resolve' | 'tree' | 'fetch' | 'count' | 'done';

export interface ProgressEvent {
  phase: ProgressPhase;
  message: string;
  done?: number;
  total?: number;
}

export type ProgressFn = (event: ProgressEvent) => void;

export interface CountParams {
  options: CountOptions;
}

/**
 * A repository pinned to an immutable commit. Resolution is separate from
 * counting so the caller can consult the sha-keyed cache before doing any work.
 */
export interface ResolvedTarget {
  repoInfo: RepoInfo;
  ref: string;
  sha: string;
  resolveMs: number;
}

export interface ShaCache {
  getRefSha(owner: string, repo: string, ref: string): Promise<string | null>;
  putRefSha(owner: string, repo: string, ref: string, sha: string): Promise<void>;
}

export async function resolveTarget(
  client: GitHubClient,
  owner: string,
  repo: string,
  ref: string | undefined,
  cache?: ShaCache,
): Promise<ResolvedTarget> {
  const started = Date.now();
  const repoInfo = await client.getRepo(owner, repo);
  const effectiveRef = ref ?? repoInfo.default_branch;
  if (!effectiveRef) throw new GitHubError('empty_repo', 'This repository has no commits yet.');

  // A 40-char hex ref is already immutable.
  if (/^[0-9a-f]{40}$/i.test(effectiveRef)) {
    return {
      repoInfo,
      ref: effectiveRef.toLowerCase(),
      sha: effectiveRef.toLowerCase(),
      resolveMs: Date.now() - started,
    };
  }

  const cached = repoInfo.private ? null : await cache?.getRefSha(repoInfo.owner, repoInfo.repo, effectiveRef);
  if (cached) {
    return { repoInfo, ref: effectiveRef, sha: cached, resolveMs: Date.now() - started };
  }

  const sha = await client.resolveSha(repoInfo.owner, repoInfo.repo, effectiveRef);
  if (!repoInfo.private) {
    await cache?.putRefSha(repoInfo.owner, repoInfo.repo, effectiveRef, sha).catch(() => undefined);
  }
  return { repoInfo, ref: effectiveRef, sha, resolveMs: Date.now() - started };
}

type SkipCounts = Record<SkipReason, number>;

const SYMLINK_MODE = '120000';

export async function runCount(
  client: GitHubClient,
  target: ResolvedTarget,
  params: CountParams,
  limits: CountLimits,
  onProgress: ProgressFn = () => undefined,
  signal?: AbortSignal,
): Promise<CountResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const skipped: SkipCounts = { binary: 0, vendored: 0, generated: 0, too_large: 0, other: 0 };
  const aggregator = new Aggregator();

  const repoInfo: RepoInfo = target.repoInfo;
  const ref = target.ref;
  const sha = target.sha;
  const resolveMs = target.resolveMs;

  // --- tree ---------------------------------------------------------------
  onProgress({ phase: 'tree', message: 'Listing tree…' });
  const treeStart = Date.now();
  const tree = await client.getTree(repoInfo.owner, repoInfo.repo, sha);
  const treeMs = Date.now() - treeStart;

  if (tree.truncated) {
    warnings.push(
      'GitHub truncated the recursive tree for this repository, so file listing came from the ' +
        'commit archive instead. Totals are complete; per-file blob metadata was unavailable.',
    );
  }

  interface Candidate {
    path: string;
    sha: string;
    size: number;
  }

  const candidates: Candidate[] = [];
  let hitFileLimitEarly = false;
  if (!tree.truncated) {
    for (const entry of tree.entries as TreeEntry[]) {
      if (entry.type !== 'blob') continue;
      if (entry.mode === SYMLINK_MODE) {
        skipped.other++;
        continue;
      }
      const decision = decidePath(entry.path, entry.size, {
        includeLockfiles: params.options.includeLockfiles,
        includeVendored: params.options.includeVendored,
        maxFileBytes: limits.maxFileBytes,
      });
      if (decision.skip) {
        skipped[decision.reason]++;
        continue;
      }
      candidates.push({ path: entry.path, sha: entry.sha, size: entry.size });
    }
    if (candidates.length > limits.maxFiles) {
      skipped.other += candidates.length - limits.maxFiles;
      candidates.length = limits.maxFiles;
      hitFileLimitEarly = true;
    }
    onProgress({
      phase: 'tree',
      message: `${candidates.length} candidate files (${tree.entries.length} tree entries).`,
      total: candidates.length,
    });
  }

  const hitLimits = { files: hitFileLimitEarly, bytes: false };
  let fetchMs = 0;
  let parseMs = 0;
  let strategy: 'blobs' | 'tarball';

  const useTarball = tree.truncated || candidates.length > limits.maxBlobFetches;

  if (!useTarball) {
    // --- blob strategy ----------------------------------------------------
    strategy = 'blobs';
    if (candidates.length === 0) {
      onProgress({ phase: 'count', message: 'Nothing to count.' });
    }
    let completed = 0;
    let totalBytes = 0;
    const fetchStart = Date.now();
    const results = await mapPool(
      candidates,
      limits.concurrency,
      async (candidate) => {
        if (totalBytes > limits.maxTotalBytes) return null;
        const bytes = await client.getBlob(repoInfo.owner, repoInfo.repo, candidate.sha, signal);
        totalBytes += bytes.length;
        return { path: candidate.path, bytes };
      },
      () => {
        completed++;
        if (completed % 5 === 0 || completed === candidates.length) {
          onProgress({
            phase: 'fetch',
            message: `Counting files ${completed}/${candidates.length}…`,
            done: completed,
            total: candidates.length,
          });
        }
      },
    );
    fetchMs = Date.now() - fetchStart;

    const parseStart = Date.now();
    for (const result of results) {
      if (!result) {
        hitLimits.bytes = true;
        skipped.other++;
        continue;
      }
      if (looksBinary(result.bytes)) {
        skipped.binary++;
        continue;
      }
      const counted = countFile(result.path, result.bytes);
      aggregator.add(counted.path, counted.language, counted.bytes, counted.counts);
    }
    parseMs = Date.now() - parseStart;
  } else {
    // --- tarball strategy -------------------------------------------------
    strategy = 'tarball';
    const wantedPaths = tree.truncated ? null : new Set(candidates.map((c) => c.path));
    const expected = wantedPaths ? wantedPaths.size : null;
    onProgress({
      phase: 'fetch',
      message: expected === null ? 'Downloading archive…' : `Downloading archive (${expected} files)…`,
      total: expected ?? undefined,
    });

    const fetchStart = Date.now();
    const body = await client.openTarball(repoInfo.owner, repoInfo.repo, sha, signal);
    let totalBytes = 0;
    let counted = 0;

    const wanted = (rawPath: string, size: number): boolean => {
      const path = stripArchiveRoot(rawPath);
      if (path === null) return false;
      if (counted >= limits.maxFiles) {
        hitLimits.files = true;
        return false;
      }
      if (totalBytes >= limits.maxTotalBytes) {
        hitLimits.bytes = true;
        return false;
      }
      if (wantedPaths) return wantedPaths.has(path);
      const decision = decidePath(path, size, {
        includeLockfiles: params.options.includeLockfiles,
        includeVendored: params.options.includeVendored,
        maxFileBytes: limits.maxFileBytes,
      });
      if (decision.skip) {
        skipped[decision.reason]++;
        return false;
      }
      return true;
    };

    try {
      for await (const entry of readTar(gunzipStream(body), { wanted })) {
        if (signal?.aborted) throw new GitHubError('network', 'Request aborted.');
        if (!entry.data) continue;
        const path = stripArchiveRoot(entry.path);
        if (path === null) continue;

        totalBytes += entry.data.length;
        const parseStart = Date.now();
        if (looksBinary(entry.data)) {
          skipped.binary++;
        } else {
          const result = countFile(path, entry.data);
          aggregator.add(result.path, result.language, result.bytes, result.counts);
        }
        parseMs += Date.now() - parseStart;

        counted++;
        if (counted % 50 === 0) {
          onProgress({
            phase: 'count',
            message:
              expected === null
                ? `Counting files ${counted}…`
                : `Counting files ${counted}/${expected}…`,
            done: counted,
            total: expected ?? undefined,
          });
        }
      }
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError('bad_response', `Failed while reading the repository archive: ${String(error)}`);
    }
    fetchMs = Math.max(0, Date.now() - fetchStart - parseMs);

    if (wantedPaths) {
      // Files the tree listed but the archive did not deliver — usually
      // `export-ignore` in .gitattributes, occasionally an early cap.
      const missing = wantedPaths.size - counted;
      if (missing > 0) skipped.other += missing;
    }
  }

  if (aggregator.totals.files >= limits.maxFiles) hitLimits.files = true;
  if (aggregator.totals.bytes >= limits.maxTotalBytes) hitLimits.bytes = true;
  if (hitLimits.files) {
    warnings.push(`Stopped at the ${limits.maxFiles.toLocaleString()} file cap. Totals are partial.`);
  }
  if (hitLimits.bytes) {
    warnings.push(
      `Stopped at the ${(limits.maxTotalBytes / (1024 * 1024)).toFixed(0)} MiB text cap. Totals are partial.`,
    );
  }
  if (skipped.too_large > 0) {
    warnings.push(
      `${skipped.too_large} file(s) exceeded the ${(limits.maxFileBytes / (1024 * 1024)).toFixed(0)} MiB per-file cap and were skipped.`,
    );
  }
  if (aggregator.totals.files === 0 && warnings.length === 0) {
    warnings.push('No countable text files were found. Everything was binary, vendored or generated.');
  }

  onProgress({ phase: 'done', message: 'Done.' });

  const result: CountResult = {
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    full_name: repoInfo.full_name,
    sha,
    ref,
    default_branch: repoInfo.default_branch,
    cached: false,
    duration_ms: Date.now() - started + resolveMs,
    counted_at: new Date().toISOString(),
    totals: {
      files: aggregator.totals.files,
      bytes: aggregator.totals.bytes,
      lines: aggregator.totals.lines,
      code: aggregator.totals.code,
      comment: aggregator.totals.comment,
      blank: aggregator.totals.blank,
    },
    by_language: aggregator.languages(),
    biggest_files: aggregator.biggestFiles(),
    skipped,
    repo_meta: {
      stars: repoInfo.stars,
      size_kb: repoInfo.size_kb,
      private: repoInfo.private,
      archived: repoInfo.archived,
      fork: repoInfo.fork,
      description: repoInfo.description,
      html_url: repoInfo.html_url,
    },
    options: params.options,
    strategy,
    languages_without_comment_rules: [...aggregator.languagesWithoutCommentRules].sort(),
    warnings,
    timing: { resolve_ms: resolveMs, tree_ms: treeMs, fetch_ms: fetchMs, parse_ms: parseMs },
    limits: {
      max_files: limits.maxFiles,
      max_total_bytes: limits.maxTotalBytes,
      max_file_bytes: limits.maxFileBytes,
      hit_file_limit: hitLimits.files,
      hit_byte_limit: hitLimits.bytes,
      tree_truncated: tree.truncated,
    },
    github_requests: client.requestCount,
    rate_limit_remaining: client.rateLimit.remaining,
    counter_version: COUNTER_VERSION,
  };

  return result;
}

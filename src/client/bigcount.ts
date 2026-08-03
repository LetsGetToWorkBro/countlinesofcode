/**
 * Browser-side counting ("big repo mode").
 *
 * Bundled to public/bigcount.js by scripts/build-client.mjs and loaded on
 * demand, only when the server refuses a repository as too large.
 *
 * The point: Cloudflare caps CPU per request (10 ms on the free plan), but a
 * browser tab has no such limit. The Worker streams the archive through without
 * touching it, and everything expensive — gunzip, tar parsing, classification —
 * happens here, using the *same* modules the Worker uses. There is no second
 * implementation to keep in sync, so browser results and server results agree
 * by construction.
 *
 * Nothing is cached server-side from this path: the server cannot verify a
 * result it did not compute, and accepting client-submitted totals would let
 * anyone poison the shared cache.
 */

import { Aggregator, countFile } from '../lib/count';
import { decidePath, looksBinary, type SkipReason } from '../lib/ignore';
import { gunzipStream, readTar, stripArchiveRoot } from '../lib/tar';
import { COUNTER_VERSION } from '../lib/version';

export interface BrowserCountOptions {
  includeLockfiles?: boolean;
  includeVendored?: boolean;
  maxFileBytes?: number;
  onProgress?: (files: number, bytes: number) => void;
  /** Lets the page's Stop button abort the download and the counting. */
  signal?: AbortSignal;
}

export interface ResolvedRepo {
  owner: string;
  repo: string;
  full_name: string;
  sha: string;
  ref: string;
  default_branch: string;
  repo_meta: {
    stars: number;
    size_kb: number;
    private: boolean;
    archived: boolean;
    fork: boolean;
    description: string | null;
    html_url: string;
  };
}

/**
 * Stream the archive at `archiveUrl`, count everything in it, and return a
 * payload shaped exactly like the server's so the same renderer can display it.
 */
export async function countArchive(
  archiveUrl: string,
  resolved: ResolvedRepo,
  options: BrowserCountOptions = {},
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const aggregator = new Aggregator();
  const skipped: Record<SkipReason, number> = {
    binary: 0,
    vendored: 0,
    generated: 0,
    too_large: 0,
    other: 0,
  };

  const response = await fetch(archiveUrl, options.signal ? { signal: options.signal } : {});
  if (!response.ok) {
    let message = `Could not download the archive (HTTP ${response.status}).`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* not json */
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error('The archive response had no body.');

  const maxFileBytes = options.maxFileBytes ?? 4 * 1024 * 1024;
  let files = 0;
  let bytes = 0;

  const wanted = (rawPath: string, size: number): boolean => {
    const path = stripArchiveRoot(rawPath);
    if (path === null) return false;
    const decision = decidePath(path, size, {
      includeLockfiles: options.includeLockfiles,
      includeVendored: options.includeVendored,
      maxFileBytes,
    });
    if (decision.skip) {
      skipped[decision.reason]++;
      return false;
    }
    return true;
  };

  for await (const entry of readTar(gunzipStream(response.body), { wanted })) {
    if (options.signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
    if (!entry.data) continue;
    const path = stripArchiveRoot(entry.path);
    if (path === null) continue;

    if (looksBinary(entry.data)) {
      skipped.binary++;
      continue;
    }
    const counted = countFile(path, entry.data);
    aggregator.add(counted.path, counted.language, counted.bytes, counted.counts);

    files++;
    bytes += entry.data.length;
    if (files % 100 === 0) {
      options.onProgress?.(files, bytes);
      // Yield so the progress line actually repaints.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  options.onProgress?.(files, bytes);

  const totals = aggregator.totals;
  return {
    owner: resolved.owner,
    repo: resolved.repo,
    full_name: resolved.full_name,
    sha: resolved.sha,
    ref: resolved.ref,
    default_branch: resolved.default_branch,
    cached: false,
    duration_ms: Date.now() - started,
    counted_at: new Date().toISOString(),
    totals: {
      files: totals.files,
      bytes: totals.bytes,
      lines: totals.lines,
      code: totals.code,
      comment: totals.comment,
      blank: totals.blank,
    },
    by_language: aggregator.languages(),
    biggest_files: aggregator.biggestFiles(),
    skipped,
    repo_meta: resolved.repo_meta,
    options: {
      includeLockfiles: options.includeLockfiles ?? false,
      includeVendored: options.includeVendored ?? false,
    },
    strategy: 'browser',
    languages_without_comment_rules: [...aggregator.languagesWithoutCommentRules].sort(),
    warnings: [
      'Counted in your browser: this repository is larger than the server will process. ' +
        'Same counting code, same numbers — but the result is not cached or shareable.',
    ],
    timing: { resolve_ms: 0, tree_ms: 0, fetch_ms: 0, parse_ms: Date.now() - started },
    limits: {
      max_files: 0,
      max_total_bytes: 0,
      max_file_bytes: maxFileBytes,
      hit_file_limit: false,
      hit_byte_limit: false,
      tree_truncated: false,
    },
    github_requests: 0,
    rate_limit_remaining: null,
    counter_version: COUNTER_VERSION,
  };
}

// Published on the global object rather than as a module export: the bundle is
// loaded with a plain <script> tag, which keeps the page free of module
// plumbing (and of anything resembling a build step for the 1999 UI).
const globalScope = globalThis as unknown as {
  LOC1999_BIG?: { countArchive: typeof countArchive };
};
globalScope.LOC1999_BIG = { countArchive };

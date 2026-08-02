/**
 * Input parsing: turn whatever the human pasted into { owner, repo, ref? }.
 *
 * Accepted shapes:
 *   owner/repo
 *   owner/repo@branch
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/branch
 *   https://github.com/owner/repo/tree/feature/nested/name
 *   https://github.com/owner/repo/blob/branch/path/to/file.ts   (ref extracted)
 *   https://github.com/owner/repo/commit/<sha>
 *   git@github.com:owner/repo.git
 *   git://github.com/owner/repo.git
 *   www.github.com/owner/repo, github.com/owner/repo (no scheme)
 *
 * Anything that does not resolve to a github.com repository is rejected. This
 * is also the SSRF gate: we never build a URL from user input, we only ever
 * extract an owner/repo/ref triple and interpolate it into api.github.com.
 */

export interface RepoRef {
  owner: string;
  repo: string;
  /** undefined => use the repository's default branch */
  ref?: string;
}

export class ParseError extends Error {
  override readonly name = 'ParseError';
}

/** GitHub owner names: alphanumeric + hyphen, no leading/trailing hyphen, <= 39. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** Repo names: alphanumeric, hyphen, underscore, dot. Not "." or "..". */
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;
/**
 * Git ref names, plus raw SHAs. Deliberately strict: no spaces, no "..",
 * no leading "-", no control characters, no "~^:?*[\" (git's own rules).
 */
const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\-/+]{1,255}$/;

const HOSTS = new Set(['github.com', 'www.github.com']);

export function isValidOwner(s: string): boolean {
  return OWNER_RE.test(s);
}

export function isValidRepo(s: string): boolean {
  return REPO_RE.test(s) && s !== '.' && s !== '..' && !s.endsWith('.');
}

export function isValidRef(s: string): boolean {
  return REF_RE.test(s) && !s.endsWith('/') && !s.endsWith('.lock');
}

function stripDotGit(repo: string): string {
  return repo.endsWith('.git') ? repo.slice(0, -4) : repo;
}

function finish(owner: string, repo: string, ref?: string): RepoRef {
  const cleanRepo = stripDotGit(repo);
  if (!isValidOwner(owner)) throw new ParseError(`Bad owner name: "${owner}"`);
  if (!isValidRepo(cleanRepo)) throw new ParseError(`Bad repository name: "${cleanRepo}"`);
  if (ref !== undefined) {
    if (!isValidRef(ref)) throw new ParseError(`Bad ref: "${ref}"`);
    return { owner, repo: cleanRepo, ref };
  }
  return { owner, repo: cleanRepo };
}

/**
 * Pull the ref out of the tail of a /tree/ or /blob/ URL. Branch names may
 * contain slashes ("feature/x"), and for /blob/ the tail also contains a file
 * path, so this is inherently ambiguous. Heuristic, in order:
 *   - a 40 or 7-to-40 char hex string => commit sha, take just that
 *   - for /blob/: take the first segment (the common case: branch without "/")
 *   - for /tree/: take everything (branches with slashes are common here)
 */
function refFromTail(segments: string[], kind: 'tree' | 'blob'): string | undefined {
  if (segments.length === 0) return undefined;
  const first = segments[0]!;
  if (/^[0-9a-f]{7,40}$/i.test(first)) return first;
  if (kind === 'blob') return first;
  return segments.join('/');
}

export function parseRepoInput(raw: string): RepoRef {
  const input = raw.trim();
  if (!input) throw new ParseError('Enter a repository.');
  if (input.length > 2048) throw new ParseError('Input too long.');

  // git@github.com:owner/repo(.git)
  const scp = /^(?:ssh:\/\/)?git@github\.com[:/]+(.+)$/i.exec(input);
  if (scp) return fromPath(scp[1]!);

  // git://github.com/owner/repo.git
  const gitProto = /^git:\/\/github\.com\/(.+)$/i.exec(input);
  if (gitProto) return fromPath(gitProto[1]!);

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new ParseError('That does not look like a URL.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ParseError('Only http(s) GitHub URLs are supported.');
    }
    if (!HOSTS.has(url.hostname.toLowerCase())) {
      throw new ParseError('Only github.com repositories are supported.');
    }
    return fromPath(decodeURIComponent(url.pathname));
  }

  // Scheme-less "github.com/owner/repo" / "www.github.com/owner/repo"
  const bare = /^(?:www\.)?github\.com\/(.+)$/i.exec(input);
  if (bare) return fromPath(bare[1]!);

  if (input.includes('://') || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(input)) {
    throw new ParseError('Only github.com repositories are supported.');
  }

  return fromPath(input);
}

function fromPath(path: string): RepoRef {
  // "owner/repo@ref" shorthand (only when there is no /tree/ or /blob/ part).
  let refFromAt: string | undefined;
  let work = path;
  if (!/\/(tree|blob|commit|commits)\//.test(work)) {
    const at = work.lastIndexOf('@');
    if (at > 0) {
      refFromAt = work.slice(at + 1);
      work = work.slice(0, at);
    }
  }

  const segments = work.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw new ParseError('Expected owner/repo (for example: torvalds/linux).');
  }
  const [owner, repo, kind, ...rest] = segments;

  if (kind === 'tree' || kind === 'blob') {
    return finish(owner!, repo!, refFromTail(rest, kind));
  }
  if (kind === 'commit' || kind === 'commits') {
    const sha = rest[0];
    return finish(owner!, repo!, sha);
  }
  if (kind !== undefined && kind !== '') {
    // e.g. /owner/repo/pull/123 — we only count repositories, but the repo part
    // is still unambiguous, so accept it at the default branch.
    return finish(owner!, repo!, refFromAt);
  }
  return finish(owner!, repo!, refFromAt);
}

/** Build the canonical share path for a completed count. */
export function resultPath(owner: string, repo: string, sha: string): string {
  return `/r/${owner}/${repo}/${sha}`;
}

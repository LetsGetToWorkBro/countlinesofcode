/**
 * Recorded-style GitHub fixture. Everything the counter needs is served from an
 * in-memory repository description, so the whole pipeline (resolve -> tree ->
 * blobs or tarball -> classify -> aggregate) is exercised without a network.
 */

import { buildTar, gzip } from './tar';

export interface FakeRepo {
  owner: string;
  repo: string;
  /** Legacy "owner/repo" names that 301 to this one, as GitHub does. */
  renamedFrom?: string[];
  defaultBranch: string;
  sha: string;
  private?: boolean;
  fork?: boolean;
  stars?: number;
  sizeKb?: number;
  /** path -> file contents */
  files: Record<string, string>;
  /** Report the recursive tree as truncated. */
  truncated?: boolean;
}

export interface FakeGitHub {
  restore(): void;
  requests: string[];
  /** Per-request record of which host saw an Authorization header. */
  authHeaders: { host: string; authorization: string | null }[];
  /** HTTP method of every outbound request, so "read only" is checkable. */
  methods: string[];
  /** Force the next matching request to fail with this status. */
  failNext(status: number, body?: string): void;
}

function blobSha(path: string): string {
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, '0').repeat(5).slice(0, 40);
}

const encoder = new TextEncoder();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' },
  });
}

export function installFakeGitHub(repos: FakeRepo[]): FakeGitHub {
  const original = globalThis.fetch;
  const requests: string[] = [];
  const authHeaders: { host: string; authorization: string | null }[] = [];
  const methods: string[] = [];
  let forcedFailure: { status: number; body: string } | null = null;

  const byName = new Map(repos.map((r) => [`${r.owner}/${r.repo}`.toLowerCase(), r]));
  const renamed = new Map<string, FakeRepo>();
  for (const record of repos) {
    for (const old of record.renamedFrom ?? []) renamed.set(old.toLowerCase(), record);
  }

  const fake: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requests.push(url);
    methods.push((init?.method ?? 'GET').toUpperCase());
    try {
      authHeaders.push({
        host: new URL(url).hostname,
        authorization: new Headers(init?.headers).get('authorization'),
      });
    } catch {
      /* not a URL we can record */
    }

    if (forcedFailure) {
      const failure = forcedFailure;
      forcedFailure = null;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (failure.status === 403 || failure.status === 429) {
        // Shape it like a real GitHub rate-limit response.
        headers['x-ratelimit-remaining'] = '0';
        headers['retry-after'] = '60';
      }
      return new Response(JSON.stringify({ message: failure.body }), { status: failure.status, headers });
    }

    const parsed = new URL(url);

    if (parsed.hostname === 'codeload.github.com') {
      const [, owner, repo] = parsed.pathname.split('/');
      const record = byName.get(`${owner}/${repo}`.toLowerCase());
      if (!record) return json({ message: 'Not Found' }, 404);
      const tar = buildTar(
        Object.entries(record.files).map(([path, content]) => ({
          path: `${record.owner}-${record.repo}-${record.sha.slice(0, 7)}/${path}`,
          content,
        })),
      );
      const compressed = await gzip(tar);
      return new Response(compressed, { headers: { 'content-type': 'application/x-gzip' } });
    }

    if (parsed.hostname !== 'api.github.com') {
      throw new Error(`Unexpected host in test: ${parsed.hostname}`);
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'repos') return json({ message: 'Not Found' }, 404);
    const requested = `${segments[1]}/${segments[2]}`.toLowerCase();

    // GitHub 301s a renamed repository to its canonical path, on api.github.com.
    const moved = renamed.get(requested);
    if (moved) {
      const rest = segments.slice(3).join('/');
      return new Response(null, {
        status: 301,
        headers: {
          location: `https://api.github.com/repos/${moved.owner}/${moved.repo}${rest ? `/${rest}` : ''}`,
        },
      });
    }

    const record = byName.get(requested);
    if (!record) return json({ message: 'Not Found' }, 404);

    const rest = segments.slice(3);

    if (rest.length === 0) {
      return json({
        full_name: `${record.owner}/${record.repo}`,
        name: record.repo,
        owner: { login: record.owner },
        default_branch: record.defaultBranch,
        private: record.private ?? false,
        size: record.sizeKb ?? 128,
        stargazers_count: record.stars ?? 7,
        html_url: `https://github.com/${record.owner}/${record.repo}`,
        archived: false,
        fork: record.fork ?? false,
        description: 'fixture',
      });
    }

    if (rest[0] === 'commits') {
      const accept = new Headers(init?.headers).get('Accept') ?? '';
      if (accept.includes('vnd.github.sha')) {
        return new Response(record.sha, { headers: { 'content-type': 'text/plain' } });
      }
      return json({ sha: record.sha });
    }

    if (rest[0] === 'git' && rest[1] === 'trees') {
      return json({
        sha: record.sha,
        truncated: Boolean(record.truncated),
        tree: record.truncated
          ? []
          : Object.entries(record.files).map(([path, content]) => ({
              path,
              type: 'blob',
              mode: '100644',
              sha: blobSha(path),
              size: encoder.encode(content).length,
            })),
      });
    }

    if (rest[0] === 'git' && rest[1] === 'blobs') {
      const entry = Object.entries(record.files).find(([path]) => blobSha(path) === rest[2]);
      if (!entry) return json({ message: 'Not Found' }, 404);
      return new Response(entry[1], { headers: { 'content-type': 'application/vnd.github.raw' } });
    }

    if (rest[0] === 'tarball') {
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://codeload.github.com/${record.owner}/${record.repo}/tar.gz/${record.sha}`,
        },
      });
    }

    return json({ message: 'Not Found' }, 404);
  };

  globalThis.fetch = fake;

  return {
    restore() {
      globalThis.fetch = original;
    },
    requests,
    authHeaders,
    methods,
    failNext(status: number, body = 'Not Found') {
      forcedFailure = { status, body };
    },
  };
}

/** Minimal in-memory KVNamespace. */
export function fakeKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const metadataStore = new Map<string, unknown>();
  const kv = {
    store,
    async get(key: string, type?: string) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key: string, value: string, options?: { metadata?: unknown }) {
      store.set(key, value);
      if (options?.metadata !== undefined) metadataStore.set(key, options.metadata);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string; limit?: number }) {
      const prefix = options?.prefix ?? '';
      const names = [...store.keys()].filter((name) => name.startsWith(prefix));
      const limited = names.slice(0, options?.limit ?? 1000);
      return {
        keys: limited.map((name) => ({ name, metadata: metadataStore.get(name) })),
        list_complete: true,
        cacheStatus: null,
      };
    },
    async getWithMetadata() {
      return { value: null, metadata: null, cacheStatus: null };
    },
  };
  return kv as unknown as KVNamespace & { store: Map<string, string> };
}

export function fakeCtx(): ExecutionContext & { settled(): Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {
      /* noop */
    },
    props: {},
    async settled() {
      await Promise.all(pending);
    },
  } as unknown as ExecutionContext & { settled(): Promise<void> };
}

/** A small but representative repository fixture. */
export const SAMPLE_REPO: FakeRepo = {
  owner: 'acme',
  repo: 'widget',
  defaultBranch: 'main',
  sha: 'a'.repeat(40),
  files: {
    'src/index.ts': ['// entry point', '', 'export function main(): void {', '  console.log(1);', '}', ''].join('\n'),
    'src/util.ts': ['/* helpers */', 'export const x = 1;', ''].join('\n'),
    'app.py': ['"""Docs."""', '', 'import os  # stdlib', 'print(os.name)', ''].join('\n'),
    'README.md': ['# Widget', '', 'Text.', ''].join('\n'),
    'package.json': ['{', '  "name": "widget"', '}', ''].join('\n'),
    'package-lock.json': ['{', '  "lockfileVersion": 3', '}', ''].join('\n'),
    'node_modules/left-pad/index.js': 'module.exports = () => {};\n',
    'dist/bundle.min.js': 'var a=1;\n',
    'assets/logo.png': ' PNG binary-ish\n',
  },
};

/**
 * Counted by hand from SAMPLE_REPO, with default options:
 *   src/index.ts   5 lines: 3 code, 1 comment, 1 blank
 *   src/util.ts    2 lines: 1 code, 1 comment, 0 blank
 *   app.py         4 lines: 2 code, 1 comment, 1 blank
 *   README.md      3 lines: 2 code, 0 comment, 1 blank
 *   package.json   3 lines: 3 code, 0 comment, 0 blank
 * skipped: package-lock.json (generated), node_modules (vendored),
 *          dist/bundle.min.js (vendored), assets/logo.png (binary)
 */
export const SAMPLE_EXPECTED = {
  files: 5,
  lines: 17,
  code: 11,
  comment: 3,
  blank: 3,
};

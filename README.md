# LOC.1999

Count the lines of code in any GitHub repository. Paste a URL, get accurate
totals. Runs entirely on Cloudflare's edge.

The UI looks like it was made in Notepad in 1999. That is deliberate. The
engineering behind it is not.

```
LOC.1999
Enter a repository. We will count the lines. That is all.
------------------------------------------------------------
Repository: [ https://github.com/owner/repo               ]
Branch/tag: [ (default branch) ]   [ Count Lines ]
------------------------------------------------------------
owner/repo                                          [fresh]
+-----------------------+------------+---------+
| Total lines           |    120,440 |  100.0% |
| Code                  |     98,112 |   81.5% |
| Comments              |     10,200 |    8.5% |
| Blank                 |     12,128 |   10.1% |
| Files counted         |        421 | 4.2 MB  |
+-----------------------+------------+---------+
```

---

## What makes the numbers trustworthy

* **Not GitHub's language bar.** Linguist reports *bytes* per language. We read
  file contents and count lines.
* **Pinned to a commit.** Every count resolves to a 40-character sha before
  doing any work, and displays it. Same sha + same `counter_version` = same
  numbers, forever.
* **Real comment parsing.** A single-pass state machine per file that tracks
  string literals, nested block comments, Python/Elixir docstrings, JavaScript
  regex literals and template-literal interpolation — so `//` inside
  `"http://x"` is not a comment, `#` inside a shell string is not either, and
  `/^([^\/]+:\/)?\/*$/` does not open a block comment. ~90 languages have
  comment rules; the rest are counted blank vs non-blank and the result page
  **says which ones**.
* **Checked against `cloc`.** Over a ~30,000 line corpus (this repo plus zod,
  chai, source-map, busboy), 125 of 127 files matched exactly on
  code/comment/blank. Both disagreements are cloc bugs: a regex literal
  containing `/*`, and comment markers inside a string literal. See
  `test/corpus.test.ts`.
* **Honest skipping.** Vendored dirs, build output, minified bundles, codegen,
  lockfiles and binaries are excluded by default, each counted under its own
  reason so you can see what was dropped.
* **Honest limits.** Hitting a cap, or a truncated GitHub tree, produces a
  visible warning — partial results are always labelled partial.

Full methodology, including known limitations: **[`/how.html`](public/how.html)**.

---

## Architecture

```
                    browser (public/, ~14 KB of vanilla JS)
                        |  GET /api/stream?input=owner/repo
                        |  <- SSE: progress, progress, ..., result
                        v
    +-------------------------------------------------------------+
    |            Cloudflare Worker  (src/worker/index.ts)          |
    |                                                             |
    |   route -> validate (zod + parse-url) -> rate limit (KV)     |
    |                                                             |
    |   +------------------ src/lib/counter.ts ---------------+    |
    |   |                                                     |    |
    |   |  1. resolveTarget()  repo -> default branch -> SHA   |   |
    |   |        +--> KV: ref->sha (60s)                       |   |
    |   |        +--> KV: res:<ver>:owner/repo@sha  -- HIT ----+---+--> response
    |   |                                                      |   |
    |   |  2. GET /git/trees/{sha}?recursive=1                 |   |
    |   |  3. filter paths        (src/lib/ignore.ts)          |   |
    |   |  4. fetch contents:                                  |   |
    |   |       <= 40 files  -> Git Blobs API, pool of 12      |   |
    |   |       >  40 files  -> tarball, streamed + gunzipped  |   |
    |   |       truncated    -> tarball enumerates everything  |   |
    |   |  5. classify lines      (src/lib/count.ts)           |   |
    |   |  6. aggregate + validate against the zod schema      |   |
    |   |  7. KV put (7 days, keyed by immutable sha)          |   |
    |   +------------------------------------------------------+   |
    +-------------------------------------------------------------+
                        |                          |
                 api.github.com          codeload.github.com
                 (repo, ref, tree,       (archive redirect target,
                  blobs, user)            allowlisted, no auth header)
```

### Why two content strategies

Cloudflare caps **sub-requests per request** (50 on the free plan, 1000 on
paid). One blob fetch per file therefore does not scale past a few dozen files.
Above `MAX_BLOB_FETCHES` we download the repository tarball at the pinned sha in
a single request and parse it as a stream — gunzip through
`DecompressionStream`, then an incremental tar reader that hands the counter one
file at a time and discards bytes it does not want. Peak memory is one file, not
one repository. Nothing is ever cloned, written to disk, or executed.

The same path rescues repositories whose recursive tree GitHub reports as
truncated (~100k entries): the archive enumerates everything, so totals stay
complete and the result carries a warning explaining where the listing came
from.

### Layout

```
public/            the 1999 UI: index.html, how.html, style.css, app.js, favicon
src/lib/
  parse-url.ts     input parsing + the SSRF gate (owner/repo/ref validators)
  languages.ts     extension/filename detection + per-language comment syntax
  count.ts         the line classifier and the aggregator
  ignore.ts        vendored / generated / binary / size rules
  github.ts        REST client: retries, backoff, rate-limit capture, archives
  tar.ts           streaming tar reader + gunzip helper
  counter.ts       the pipeline (resolve -> tree -> content -> classify)
  cache.ts         KV keys and TTLs
  ratelimit.ts     per-IP fixed window
  schema.ts        zod contracts for every request and response
  pool.ts          bounded-concurrency map
src/worker/
  index.ts         router, error mapping, SSE, security headers
  auth.ts          GitHub OAuth + server-side session storage
  html.ts          server-rendered result and error pages
  env.ts           bindings and tunables
test/              unit + fixture-driven integration tests (no live network)
```

---

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars     # optional: token / OAuth credentials
npx wrangler kv namespace create LOC_KV            # paste the id into wrangler.toml
npx wrangler kv namespace create LOC_KV --preview  # paste as preview_id
npm run dev                                        # http://localhost:8787
```

`npm run dev` works without any KV namespace or token — counting falls back to
anonymous GitHub (60 requests/hour) and skips caching. It just gets slow.

```bash
npm test          # 179 tests, no network access required
npm run typecheck
npm run check     # both
```

Tests run against an in-memory GitHub fixture (`test/fixtures/fake-github.ts`)
that serves repo metadata, refs, trees, blobs and a real gzipped tarball, so CI
never touches api.github.com and never needs a token.

---

## Deploy

```bash
npx wrangler kv namespace create LOC_KV        # once; put the id in wrangler.toml
npx wrangler secret put GITHUB_TOKEN           # optional but strongly recommended
npx wrangler secret put GITHUB_CLIENT_ID       # optional (enables Connect GitHub)
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler deploy --env production
```

Set `APP_BASE_URL` in `[env.production.vars]` to the deployed origin before
enabling OAuth — it is used to build the `redirect_uri`.

> **A note on Pages.** This ships as a Worker with a static-assets binding
> (`[assets]` in `wrangler.toml`), which is the current form of what used to be
> "Pages for the static files + a Worker for the API". Files in `public/` are
> served straight from the edge; only unmatched paths (`/api/*`, `/r/*`) invoke
> the Worker. One deploy, one origin, no CORS. If your org requires a Pages
> project specifically, the same `public/` directory and a Pages Function
> wrapping `src/worker/index.ts` will work unchanged.

### Environment variables

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `GITHUB_TOKEN` | secret | – | Server token for anonymous visitors. Raises the shared limit from 60/h to 5,000/h. Needs no scopes for public repos. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | secret | – | OAuth App credentials. Without them the "Connect GitHub" section says so and public counting still works. |
| `APP_BASE_URL` | var | request origin | Origin used to build the OAuth `redirect_uri`. |
| `MAX_FILES` | var | `20000` | Cap on files counted per request. |
| `MAX_TOTAL_BYTES` | var | `67108864` | Cap on decoded text per request (64 MiB). |
| `MAX_FILE_BYTES` | var | `4194304` | Per-file cap; larger files are skipped as `too_large`. |
| `MAX_BLOB_FETCHES` | var | `40` | Above this many files, switch to the tarball strategy. Raise it on a paid plan if you prefer blobs. |
| `FETCH_CONCURRENCY` | var | `12` | Parallel blob fetches. |
| `RATE_LIMIT_PER_MINUTE` | var | `20` | Per-IP counts per minute for anonymous callers. |
| `LOC_KV` | KV binding | – | Result cache, ref cache, sessions, rate-limit counters. |

---

## GitHub OAuth setup

1. <https://github.com/settings/developers> → **New OAuth App**.
2. Homepage URL: your deployed origin (or `http://localhost:8787`).
3. Authorization callback URL: `<origin>/api/auth/callback`.
4. `wrangler secret put GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

**Scopes.** The app requests `read:user repo`. `repo` is what GitHub requires to
read *private* repository contents — there is no narrower private-read scope on
an OAuth App. If you only care about public repositories, change `SCOPES` in
`src/worker/auth.ts` to `read:user public_repo` (or just `read:user`); users then
get the higher 5,000/h rate limit and their repo list without granting private
access. For a production deployment where least privilege matters more than
setup effort, a **GitHub App** with `contents: read` scoped to selected
repositories is the better shape.

**Token handling.** The access token is written to KV under a random 256-bit
session id and never sent to the browser; the cookie holds only that id and is
`HttpOnly; Secure; SameSite=Lax`. Tokens are never logged — the OAuth error path
logs a message string only, and result payloads contain no credentials.

---

## Why not Supabase

The brief allowed Supabase for auth and history and asked for it to be skipped
if plain KV was cleaner. It is:

* Auth here is one OAuth round trip and one opaque session record. Supabase Auth
  would add a second identity system, a `provider_token` refresh story, and a
  network hop from the edge to Postgres on **every** counted request.
* There are no user-owned rows to protect, so there is no RLS to benefit from.
  Results are keyed by public commit shas and are already shareable by URL.
* Sharing works through `/r/{owner}/{repo}/{sha}`, backed by the same cache
  entry the API returns. A `counts` table would duplicate that.

If per-user history is wanted later, the seam is small: `ResultCache.put` in
`src/lib/cache.ts` is the single write point.

---

## API

```
POST /api/count
     {"url": "https://github.com/owner/repo", "ref": "main",
      "includeLockfiles": false, "includeVendored": false, "fresh": false}
     -- or -- {"owner": "...", "repo": "...", "ref": "..."}

GET  /api/count/{owner}/{repo}?ref=&lockfiles=1&vendored=1&fresh=1
GET  /api/stream?input=owner/repo&ref=main      text/event-stream
GET  /api/meta                                  limits + versions
GET  /r/{owner}/{repo}/{sha}                    shareable HTML result

GET  /api/auth/login | /api/auth/callback | /api/auth/me | /api/auth/repos
POST /api/auth/logout
```

`/api/stream` emits `event: progress` (`{phase, message, done?, total?}`), then
exactly one `event: result` (the full payload) or `event: failure`
(`{error: {code, message, hint?}}`).

<details>
<summary>Example response</summary>

```json
{
  "owner": "acme",
  "repo": "widget",
  "full_name": "acme/widget",
  "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "ref": "main",
  "default_branch": "main",
  "cached": false,
  "duration_ms": 4820,
  "counted_at": "2026-08-02T22:00:00.000Z",
  "totals": { "files": 421, "bytes": 4404019, "lines": 120440, "code": 98112, "comment": 10200, "blank": 12128 },
  "by_language": [
    { "language": "TypeScript", "files": 210, "bytes": 2400000, "code": 50000, "comment": 4000, "blank": 5000, "lines": 59000 }
  ],
  "biggest_files": [{ "path": "src/schema.ts", "lines": 1204, "language": "TypeScript" }],
  "skipped": { "binary": 30, "vendored": 1200, "generated": 12, "too_large": 0, "other": 0 },
  "repo_meta": { "stars": 1200, "size_kb": 40960, "private": false, "archived": false, "fork": false, "description": "…", "html_url": "https://github.com/acme/widget" },
  "options": { "includeLockfiles": false, "includeVendored": false },
  "strategy": "tarball",
  "languages_without_comment_rules": ["JSON"],
  "warnings": [],
  "timing": { "resolve_ms": 180, "tree_ms": 240, "fetch_ms": 3800, "parse_ms": 600 },
  "limits": { "max_files": 20000, "max_total_bytes": 67108864, "max_file_bytes": 4194304, "hit_file_limit": false, "hit_byte_limit": false, "tree_truncated": false },
  "github_requests": 5,
  "rate_limit_remaining": 4993,
  "counter_version": "1.0.0"
}
```

</details>

Error responses are `{"error": {"code", "message", "hint?"}}` with codes
`bad_input`, `bad_request`, `not_found`, `forbidden`, `rate_limited`,
`empty_repo`, `too_large`, `github_down`, `network`, `internal`.

---

## Security

* **SSRF.** User input never becomes a URL. It is decomposed into
  owner/repo/ref, each validated against strict patterns, then interpolated into
  the constant `https://api.github.com`. The archive redirect is followed
  manually and only to an allowlisted host, with the `Authorization` header
  dropped on the second hop.
* **No execution.** Repository content is only ever decoded as text and counted.
* **Headers.** `Content-Security-Policy` (no inline script, no external
  origins), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`.
* **Rate limiting.** Per-IP fixed window in KV for anonymous callers;
  authenticated users spend their own GitHub quota. KV is eventually consistent,
  so for adversarial traffic put a Cloudflare rate-limiting rule in front of
  `/api/*` — the in-Worker limit is a courtesy control protecting the server
  token, not a security boundary.
* **Logs.** Structured JSON with timing spans (`resolve_ms`, `tree_ms`,
  `fetch_ms`, `parse_ms`), request counts and cache status. No tokens, no
  cookies, no file contents.

## Performance

* Cached counts (`owner/repo@sha`) return in a single KV read.
* Uncached small repos take one round trip per file across a pool of 12.
* Uncached medium repos take one archive request; wall time is dominated by the
  download, and counting is interleaved with it rather than following it.
* Progress is streamed, so the page shows `Listing tree…` → `Counting files
  120/400…` instead of a blank wait.

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with GitHub. Hosted on Cloudflare. Made with spite for bloat.

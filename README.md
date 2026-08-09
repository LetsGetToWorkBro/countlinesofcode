# 1999.LOC

**Live at [1999loc.com](https://1999loc.com)**

Count the lines of code in any GitHub repository. Paste a URL, get accurate
totals. Runs entirely on Cloudflare's edge.

The UI looks like it was made in Notepad in 1999. That is deliberate. The
engineering behind it is not.

The line counter is where it started. It has since grown a family of small,
private tools that share the same Worker and the same rule — your file does not
leave your browser unless the page tells you it must. **[Jump to the
toolkit](#the-toolkit).**

```
1999.LOC
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

## The toolkit

Everything below is served by the one Worker (`src/worker/index.ts`) with a
`[assets]` binding — one origin, no accounts, no upload. Almost every tool is a
static page and a few kilobytes of vanilla JavaScript that does its work *in the
tab*; each page carries a **"Prove it"** panel that shows, from the browser's own
Performance timeline and Content-Security-Policy, that nothing left. The three
tools that genuinely need a server say so on the page and in the table below.

Three tools are two-in-one, on tabs (a shared `public/tabs.js`, hash-deep-linked
so `/email.html#inbox` opens the right tab; the retired URLs 301 to it).

### Documents

| Tool | URL | What it does | Runs on |
|---|---|---|---|
| **PDF** | `/sign.html` | *Edit* tab: sign, fill a form's real fields, add a picture, and delete/replace text so it truly leaves the file — not a black box over the top. *Pages* tab: merge, split, reorder, rotate. | your browser |
| **PDF ↔ Word** | `/convert.html` | Convert either direction, with a quality verdict *before* you commit; scans read by OCR. | your browser |
| **Excel ↔ CSV** | `/sheet.html` | Semicolon-aware, quote-honouring, won't turn `007` into `7`. | your browser |
| **ZIP** | `/zip.html` | Look inside an archive without unpacking it, extract only what you want, or build one. | your browser |
| **Unlock a PDF** | `/unlock.html` | Strip "no printing / no copying" from a PDF that opens without a password. | your browser |
| **Shrink a file** | `/shrink.html` | Make a heavy PDF or an oversized picture smaller. | your browser |
| **Audio tools** | `/audio.html` | Cut a ringtone, convert to MP3 or WAV, boost or normalise, fade, join. MP3 out is LAME. | your browser |

### Media

| Tool | URL | What it does | Runs on |
|---|---|---|---|
| **Image tools** | `/image.html` | Resize, compress and convert between PNG/JPEG/WebP, including HEIC off an iPhone; location and camera data stripped on the way out. | your browser |
| **Video & GIF** | `/video.html` | Cut a clip, change format, squeeze under a size limit, make a GIF, pull the audio — *copying* rather than re-encoding where it can, and it tells you which. | your browser |

### Privacy

| Tool | URL | What it does | Runs on |
|---|---|---|---|
| **Encrypt** | `/lock.html` | *Password* tab: lock a file with a passphrase (OpenPGP symmetric). *Key pair* tab: full PGP — generate, encrypt, decrypt, sign, verify. Your private key never leaves the tab. | your browser |
| **Inspect a file** | `/inspect.html` | What a document is quietly carrying: text under black boxes, tracked changes, comments, author, timezone. | your browser |
| **Delete posts** | [delete.1999loc.com](https://delete.1999loc.com/) | Bulk-delete your old social posts. | its own service |

### Communications

| Tool | URL | What it does | Runs on |
|---|---|---|---|
| **Email** | `/email.html` | *Disposable inbox* tab: an address that reads its own mail and self-destructs in an hour. *Check a message* tab: is the sender forged (SPF/DKIM/DMARC) and what is tracking you, read straight from the source. | inbox: **the server** (D1 + Email Routing) · checker: your browser |

### Monero

| Tool | URL | What it does | Runs on |
|---|---|---|---|
| **Wallets** | `/wallet.html` | *Monero* tab: a full hot wallet in the tab — create, restore, receive, send; keys never leave the browser, node traffic proxied through `/api/xmr`. *Bitcoin* tab: the same deal for BTC — BIP84 (12 words, bc1 addresses), created/restored/watch-only, signed in the tab, with balance and broadcast through `/api/btc` to an Esplora explorer (mempool.space or blockstream.info, or your own). *Check an address* tab: validate an address, restore a seed, or generate a paper wallet offline, verified against published test vectors. | wallets: browser + **node/explorer proxy** · checker: browser |
| **Swap** | `/swap.html` | Monero in or out, against BTC, USDT (Tron or Ethereum), ETH and USDC (Ethereum or Solana), through instant exchanges. Every pair has XMR on one side; the payout address is checked against the chain it is being paid to. Quotes from Exolix out of the box, plus ChangeNOW when a `CHANGENOW_API_KEY` secret is set; the Worker relays via `/api/swap` so the exchange sees Cloudflare, not the visitor, and stores nothing about the order. | **the server** (relay only, no custody, no storage) |

### Code

| Tool | URL | What it does | Runs on |
|---|---|---|---|
| **Count code** | `/code.html` | The line counter — the rest of this README. | server, or your browser for big repos |
| **Code golf** | `/golf` | The fewest-lines leaderboard, one stated problem per board. | server |

### Privacy beyond the tools themselves

Two things go further than "the file never leaves your browser", and both are
documented rather than assumed:

* **A Tor onion mirror.** [`docs/onion.md`](docs/onion.md) is the full runbook
  (EOTK, `mkp224o`, the config that matters). The clearnet site's half is done:
  `npm run onion:set <address>.onion` writes the `Onion-Location`
  advertisement into `public/_headers` (static pages, served at the edge) and
  the `ONION_HOST` var (pages the Worker renders), so the two cannot drift.
  `src/lib/onion.ts` holds the rules: HTTPS only, never onion-to-itself, never
  on `/api/`.
* **The Bitcoin wallet's address lookups.** A light BTC wallet has to name its
  addresses out loud, so this site's own server could read a wallet off the
  request log. [`docs/wallet-privacy.md`](docs/wallet-privacy.md) says so
  plainly and offers three answers: padded lookups (decoys shuffled into every
  batch, including the follow-up calls), your own Esplora, or the onion. It
  also explains why BIP157/158 compact filters are not on the menu.

The tools' client engines live in `src/client/` (`pdfedit.ts`, `email.ts`,
`pgpkit.ts`, `monero.ts`, `zipkit.ts`, `convert.ts`, …), built to committed
bundles in `public/` by `npm run build:client`. The two server-backed newcomers
are the throwaway inbox (`src/worker/mail.ts`, `src/lib/mailbox.ts`, a D1
database, and an `email()` handler fed by Cloudflare Email Routing — see
[`docs/tempmail.md`](docs/tempmail.md)) and the Monero node proxy
(`src/lib/xmrproxy.ts`). The nav bar is generated from one list
(`SITE_TOOLS` in `src/worker/html.ts`) and written into every static page by
`npm run sync:nav`, so a tool cannot go missing from half the site.

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

### Big repositories: counted in your browser

Counting is CPU-bound and Cloudflare caps CPU per request (10 ms free, 30 s
paid), so past a certain size the server cannot finish. Streaming bytes,
however, costs essentially no CPU — the runtime pipes a response body without
JavaScript touching it.

So when the server refuses a repository as too large, the page offers to do it
locally: `/api/archive/:owner/:repo/:sha` streams the GitHub tarball straight
through, and `public/bigcount.js` does the gunzip, tar parsing and
classification in the tab. There is no repository size it cannot handle, on any
plan.

That bundle is built from `src/client/bigcount.ts`, which imports the *same*
`count.ts`, `ignore.ts` and `tar.ts` the Worker uses — there is no second
implementation to drift. Verified in Chromium against a real archive: browser
and server produce identical totals to the line.

Trade-offs, stated on the page itself: the archive downloads to the visitor,
and the result is not cached or shareable, because the server cannot verify
numbers it did not compute and accepting client-submitted totals would let
anyone poison the shared cache.

`public/bigcount.js` is a committed build artifact (`npm run build:client`),
since `wrangler deploy` runs no build step. `test/client-bundle.test.ts`
rebuilds and compares, so a stale bundle fails the suite.

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
public/            every tool page (index/how/code/sign/convert/sheet/zip/
                   image/video/inspect/email/lock/monero/wallet/…), the
                   committed client bundles, style.css, tabs.js, favicon
src/client/        the in-browser tool engines, built to public/ bundles:
  bigcount.ts      browser-side line counting (shares the counter's core)
  pdfedit.ts       PDF edit / sign / redact + page ops (pdfpages.ts)
  convert.ts       PDF <=> Word, with docmodel.ts and OCR
  sheet.ts         Excel <=> CSV        zipkit.ts   read / write ZIP
  email.ts         SPF/DKIM/DMARC + tracker parser (reused server-side)
  pgpkit.ts        OpenPGP: password locking and full PGP
  monero.ts        address check + offline paper-wallet derivation
  inspect.ts       document metadata / hidden-content scanner
src/lib/
  parse-url.ts     input parsing + the SSRF gate (owner/repo/ref validators)
  languages.ts     extension/filename detection + per-language comment syntax
  count.ts         the line classifier and the aggregator
  ignore.ts        vendored / generated / binary / size rules
  github.ts        REST client: retries, backoff, rate-limit capture, archives
  tar.ts           streaming tar reader + gunzip helper
  counter.ts       the pipeline (resolve -> tree -> content -> classify)
  board.ts         the standings: ranking rules, purely from cache metadata
  challenges.ts    code golf: the challenge list and fewest-lines ranking
  mailbox.ts       throwaway-inbox primitives (address gen, TTL, trimming)
  xmrproxy.ts      Monero node allowlist + RPC proxy target resolution
  cache.ts         KV keys and TTLs      ratelimit.ts  per-IP fixed window
  schema.ts        zod contracts        pool.ts       bounded-concurrency map
src/worker/
  index.ts         router, error mapping, SSE, security headers, email()+cron
  auth.ts          GitHub OAuth + server-side session storage
  mail.ts          throwaway inbox: receive, store (D1), and the /api/mail/* API
  html.ts          server-rendered pages + SITE_TOOLS (the one nav source)
  board-html.ts    the standings page
  golf-html.ts     the golf course and its per-challenge pages
  env.ts           bindings and tunables
migrations/        D1 schema for the throwaway inbox
docs/tempmail.md   operator runbook for turning the inbox on (Email Routing)
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
anonymous GitHub and skips caching.

A token is **optional**, not required. What changes without one:

| | anonymous | with `GITHUB_TOKEN` |
|---|---|---|
| GitHub quota | 60 requests/hour, **per IP** | 5,000 requests/hour |
| Cost per uncached count | 5 requests (tarball) / 3 + one per file (blobs) | same |
| Cost per cached share link | 0 | 0 |
| Roughly | ~10 fresh counts/hour | ~1,000 fresh counts/hour |
| Private repositories | no | no — that needs OAuth |

For **local testing that is usually fine**: your own IP has its own allowance.
For a **deployed Worker it usually is not** — Cloudflare's egress IPs are shared
across many customers, so the anonymous pool is often already exhausted by
someone else. (Counting from this build's CI container hit exactly that: every
anonymous request came back rate-limited.) Set a token before deploying, or have
visitors connect their own GitHub account.

Two things keep quota use low either way: results are cached by immutable commit
sha, and a request for an explicit sha that is already cached returns without
contacting GitHub at all — so shared `/r/` links are free.

```bash
npm test          # 1,200+ tests, no network access required
npm run typecheck
npm run check     # both
```

Tests run against an in-memory GitHub fixture (`test/fixtures/fake-github.ts`)
that serves repo metadata, refs, trees, blobs and a real gzipped tarball, so CI
never touches api.github.com and never needs a token.

### Verifying against the real GitHub API

The test suite is deliberately offline, so one command exercises the real thing:

```bash
GITHUB_TOKEN=ghp_xxx npm run verify:live -- vercel/next.js
GITHUB_TOKEN=ghp_xxx npm run verify:live -- torvalds/linux master
env -u GITHUB_TOKEN npm run verify:live -- octocat/Hello-World   # anonymous
```

It runs the production pipeline outside the Worker — no KV, no cache — streams
the same progress the UI shows, prints the totals and language breakdown, and
asserts `code + comment + blank === lines` before exiting. Non-zero exit means
the invariant broke or GitHub refused.

Without a token you get GitHub's 60 requests/hour anonymous allowance, which is
shared per IP and frequently already exhausted on cloud hosts and CI runners.

### Getting a `GITHUB_TOKEN`

For public repositories the token needs **no scopes at all** — being
authenticated is what raises the limit from 60 to 5,000 requests/hour.

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens** →
   **Tokens (classic)** → **Generate new token (classic)**.
2. Give it a name and an expiry, and **tick no scopes**. (A fine-grained token
   with *Public Repositories (read-only)* works equally well.)
3. Copy the `ghp_…` value — GitHub shows it exactly once.

Then put it where it is needed:

```bash
echo 'GITHUB_TOKEN=ghp_xxx' >> .dev.vars            # local dev (gitignored)
npx wrangler secret put GITHUB_TOKEN   # deployed
```

The server token is only ever used for visitors who have not connected their own
GitHub account; signed-in users spend their own quota. To count **private**
repositories you need the OAuth flow below, not this token.

---

## Deploy

> Following this start to finish with nothing installed? **[DEPLOY.md](DEPLOY.md)**
> is the step-by-step version, verified from a clean clone.

**Requires the Workers Paid plan ($5/month).** Counting is CPU-bound and the free
plan allows 10 ms of CPU per request; the classifier runs at ~200 lines/ms, so
10 ms is about 2,000 lines. Paid allows 30 s (a million-line repo needs ~5 s).
Local `wrangler dev` has no such limit. Full reasoning and measurements:
**[DEPLOY.md](DEPLOY.md)**.

The KV namespace already exists and its id is committed in `wrangler.toml`, so a
deploy is three commands:

```bash
npx wrangler login                                    # once per machine
npx wrangler secret put GITHUB_TOKEN # paste the token, press enter
npx wrangler deploy
```

That prints the live URL (`https://loc1999.<your-subdomain>.workers.dev`). Check
it with:

```bash
curl https://loc1999.<your-subdomain>.workers.dev/api/meta
# {"counter_version":"1.1.0","server_token":true,...}
```

`server_token: true` confirms the secret landed. Then count something.

**Before deploying**, `--dry-run` validates the config, bundles the Worker and
lists every binding without uploading anything:

```bash
npx wrangler deploy --dry-run
```

### What is already configured

| Setting | Value | Why |
|---|---|---|
| KV namespace `LOC_KV` | `8c82bc2e…4212` (preview `ee8bb66d…a055`) | result cache, ref cache, sessions, rate limits |
| D1 database `MAIL_DB` | `loc1999-tempmail` | throwaway-inbox storage; schema in `migrations/`. The binding is inert until Email Routing is pointed at the Worker — see [`docs/tempmail.md`](docs/tempmail.md) |
| Cron trigger | `*/15 * * * *` | sweeps expired throwaway messages (expiry is also enforced on every read, so a missed run leaks nothing) |
| Static assets | `./public`, `not_found_handling = "none"` | unmatched paths fall through to the Worker so `/r/…` renders |
| | `html_handling = "none"` | keeps `/how.html` at `/how.html` instead of 307-ing to `/how` |
| `[observability]` | enabled | structured logs visible in the dashboard and `wrangler tail` |
| `APP_BASE_URL` | deliberately unset | the OAuth `redirect_uri` is derived from the request origin, so it is correct on localhost, `*.workers.dev` and a custom domain with no edit |
| Bundle size | ~220 KiB, 45 KiB gzipped | well inside the 1 MiB (gzipped) free-plan limit |

Nothing else needs changing to go live. The tunables (`MAX_FILES`,
`FETCH_CONCURRENCY`, `RATE_LIMIT_PER_MINUTE`, …) are plain vars in
`[env.production.vars]` and take effect on the next deploy.

### Secrets

Secrets are set with `wrangler secret put`, never in `wrangler.toml` — that file
is committed.

```bash
npx wrangler secret put GITHUB_TOKEN          # recommended
npx wrangler secret put GITHUB_CLIENT_ID      # optional: OAuth
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret list                      # names only, never values
```

Rotating one is the same command again; the new value takes effect immediately,
with no redeploy.

### Custom domain (optional)

Workers dashboard → your Worker → **Settings** → **Domains & Routes** → **Add** →
**Custom domain**. Cloudflare issues the certificate and routes it. If you use
one with OAuth, update the callback URL in the GitHub OAuth App to match;
nothing in this repository needs editing.

### Watching it run

```bash
npx wrangler tail --format pretty
```

Every count logs one structured line: cache hit or miss, strategy, file and line
totals, and the `resolve/tree/fetch/parse` timing spans. No tokens, no cookies,
no file contents.

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

## Code golf

`/golf` is the leaderboard that means something. Ranking whole repositories
against each other never did, because two repositories are not attempting the
same thing — these are. Every entry on a challenge board solves the same stated
problem (a URL shortener, a Markdown parser, a JSON parser, Game of Life,
unbeatable tic-tac-toe, a static site generator), so the line count is finally
worth arguing about.

Ranked by **lines of code**, comments and blanks excluded: nobody should have to
strip their comments to compete, and nobody should gain by it. Bytes break ties,
which also means putting a whole program on one line wins the line column and
looks absurd in the byte column beside it. One entry per repository, replaced
when you submit again — the board shows what a repository is now, not the best
it ever was.

Nothing verifies that a submission works. The counter counts; the repository is
linked so anyone can look. That is the whole enforcement mechanism and it is
stated that way on the page.

Challenges live in `src/lib/challenges.ts`, not in storage. There is no admin
page and no way for one to appear without a commit — the cheapest possible
defence against a leaderboard of junk categories.

---

## The standings

`/board` ranks everything counted here on things that should not matter: sheer
size, average file length, comment ratio at both ends, blank-line share, and how
many files were skipped as vendored or generated.

Nothing here ranks on GitHub stars. It used to, and it was wrong twice over: the
board only contains repositories somebody actually counted on this site, and most
of those are personal or obscure, so a per-star board sat empty while excluding
exactly the repositories it was supposed to celebrate. Every measurement now comes
from the counter itself, so a twelve-line project with no stars can top a board on
the day it is written.

**Only counts driven from the page are eligible.** Calling `/api/count` still
counts, caches and shares perfectly well; it just does not put anything on a
board. This is a speed bump rather than authentication — the endpoint the page
uses can be called by hand — and it exists because the board was once filled by
a script walking the API, which is exactly what a leaderboard should not be.

Both sections cost one KV `list()` call and zero result reads: the numbers needed
to rank live in each entry's *metadata*, which `list()` returns for free. The
homepage shows the challenges, fetched from `/api/golf` after load so
`index.html` stays a static asset served straight from the edge. Both board
routes go through the Cache API for 60 seconds, so a burst of visitors costs one
KV list per colo per minute rather than one per visit — Worker responses are not
edge-cached unless you ask.

Ranking rules: forks are excluded, ratio boards need 1,000 lines, per-file
averages need 10 files, and a repository appears once at its most recent commit.
Private repositories never appear on any board or in the sitemap; the listings
fail closed, publishing an entry only if it recorded `private: false`.
Repositories too large for the server are counted in your browser and are not
ranked — the server never sees those numbers and will not rank what it cannot
verify. That is why `MAX_COUNT_BYTES` matters beyond convenience: it decides
what can be ranked at all.

Raising it was tried and measured. At 32 MiB, repositories above roughly 2 MiB
of text failed most requests with Cloudflare's `error code: 1102` — the isolate
killed for exceeding resource limits, which no handler here can catch. Whatever
CPU this deployment gets is far below the paid plan's 30 s, and `[limits]` is
rejected at build time, so the cap stays at the measured-safe 2 MiB. The plan
notes in `wrangler.toml` carry the numbers, and `test/config.test.ts` fails if
the cap drifts back above them.

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
GET  /board                                     the standings (HTML)
GET  /api/board                                 the standings (JSON)
GET  /golf | /golf/{challenge}                  code golf (HTML)
GET  /api/golf                                  challenges + standings (JSON)

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

## Discoverability

Technical only — there is no marketing copy anywhere in this repository, and the
pages carry exactly the text they carried before.

* `/sitemap.xml` is generated from the KV cache: the two static pages plus every
  cached result. Result pages are server-rendered, need no JavaScript, and carry
  real numbers for a specific commit, which makes them the useful long-tail
  content — but they are only linked from a completed count, so a crawler would
  never otherwise find them. Building the list from the cache also guarantees
  every advertised URL is a cache hit, so crawling costs no GitHub quota. A test
  enforces that.
* `/robots.txt` allows the pages, disallows `/api/` (indexing JSON wastes crawl
  budget), and points at the sitemap.
* Titles lead with the answer — `expressjs/express — 26,700 lines of code` —
  rather than the brand, and descriptions carry the real totals.
* `CANONICAL_ORIGIN` pins canonical URLs to the primary domain so the
  `*.workers.dev` copy does not compete with it.
* Error pages are `noindex`.

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

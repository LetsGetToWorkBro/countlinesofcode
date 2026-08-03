# Deploying LOC.1999 from scratch

Start-to-finish, assuming nothing is installed and the repository is not on your
machine. Roughly five minutes, most of it waiting for two browser logins.

Every command is the same on macOS, Linux and Windows (PowerShell).

---

## 0. Prerequisites

You need **Node 20 or newer** and **git**.

```bash
node -v      # want v20.x or higher
git --version
```

If `node -v` says v18 or "command not found", install the LTS from
<https://nodejs.org> (or `brew install node` on macOS). Wrangler 4 requires
Node 20+; nothing else here is version-sensitive.

You also need:

* a **Cloudflare account** — the free plan is enough, see below
* a **GitHub personal access token** — see step 3

### Which plan you need

The free plan works. Counting is CPU-bound, and Cloudflare limits CPU time per
request:

| | Workers Free | Workers Paid ($5/mo) |
|---|---|---|
| CPU time per request | **10 ms** | 30 s default, up to 5 min |
| External subrequests | 50 | 10,000 |
| Requests included | 100k/day | 10M/month |

Measured on this codebase, the classifier runs at about **200 lines per
millisecond**:

| Repository size | CPU needed |
|---|---|
| 1,000 lines | ~5 ms |
| 10,000 lines | ~49 ms |
| 100,000 lines | ~0.5 s |
| 1,000,000 lines | ~4.9 s |

Waiting on GitHub does **not** count toward CPU time, only computation does.

`MAX_COUNT_BYTES` in `wrangler.toml` is set to 2 MiB, which is what the free
plan can finish. Larger repositories are refused *before* any content is
fetched — with a plain explanation, not Cloudflare's bare `error code: 1102` —
and the page then offers to **count them in the visitor's browser**, which has
no CPU limit at all. So on the free plan:

| | where it runs | cached & shareable |
|---|---|---|
| up to ~2 MiB of text | server | yes |
| anything larger | the visitor's browser | no |

Measured on a live free-plan deployment: `expressjs/express` (26,700 lines,
0.68 MiB) counts server-side in about a second; `facebook/react` and
`vercel/next.js` go to browser mode.

Upgrading to **Workers Paid** ($5/month) raises the CPU ceiling to 30 s, so
raising `MAX_COUNT_BYTES` to `"33554432"` moves roughly a million lines back to
the server, where results are cached and links are shareable. Upgrade at
**Workers & Pages** → **Plans**.

---

## 1. Get the code

```bash
git clone https://github.com/LetsGetToWorkBro/countlinesofcode.git
cd countlinesofcode
git checkout claude/github-loc-counter-1999-9marqi
```

> The code lives on that branch. If you have already merged it into `main`, skip
> the `git checkout` line.

---

## 2. Install dependencies

```bash
npm install
```

About 90 packages, a few seconds. Then confirm everything works before you touch
Cloudflare:

```bash
npm test
```

Expect `Tests  205 passed (205)`. These run entirely offline — no GitHub, no
Cloudflare, no token needed.

---

## 3. Create a GitHub token

The site works without one, but anonymous GitHub allows only 60 requests per
hour **per IP**, and Cloudflare's outbound IPs are shared with every other
customer — in practice that allowance is usually already spent by someone else.
Set a token.

1. Go to <https://github.com/settings/tokens>
2. **Generate new token** → **Generate new token (classic)**
3. Note: `LOC.1999`. Expiration: 90 days (or whatever you prefer).
4. **Tick no scopes at all.** For public repositories, being authenticated is the
   entire benefit — scopes would only add risk.
5. **Generate token**, then copy the `ghp_…` value. GitHub shows it exactly once.

Keep it on your clipboard for the next step.

---

## 4. Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser tab. Click **Allow**. You will not need to do it again on
this machine.

Confirm it worked:

```bash
npx wrangler whoami
```

---

## 5. Store the token as a secret

```bash
npx wrangler secret put GITHUB_TOKEN
```

It prompts for the value. Paste the `ghp_…` token and press enter. **Nothing
appears as you paste** — the input is hidden on purpose. That is normal.

Secrets are encrypted at rest and never appear in the repository. Do not put the
token in `wrangler.toml`: that file is committed to git.

---

## 6. Deploy

Validate first — this bundles the Worker and checks every binding without
uploading anything:

```bash
npx wrangler deploy --dry-run
```

Then go live:

```bash
npx wrangler deploy
```

The last line of output is your URL:

```
https://loc1999.<your-subdomain>.workers.dev
```

---

## 7. Check it

```bash
curl https://loc1999.<your-subdomain>.workers.dev/api/meta
```

Look for `"server_token":true` — that confirms the secret arrived. Then open the
URL in a browser, paste `vercel/next.js` (or anything) into the form, and press
**Count Lines**.

Watch the logs live while you do it:

```bash
npx wrangler tail --format pretty
```

One structured line per count: cache hit or miss, strategy, totals, and timing
spans. No tokens, no cookies, no file contents are ever logged.

---

## Running it locally instead

You do not have to deploy to try it:

```bash
echo 'GITHUB_TOKEN=ghp_xxx' >> .dev.vars   # optional, gitignored
npm run dev                                # http://localhost:8787
```

KV is simulated on disk, so caching works locally too. Without a token you get
GitHub's anonymous 60 requests/hour, which from your own IP is usually fine for
poking around — roughly ten fresh counts an hour, and repeats of the same commit
are free.

There is also a one-shot check that runs the real pipeline with no server:

```bash
GITHUB_TOKEN=ghp_xxx npm run verify:live -- vercel/next.js
```

---

## Optional: "Connect GitHub" sign-in

Needed to count **private** repositories, or to let visitors spend their own
GitHub quota instead of yours. The server token above covers neither.

**Choose the app type first — it decides how much power you are asking for.**

| | GitHub App *(recommended)* | OAuth App |
|---|---|---|
| Private repo permission | `contents: read` | `repo` — read **and write**, all private repos |
| Which repos | the user picks at install time | all of them, always |
| `GITHUB_OAUTH_SCOPES` | `""` (empty) | `"read:user repo"` |

A classic OAuth App has no read-only scope for private repositories. `repo` is
the only option, and it grants write access to every private repository the user
can reach — for a tool that counts lines. A GitHub App with `contents: read`,
installed on selected repositories, asks for a fraction of that, and users can
see exactly which repositories they exposed.

**This is why the default is `read:user`**: public repositories and a higher rate
limit, no private access at all. Private support is opt-in, never accidental,
and a test enforces that `repo` is never requested unless configured.

### GitHub App (recommended)

1. <https://github.com/settings/apps> → **New GitHub App**
2. Homepage URL `https://1999loc.com`, callback URL
   `https://1999loc.com/api/auth/callback`
3. Tick **Request user authorization (OAuth) during installation**
4. Permissions → Repository → **Contents: Read-only**, **Metadata: Read-only**.
   Nothing else.
5. Create it, note the Client ID, generate a client secret, then install the app
   on whichever repositories should be countable.

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Then set `GITHUB_OAUTH_SCOPES = ""` in `[vars]` and deploy. The empty value tells
the Worker to send no `scope` parameter, because a GitHub App's permissions come
from the app itself.

### OAuth App (simpler, far more privilege)

1. <https://github.com/settings/developers> → **New OAuth App**
2. Homepage `https://1999loc.com`, callback
   `https://1999loc.com/api/auth/callback`
3. Set the two secrets as above.
4. For public repositories only, change nothing — the default `read:user` is
   already right. For private repositories, set
   `GITHUB_OAUTH_SCOPES = "read:user repo"` and understand that you are asking
   every user for write access to all their private code.

### Either way

The front page states the exact scope before anyone clicks, `/api/meta` reports
it as `oauth_scopes`, and `/security.html` explains what is stored with links to
the source that implements it. Tokens live in KV under an opaque session id and
never reach the browser; the cookie holds only that id.

### Making the deployment verifiable

`/api/meta` reports `source_commit`, so anyone can check the running build
against the public repository. Set it at deploy time — in Workers Builds, use:

```
npx wrangler deploy --var SOURCE_COMMIT:$WORKERS_CI_COMMIT_SHA
```

---

## Custom domain

This deployment serves <https://1999loc.com>, added through the dashboard. The
bare domain is canonical.

`www.1999loc.com` is optional. The Worker already 301s it to the apex, so it
never dead-ends and only one address gets indexed — but that redirect can only
run if www reaches the Worker. To enable it, add `www.1999loc.com` as a second
custom domain exactly like the apex. No page rule or redirect rule is required;
leaving www unregistered is also fine.

### How it was done

Cloudflare dashboard → **Workers & Pages** → `loc1999` → **Settings** →
**Domains & Routes** → **Add** → **Custom domain**. Cloudflare issues the
certificate and routes it automatically. The domain must already be a zone in
the same Cloudflare account.

The `*.workers.dev` URL keeps working alongside it. That is convenient for
testing but means two public addresses serve the same pages, so the static pages
carry a `<link rel="canonical">` pointing at the custom domain. To collapse to
one address entirely, set `workers_dev = false` in `wrangler.toml` and redeploy
— at the cost of losing the workers.dev URL and per-deploy preview URLs.

Nothing in this repository needs editing — the app derives its own base URL from
the incoming request. If you are using OAuth, update the callback URL in the
GitHub OAuth App to the new domain.

---

## Updating it later

```bash
git pull
npx wrangler deploy
```

Secrets survive deploys. To rotate the token, run `wrangler secret put` again —
it takes effect immediately, with no redeploy.

### Automatic deploys from GitHub

Connecting the repository in **Workers & Pages -> loc1999 -> Settings -> Build**
makes every push to the production branch deploy itself. Settings that matter:

| Field | Value |
|---|---|
| Production branch | `main` |
| Build command | `npm ci && npm run build:client` |
| Deploy command | `npx wrangler deploy` |
| Root directory | *(blank)* |

Two things make this work:

* **One configuration.** `wrangler.toml` has no `[env.production]` block, on
  purpose. Workers Builds runs a bare `npx wrangler deploy`, so a second
  environment would mean pushes and manual deploys shipped different settings to
  the same Worker.
* **Secrets are not in the repository.** `GITHUB_TOKEN` and the OAuth
  credentials live on the Worker and survive every deploy, automatic or not. An
  automatic deploy never needs them re-entered.

The build command is optional — `public/bigcount.js` is committed — but running
it means a forgotten rebuild cannot ship stale counting rules to the browser.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `Error 1102 Worker exceeded resource limits` | `MAX_COUNT_BYTES` set too high for the plan | lower it to `"2097152"` on free; large repos then fall back to browser mode |
| `"server_token":false` at `/api/meta` | secret not set | re-run step 5, then redeploy |
| Counts fail with `rate_limited` | no token, or the token is exhausted | check `server_token`, or wait for the hourly reset |
| `Bad credentials` | token expired, revoked, or mistyped | generate a new one, re-run step 5 |
| `not_found` on a repo you can see | it is private | private repos need the OAuth flow, not the server token |
| Deploy says "you need to login" | not authenticated | `npx wrangler login` |
| `npm install` fails on Node 18 | wrangler 4 needs Node 20+ | upgrade Node |

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

* a **Cloudflare account** on the **Workers Paid plan** ($5/month) — see below
* a **GitHub personal access token** — see step 3

### Why the paid plan is required

This is the one thing that cannot be worked around, so know it before you start.

Counting is CPU-bound, and Cloudflare limits CPU time per request:

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

So the free plan's 10 ms budget covers roughly **2,000 lines** — smaller than
many single source files — and that is before gzip and tar parsing. On the free
plan anything real returns HTTP 1102, `Worker exceeded resource limits`.

On the paid plan the 30 second default is ample: a million-line repository uses
about 5 seconds. Waiting on GitHub does **not** count toward CPU time, only
actual computation does.

If you only want to try it out, run it locally instead (see the end of this
document) — `wrangler dev` has no CPU limit.

Upgrade at **Workers & Pages** → **Plans** in the Cloudflare dashboard.

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

Expect `Tests  181 passed (181)`. These run entirely offline — no GitHub, no
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
npx wrangler secret put GITHUB_TOKEN --env production
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
npx wrangler deploy --env production --dry-run
```

Then go live:

```bash
npx wrangler deploy --env production
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
npx wrangler tail --env production --format pretty
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

Only needed to count **private** repositories, or to let visitors spend their own
GitHub quota instead of yours. The server token above does not cover private
repos.

1. <https://github.com/settings/developers> → **New OAuth App**
2. **Homepage URL**: `https://loc1999.<your-subdomain>.workers.dev`
3. **Authorization callback URL**:
   `https://loc1999.<your-subdomain>.workers.dev/api/auth/callback`
4. Register, then copy the Client ID and generate a Client Secret.

```bash
npx wrangler secret put GITHUB_CLIENT_ID --env production
npx wrangler secret put GITHUB_CLIENT_SECRET --env production
npx wrangler deploy --env production
```

The "Connect GitHub" section on the homepage switches from "not configured" to a
working sign-in link. Tokens are stored server-side in KV under an opaque session
id; the browser only ever holds that id, in an HttpOnly cookie.

---

## Optional: custom domain

Cloudflare dashboard → **Workers & Pages** → `loc1999` → **Settings** →
**Domains & Routes** → **Add** → **Custom domain**. Cloudflare issues the
certificate and routes it automatically.

Nothing in this repository needs editing — the app derives its own base URL from
the incoming request. If you are using OAuth, update the callback URL in the
GitHub OAuth App to the new domain.

---

## Updating it later

```bash
git pull
npx wrangler deploy --env production
```

Secrets survive deploys. To rotate the token, run `wrangler secret put` again —
it takes effect immediately, with no redeploy.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `Error 1102 Worker exceeded resource limits` | free plan's 10 ms CPU cap | upgrade to Workers Paid — see "Why the paid plan is required" |
| `"server_token":false` at `/api/meta` | secret not set, or set on the wrong environment | re-run step 5 **with** `--env production` |
| Counts fail with `rate_limited` | no token, or the token is exhausted | check `server_token`, or wait for the hourly reset |
| `Bad credentials` | token expired, revoked, or mistyped | generate a new one, re-run step 5 |
| `not_found` on a repo you can see | it is private | private repos need the OAuth flow, not the server token |
| Deploy says "you need to login" | not authenticated | `npx wrangler login` |
| `npm install` fails on Node 18 | wrangler 4 needs Node 20+ | upgrade Node |

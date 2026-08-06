# Turning on the temporary inbox

`/mail.html` hands out disposable email addresses and shows what lands at them.
The code ships dark: the page loads, generates an address and polls, but no mail
can reach it until **Cloudflare Email Routing** is pointed at this Worker. That
last step is done in the dashboard and DNS, not in this repository, so it lives
here rather than in the deploy script.

Everything on the code side is already in place after a normal deploy:

* the `email()` handler in `src/worker/index.ts` (receives and stores mail),
* the `/api/mail/*` routes (the page reads its inbox through these),
* the `MAIL_DB` D1 binding and the `messages` table (`migrations/0001_mailbox.sql`),
* the `*/15 * * * *` cron that sweeps expired messages,
* `MAIL_DOMAIN` in `wrangler.toml`, the domain addresses are minted under.

What remains is one-time, and only the Cloudflare account owner can do it.

## The domain: a subdomain, on purpose

`MAIL_DOMAIN` is set to **`mail.1999loc.com`**, a subdomain, not the apex. This
is deliberate. A public throwaway inbox attracts spam and its addresses leak into
lists and breach dumps; pinning all of that to a subdomain keeps it off the
**apex's mail reputation** — the same `1999loc.com` that serves the site and that
you'd care about if it ever sent real mail. It costs nothing extra: the subdomain
lives in the same Cloudflare zone, so there is no second domain to buy.

Cloudflare supports Email Routing on subdomains natively (Email Routing is
enabled on the apex, then subdomains are added under its settings). The steps
below reflect that. If you would rather run it on the apex, or on a wholly
separate domain, see [Using a different domain](#using-a-different-domain).

---

## 0. Before you start

* The **apex `1999loc.com` must be a zone in the Cloudflare account.** It is,
  because it serves the site. The `mail.` subdomain does not need to exist as its
  own zone — it is added from the apex zone's Email Routing settings in step 2.
* The D1 database must exist and be migrated. It already is — created as
  `loc1999-tempmail`, schema applied — but on a fresh account, do it once:

  ```bash
  npx wrangler d1 create loc1999-tempmail
  # put the printed database_id into wrangler.toml under [[d1_databases]]
  npx wrangler d1 migrations apply MAIL_DB --remote
  ```

* Deploy the Worker at least once (`npx wrangler deploy`), so there is an
  `email` handler for Email Routing to target.

---

## 1. Enable Email Routing on the apex

Email Routing is a zone-level feature; it is switched on at the apex first, even
though the inbox will live on a subdomain.

Cloudflare dashboard → the domain (`1999loc.com`) → **Email** →
**Email Routing** → **Get started**. Accept the DNS records it offers to add
(MX + a TXT SPF record). This is what makes the internet deliver mail for the
zone to Cloudflare. It takes a few minutes to verify.

> You do **not** have to create any named address or catch-all on the apex. Leave
> the apex with no catch-all (or an inert one) so mail to `1999loc.com` itself is
> unaffected — only the subdomain routes to the Worker.

---

## 2. Add the `mail` subdomain

Still under **Email Routing** → **Settings** → **Subdomains** → enter `mail`
and submit.

Cloudflare adds the required DNS records (MX, SPF, DKIM) to `mail.1999loc.com`
automatically. Wait for them to propagate — usually a few minutes. Once they do,
the subdomain accepts mail and gets its own routing rules, separate from the
apex.

---

## 3. Point the subdomain's catch-all at this Worker

**Email Routing** → **Routing rules**, with **`mail.1999loc.com`** selected (not
the apex) → **Catch-all address**.

* Set the action to **Send to a Worker**.
* Choose the **`loc1999`** Worker.
* **Enable** the catch-all.

A catch-all (rather than a list of named addresses) is required: the whole point
is that every random generated localpart — `rzhzycag2afsta@mail.1999loc.com` and
a million others — must resolve to the Worker without being registered first. The
Worker itself decides what to keep: `parseInboxAddress` accepts only addresses
that match the generated shape *and* the configured domain, and drops everything
else, so mail to `admin@mail.1999loc.com` or a guessed name is received and
discarded, never stored.

Leave the subdomain's "Custom addresses" list empty (or use it only for real mail
you want forwarded elsewhere — those rules run ahead of the catch-all).

---

## 4. Confirm it works

Send a message from any real mailbox to an address the page shows:

1. Open `https://1999loc.com/mail.html`, copy the address it generated (it will
   end in `@mail.1999loc.com`).
2. Email it from Gmail, or anywhere.
3. Within a few seconds the page's inbox lists it, with the sender-auth verdict
   and tracker count. Click it to read the body as plain text.

Watch it server-side while you test:

```bash
npx wrangler tail --format pretty
```

A delivered message logs a `mail_received` line with its size and tracker count;
a dropped one (`admin@`, wrong domain, malformed) logs `mail_dropped` with the
reason. Nothing logs the body, the sender, or the recipient address.

If mail never arrives, check in this order:

| Symptom | Likely cause |
|---|---|
| Subomain shows "Not configured" / MX unverified | DNS from step 2 hasn't propagated yet — wait, then re-check |
| Sender gets a bounce | the **subdomain's** catch-all isn't enabled, or not set to the Worker (check you selected `mail.1999loc.com`, not the apex) |
| Bounce mentions SPF/DMARC | the records Cloudflare added on the subdomain are missing or edited |
| Page shows an address but nothing lands, no bounce | `MAIL_DOMAIN` doesn't match the routed subdomain — it must be exactly `mail.1999loc.com` |

---

## Using a different domain

`MAIL_DOMAIN` in `wrangler.toml` decides the domain in every address the page
mints, and the Worker only accepts mail whose recipient domain matches it
exactly. To change it, edit that one line, redeploy, and enable routing for the
new target. No code changes.

* **A different subdomain** (`inbox.1999loc.com`, `tmp.1999loc.com`): same as
  above with a different label in step 2. This is the recommended shape.
* **The apex (`1999loc.com`)** — set `MAIL_DOMAIN = "1999loc.com"`, skip step 2,
  and put the catch-all on the apex in step 3. Simpler, but throwaway-inbox spam
  then accrues to the domain the site runs on. Fine if the apex never sends mail;
  the blast radius is small but not zero.
* **A wholly separate domain** (`1999mail.com`, added as a second zone in the
  same account) — maximum isolation, but it is a domain to register and renew.
  The subdomain gets nearly the same benefit for free, which is why it is the
  default.

Addresses already handed out on the old domain simply stop receiving once its
catch-all is removed — nothing to migrate, since inboxes are ephemeral by design.

---

## How the storage behaves

Worth knowing when you operate it, all enforced in `src/lib/mailbox.ts` and
`src/worker/mail.ts`:

* **Messages expire after one hour** (`INBOX_TTL_MS`). Reads already filter on
  expiry, so an expired message is invisible the moment it lapses; the cron just
  reclaims the row.
* **At most 50 messages per inbox** (`MAX_MESSAGES_PER_INBOX`) — a new arrival
  trims the oldest beyond that, in the same D1 batch as the insert.
* **A message is capped at 1 MB on the wire** (`MAX_MESSAGE_BYTES`) and its
  stored text at 100 000 characters (`MAX_BODY_CHARS`); the raw stream is read no
  further than the cap.
* **HTML is never rendered.** The body is reduced to plain text server-side and
  the page prints it inside a `<pre>` as escaped text, so a message can't run
  script or load a remote image in the reader. Trackers found in the original are
  *reported*, not fetched.
* **Addresses are unguessable** — a 14-character base32 localpart, ~70 bits — so
  one visitor cannot read another's inbox by trying. There are no accounts and no
  auth; holding the address is the only claim to it, which is exactly the
  disposable-inbox model.

The cron is a caretaker, not load-bearing: if it misses a run nothing leaks,
because expiry is also checked on every read.

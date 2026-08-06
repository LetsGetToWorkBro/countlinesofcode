# Turning on the temporary inbox

`/mail.html` hands out throwaway email addresses and shows what arrives at them.
The code ships dark: the page loads, generates an address and polls, but no mail
can reach it until **Cloudflare Email Routing** for the domain is pointed at this
Worker. That last step is done in the dashboard and DNS, not in this repository,
so it lives here rather than in the deploy script.

Everything on the code side is already in place after a normal deploy:

* the `email()` handler in `src/worker/index.ts` (receives and stores mail),
* the `/api/mail/*` routes (the page reads its inbox through these),
* the `MAIL_DB` D1 binding and the `messages` table (`migrations/0001_mailbox.sql`),
* the `*/15 * * * *` cron that sweeps expired messages,
* `MAIL_DOMAIN` in `wrangler.toml`, the domain addresses are minted under.

What remains is one-time, and only the Cloudflare account owner can do it.

---

## 0. Before you start

* The domain must already be a **zone in the same Cloudflare account** as the
  Worker. `1999loc.com` is, because it serves the site.
* The D1 database must exist and be migrated. It already is — created as
  `loc1999-tempmail`, schema applied — but if you are standing this up on a fresh
  account, do it once:

  ```bash
  npx wrangler d1 create loc1999-tempmail
  # put the printed database_id into wrangler.toml under [[d1_databases]]
  npx wrangler d1 migrations apply MAIL_DB --remote
  ```

* Deploy the Worker at least once (`npx wrangler deploy`), so there is an
  `email` handler for Email Routing to target.

---

## 1. Enable Email Routing on the zone

Cloudflare dashboard → pick the domain (`1999loc.com`) → **Email** →
**Email Routing** → **Get started**.

Cloudflare adds the DNS it needs automatically:

* three **MX** records pointing at `*.mx.cloudflare.net`,
* a **TXT SPF** record (`v=spf1 include:_spf.mx.cloudflare.net ~all`).

Accept them. This is what makes the internet deliver mail for the domain to
Cloudflare in the first place. It takes a few minutes to verify.

> If the apex already sends mail (it does not here), enabling routing changes its
> MX records. That is the reason to consider a dedicated domain — see step 4.

---

## 2. Point the catch-all at this Worker

Still under **Email Routing** → **Routing rules** → **Catch-all address**.

* Set the action to **Send to a Worker**.
* Choose the **`loc1999`** Worker.
* **Enable** the catch-all.

A catch-all (rather than a list of named addresses) is required: the whole point
is that every random generated localpart — `rzhzycag2afsta@1999loc.com` and a
million others — must resolve to the Worker without being registered first. The
Worker itself decides what to keep: `parseInboxAddress` accepts only addresses
that match the generated shape and drops everything else, so mail to
`admin@`, `hello@` and the like is received and discarded, never stored.

You do **not** need to add individual custom addresses. Leave the "Custom
addresses" list empty (or use it only for real mail you want forwarded
elsewhere — those rules run ahead of the catch-all).

---

## 3. Confirm it works

Send a message from any real mailbox to an address the page shows:

1. Open `https://1999loc.com/mail.html`, copy the address it generated.
2. Email it from Gmail, or anywhere.
3. Within a few seconds the page's inbox lists it, with the sender-auth verdict
   and tracker count. Click it to read the body as plain text.

Watch it server-side while you test:

```bash
npx wrangler tail --format pretty
```

A delivered message logs a `mail_received` line; a dropped one
(`admin@`, malformed) logs `mail_dropped` with the reason. Nothing logs the body,
the sender, or the recipient address.

If mail never arrives, check in this order:

| Symptom | Likely cause |
|---|---|
| Email Routing shows "Not configured" / MX unverified | DNS from step 1 hasn't propagated yet — wait, then re-check |
| Sender gets a bounce | catch-all not enabled, or not set to the Worker |
| Bounce mentions SPF/DMARC | the SPF record from step 1 is missing or edited |
| Page shows an address but nothing lands, no bounce | `MAIL_DOMAIN` doesn't match the routed domain (step 4) |

---

## 4. `MAIL_DOMAIN`: apex vs a dedicated domain

`MAIL_DOMAIN` in `wrangler.toml` decides the domain in every address the page
mints, and the Worker only accepts mail whose recipient domain matches it. It
must be exactly the domain you enabled routing on.

It is set to `1999loc.com`, the apex. That works, but there is a reputation
trade-off worth understanding:

* **Apex (`1999loc.com`).** One domain, nothing extra to buy. But a public
  throwaway inbox attracts spam and its addresses show up in leaks and lists;
  over time that can drag on the *domain's* mail reputation — the same domain the
  site runs on. Since the site never *sends* mail, the blast radius is small, but
  it is not zero.
* **A dedicated throwaway domain** (say `1999mail.com`, added as a second zone in
  the same account). Isolates all of that from the main domain. Enable Email
  Routing on it, point its catch-all at the same `loc1999` Worker, set
  `MAIL_DOMAIN` to it, and redeploy. The Worker code needs no other change.

To switch domains later: change `MAIL_DOMAIN`, redeploy, and enable routing on
the new domain. Addresses already handed out on the old domain simply stop
receiving once its catch-all is removed — nothing to migrate, since inboxes are
ephemeral by design.

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

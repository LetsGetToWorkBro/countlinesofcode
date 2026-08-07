# The Tor onion mirror

Running 1999.LOC as a v3 onion service removes two parties from the path at
once. There is no exit node, because the traffic never leaves Tor. And there
is no Cloudflare, because the onion box talks to the origin itself. What the
service sees is a circuit; what the network sees is onion cells.

This is the strongest privacy thing the site can offer a visitor, and it is
also the one that needs a machine. The site's own half is done: `npm run
onion:set` writes the advertisement. The rest is below.

**The honest caveat, first.** Whoever runs the onion box sees the traffic in
the clear, because that box is where the TLS ends. Today that party is
Cloudflare. If you rent the onion box from a host who can read its memory, you
have swapped one watcher for a smaller, less accountable one. Run it yourself,
on hardware or a VPS you control, or do not run it at all.

---

## What you need

- A machine with a public IP that can reach `1999loc.com` outbound. It needs
  no inbound ports: an onion service dials out to Tor. 1 vCPU and 1 GB is
  plenty for a static site. Debian or Ubuntu below; adjust to taste.
- Root on it.
- About twenty minutes, plus however long you let the vanity address grind.

---

## 1. Install Tor and EOTK

[EOTK](https://github.com/alecmuffett/eotk), the Enterprise Onion Toolkit, is
Alec Muffett's tool for exactly this: it stands up an onion service that
mirrors an existing site, rewriting the clearnet hostname to the onion one in
HTML, CSS and JavaScript as it passes through, so links inside the site stay
inside the onion.

```sh
sudo apt update
sudo apt install -y tor git nginx-extras libnginx-mod-http-subs-filter \
                    build-essential libssl-dev
git clone https://github.com/alecmuffett/eotk.git
cd eotk
./opt.d/000-install-debian.sh      # pulls the rest of what it needs
```

EOTK wants `nginx` built with the `subs_filter` module, which is what
`nginx-extras` provides on Debian and Ubuntu. If `nginx -V` does not mention
`ngx_http_subs_filter_module`, stop and fix that first: everything downstream
depends on the rewriting.

## 2. Pick an address

A v3 onion address is 56 characters of base32, and it is the public key. You
can take whatever Tor generates, or grind a readable prefix with
[mkp224o](https://github.com/cathugger/mkp224o):

```sh
git clone https://github.com/cathugger/mkp224o
cd mkp224o && ./autogen.sh && ./configure && make
./mkp224o 1999loc -d ~/onion-keys -n 1 -v
```

A 7-character prefix is minutes on a laptop; 8 is hours; beyond that the
maths turns unkind quickly. Grinding does not weaken the key: it is still a
real Ed25519 keypair, you are simply discarding the ones that do not spell
what you wanted.

**The key in `~/onion-keys/<address>/hs_ed25519_secret_key` is the address.**
Back it up somewhere offline. Lose it and the address is gone forever; leak it
and somebody else can be you.

## 3. Configure the mirror

Create `1999loc.tconf` in the EOTK directory:

```
set project 1999loc
hardmap %ONION_ADDRESS% 1999loc.com
set nginx_resolver 1.1.1.1 9.9.9.9
set nginx_timeout 30
set force_https 0
set suppress_header_hsts 1
set suppress_header_hpkp 1
set suppress_header_onion_location 1
```

Three of those matter:

- `suppress_header_hsts` strips Strict-Transport-Security. The onion is
  plain http, and an HSTS header from the mirror would tell the browser to
  demand https from an address that has no certificate.
- `suppress_header_onion_location` strips the header the clearnet site sends,
  so the mirror does not advertise itself to itself.
- `force_https 0` because, again, an onion is its own transport security. The
  address *is* the public key; a certificate on top adds a warning and
  nothing else.

Then:

```sh
./eotk config 1999loc.tconf
./eotk maketorrc 1999loc
# put your ground key in place, if you ground one:
cp -r ~/onion-keys/<address>/ projects.d/1999loc/hs.d/<address>/
./eotk start 1999loc
./eotk status
```

`./eotk print-onions 1999loc` prints the address the mirror is serving.

## 4. Advertise it from the clearnet site

From this repository, with the address EOTK printed:

```sh
npm run onion:set <address>.onion
git commit -am "Advertise the onion mirror"
git push            # Workers Builds deploys it
```

That writes the address in the two places the site is served from:

- `public/_headers`, for the static pages. The asset router serves those at
  the edge and never wakes the Worker, so the Worker's copy cannot cover them.
- the `ONION_HOST` var in `wrangler.toml`, for the pages the Worker renders
  (`/golf`, `/board`, `/r/...`, the error pages).

`npm run onion:clear` reverses it. `src/lib/onion.ts` holds the rules and
`test/onion.test.ts` holds them to it: the header is only sent from HTTPS,
never from the onion about itself, and never on `/api/` paths.

## 5. Check it

```sh
curl -sI https://1999loc.com/ | grep -i onion-location
```

Then load the site in Tor Browser. It should show **".onion available"** in
the address bar. Click it and confirm:

- the desktop, the icons and the taskbar all render (EOTK is rewriting the
  stylesheet and script URLs correctly);
- the Start menu and the DOS prompt work (same, for `start.js`);
- **the tools still work.** This is the one to check properly. The site's
  Content-Security-Policy is `connect-src 'self'`, and on the mirror "self"
  is the onion, so `/api/xmr`, `/api/btc`, `/api/swap` and `/api/mail` all
  resolve to the onion and pass. If a tool cannot reach its API on the
  mirror, EOTK's rewriting missed something; check `nginx -T` on the box.

## What the mirror changes, and what it does not

| | clearnet | onion |
|---|---|---|
| Sees your IP | Cloudflare, and the site behind it | nobody: the service sees a circuit |
| Sees the URLs you fetch | Cloudflare | the onion box (yours) |
| Sees the wallet addresses the Bitcoin tab looks up | Cloudflare, then the explorer | the onion box, then the explorer |
| Certificate authority in the path | yes | no: the address is the key |
| Exit node | not applicable | none |

The onion does not change what the *upstream services* see. A Monero node
still sees a request for blocks, an Esplora explorer still sees the addresses
the Bitcoin wallet asks about, and an exchange still sees a swap being
created. Those all arrive from the onion box rather than from Cloudflare, so
they are a step further from the visitor, but they are the same requests. For
the explorer specifically, see the Bitcoin wallet's own privacy modes in
`docs/wallet-privacy.md`.

## Keeping it alive

- `./eotk stop 1999loc` and `./eotk start 1999loc` are the whole lifecycle.
  Add a systemd unit or a cron `@reboot` so it comes back on its own.
- Tor and nginx both want ordinary security updates. An onion box is a web
  server with a nicer address, not a magic one.
- If the site's CSP or hostnames ever change, re-run `./eotk config` so the
  rewriting keeps up.
- Publish the address somewhere signed. An onion address handed over an
  unauthenticated channel is an onion address somebody can substitute; the
  `Onion-Location` header is authenticated by the clearnet site's certificate,
  which is exactly why it is the right way to hand it out.

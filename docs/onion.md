# The Tor onion mirror

Running 1999.LOC as a v3 onion service removes two parties from the path at
once. There is no exit node, because the traffic never leaves Tor. And there
is no Cloudflare, because the onion box talks to the origin itself. What the
service sees is a circuit; what the network sees is onion cells.

This is the strongest privacy thing the site can offer a visitor, and it is
also the one that needs a machine. The site's own half is done: `npm run
onion:set` writes the advertisement. Everything else is in `ops/onion/`, and
this file is the runbook for it.

**The honest caveat, first.** Whoever runs the onion box sees the traffic in
the clear, because that box is where the TLS ends. Today that party is
Cloudflare. If you rent the onion box from a host who can read its memory, you
have swapped one watcher for a smaller, less accountable one. Run it yourself,
on hardware or a VPS you control, or do not run it at all.

---

## What you need

- A machine with a public IP that can reach `1999loc.com` outbound. It needs
  no inbound ports at all: an onion service dials out to Tor and nothing dials
  in. 1 vCPU and 1 GB is plenty. Debian or Ubuntu below; adjust to taste.
- Root on it.
- About ten minutes, plus however long you let the vanity address grind.

---

## 1. Pick an address

A v3 onion address is 56 characters of base32 and it *is* the public key, so
you cannot choose one: you generate keys until one happens to start with what
you wanted. [mkp224o](https://github.com/cathugger/mkp224o) does that.

**Base32 has no 0, 1, 8 or 9.** The alphabet is `a`-`z` and `2`-`7`, and that
is the whole of it. So "1999" cannot appear in an onion address, and neither
can any word containing those digits. The nearest thing available is
`mcmxcix`, which is 1999 in Roman numerals, and after that it is words.

```sh
sudo apt install -y build-essential autoconf libsodium-dev
git clone https://github.com/cathugger/mkp224o
cd mkp224o
./autogen.sh
./configure --enable-amd64-51-30k --enable-intfilter --enable-binsearch
make -j"$(nproc)"

printf '%s\n' mcmxcix nothing notrack loccode codeloc loctool tinyloc locfree > filters.txt
./mkp224o -f filters.txt -t "$(nproc)" -d ~/onion-keys -O found.txt -s
```

Those `configure` flags matter more than they look: they pick the fast
assembly Ed25519 implementation and the integer filter, and they are worth
roughly an order of magnitude over a bare `./configure`.

How long it takes is only a function of prefix length, because each character
is one of 32:

| prefix | keys to expect | at 17 M/s (4 cores, 2.1 GHz Xeon) |
|---|---|---|
| 5 | 34 million | 2 seconds |
| 6 | 1.1 billion | a minute |
| 7 | 34 billion | ~30 minutes |
| 8 | 1.1 trillion | ~18 hours |
| 9 | 35 trillion | ~24 days |

Those are means, not deadlines: it is a memoryless search, so half the time
you beat it and occasionally you wait three times as long. Feeding several
filters at once does not slow any of them down, because every generated key is
tested against all of them; it just means more ways to win. Seven characters
is the sweet spot, and eight is the last one that is reasonable.

Grinding does not weaken the key. It is a real Ed25519 keypair either way; you
are only discarding the ones that do not spell what you wanted.

**The key in `~/onion-keys/<address>.onion/hs_ed25519_secret_key` is the
address.** Back it up offline. Lose it and the address is gone forever; leak
it and somebody else can be you. Generate it on a machine you trust, for the
same reason.

## 2. Stand up the mirror

```sh
git clone https://github.com/letsgettoworkbro/countlinesofcode
cd countlinesofcode/ops/onion
sudo ./install.sh ~/onion-keys/<address>.onion
```

That installs tor and nginx, drops the key in with the permissions Tor
insists on, enables both at boot, and prints the address. Run it again any
time; it will not overwrite a key already in place unless you hand it a new
one. Omit the key argument and Tor generates a random address instead.

### Why this is a reverse proxy and not EOTK

The usual tool for onion-mirroring an existing site is
[EOTK](https://github.com/alecmuffett/eotk), which runs nginx with
`subs_filter` and rewrites the clearnet hostname to the onion one in HTML,
CSS and JavaScript as it passes through. It exists because most sites are full
of absolute links to themselves, and on the mirror every one of those is a
door back out to the clearnet.

This site has none. Every link, stylesheet, script, image and API path is
written relative; the only absolute self-references anywhere in the HTML are
`<link rel="canonical">` and `og:url`, which are metadata for search engines
and are *supposed* to point at the clearnet original. So there is nothing to
rewrite, and `ops/onion/nginx-onion.conf` is forty lines of reverse proxy
instead of a toolkit with a Perl driver.

The Content-Security-Policy comes along for free, which is the part worth
understanding. It is `connect-src 'self'`, `script-src 'self'`, and on the
mirror "self" *is* the onion, because the browser resolves it against the
origin it loaded the page from. The tools call `/api/xmr`, `/api/btc`,
`/api/swap` and `/api/mail` relatively, those resolve to the onion, the proxy
passes them to the origin, and the policy is satisfied without anybody
configuring anything. A site that had hardcoded `https://1999loc.com/api/...`
would fail its own CSP on the mirror and need EOTK to fix it.

Two things the proxy does have to do, both in the config with comments:

- **Strip `Strict-Transport-Security`.** The onion is plain http. An HSTS
  header would tell the browser to demand https from an address that has no
  certificate and cannot be issued one.
- **Strip `Onion-Location`.** Otherwise the mirror advertises itself to
  itself.

And one it deliberately does not do: there is no `X-Forwarded-For`. A visitor
arrives as a Tor circuit, `127.0.0.1` is the whole truth about where the
request came from, and inventing a header would hand the origin a fact the
onion exists to withhold.

There is also no proxy cache, on purpose. A cache shared between visitors
tells one of them, through response timing, which pages another fetched
recently. The origin is a Worker with its assets on a CDN edge and answers in
single-digit milliseconds, which is nothing against six Tor hops; there is no
speed here worth that side channel.

## 3. Check it before you advertise it

Load the address in Tor Browser and click through the tools. `install.sh`
already checks the proxy hop and the header stripping, so what is left is the
part only a browser can answer:

- the desktop, the icons, the taskbar and the Start menu all render and work
  (stylesheet and scripts are resolving against the onion);
- **the tools still work**, particularly the wallet, the swap and the
  disposable inbox, because those are the ones that call `/api/`.

The same check runs locally without Tor, which is how this config was
verified: point nginx at the origin, load `http://127.0.0.1:8080/` in a
browser, and every relative URL and CSP rule behaves exactly as it will on the
onion, because in both cases "self" is an origin that is not `1999loc.com`.

## 4. Advertise it from the clearnet site

Last, once the service actually answers:

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
`test/onion.test.ts` holds them to it: the header is only sent over HTTPS,
never from the onion about itself, and never on `/api/` paths.

```sh
curl -sI https://1999loc.com/ | grep -i onion-location
```

Tor Browser will then show **".onion available"** in the address bar. Do this
step last: until the service answers, the header points at a door that is not
there.

## A thing to check on the Cloudflare side

Cloudflare's Web Analytics injects `static.cloudflareinsights.com/beacon.min.js`
into HTML responses at the edge, after the Worker has run, when the request
looks like it came from a browser. It is off in the dashboard or it is not;
there is no code in this repository that can prevent it.

The site's CSP refuses to load it, which is verifiable in any browser console
and is exactly the argument the site makes about itself: the rule is enforced
by the browser rather than promised by us, and it holds even against the
company serving the page. But a blocked script tag is still a script tag in
the HTML, and the site says in plain words that there is no analytics script
on any page. Turn it off at **the zone → Analytics → Web Analytics** rather
than relying on the policy to keep catching it.

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

- `systemctl status tor nginx` is the whole health check. Both are enabled at
  boot by `install.sh`.
- Tor and nginx want ordinary security updates. An onion box is a web server
  with a nicer address, not a magic one.
- The key is the only irreplaceable thing on the machine. Everything else in
  `ops/onion/` rebuilds the box from scratch in ten minutes.
- Publish the address somewhere signed. An onion address handed over an
  unauthenticated channel is an onion address somebody can substitute; the
  `Onion-Location` header is authenticated by the clearnet site's certificate,
  which is exactly why it is the right way to hand it out.
- If the site ever grows an absolute link to itself, the mirror will start
  leaking visitors back to the clearnet and this becomes an EOTK problem
  again. `grep -rn 'https://1999loc.com' public/` should only ever turn up
  `canonical` and `og:url`.

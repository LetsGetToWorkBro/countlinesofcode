# What the Bitcoin wallet leaks, and what to do about it

The Monero wallet has an easy time of it. A Monero node hands over blocks and
the tab works out which outputs are yours, so the node learns nothing except
that somebody asked for blocks.

A Bitcoin light wallet cannot do that. It has to name its addresses out loud:
"has `bc1q…` got anything on it?", forty times, at somebody. That question is
the leak, and it is worth stating plainly rather than burying it.

## Who hears the question

```
your tab  ->  1999loc.com/api/btc/...  ->  mempool.space or blockstream.info
              (this site's Worker,          (the explorer)
               and Cloudflare in front)
```

Both middle parties see the addresses. The explorer sees them because it must
answer. This site's Worker sees them because it carries the question, which
means Cloudflare, whose certificate terminates the TLS, sees them too. None of
them ever see a key, a seed phrase, or a signature: those never leave the tab.
But a request log with forty addresses in it, from one visitor, in one minute,
**is** a wallet.

## The three answers, weakest to strongest

### 1. Padded lookups (Explorer -> Lookups -> Padded)

Every batch of address questions is mixed with real decoy addresses, drawn
from a shipped pool of 256 mainnet P2WPKH addresses harvested from settled
blocks, and the whole batch is shuffled. The follow-up calls (`/utxo`,
`/txs`) are padded the same way, because following up on only the used
addresses would hand back exactly the set the shuffle just hid.

The decoys are real and mostly have history on purpose. A haystack of
never-used addresses would leave the wallet's used ones standing alone.

**What it buys:** somebody reading the request log sees a set of addresses
and cannot tell which of them are one wallet. That is the realistic threat
for a site like this, and this defeats it.

**What it does not buy:** anything against an adversary willing to do chain
analysis. Your wallet's addresses are linked to each other *on the chain*, by
change outputs and common inputs; the decoys are not linked to anything of
yours. Someone with a full node and patience can cluster the queried set and
pull your wallet back out. Padding raises the cost; it does not close the
door.

**What it costs:** two to three times the requests. Public explorers
rate-limit, and mempool.space starts answering 429 well before a padded scan
of a busy wallet finishes. The wallet fails over to the other explorer and
says so, but expect it to be slower and occasionally to need a retry.

### 2. Your own Esplora (Explorer -> An Esplora server of your own)

Point the wallet at an Esplora instance you run. The questions still leave
your tab, but they go to you.

```sh
# Roughly: a full node with a transaction index, plus Blockstream's esplora
bitcoind -txindex=1
git clone https://github.com/Blockstream/electrs && cd electrs
cargo run --release -- --http-addr 0.0.0.0:3002
# then put https://your.host:3002 in the "Your server" field
```

The field validates what you type through the same anti-SSRF gate as
everything else (`src/lib/btcproxy.ts`): https only, never a private or
loopback address, and the path has to look like an Esplora API.

**This is strictly better than padding** and it is one field away. If you are
holding an amount you would mind losing the privacy of, this is the answer.

### 3. Reach the site over its Tor mirror

See [`onion.md`](onion.md). Over the onion there is no exit node and no
Cloudflare in the path at all, so the middle party shrinks to the onion box,
which is yours. Combine it with your own Esplora and there is no third party
in the picture anywhere.

## Why not compact block filters

The genuinely correct fix for a light Bitcoin wallet is
[BIP157/158](https://github.com/bitcoin/bips/blob/master/bip-0158.mediawiki):
the server sends a compact filter per block, the client checks it locally
against its own addresses, and only asks for the blocks that match. The
server never learns which addresses you hold. It is what
[Neutrino](https://github.com/lightninglabs/neutrino) and
[Nakamoto](https://github.com/cloudhead/nakamoto) do.

It is not available here, and it is worth being specific about why rather
than filing it as "later":

- **Esplora does not serve filters.** Neither mempool.space nor
  blockstream.info exposes a BIP157 endpoint. The protocol is a peer-to-peer
  one (`getcfilters`), not an HTTP one, and a browser cannot speak it.
- **The bandwidth is the point of the design.** Filter headers for the whole
  chain are hundreds of megabytes, and the filters themselves more. That is
  fine for a desktop wallet that syncs once and keeps a database; it is not
  fine for a page that promises to hold nothing between reloads.
- **It would need a different backend entirely.** A `bitcoind` with
  `blockfilterindex=1` plus something to relay filters over HTTP to the
  browser. At which point you are running a server, and running your own
  Esplora (option 2) gets you a stronger privacy result for less work.

So: no BIP158 here, honestly, rather than a filter mode that quietly asks the
server the same question in a nicer wrapper.

## What is not a leak

- **Sending.** A signed transaction is broadcast to the explorer. It reveals
  the transaction, which is about to be public anyway, and nothing else.
- **Creating a wallet.** A brand new wallet is empty by construction, so the
  page shows it without making a single request. No explorer ever hears about
  a wallet that has not been used.
- **Fee estimates.** `/fee-estimates` is the same call for everybody.
- **The Monero tab.** Different protocol, different properties: the node
  hands over blocks and cannot tell which outputs are yours.

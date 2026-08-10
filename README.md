# Labyrinth Vault

**An airgapped signing device for Bitcoin and Monero, made out of the phone in
your drawer.**

The old phone you stopped using is a computer with a screen, a camera, a
secure enclave and a battery. Take the SIM out, turn the radios off, install
this, and it becomes a hardware wallet that cost you nothing and that no
courier ever handled.

It is not a wallet in the usual sense. It holds keys and it gives signatures.
It has no network code in it at all, so there is nothing to misconfigure and
nothing to leak: the only thing that ever leaves is a QR code you point a
camera at.

## How it works

Two halves that never touch:

**The vault** (this app, on the offline phone) makes the keys, keeps them, and
signs what you approve. It asks for no network permission, which means the
absence is something you can verify in Settings rather than something we
assert in a README.

**The companion** (your everyday phone, or a desktop wallet like Sparrow)
watches the chain with a watch-only key, builds unsigned transactions, and
broadcasts the signed ones. It cannot spend anything: it has never seen a
private key.

They talk in one direction at a time, by showing each other QR codes.

```
   vault (offline)                        companion (online)
   ───────────────                        ──────────────────
   make keys
   show watch-only key   ──── QR ───▶     watch the chain
                                          build a payment
   read unsigned tx      ◀─── QR ────     show unsigned tx
   SHOW IT TO A PERSON
   sign, if approved
   show signed tx        ──── QR ───▶     broadcast
```

## The part that is actually the security

The vault renders every transaction in full and makes you approve it: amounts,
destinations, change, fee. That screen is the security boundary.

It has to be, because the alternative does not work. The online half might be
compromised, and if it is, it can hand the vault a transaction where every
byte is valid and the money goes to someone else. No checksum catches that. No
encryption catches that. A person reading the destination catches that.

Any build of this app that hides those details behind a friendly "Sign" button
has thrown away the only defence it had. The checksum on the wire is there to
catch a misread camera frame, and that is all it claims.

See [docs/airgap-protocol.md](docs/airgap-protocol.md) for the wire format, the
fail-closed rules, and what the threat model does and does not cover.

## Where it is

Early. What exists and is tested:

- **The airgap wire** (`src/airgap/envelope.ts`) — chunking a payload across
  many QR frames, reading them back out of order and repeated, and refusing to
  assemble anything that does not match its own digest. 18 tests, most of them
  about the refusing.

Next, in order:

1. Port the Bitcoin and Monero key handling from the sibling project, which is
   already DOM-free TypeScript with test coverage.
2. BC-UR (`ur:crypto-psbt`), so the vault talks to Sparrow and Electrum rather
   than only to its own companion.
3. The iOS shell, and the confirmation screen, which is the part to get right.

## Running the tests

```sh
npm install
npm test
npm run typecheck
```

## Design rules

- **No network code.** Not "no network calls we know about": no networking
  layer in the vault target at all, so there is nothing to review.
- **Nothing at rest that is not encrypted.** Keys live behind the device's own
  secure hardware and a passphrase, and the app has no cloud, no account and
  no backup service to lose.
- **Fail closed.** Every ambiguity on the wire ends in "scan it again" rather
  than in a signature.
- **Show the person what they are signing.** Always, in full, before anything
  is signed.

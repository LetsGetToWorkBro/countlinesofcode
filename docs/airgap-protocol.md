# The airgap protocol

The only wire between the two halves of Labyrinth Vault is a camera pointed at
a screen. This document is what crosses it, and, more importantly, what that
does and does not protect you from.

## The two halves

**The vault** is a phone with no network. Ideally an old one in a drawer with
its SIM out and its radios off; the app never asks for a network permission,
so on iOS the absence is checkable in Settings rather than promised in
marketing. It holds the keys, and it is the only thing that ever sees them.

**The companion** is online: your everyday phone or a desktop wallet. It
watches the chain, builds unsigned transactions, and broadcasts finished ones.
It never holds a key and cannot spend anything on its own.

Neither half is much use alone, which is the point. Stealing the online device
gets an attacker a view of your balance. Stealing the vault gets them a brick
without your passphrase. Both, plus the passphrase, is the threat model any
hardware wallet has.

## What crosses

Five payload kinds, named on the wire so a device can refuse what it does not
understand rather than guess:

| Kind | Direction | What it is |
|---|---|---|
| `ACCOUNT` | vault to companion | Watch-only export: an xpub/zpub, or a Monero view key and primary address |
| `PSBT` | companion to vault | An unsigned Bitcoin transaction |
| `TXSIGNED` | vault to companion | A finished, broadcastable transaction |
| `XMRUNSIGNED` | companion to vault | An unsigned Monero transaction set |
| `XMRSIGNED` | vault to companion | A signed Monero transaction set |

## The frame

One QR code carries one frame, and a frame is plain text:

```
LV1:PSBT:3:12:9f2a1c04:MFRGGZDFMZTWQ2LK...
│   │    │ │  │        └ this frame's slice of the payload, base32
│   │    │ │  └ digest of the WHOLE payload, CRC-32, hex
│   │    │ └ how many frames in total
│   │    └ this frame's number, from 1
│   └ payload kind
└ format, refused if it is not the version this build speaks
```

**Why base32 rather than base64 or raw bytes.** QR has an alphanumeric mode
covering upper-case letters and digits, and it spends about 1.55 bits per
character there against 8 bits per byte in binary mode. Base32 costs 8
characters per 5 bytes but each character is cheap, so the code comes out
sparser: bigger modules, read from further away, by the mediocre camera on a
seven-year-old phone. That is the premise of the product, so the wire is
optimised for it.

**Why 400 bytes a frame.** A version-20 QR at error correction M holds roughly
850 alphanumeric characters. 400 payload bytes is 640 characters of base32
plus a short header, which leaves room and keeps the modules large. A 40 KB
Monero transaction set becomes about a hundred frames: fifteen seconds of
animation, not a nice number, but an honest one.

## What the digest is for, and what it is not for

Every frame carries a CRC-32 of the entire payload. After the last frame
arrives, the receiver reassembles and recomputes it. If it does not match,
**everything is discarded** and the scan starts again. There is no "probably
fine" path, however long the person has been waving a phone at a screen.

This catches the accidents, which are the likely failures:

- a frame misread by one character,
- a screen caught mid-refresh,
- a scan of two different transactions merged because they had the same number
  of parts.

It does **not** catch an attacker, and cannot. CRC-32 is not a hash, and even
a real hash would not help: on a one-way optical wire, whoever controls the
online device can simply display a *valid* transaction that pays themselves.
Every byte would check out perfectly.

**So the confirmation screen is the security boundary, not the checksum.** The
vault renders what it is about to sign, in full, and a person approves it:
amounts, destinations, change, fee. The digest protects against noise. The
person protects against malice. Neither substitutes for the other, and any
version of this app that hides the details behind a "Sign" button has thrown
away the only defence that matters.

## Fail-closed, enumerated

The collector is written so each of these ends in nothing rather than in the
wrong bytes, and each has a test:

- a frame from a different payload, mid-scan, restarts rather than merges;
- a frame claiming a different total length is rejected, keeping what is good;
- frame number 0, or 4-of-3, is not a frame;
- an unknown payload kind is not a frame;
- a future format version is refused rather than read with today's rules;
- a body that is not base32 is a misread, not bytes;
- an assembled payload whose digest disagrees is thrown away entirely.

## Interoperating with other wallets

Bitcoin has a standard for exactly this, **BC-UR** (`ur:crypto-psbt`), spoken
by Sparrow, Electrum, Keystone and the rest. An airgapped signer that only
talks to its own companion is worth much less than one a person can point at
the desktop wallet they already use, so BC-UR is a target rather than an
afterthought.

It is an *encoder over this same core*, not a different design: the chunking,
the ordering tolerance and the verify-before-handing-over all stay. What
changes is the frame's clothes. The order of work is: this format first,
because it is complete and testable and unblocks the app; BC-UR next, because
interop is what makes it useful; and both readable at once, since a scanner
can tell them apart from the first character.

Monero has no equivalent standard. Cake and Monerujo each animate their own
multi-part format, so talking to them means implementing theirs specifically,
and that is a separate piece of work with its own document.

## What this protocol does not do

- **No back channel.** The vault cannot ask for a frame to be repeated,
  because it has no way to speak except by drawing its own code, and the
  companion is not necessarily still looking. Everything is designed around
  scanning until it works.
- **No encryption.** The payloads are public data: an unsigned transaction and
  a signed one are both things you are about to broadcast to the world.
  Encrypting the wire would protect nothing and would add a key-exchange
  problem to a channel whose entire virtue is that it has no state.
- **No authentication of the companion.** See above: the vault assumes the
  transaction in front of it may be hostile, and shows it to you instead.

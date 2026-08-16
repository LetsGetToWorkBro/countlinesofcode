# The vault frames, and how to make them again

`src/client/vaultwire.ts` is a **second implementation** of a wire format that
already has a first one. The first lives in the Labyrinth Vault, at
`src/airgap/envelope.ts`, and it is the implementation that decides what a
frame means, because it is the one doing the reading.

Two implementations of a wire format is the classic way to ship something that
works on every file anybody tried and fails on a file nobody did. The failure
is not an exception either: a vault handed frames with a bad base32 tail or a
checksum over the wrong slice says *the codes did not add up*, and the person
holding the phone blames their camera, their screen brightness, or the app.

So the port is not trusted to agree by inspection. It is compared, byte for
byte, against frames the vault's own encoder produced.

## The fixture

`test/fixtures/vault-frames.json` holds:

- `cases` — payloads and the frames the vault produced for each. The sizes are
  0 through 7, then 399, 400 and 401, then 800 and 801, then a real
  `unsigned_monero_tx`. That is not a spread for its own sake: base32 packs
  five bytes into eight characters, so lengths 1 to 4 past a multiple of five
  exercise the tail a careless port drops, and 399/400/401 sit either side of a
  frame boundary, where an off-by-one gives every frame the wrong `total`.
- `kinds` — one small payload encoded under each of the wire's eight payload
  kinds. A port that hardcoded `XMRFILE` into the header would pass every case
  above and still be wrong about a format it claims to implement.
- `source` — the vault repository and the exact commit the frames came from.

`test/vaultwire.test.ts` reads all of it.

## Regenerating

You need a checkout of the vault repository. From its root:

```js
// scripts/tmp-genframes.mjs
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const compiled = await build({
  entryPoints: ['src/airgap/envelope.ts'],
  bundle: true, format: 'esm', write: false, platform: 'neutral',
});
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fixture = JSON.parse(readFileSync('test/fixtures/monero-unsigned-tx-set.json', 'utf8'));
const real = new Uint8Array(fixture.file.match(/../g).map((p) => parseInt(p, 16)));

const sizes = [0, 1, 2, 3, 4, 5, 6, 7, 399, 400, 401, 800, 801];
const cases = sizes.map((size) => {
  const payload = new Uint8Array(size).map((_, i) => (i * 37 + 11) & 0xff);
  return { name: `${size} bytes`, payload: hex(payload), frames: mod.encodeParts('XMRFILE', payload, 400) };
});
cases.push({ name: 'a real unsigned_monero_tx', payload: fixture.file, frames: mod.encodeParts('XMRFILE', real, 400) });

const oneFrame = new Uint8Array(11).map((_, i) => i * 9);
const kinds = ['ACCOUNT', 'PSBT', 'XMRUNSIGNED', 'XMRSIGNED', 'XMROUTPUTS', 'XMRKEYIMAGES', 'XMRFILE', 'TXSIGNED']
  .map((kind) => ({ kind, frames: mod.encodeParts(kind, oneFrame, 400) }));

writeFileSync('/tmp/vault-frames.json', JSON.stringify({
  note: '…', regenerate: 'See docs/vault-frames.md.',
  source: {
    repo: 'https://github.com/LetsGetToWorkBro/labyrinth-vault',
    commit: execSync('git rev-parse HEAD').toString().trim(),
    encoder: 'src/airgap/envelope.ts',
    partBytes: 400,
  },
  cases, kinds,
}, null, 1) + '\n');
```

Run it with `node scripts/tmp-genframes.mjs`, copy `/tmp/vault-frames.json`
over `test/fixtures/vault-frames.json` here, keep the `note` prose, and run the
suite. It has to live in the vault repo because that is where the encoder and
the `unsigned_monero_tx` fixture are, and the script is deliberately temporary
there: this repository owns the fixture, not the generator.

The `unsigned_monero_tx` in it is itself second-hand from Monero: the vault's
`oracle/` harness links `wallet/wallet2.h` and serializes a real
`unsigned_tx_set` with Monero's own `binary_archive`, so no struct layout is
transcribed by anybody.

## When the two disagree

The port is wrong. Fix `src/client/vaultwire.ts`.

The only case where that is not the answer is a deliberate change to the format
itself, and a format change is a change to `WIRE_VERSION` — at which point old
vaults refuse the new frames by design, and the fixture should be regenerated
from the commit that made the change.

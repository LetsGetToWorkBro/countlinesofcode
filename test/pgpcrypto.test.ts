/**
 * What the profiles actually produce.
 *
 * pgpkit.ts describes two OpenPGP profiles to the visitor in specific terms:
 * which algorithm signs, which protects the private key at rest, whether a
 * message is authenticated. Those sentences are the whole value of the page —
 * someone choosing "modern" because it says Argon2 is entitled to get Argon2.
 *
 * Nothing in the other test file can check that. It asserts the shape of an
 * options object, and an options object is only a claim about what a library
 * will do with it. So this file hands those exact options to the vendored
 * OpenPGP.js, generates real keys, and reads the algorithms back out of the
 * packets. If a future version of the library reinterprets one of them, or a
 * value gets "tidied" into something that quietly falls back to the default,
 * the sentence on the page becomes false and this fails.
 *
 * It is slow by the standards of the rest of the suite, because generating a
 * key pair is meant to be. RSA is left out on purpose: it takes seconds, and it
 * is the one choice here with no encoding subtlety to get wrong.
 */

import { describe, expect, it } from 'vitest';
import { PROFILES, emailProblem, keyOptions, messageFormatFor } from '../src/client/pgpkit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const openpgp: any = await import('../public/vendor/openpgp/openpgp.min.mjs' as string);

const PASSPHRASE = 'a-passphrase-worth-having';

/**
 * The version of the sealed-data packet in a message: 1 is CFB with a
 * modification-detection code, 2 is AEAD. Found by packet tag rather than by
 * "the first packet that has a version", which picks up the session-key packet
 * in front of it.
 */
const SEIPD = 18;

async function sealedVersion(recipient: unknown, config: Record<string, unknown>): Promise<number | undefined> {
  const armored: string = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: 'hello' }),
    encryptionKeys: recipient,
    config,
  });
  const parsed = await openpgp.readMessage({ armoredMessage: armored });
  const sealed = parsed.packets.find(
    (p: { constructor: { tag?: number } }) => p.constructor.tag === SEIPD,
  ) as { version?: number } | undefined;
  return sealed?.version;
}

async function makeKey(profile: (typeof PROFILES)[keyof typeof PROFILES], passphrase = PASSPHRASE) {
  const options = keyOptions(profile, { name: 'Ada', email: 'ada@example.com', kind: 'curve25519', passphrase });
  const generated = await openpgp.generateKey(options);
  return {
    ...generated,
    priv: await openpgp.readPrivateKey({ armoredKey: generated.privateKey }),
    pub: await openpgp.readKey({ armoredKey: generated.publicKey }),
  };
}

describe('the compatible profile', () => {
  it('makes the key every deployed implementation understands', async () => {
    const { priv } = await makeKey(PROFILES.compatible);
    // v4 packets, EdDSA-legacy signing, ECDH encryption. This is the shape
    // GnuPG has read for years, and the reason this profile exists.
    expect(priv.keyPacket.version).toBe(4);
    expect(priv.keyPacket.algorithm).toBe(openpgp.enums.publicKey.eddsaLegacy);
    expect(priv.subkeys[0].keyPacket.algorithm).toBe(openpgp.enums.publicKey.ecdh);
  }, 30_000);

  it('protects the private key with iterated SHA-256, as the page says', async () => {
    const { priv } = await makeKey(PROFILES.compatible);
    expect(priv.isDecrypted()).toBe(false);
    expect(priv.keyPacket.s2k.type).toBe('iterated');
    // The page prints 16,777,216 rounds. That number is this byte, expanded.
    expect(priv.keyPacket.s2k.getCount()).toBe(65_011_712);
    expect(priv.keyPacket.symmetric).toBe(openpgp.enums.symmetric.aes256);
  }, 30_000);

  it('writes a message with a modification-detection code, not AEAD', async () => {
    // The claim on lock.html used to be "an authenticated mode", which this
    // is not. Tampering is still caught; it is caught a different way, and the
    // page now says which.
    const { pub } = await makeKey(PROFILES.compatible);
    expect(await sealedVersion(pub, PROFILES.compatible.config)).toBe(1);
  }, 30_000);

  it('still catches tampering, which is the part that matters to a reader', async () => {
    const { pub, priv } = await makeKey(PROFILES.compatible);
    const unlocked = await openpgp.decryptKey({ privateKey: priv, passphrase: PASSPHRASE });
    const armored: string = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'hello' }),
      encryptionKeys: pub,
    });
    const parsed = await openpgp.readMessage({ armoredMessage: armored });
    await expect(openpgp.decrypt({ message: parsed, decryptionKeys: unlocked })).resolves.toMatchObject({ data: 'hello' });

    // Flip a bit in the ciphertext body and it must refuse rather than hand
    // back something subtly wrong.
    const lines = armored.split('\n');
    const body = lines.findIndex((l) => l.length > 40);
    lines[body] = lines[body]!.slice(0, 10) + (lines[body]![10] === 'A' ? 'B' : 'A') + lines[body]!.slice(11);
    await expect(
      openpgp
        .readMessage({ armoredMessage: lines.join('\n') })
        .then((m: unknown) => openpgp.decrypt({ message: m, decryptionKeys: unlocked })),
    ).rejects.toThrow();
  }, 30_000);
});

describe('the modern profile', () => {
  it('makes an RFC 9580 key: v6 packets, native Ed25519 and X25519', async () => {
    const { priv } = await makeKey(PROFILES.modern);
    expect(priv.keyPacket.version).toBe(6);
    expect(priv.keyPacket.algorithm).toBe(openpgp.enums.publicKey.ed25519);
    expect(priv.subkeys[0].keyPacket.algorithm).toBe(openpgp.enums.publicKey.x25519);
  }, 30_000);

  it('really does use Argon2 on the private key, which is the reason to pick it', async () => {
    // The single claim most worth pinning. Argon2 is memory-hard; the
    // compatible profile's iterated SHA-256 is not. If this silently fell back,
    // the page would be promising resistance it does not have.
    const { priv } = await makeKey(PROFILES.modern);
    expect(priv.isDecrypted()).toBe(false);
    expect(priv.keyPacket.s2k.type).toBe('argon2');
  }, 30_000);

  it('writes an authenticated message', async () => {
    const { pub } = await makeKey(PROFILES.modern);
    expect(await sealedVersion(pub, PROFILES.modern.config)).toBe(2);
  }, 30_000);
});

describe('the two profiles interoperate with each other', () => {
  it('reads a compatible message while set to modern, and the other way round', async () => {
    // The config decides what is *written*. Someone who switches the toggle
    // must not lose the ability to open what they already have.
    const compatible = await makeKey(PROFILES.compatible);
    const modern = await makeKey(PROFILES.modern);

    for (const [writer, reader] of [[compatible, modern], [modern, compatible]] as const) {
      const armored: string = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: 'across' }),
        encryptionKeys: writer.pub,
        config: PROFILES.modern.config,
      });
      const unlocked = await openpgp.decryptKey({ privateKey: writer.priv, passphrase: PASSPHRASE });
      const back = await openpgp.decrypt({
        message: await openpgp.readMessage({ armoredMessage: armored }),
        decryptionKeys: unlocked,
        config: reader === compatible ? PROFILES.compatible.config : PROFILES.modern.config,
      });
      expect(back.data).toBe('across');
    }
  }, 60_000);

  it('signs and verifies across a full round trip', async () => {
    const { pub, priv } = await makeKey(PROFILES.modern);
    const unlocked = await openpgp.decryptKey({ privateKey: priv, passphrase: PASSPHRASE });
    const armored: string = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: 'signed and sealed' }),
      encryptionKeys: pub,
      signingKeys: unlocked,
      config: PROFILES.modern.config,
    });
    const back = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: armored }),
      decryptionKeys: unlocked,
      verificationKeys: pub,
    });
    expect(back.data).toBe('signed and sealed');
    await expect(back.signatures[0].verified).resolves.toBe(true);
  }, 30_000);
});

describe('a key with no passphrase', () => {
  it('comes out unprotected, which is exactly why it is never stored', async () => {
    // mayStorePrivate() refuses to keep this in local storage. This is the
    // reason: there is nothing between the armor and the secret.
    const { priv } = await makeKey(PROFILES.compatible, '');
    expect(priv.isDecrypted()).toBe(true);
    expect(priv.keyPacket.s2k).toBeFalsy();
  }, 30_000);
});

describe('expiry', () => {
  it('sets one when asked, and leaves the key immortal when not', async () => {
    const withExpiry = await openpgp.generateKey(
      keyOptions(PROFILES.compatible, { name: 'Ada', kind: 'curve25519', passphrase: PASSPHRASE, expiryYears: 2 }),
    );
    const key = await openpgp.readKey({ armoredKey: withExpiry.publicKey });
    const expires = await key.getExpirationTime();
    expect(expires).not.toBe(Infinity);
    const years = (Number(expires) - Date.now()) / (365.25 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThan(1.9);
    expect(years).toBeLessThan(2.1);

    const forever = await makeKey(PROFILES.compatible);
    await expect(forever.pub.getExpirationTime()).resolves.toBe(Infinity);
  }, 60_000);
});

describe('which format a message actually gets', () => {
  it('follows the recipient, not the setting, and messageFormatFor says so', async () => {
    // Found while writing these tests, and worth a test of its own: turning
    // the toggle to modern does NOT make a message to an older key AEAD.
    // OpenPGP.js is right to refuse — the recipient could not open it — but a
    // page that advertised AEAD here would be lying.
    const compatible = await makeKey(PROFILES.compatible);
    const modern = await makeKey(PROFILES.modern);

    expect(await sealedVersion(compatible.pub, PROFILES.modern.config)).toBe(1);
    expect(await sealedVersion(modern.pub, PROFILES.compatible.config)).toBe(2);

    expect(messageFormatFor(compatible.pub.keyPacket.version).aead).toBe(false);
    expect(messageFormatFor(modern.pub.keyPacket.version).aead).toBe(true);
  }, 60_000);

  it('explains the older case rather than just reporting false', () => {
    expect(messageFormatFor(4).note).toMatch(/could not open/i);
    expect(messageFormatFor(6).note).toMatch(/authenticated/i);
  });
});

/**
 * The one thing the other file cannot check.
 *
 * pgpkit's emailProblem() states OpenPGP.js's rule for an address in its own
 * words, ahead of it, so that a full stop on the end comes back as a sentence
 * about the full stop rather than "Invalid user ID format". A restatement of
 * somebody else's rule is only useful while it agrees with the rule, so here
 * both sides are asked about the same addresses and compared.
 */
describe('what an address may be', () => {
  const ACCEPTED = ['ada@example.com', 'ada+pgp@example.com', 'ada.lovelace@example.co.uk', 'ada@localhost', 'ada@ex'];
  const REFUSED = ['ada', 'ada@', 'a@b', '@example.com', 'ada@example.com.', 'ada lovelace@example.com'];

  /** Straight to the library, bypassing our own check, to see what it does. */
  async function libraryAccepts(email: string): Promise<boolean> {
    try {
      await openpgp.generateKey({
        userIDs: [{ email }], type: 'ecc', curve: 'curve25519', format: 'armored',
      });
      return true;
    } catch {
      return false;
    }
  }

  it('agrees with OpenPGP.js about every address, in both directions', async () => {
    for (const email of ACCEPTED) {
      expect(emailProblem(email), `we refuse ${email}`).toBeNull();
      expect(await libraryAccepts(email), `the library refuses ${email}`).toBe(true);
    }
    for (const email of REFUSED) {
      expect(emailProblem(email), `we accept ${email}`).not.toBeNull();
      expect(await libraryAccepts(email), `the library accepts ${email}`).toBe(false);
    }
  }, 60_000);

  it('never lets "Invalid user ID format" reach anybody through keyOptions', async () => {
    // The bug as it was reported. Whatever goes in, what comes out is either a
    // key or a sentence written here.
    for (const email of REFUSED) {
      let message = '';
      try {
        await openpgp.generateKey(keyOptions(PROFILES.compatible, { name: 'Ada', email }));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, email).not.toBe('');
      expect(message, email).not.toMatch(/invalid user id format/i);
    }
  }, 60_000);
});

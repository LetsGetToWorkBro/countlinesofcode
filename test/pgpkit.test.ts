/**
 * The encryption tools' engine.
 *
 * No cryptography is tested here because none is written here — OpenPGP.js does
 * that, and it is vendored precisely so it is not our implementation to get
 * wrong. What is tested is everything a person interacts with: whether the
 * strength meter tells the truth, whether the passphrase generator's stated
 * entropy is the entropy it actually has, and whether a file's name survives a
 * round trip through locking and unlocking.
 *
 * The strength meter gets the most attention. A meter that congratulates
 * `Passw0rd!` is worse than no meter, because it tells someone they are safe
 * when the exact string is in every cracking dictionary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROFILES,
  WORDS,
  armorKind,
  backupName,
  expirySeconds,
  forgetAllKeys,
  forgetKey,
  formatFingerprint,
  keyOptions,
  keyPairArmor,
  lockedName,
  looksEncrypted,
  makePassphrase,
  mayStorePrivate,
  passphraseBits,
  phraseBits,
  profileFor,
  rememberKey,
  savedKeys,
  shortId,
  splitArmored,
  strength,
  unlockedName,
  type StoredKey,
} from '../src/client/pgpkit';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('armorKind', () => {
  it('recognises each kind of block', () => {
    expect(armorKind('-----BEGIN PGP PUBLIC KEY BLOCK-----\nx')).toBe('public-key');
    expect(armorKind('-----BEGIN PGP PRIVATE KEY BLOCK-----\nx')).toBe('private-key');
    expect(armorKind('-----BEGIN PGP MESSAGE-----\nx')).toBe('message');
    expect(armorKind('-----BEGIN PGP SIGNATURE-----\nx')).toBe('signature');
  });

  it('calls a clearsigned note a signed message, not a signature', () => {
    // A clearsigned message contains a signature block inside it, so the outer
    // header has to win or every signed note is misread.
    const clearsigned = [
      '-----BEGIN PGP SIGNED MESSAGE-----',
      'Hash: SHA256',
      '',
      'I agree to the terms.',
      '-----BEGIN PGP SIGNATURE-----',
      'abc',
      '-----END PGP SIGNATURE-----',
    ].join('\n');
    expect(armorKind(clearsigned)).toBe('signed-message');
  });

  it('is nothing for ordinary text', () => {
    expect(armorKind('hello, this is just a note')).toBeNull();
    expect(armorKind('')).toBeNull();
  });
});

describe('looksEncrypted', () => {
  it('recognises armored output', () => {
    expect(looksEncrypted(bytes('-----BEGIN PGP MESSAGE-----\nabc'))).toBe(true);
  });

  it('recognises the binary form by its first packet', () => {
    expect(looksEncrypted(new Uint8Array([0xc3, 0x1e, 0x04]))).toBe(true);
  });

  it('trusts the extension too', () => {
    expect(looksEncrypted(bytes('anything'), 'report.pdf.gpg')).toBe(true);
    expect(looksEncrypted(bytes('anything'), 'note.asc')).toBe(true);
  });

  it('is false for an ordinary file', () => {
    expect(looksEncrypted(bytes('%PDF-1.7'), 'report.pdf')).toBe(false);
  });
});

describe('lockedName and unlockedName', () => {
  it('keeps the whole original name, extension and all', () => {
    // report.pdf.gpg unlocks back to report.pdf. Stripping the .pdf first
    // would give back a file nothing knows how to open.
    expect(lockedName('report.pdf')).toBe('report.pdf.gpg');
    expect(unlockedName('report.pdf.gpg')).toBe('report.pdf');
  });

  it('uses .asc for the armored form', () => {
    expect(lockedName('note.txt', true)).toBe('note.txt.asc');
  });

  it('round-trips', () => {
    for (const name of ['a.pdf', 'holiday photo.jpg', 'archive.tar.gz', 'LICENSE']) {
      expect(unlockedName(lockedName(name))).toBe(name);
    }
  });

  it('prefers the name recorded inside the file', () => {
    // OpenPGP stores the original filename; whoever renamed the .gpg on the way
    // through should not win over it.
    expect(unlockedName('renamed.gpg', 'original.docx')).toBe('original.docx');
  });

  it('ignores a useless embedded name', () => {
    expect(unlockedName('report.pdf.gpg', 'file')).toBe('report.pdf');
    expect(unlockedName('report.pdf.gpg', '')).toBe('report.pdf');
  });

  it('never returns nothing', () => {
    expect(lockedName('')).toBe('file.gpg');
    expect(unlockedName('.gpg')).toBe('decrypted');
  });
});

describe('strength', () => {
  it('refuses to praise the passwords crackers try first', () => {
    for (const bad of ['password', 'PASSWORD', '123456', 'qwerty', 'letmein', 'hunter2']) {
      expect(strength(bad).verdict, bad).toBe('terrible');
    }
  });

  it('is not fooled by a capital and a digit bolted on', () => {
    // Password1 is in every dictionary too, and a meter that scores it well
    // because it has three character classes is actively harmful.
    expect(strength('Password1').verdict).toBe('terrible');
    expect(strength('Monkey99').verdict).toBe('terrible');
  });

  it('says something rather than nothing for an empty box', () => {
    expect(strength('').verdict).toBe('empty');
    expect(strength('').bits).toBe(0);
  });

  it('rates a short random string badly however mixed it is', () => {
    expect(strength('aB3!').verdict).toBe('terrible');
  });

  it('penalises a keyboard walk', () => {
    // asdfghjkl is long and all lower case; length alone would call it fair.
    expect(strength('asdfghjkl').bits).toBeLessThan(strength('xtqbnwmpz').bits);
  });

  it('penalises repetition', () => {
    expect(strength('aaaaaaaaaaaa').bits).toBeLessThan(strength('kdmqxvhzpwrt').bits);
  });

  it('rewards real length', () => {
    expect(strength('correcthorsebatterystaple').verdict).toMatch(/strong|excellent/);
  });

  it('rises monotonically as a random password grows', () => {
    let previous = -1;
    for (const length of [8, 12, 16, 24, 32]) {
      const bits = strength('Xq7$'.repeat(length / 4).slice(0, length)).bits;
      expect(bits).toBeGreaterThan(previous);
      previous = bits;
    }
  });

  it('scores a passphrase as words, not as a long random string', () => {
    // The bug this fixes: a seven-word phrase from the published list was
    // reported as 224 bits when its real strength is 56. An attacker gets to
    // choose the cheaper attack, so the weaker reading has to win.
    const phrase = makePassphrase(7);
    expect(strength(phrase).bits).toBe(passphraseBits(7));
  });

  it('gives an unfamiliar phrase more credit than one from our own list', () => {
    // Our list is published, so words from it are worth exactly their eight
    // bits; words an attacker has to guess from a whole language are worth more.
    const ours = strength('edge-habit-cycle-dune-hinge').bits;
    const theirs = strength('rutabaga-clavicle-tympanum-basalt-nocturne').bits;
    expect(theirs).toBeGreaterThan(ours);
  });

  it('does not let the word reading inflate a weak phrase', () => {
    // min() of the two, never max(): "aaa bbb ccc" must not score as 3 words.
    expect(strength('aaa bbb ccc').bits).toBeLessThan(40);
  });

  it('explains what the verdict means rather than just naming a colour', () => {
    expect(strength('abc').note.length).toBeGreaterThan(20);
    expect(strength('a very long and quite unusual passphrase here').note.length).toBeGreaterThan(20);
  });
});

describe('the word list', () => {
  it('is exactly 256 words, which is what makes the arithmetic honest', () => {
    // Each word is precisely eight bits only if the list is a power of two.
    // The first draft had 260 and the stated entropy would have been wrong.
    expect(WORDS).toHaveLength(256);
  });

  it('has no duplicates, which would skew the odds', () => {
    expect(new Set(WORDS).size).toBe(WORDS.length);
  });

  it('holds only short lower-case words, so a phrase can be typed and said', () => {
    for (const word of WORDS) {
      expect(word, word).toMatch(/^[a-z]{3,6}$/);
    }
  });
});

describe('makePassphrase', () => {
  it('produces the number of words asked for', () => {
    expect(makePassphrase(7).split('-')).toHaveLength(7);
    expect(makePassphrase(12).split('-')).toHaveLength(12);
  });

  it('uses only words from the list', () => {
    const list = new Set(WORDS);
    for (const word of makePassphrase(20).split('-')) expect(list.has(word), word).toBe(true);
  });

  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 20 }, () => makePassphrase(7)));
    expect(seen.size).toBe(20);
  });

  it('refuses a length that would be pointless, either way', () => {
    expect(makePassphrase(1).split('-').length).toBeGreaterThanOrEqual(3);
    expect(makePassphrase(500).split('-').length).toBeLessThanOrEqual(20);
  });

  it('uses the browser’s random source, not Math.random', () => {
    // Math.random is not seeded for this and using it here would be a real bug.
    const source = (globalThis as unknown as { crypto: Crypto }).crypto;
    const spy = vi.spyOn(source, 'getRandomValues');
    makePassphrase(7);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('draws each word roughly evenly', () => {
    // Modulo over a byte would make the first words of the list likelier; with
    // 256 words it divides evenly, and this notices if the list ever changes.
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      for (const word of makePassphrase(20).split('-')) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const values = [...counts.values()];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    // 8000 draws over 256 words is about 31 each; a modulo bias would show as
    // one half of the list running consistently high.
    expect(Math.max(...values)).toBeLessThan(mean * 3);
  });

  it('takes a separator', () => {
    expect(makePassphrase(4, ' ').split(' ')).toHaveLength(4);
  });
});

describe('phraseBits', () => {
  it('is nothing for something that is not a phrase', () => {
    expect(phraseBits('hunter2')).toBeNull();
    expect(phraseBits('two words')).toBeNull();
    expect(phraseBits('abc-123-xyz')).toBeNull();
  });

  it('counts words from our list at exactly eight bits each', () => {
    expect(phraseBits(WORDS.slice(0, 5).join('-'))).toBe(40);
  });

  it('reads the separators people actually use', () => {
    for (const separator of ['-', ' ', '.', '_']) {
      expect(phraseBits(WORDS.slice(0, 4).join(separator)), separator).toBe(32);
    }
  });
});

describe('passphraseBits', () => {
  it('states exactly eight bits a word', () => {
    expect(passphraseBits(7)).toBe(56);
    expect(passphraseBits(10)).toBe(80);
  });

  it('is nothing for nothing', () => {
    expect(passphraseBits(0)).toBe(0);
    expect(passphraseBits(-3)).toBe(0);
  });

  it('agrees with what the generator actually produces', () => {
    expect(passphraseBits(7)).toBe(Math.round(7 * Math.log2(WORDS.length)));
  });
});

describe('fingerprints', () => {
  it('spaces a fingerprint the way every other tool prints it', () => {
    expect(formatFingerprint('abcd1234ef567890')).toBe('ABCD 1234 EF56 7890');
  });

  it('tolerates one that already has spaces', () => {
    expect(formatFingerprint('ABCD 1234')).toBe('ABCD 1234');
  });

  it('takes the last sixteen digits as the short id', () => {
    expect(shortId('0123456789abcdef0123456789abcdef01234567')).toBe('89ABCDEF01234567');
  });

  it('says so rather than returning nothing', () => {
    expect(shortId('')).toBe('unknown');
  });
});

describe('remembering keys', () => {
  /* Tests run under Node, which has no localStorage. The store is a
     convenience the engine is written to survive losing, so the stub is the
     smallest thing that exercises the real path. */
  beforeEach(() => {
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  const key = (over: Partial<StoredKey> = {}): StoredKey => ({
    armored: '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    kind: 'public',
    name: 'Ada <ada@example.com>',
    fingerprint: 'AAAA1111',
    added: 1,
    ...over,
  });

  it('keeps a key and gives it back', () => {
    forgetAllKeys();
    rememberKey(key());
    expect(savedKeys()).toHaveLength(1);
    expect(savedKeys()[0]!.name).toContain('Ada');
  });

  it('replaces rather than duplicating when the same key is imported twice', () => {
    forgetAllKeys();
    rememberKey(key());
    rememberKey(key({ name: 'Ada Lovelace <ada@example.com>' }));
    expect(savedKeys()).toHaveLength(1);
    expect(savedKeys()[0]!.name).toBe('Ada Lovelace <ada@example.com>');
  });

  it('keeps the public and private halves as separate entries', () => {
    // Importing the private key must not hide the public one, and vice versa.
    forgetAllKeys();
    rememberKey(key({ kind: 'public' }));
    rememberKey(key({ kind: 'private' }));
    expect(savedKeys()).toHaveLength(2);
  });

  it('forgets one without forgetting the rest', () => {
    forgetAllKeys();
    rememberKey(key({ fingerprint: 'AAAA' }));
    rememberKey(key({ fingerprint: 'BBBB' }));
    forgetKey('AAAA', 'public');
    expect(savedKeys().map((k) => k.fingerprint)).toEqual(['BBBB']);
  });

  it('survives storage being unavailable rather than throwing', () => {
    // Private browsing throws on setItem; losing the list must never stop an
    // encryption from working.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => { throw new Error('denied'); },
        setItem: () => { throw new Error('denied'); },
      },
    });
    expect(() => rememberKey(key())).not.toThrow();
    expect(savedKeys()).toEqual([]);
  });

  it('ignores a store that has been filled with something that is not keys', () => {
    (globalThis as unknown as { localStorage: Storage }).localStorage.setItem('loc1999:pgp-keys', '{"not":"an array"}');
    expect(savedKeys()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The two OpenPGP profiles
// ---------------------------------------------------------------------------

describe('profiles', () => {
  it('falls back to the compatible one rather than breaking on a stale value', () => {
    // The choice is remembered in the page; a value from an older build must
    // not leave someone unable to make a key.
    expect(profileFor('nonsense').id).toBe('compatible');
    expect(profileFor('').id).toBe('compatible');
    expect(profileFor('modern').id).toBe('modern');
  });

  it('leaves the compatible profile on the library defaults', () => {
    // Pinning today's defaults into a config object would freeze them, so this
    // profile deliberately says nothing.
    expect(PROFILES.compatible.config).toEqual({});
  });

  it('asks for Argon2, AEAD and v6 in the modern one', () => {
    expect(PROFILES.modern.config).toEqual({ aeadProtect: true, s2kType: 4, v6Keys: true });
  });

  it('names the two Curve25519 encodings apart, because they are not the same packets', () => {
    const compatible = keyOptions(PROFILES.compatible, { name: 'A', kind: 'curve25519' });
    const modern = keyOptions(PROFILES.modern, { name: 'A', kind: 'curve25519' });
    expect(compatible).toMatchObject({ type: 'ecc', curve: 'curve25519' });
    expect(modern).toMatchObject({ type: 'curve25519' });
    expect(modern.curve).toBeUndefined();
  });

  it('asks for RSA the same way in both, because RSA has only one encoding', () => {
    for (const profile of [PROFILES.compatible, PROFILES.modern]) {
      expect(keyOptions(profile, { name: 'A', kind: 'rsa4096' })).toMatchObject({ type: 'rsa', rsaBits: 4096 });
    }
  });

  it('leaves the passphrase out entirely when there is not one', () => {
    // An empty string here would be a passphrase of no characters rather than
    // no passphrase, and OpenPGP.js treats those differently.
    expect('passphrase' in keyOptions(PROFILES.compatible, { name: 'A' })).toBe(false);
    expect(keyOptions(PROFILES.compatible, { name: 'A', passphrase: 'x' }).passphrase).toBe('x');
  });

  it('copies the config rather than handing out the shared one', () => {
    const options = keyOptions(PROFILES.modern, { name: 'A' });
    (options.config as Record<string, unknown>).aeadProtect = false;
    expect(PROFILES.modern.config.aeadProtect).toBe(true);
  });
});

describe('expirySeconds', () => {
  it('is zero for never, which is the absence of the option', () => {
    expect(expirySeconds(0)).toBe(0);
    expect(expirySeconds(undefined)).toBe(0);
    expect(expirySeconds(-1)).toBe(0);
    expect(expirySeconds(Number.NaN)).toBe(0);
  });

  it('counts leap years, so a two-year key does not expire two days early', () => {
    expect(expirySeconds(2)).toBe(Math.round(2 * 365.25 * 86400));
    expect(expirySeconds(1)).toBeGreaterThan(365 * 86400);
  });
});

describe('mayStorePrivate', () => {
  it('refuses to keep an unprotected private key', () => {
    // The whole rule: without a passphrase, what would sit in local storage is
    // the key itself.
    expect(mayStorePrivate('')).toBe(false);
    expect(mayStorePrivate(undefined as unknown as string)).toBe(false);
    expect(mayStorePrivate('x')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reading a key file
// ---------------------------------------------------------------------------

const block = (label: string, body = 'AAAA') =>
  `-----BEGIN PGP ${label}-----\n\n${body}\n-----END PGP ${label}-----`;

describe('splitArmored', () => {
  it('finds both halves of an exported key pair', () => {
    const file = `${block('PUBLIC KEY BLOCK')}\n\n${block('PRIVATE KEY BLOCK')}\n`;
    const blocks = splitArmored(file);
    expect(blocks).toHaveLength(2);
    expect(armorKind(blocks[0]!)).toBe('public-key');
    expect(armorKind(blocks[1]!)).toBe('private-key');
  });

  it('finds every key in a whole exported keyring', () => {
    expect(splitArmored([block('PUBLIC KEY BLOCK'), block('PUBLIC KEY BLOCK'), block('PUBLIC KEY BLOCK')].join('\n'))).toHaveLength(3);
  });

  it('ignores the notes people leave around a pasted key', () => {
    const file = `Here is my key, thanks!\n\n${block('PUBLIC KEY BLOCK')}\n\nlet me know if it works`;
    expect(splitArmored(file)).toHaveLength(1);
  });

  it('keeps a clearsigned message whole instead of tearing out its signature', () => {
    // A signed message nests a SIGNATURE block inside itself. Matching END
    // against the opening label is what stops that becoming two fragments.
    const signed = '-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nhello\n' +
      '-----BEGIN PGP SIGNATURE-----\n\nAAAA\n-----END PGP SIGNATURE-----';
    const blocks = splitArmored(signed);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('hello');
    expect(blocks[0]).toContain('END PGP SIGNATURE');
  });

  it('drops a block whose end never came rather than returning half a key', () => {
    expect(splitArmored('-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nAAAA\n')).toEqual([]);
  });

  it('has nothing to say about text with no keys in it', () => {
    expect(splitArmored('just a note')).toEqual([]);
    expect(splitArmored('')).toEqual([]);
  });
});

describe('keyPairArmor', () => {
  it('puts the public half first, so the file says what it is before it says the secret', () => {
    const pair = keyPairArmor(block('PUBLIC KEY BLOCK'), block('PRIVATE KEY BLOCK'));
    expect(pair.indexOf('PUBLIC')).toBeLessThan(pair.indexOf('PRIVATE'));
    expect(splitArmored(pair)).toHaveLength(2);
  });

  it('round-trips through the reader', () => {
    const pair = keyPairArmor(block('PUBLIC KEY BLOCK', 'pub'), block('PRIVATE KEY BLOCK', 'priv'));
    expect(splitArmored(pair).map(armorKind)).toEqual(['public-key', 'private-key']);
  });
});

describe('backupName', () => {
  it('makes a filename out of a name with anything in it', () => {
    expect(backupName('Ada Lovelace <ada@example.com>', 'pair')).toBe('Ada_Lovelace_ada_example.com-pair.asc');
    expect(backupName('../../etc/passwd', 'private')).toBe('.._.._etc_passwd-private.asc');
  });

  it('still produces a filename when the name is unusable', () => {
    expect(backupName('', 'public')).toBe('key-public.asc');
    expect(backupName('   ', 'keyring')).toBe('key-keyring.asc');
  });
});

describe('strength does not overstate a padded passphrase', () => {
  it('scores a word phrase with a trailing year as a phrase, not raw characters', () => {
    // The finding: adding "2024" made strength() skip the phrase clamp and
    // report ~159 bits / "excellent" for four dictionary words.
    const padded = strength('edge habit cycle dune 2024');
    expect(padded.bits).toBeLessThan(55);
    expect(['terrible', 'weak', 'fair']).toContain(padded.verdict);
  });

  it('is not fooled by digits stuck onto each word', () => {
    const stuck = strength('edge1-habit2-cycle3-dune4');
    expect(stuck.bits).toBeLessThan(55);
  });

  it('still scores a plain word phrase exactly as before', () => {
    expect(phraseBits('edge-habit-cycle-dune')).toBe(32);
    expect(phraseBits(makePassphrase(7))).toBe(passphraseBits(7));
  });

  it('still gives unfamiliar words more credit than list words', () => {
    expect(strength('rutabaga-clavicle-tympanum-basalt-nocturne').bits)
      .toBeGreaterThan(strength('edge-habit-cycle-dune-hinge').bits);
  });
});

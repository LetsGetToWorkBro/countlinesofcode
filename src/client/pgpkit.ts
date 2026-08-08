/**
 * The encryption tools' engine, bundled to public/pgpkit.js.
 *
 * The cryptography itself is not here and will not be. OpenPGP.js is vendored
 * into /vendor and loaded by the pages: it is the one library on this site that
 * exists because writing it out would be irresponsible rather than admirable. A
 * GIF encoder that is subtly wrong produces a visibly broken picture; a cipher
 * that is subtly wrong produces something that looks encrypted and is not, and
 * the person holding it has no way to tell.
 *
 * What is here is everything around it — and one decision worth defending.
 *
 * **Password-locking a file writes OpenPGP, not a format of our own.** The
 * obvious build is WebCrypto: PBKDF2 to stretch the password, AES-GCM to
 * encrypt, a small header of our own design. It is a hundred lines and it
 * works. It is also a trap: the person you send the file to can only open it by
 * coming back to this page, and if this page is gone in five years so is their
 * file. Writing the standard means `gpg -d`, Kleopatra, GPG Suite and every
 * other implementation can open it, on any operating system, indefinitely. That
 * is worth 390 KB.
 */

// ---------------------------------------------------------------------------
// Which OpenPGP to write
// ---------------------------------------------------------------------------

/**
 * There are two OpenPGPs now, and pretending otherwise would be the same kind
 * of dishonesty as claiming a file is never uploaded while uploading it.
 *
 * RFC 9580 (2024) brought AEAD encryption, native Ed25519/X25519 keys, v6 key
 * packets and Argon2 for protecting a private key with a passphrase. All four
 * are better than what came before. Argon2 is the one that matters most here:
 * it is memory-hard, so a graphics card cannot grind through passphrases the
 * way it can against the older iterated-SHA-256 stretching, and the private key
 * this page keeps in your browser is exactly the thing an attacker would grind
 * against.
 *
 * The catch is that a great deal of deployed software cannot read any of it.
 * Writing only the new format would mean handing someone a file their `gpg`
 * refuses, which is the failure this whole tool exists to avoid.
 *
 * So: both, chosen explicitly, with the cost of each stated on the page. The
 * numbers below are not aspirations — `test/pgpkit.test.ts` generates real keys
 * with these options and asserts the algorithms that come out.
 */
export type ProfileId = 'compatible' | 'modern';

export interface Profile {
  id: ProfileId;
  label: string;
  /** The signing and encryption algorithms the key itself uses. */
  algorithms: string;
  /** What the private key is protected with at rest. */
  protection: string;
  /** What a message encrypted *to this key* is protected with. */
  message: string;
  /** Who can open what this writes. */
  opens: string;
  /** Handed straight to OpenPGP.js as `config`. */
  config: Record<string, unknown>;
}

/**
 * Argon2 is s2k type 4. Named rather than inlined because a bare `4` in a
 * config object is the sort of thing that gets "tidied" into the wrong value.
 */
const S2K_ARGON2 = 4;

export const PROFILES: Record<ProfileId, Profile> = {
  compatible: {
    id: 'compatible',
    label: 'Compatible',
    algorithms: 'Ed25519 to sign, X25519 to encrypt, in the packet encoding that predates RFC 9580',
    protection: 'AES-256, unlocked by putting your passphrase through 16,777,216 rounds of SHA-256',
    message: 'AES-256 with a modification-detection code, so a tampered message fails to open',
    opens: 'Anything that speaks OpenPGP: GnuPG, Thunderbird, Kleopatra, GPG Suite, and this page.',
    // Deliberately empty. The defaults are the long-established format, and
    // pinning today's values here would freeze them into the file.
    config: {},
  },
  modern: {
    id: 'modern',
    label: 'Modern',
    algorithms: 'The same Ed25519 and X25519, in the native RFC 9580 encoding, on a version 6 key',
    protection: 'AES-256, unlocked by Argon2, which is memory-hard and so far harder to attack with a graphics card',
    message: 'AES-256 in an authenticated mode (AEAD), which detects tampering as part of decrypting rather than after it',
    opens: 'Implementations updated for RFC 9580. Older GnuPG will refuse it.',
    config: { aeadProtect: true, s2kType: S2K_ARGON2, v6Keys: true },
  },
};

/**
 * Which format a message to this recipient will actually get.
 *
 * Worth stating plainly on the page, because it is not the setting you chose:
 * it follows the *recipient's* key. Encrypt to a version 6 key and the message
 * is AEAD whatever the toggle says; encrypt to an older key and it is the older
 * format, again whatever the toggle says. OpenPGP.js is right to do this — a
 * message their software cannot open is not a stronger message — but a page
 * that advertised AEAD and then quietly wrote a modification-detection code
 * would be making exactly the sort of promise this site exists not to make.
 */
export function messageFormatFor(recipientKeyVersion: number): { aead: boolean; note: string } {
  const aead = recipientKeyVersion >= 6;
  return {
    aead,
    note: aead
      ? 'Their key is a version 6 key, so this is written with authenticated encryption.'
      : 'Their key predates RFC 9580, so this is written in the older format with a modification-detection code. Sending anything else would produce a file they could not open.',
  };
}

export function profileFor(id: string): Profile {
  return PROFILES[id as ProfileId] ?? PROFILES.compatible;
}

export type KeyKind = 'curve25519' | 'rsa4096';

/**
 * Whether an address can go on a key, and if not, why not in words.
 *
 * OpenPGP.js will not build a user ID out of an address it does not like, and
 * what it throws when that happens is "Invalid user ID format" — an accurate
 * sentence about its own internals and a useless one to the person who left a
 * full stop on the end of their email. So the same rule is stated here, ahead
 * of it, and each way of failing it gets told apart.
 *
 * The shape is the library's own: something, an @, a domain of at least two
 * characters, and a last character that is not punctuation. No spaces, no
 * angle brackets, no second @. It is deliberately not an attempt to decide
 * whether an address is deliverable — nothing here can know that, and a key
 * with a wrong address on it is still a working key. It only refuses what
 * cannot be written into a key at all.
 *
 * An empty box is not a problem: a key can be named instead of addressed.
 */
const EMAIL_SHAPE = /^[^\p{C}\p{Z}@<>\\]+@[^\p{C}\p{Z}@<>\\]+[^\p{C}\p{Z}\p{P}]$/u;

export function emailProblem(email: string): string | null {
  const value = String(email ?? '').trim();
  if (!value) return null;
  if (EMAIL_SHAPE.test(value)) return null;

  if (/\p{C}/u.test(value)) {
    return 'That address has an invisible control character in it, which cannot go on a key. Type it out rather than pasting it.';
  }
  if (/[\p{Z}\s]/u.test(value)) {
    return 'An email address on a key cannot have spaces in it. Put the address alone here, like ada@example.com, and the name in the box above.';
  }
  if (/[<>\\]/.test(value)) {
    return 'Put the address by itself, like ada@example.com. The angle brackets are added for you, and the name goes in the box above.';
  }

  const parts = value.split('@');
  if (parts.length === 1) return 'That is not an email address: there is no @ in it. Write the whole address, like ada@example.com, or leave the box empty and name the key above.';
  if (parts.length > 2) return 'That has more than one @ in it. A key takes one address, like ada@example.com.';
  if (!parts[0]) return 'There is nothing in front of the @. An email address needs a name on the left of it, like ada@example.com.';
  if (parts[1]!.length < 2) return 'There is no domain after the @. An email address needs one, like ada@example.com.';
  return 'An email address cannot end in punctuation. Take the "' + value.slice(-1) + '" off the end of it.';
}

/**
 * The two profiles want *different* Curve25519.
 *
 * `{ type: 'ecc', curve: 'curve25519' }` is the older encoding: EdDSA-legacy
 * signing with an ECDH subkey, which is what every deployed implementation
 * understands. `{ type: 'curve25519' }` is the RFC 9580 native form, Ed25519
 * and X25519 proper. Same curve, same mathematics, different packets, and only
 * one of them opens in software from before 2024.
 */
export function keyOptions(
  profile: Profile,
  fields: { name?: string; email?: string; kind?: KeyKind; passphrase?: string; expiryYears?: number },
): Record<string, unknown> {
  const name = (fields.name ?? '').trim();
  const email = (fields.email ?? '').trim();

  // The backstop. The page checks this before it gets here so the answer is
  // quick, but nothing should be able to hand OpenPGP.js an address it will
  // refuse — the only thing it says about one is "Invalid user ID format".
  const trouble = emailProblem(email);
  if (trouble) throw new Error(trouble);
  if (!name && !email) throw new Error('A key needs a name or an email on it, so it can be told apart from every other key.');

  const options: Record<string, unknown> = {
    userIDs: [{ name: name || undefined, email: email || undefined }],
    format: 'armored',
  };

  if (fields.kind === 'rsa4096') {
    options.type = 'rsa';
    options.rsaBits = 4096;
  } else if (profile.id === 'modern') {
    options.type = 'curve25519';
  } else {
    options.type = 'ecc';
    options.curve = 'curve25519';
  }

  if (fields.passphrase) options.passphrase = fields.passphrase;

  const seconds = expirySeconds(fields.expiryYears);
  if (seconds) options.keyExpirationTime = seconds;

  if (Object.keys(profile.config).length) options.config = { ...profile.config };
  return options;
}

/** Years to seconds, with 0 and nonsense meaning "no expiry". */
export function expirySeconds(years?: number): number {
  const n = Number(years);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 365.25 * 24 * 60 * 60);
}

// ---------------------------------------------------------------------------
// What may be kept in this browser
// ---------------------------------------------------------------------------

/**
 * A private key is never stored here without a passphrase.
 *
 * With one, what sits in local storage is a block that costs an attacker a real
 * search to open. Without one it is the key itself, in the clear, readable by
 * anything that can run a line of script on this origin or by anyone who picks
 * up the unlocked laptop. The convenience of skipping it is not worth what it
 * costs, and a tool that offers the unsafe option with a warning beside it is
 * really just offering the unsafe option.
 *
 * A key made without a passphrase is still made, and still downloaded. It is
 * only not *remembered*.
 */
export function mayStorePrivate(passphrase: string): boolean {
  return String(passphrase ?? '').length > 0;
}

// ---------------------------------------------------------------------------
// What a block of text is
// ---------------------------------------------------------------------------

export type ArmorKind = 'public-key' | 'private-key' | 'message' | 'signature' | 'signed-message' | null;

const ARMOR_HEADERS: [RegExp, ArmorKind][] = [
  [/-----BEGIN PGP PUBLIC KEY BLOCK-----/, 'public-key'],
  [/-----BEGIN PGP PRIVATE KEY BLOCK-----/, 'private-key'],
  [/-----BEGIN PGP SIGNED MESSAGE-----/, 'signed-message'],
  [/-----BEGIN PGP SIGNATURE-----/, 'signature'],
  [/-----BEGIN PGP MESSAGE-----/, 'message'],
];

/**
 * What kind of PGP block this text holds.
 *
 * Checked in a deliberate order: a clearsigned message contains a signature
 * block inside it, so the outer header has to win or every signed note would be
 * mistaken for a bare signature.
 */
export function armorKind(text: string): ArmorKind {
  const value = String(text ?? '');
  for (const [pattern, kind] of ARMOR_HEADERS) {
    if (pattern.test(value)) return kind;
  }
  return null;
}

/** Whether a file's bytes look like something PGP wrote. */
export function looksEncrypted(bytes: Uint8Array, name = ''): boolean {
  if (/\.(gpg|pgp|asc)$/i.test(name)) return true;
  // Armored output is text and starts with the header.
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 64));
  if (head.includes('-----BEGIN PGP')) return true;
  // Binary OpenPGP: the first byte has the high bit set and marks a packet.
  // 0xc1/0xc3 are the symmetric-key and encrypted-data packets a locked file
  // starts with; 0x85/0x84 are their old-format equivalents.
  const first = bytes[0] ?? 0;
  return [0xc1, 0xc3, 0xc2, 0x84, 0x85, 0x8c, 0xa3].includes(first);
}

/**
 * Every armored block in a piece of text, in the order they appear.
 *
 * A file someone exports from GnuPG routinely holds several: the public key and
 * the private key together, or a whole keyring. Reading only the first would
 * silently drop the rest, and dropping the *private* half of a backup while
 * reporting success is the worst version of that.
 *
 * The END line is matched against the BEGIN line's own label, with one genuine
 * exception: a clearsigned message opens `BEGIN PGP SIGNED MESSAGE` and never
 * closes it — the block ends with the END of the signature nested inside it.
 * Matching labels naively there returns the inner signature and silently drops
 * the text it was vouching for, which is worse than returning nothing.
 */
export function splitArmored(text: string): string[] {
  const source = String(text ?? '');
  const blocks: string[] = [];
  const begin = /-----BEGIN PGP ([A-Z0-9 ,]+)-----/g;
  let match: RegExpExecArray | null;

  while ((match = begin.exec(source))) {
    const label = match[1]!;
    const closing = label === 'SIGNED MESSAGE' ? '-----END PGP SIGNATURE-----' : `-----END PGP ${label}-----`;
    const end = source.indexOf(closing, match.index);
    if (end === -1) continue;
    blocks.push(source.slice(match.index, end + closing.length));
    begin.lastIndex = end + closing.length;
  }
  return blocks;
}

/**
 * A key pair as one file: public half first, then private.
 *
 * That order is on purpose. Anyone opening the file in a text editor sees the
 * public block at the top and knows what they are looking at before they have
 * scrolled into the half that must not be shared.
 */
export function keyPairArmor(publicKey: string, privateKey: string): string {
  return [publicKey.trim(), privateKey.trim()].filter(Boolean).join('\n\n') + '\n';
}

/** A filename for a saved key, safe on every filesystem. */
export function backupName(name: string, kind: 'public' | 'private' | 'pair' | 'keyring'): string {
  const stem = String(name ?? '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'key';
  return `${stem}-${kind}.asc`;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * The name for a locked file.
 *
 * `.gpg` rather than `.pgp` or `.asc`, because it is the extension every
 * desktop tool associates with an encrypted file, and the extension is kept in
 * full — `report.pdf` becomes `report.pdf.gpg`, so unlocking gives the PDF back
 * with its own name rather than a file nothing knows how to open.
 */
export function lockedName(name: string, armored = false): string {
  const clean = String(name ?? '').trim() || 'file';
  return `${clean}${armored ? '.asc' : '.gpg'}`;
}

/** The name to give a file that has just been unlocked. */
export function unlockedName(name: string, embedded?: string | null): string {
  // The archive itself records the original name; prefer it when it is there.
  if (embedded && embedded.trim() && embedded !== 'file') return embedded.trim();
  const stripped = String(name ?? '').replace(/\.(gpg|pgp|asc)$/i, '').trim();
  return stripped || 'decrypted';
}

// ---------------------------------------------------------------------------
// Password strength
// ---------------------------------------------------------------------------

/**
 * Passwords that are guessed first, so a strength meter that ignores them is
 * lying. Not a complete list — no list is — but it covers what people actually
 * type when asked to invent something on the spot.
 */
const COMMON = new Set([
  'password', 'passw0rd', '123456', '12345678', '123456789', '1234567890', 'qwerty', 'qwertyuiop',
  'abc123', 'letmein', 'monkey', 'dragon', 'football', 'baseball', 'iloveyou', 'admin', 'welcome',
  'login', 'master', 'sunshine', 'princess', 'trustno1', 'starwars', 'whatever', 'superman',
  'batman', 'hunter2', 'secret', 'changeme', 'test', 'guest', 'root', 'toor', 'pass', 'hello',
  'freedom', 'shadow', 'ashley', 'michael', 'jennifer', 'jordan', 'harley', 'ranger', 'buster',
  'soccer', 'hockey', 'killer', 'george', 'charlie', 'andrew', 'thomas', 'robert', 'daniel',
  'summer', 'winter', 'spring', 'autumn', 'january', 'liverpool', 'arsenal', 'chelsea',
]);

export interface Strength {
  /** Rough bits of entropy against someone who knows how it was made. */
  bits: number;
  verdict: 'empty' | 'terrible' | 'weak' | 'fair' | 'strong' | 'excellent';
  /** What that means, in terms of what it resists. */
  note: string;
}

/** The size of the alphabet a password appears to be drawn from. */
function alphabet(password: string): number {
  let size = 0;
  if (/[a-z]/.test(password)) size += 26;
  if (/[A-Z]/.test(password)) size += 26;
  if (/[0-9]/.test(password)) size += 10;
  if (/[^a-zA-Z0-9]/.test(password)) size += 33;
  return size || 1;
}

/** How much of the password is just repetition or a run. */
function patternPenalty(password: string): number {
  const lower = password.toLowerCase();
  let penalty = 0;

  // aaaa, 1111 — every repeat after the first adds almost nothing.
  const repeats = lower.match(/(.)\1{2,}/g) ?? [];
  for (const run of repeats) penalty += (run.length - 1) * 2;

  // abcd, 4321, and the keyboard rows people walk along.
  const runs = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  for (let i = 0; i + 3 <= lower.length; i++) {
    const slice = lower.slice(i, i + 4);
    const back = slice.split('').reverse().join('');
    if (runs.some((row) => row.includes(slice) || row.includes(back))) penalty += 4;
  }
  return penalty;
}

/**
 * A rough strength, in bits, and what it actually resists.
 *
 * Deliberately pessimistic. A meter that congratulates `Passw0rd!` because it
 * has four character classes is worse than no meter at all — it tells people
 * they are safe when the exact string is in every cracking dictionary. So the
 * common list is checked first, patterns are subtracted, and the verdicts are
 * phrased in terms of what the password stands up to rather than as a colour.
 */
export function strength(password: string): Strength {
  const value = String(password ?? '');
  if (!value) return { bits: 0, verdict: 'empty', note: 'Type something.' };

  // Strip a trailing digit or two and a leading capital before checking the
  // list: Password1 is not meaningfully better than password.
  const core = value.toLowerCase().replace(/[^a-z]+$/g, '').replace(/^[^a-z]+/g, '');
  if (COMMON.has(value.toLowerCase()) || (core.length >= 4 && COMMON.has(core))) {
    return {
      bits: 8,
      verdict: 'terrible',
      note: 'That is on every list a cracker tries first. Adding a number to the end does not help.',
    };
  }

  const raw = value.length * Math.log2(alphabet(value));
  const asCharacters = Math.max(0, Math.round(raw - patternPenalty(value)));
  // A phrase is worth whichever reading is *weaker*, because an attacker gets
  // to choose which one to guess against.
  const asPhrase = phraseBits(value);
  const bits = asPhrase === null ? asCharacters : Math.min(asCharacters, asPhrase);

  if (bits < 28) {
    return { bits, verdict: 'terrible', note: 'Guessable in seconds by anything automated.' };
  }
  if (bits < 45) {
    return { bits, verdict: 'weak', note: 'Fine against someone typing guesses. Not against a machine.' };
  }
  if (bits < 60) {
    return { bits, verdict: 'fair', note: 'Would take a determined attacker with good hardware a while.' };
  }
  if (bits < 80) {
    return { bits, verdict: 'strong', note: 'Beyond casual cracking. Good enough for anything you would email.' };
  }
  return { bits, verdict: 'excellent', note: 'Not going to be guessed. Make sure you can remember it.' };
}

// ---------------------------------------------------------------------------
// Passphrases
// ---------------------------------------------------------------------------

/**
 * A word list, for generating passphrases.
 *
 * Short, common, unambiguous words — nothing that sounds like another word when
 * read aloud, nothing longer than six letters, no plurals of words already
 * present. Exactly 256 of them, which makes the arithmetic honest: each word is
 * precisely eight bits, so a seven-word phrase is 56 bits and a ten-word one is
 * 80, and the page can say so without hand-waving. A test holds the count,
 * because the first draft had 260 and the claim would have been wrong.
 */
export const WORDS: string[] = [
  'able', 'acid', 'acorn', 'actor', 'agent', 'alarm', 'album', 'alien', 'alley', 'amber',
  'anchor', 'angle', 'ankle', 'apple', 'april', 'apron', 'arena', 'armor', 'arrow', 'atlas',
  'attic', 'autumn', 'awake', 'axis', 'bacon', 'badge', 'bagel', 'baker', 'balm', 'banjo',
  'barge', 'basil', 'basin', 'batch', 'beach', 'beacon', 'beam', 'bean', 'bear', 'beast',
  'bench', 'berry', 'bison', 'blade', 'blank', 'blaze', 'blend', 'blimp', 'block', 'bloom',
  'blues', 'blunt', 'board', 'bolt', 'bonus', 'boots', 'brain', 'brake', 'brass', 'brave',
  'bread', 'brick', 'bride', 'brief', 'brisk', 'broom', 'brush', 'bugle', 'bunch', 'bunk',
  'cabin', 'cable', 'cacao', 'cadet', 'camel', 'canal', 'candy', 'canoe', 'canvas', 'cargo',
  'carol', 'carve', 'cedar', 'chalk', 'charm', 'chase', 'cheek', 'chess', 'chief', 'chill',
  'chime', 'chip', 'chord', 'cider', 'cinema', 'civic', 'clamp', 'clash', 'clay', 'clerk',
  'cliff', 'climb', 'cloak', 'clock', 'cloud', 'clove', 'clown', 'coach', 'coast', 'cobra',
  'cocoa', 'comet', 'comic', 'coral', 'couch', 'cough', 'court', 'cover', 'crane', 'crate',
  'crawl', 'cream', 'creek', 'crest', 'crisp', 'crow', 'crown', 'crumb', 'crust', 'cube',
  'curve', 'cycle', 'daisy', 'dance', 'dawn', 'delta', 'demon', 'depot', 'diary', 'diner',
  'ditch', 'diver', 'dodge', 'donut', 'draft', 'drama', 'dream', 'dress', 'drift', 'drill',
  'drum', 'dryer', 'dune', 'dusk', 'eagle', 'earth', 'easel', 'east', 'echo', 'edge',
  'eight', 'elbow', 'elder', 'elm', 'ember', 'empty', 'ended', 'entry', 'equal', 'error',
  'essay', 'ether', 'exact', 'exit', 'fable', 'fancy', 'fang', 'feast', 'fence', 'ferry',
  'fever', 'fiber', 'field', 'fifth', 'fig', 'final', 'finch', 'flame', 'flash', 'fleet',
  'flint', 'float', 'flock', 'flour', 'fluid', 'flute', 'foam', 'focus', 'forge', 'forum',
  'fossil', 'frame', 'fresh', 'frost', 'fruit', 'fudge', 'gauge', 'ghost', 'giant', 'ginger',
  'glass', 'gleam', 'globe', 'gloss', 'glove', 'goat', 'grape', 'grass', 'grave', 'green',
  'grid', 'grill', 'grove', 'guest', 'guide', 'guitar', 'gulf', 'habit', 'hall', 'hammer',
  'happy', 'harbor', 'hatch', 'haven', 'hawk', 'hazel', 'heart', 'hedge', 'helm', 'herb',
  'hinge', 'hobby', 'honey', 'horn', 'horse', 'hotel', 'house', 'human', 'humid', 'hymn',
  'ideal', 'igloo', 'image', 'index', 'inlet', 'ivory', ];

/**
 * What a phrase of words is worth, as opposed to a string of characters.
 *
 * Counting `edge-habit-cycle-dune-hinge-blues-bean` as 43 random characters
 * gives 224 bits. Its real strength is 56: an attacker who knows it is seven
 * words from a 256-word list needs 2^56 guesses, and pretending otherwise is
 * exactly the overstatement a strength meter must not make. Worse, this page
 * publishes the list, so that attacker certainly exists.
 *
 * So: anything that reads as three or more words is also scored as words, and
 * the lower of the two estimates wins. Words drawn from our own list are worth
 * their exact eight bits; other words get thirteen, which is roughly a person's
 * working vocabulary and is generous.
 *
 * Returns null when the text is not a phrase.
 */
export function phraseBits(password: string): number | null {
  const lower = String(password ?? '').toLowerCase();

  // A real passphrase uses ONE separator between its words, consistently. A
  // random password merely sprinkled with symbols uses several: `k9:Rwm/ptaQ,vXbz`
  // mixes `:` `/` `,`. Splitting that into "words" and scoring each cluster as a
  // dictionary word rated a ~90-bit random secret 'weak', which is a false claim.
  // So the phrase reading only applies when every gap is the same separator;
  // otherwise this is not a phrase and character entropy stands. `edge,habit,
  // cycle,dune,2024` (all commas) still reads as a phrase, which is the case the
  // separator set was widened for in the first place.
  const gaps = lower.match(/[\s._\-,;:/|]+/g) ?? [];
  if (gaps.length > 0 && !gaps.every((g) => g === gaps[0])) return null;

  const parts = lower.split(/[\s._\-,;:/|]+/).filter(Boolean);
  if (parts.length < 3) return null;

  // Each token's alpha core is what decides if it is a word. Requiring the whole
  // token to be pure-alpha used to return null the moment any token had a digit
  // stuck to it (`dune4`, `2024`), so strength() skipped the min() clamp and
  // reported raw character entropy — rating a padded four-word phrase
  // 'excellent'. A phrase with a year on the end is still a phrase.
  const list = new Set(WORDS);
  let bits = 0;
  let extraChars = 0;
  let wordCount = 0;
  for (const part of parts) {
    const core = part.replace(/[^a-z]/g, '');
    if (core.length < 2) {
      // A token that is essentially not a word (all digits/symbols).
      extraChars += part.length;
      continue;
    }
    wordCount++;
    bits += list.has(core) ? Math.log2(WORDS.length) : 13;
    extraChars += part.length - core.length;
  }
  // Three actual words are what make it a phrase, not three tokens: `abc-123-xyz`
  // is two words and a number, and reads better as characters.
  if (wordCount < 3) return null;

  // The digits and symbols add a little, but a bounded amount: appending a year
  // to four words does not make them strong.
  bits += Math.min(extraChars * 2, 16);
  return Math.round(bits);
}

/**
 * A passphrase, from the browser's own random source.
 *
 * `getRandomValues` with rejection sampling rather than modulo: 256 divides
 * evenly into a byte, so no rejection is needed here, but the loop is written
 * to be correct if the list ever changes length. Math.random() is nowhere near
 * this, and using it for a passphrase would be a real bug.
 */
export function makePassphrase(words = 7, separator = '-'): string {
  const count = Math.max(3, Math.min(20, Math.floor(words)));
  const out: string[] = [];
  const buffer = new Uint8Array(count * 2);
  crypto.getRandomValues(buffer);

  let at = 0;
  while (out.length < count) {
    if (at >= buffer.length) {
      crypto.getRandomValues(buffer);
      at = 0;
    }
    const byte = buffer[at++]!;
    // The largest multiple of the list length that fits in a byte; anything
    // above it would make the low words very slightly likelier.
    const limit = Math.floor(256 / WORDS.length) * WORDS.length;
    if (byte >= limit) continue;
    out.push(WORDS[byte % WORDS.length]!);
  }
  return out.join(separator);
}

/** Exactly how much randomness a phrase of this many words carries. */
export function passphraseBits(words: number): number {
  return Math.round(Math.max(0, words) * Math.log2(WORDS.length));
}

// ---------------------------------------------------------------------------
// Remembering keys
// ---------------------------------------------------------------------------

export interface StoredKey {
  /** The armored key text. */
  armored: string;
  /** Public or private. */
  kind: 'public' | 'private';
  /** Who it belongs to, as the key says. */
  name: string;
  /** The fingerprint, for telling two keys with the same name apart. */
  fingerprint: string;
  added: number;
}

const KEY_STORE = 'loc1999:pgp-keys';

function readStore(): StoredKey[] {
  try {
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(KEY_STORE);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as StoredKey[]) : [];
  } catch {
    return [];
  }
}

function writeStore(keys: StoredKey[]): void {
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.setItem(KEY_STORE, JSON.stringify(keys));
  } catch {
    // Private browsing, or full. Remembering keys is a convenience; losing it
    // must never stop an encryption from working.
  }
}

export function savedKeys(): StoredKey[] {
  return readStore();
}

/**
 * Remember a key in this browser.
 *
 * Keyed on the fingerprint, so importing the same key twice updates it rather
 * than filling the list with duplicates — and so a public key later replaced by
 * the private half does not shadow it.
 */
export function rememberKey(key: StoredKey): StoredKey[] {
  const keys = readStore().filter((k) => !(k.fingerprint === key.fingerprint && k.kind === key.kind));
  keys.push(key);
  writeStore(keys);
  return keys;
}

export function forgetKey(fingerprint: string, kind: 'public' | 'private'): StoredKey[] {
  const keys = readStore().filter((k) => !(k.fingerprint === fingerprint && k.kind === kind));
  writeStore(keys);
  return keys;
}

export function forgetAllKeys(): void {
  writeStore([]);
}

/** A fingerprint in the spaced, upper-case form every other tool prints. */
export function formatFingerprint(fingerprint: string): string {
  const clean = String(fingerprint ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return (clean.match(/.{1,4}/g) ?? []).join(' ');
}

/** The last sixteen hex digits, which is how people refer to a key in passing. */
export function shortId(fingerprint: string): string {
  const clean = String(fingerprint ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return clean.slice(-16) || 'unknown';
}

const globalScope = globalThis as unknown as { LOC1999_PGP?: Record<string, unknown> };
globalScope.LOC1999_PGP = {
  PROFILES,
  profileFor,
  keyOptions,
  emailProblem,
  expirySeconds,
  mayStorePrivate,
  splitArmored,
  keyPairArmor,
  backupName,
  armorKind,
  looksEncrypted,
  lockedName,
  unlockedName,
  strength,
  phraseBits,
  makePassphrase,
  passphraseBits,
  WORDS,
  savedKeys,
  rememberKey,
  forgetKey,
  forgetAllKeys,
  formatFingerprint,
  shortId,
};

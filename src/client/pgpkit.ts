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
  const parts = String(password ?? '')
    .toLowerCase()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length < 3) return null;
  if (!parts.every((part) => /^[a-z]+$/.test(part))) return null;

  const list = new Set(WORDS);
  const bits = parts.reduce((total, part) => total + (list.has(part) ? Math.log2(WORDS.length) : 13), 0);
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

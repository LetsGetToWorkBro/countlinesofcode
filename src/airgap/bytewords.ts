/**
 * Bytewords: the alphabet BC-UR speaks in.
 *
 * Our own wire (envelope.ts) is base32 because it only ever has to talk to
 * itself. BC-UR is the format Sparrow, Electrum, Keystone, Passport and Cake
 * already animate at each other, and it encodes bytes as English words instead:
 * 256 of them, four letters each, chosen so that no two share both their first
 * and last letter. "Minimal" style keeps only those two letters, so a byte
 * costs two characters, and everything stays inside QR's alphanumeric mode.
 *
 * The table below is not a design decision we get to make. It is a fixed list
 * published with the standard, and a single wrong word means we hand a
 * different transaction to a different wallet and nobody finds out until the
 * money is gone. So it is transcribed verbatim from the reference
 * implementation rather than reconstructed, kept as one flat blob so a diff
 * shows a character change rather than a reflowed list, and checked against
 * published vectors in the tests.
 *
 * Every bytewords string carries a CRC-32 of its payload in the last four
 * bytes. Same caveat as everywhere else in this project: that catches a misread
 * camera frame, not an adversary. The confirmation screen is the security.
 */

import { crc32 } from './envelope';

/**
 * The 256 words, concatenated, four characters each. Index n is at n*4.
 *
 * Flat rather than an array literal on purpose: it is a constant of the
 * standard, not a list anybody should be editing, and in this shape a bad
 * edit shows up as one changed character in a diff instead of hiding in
 * reflowed formatting.
 */
const BLOB =
  'ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom';

/** How a bytewords string is written down. */
export type BytewordStyle =
  /** Whole words, separated by spaces. Readable, and four times the size. */
  | 'standard'
  /** First and last letter only, run together. This is what UR uses. */
  | 'minimal'
  /** Whole words, separated by hyphens, for putting in a URI. */
  | 'uri';

/** The full word for a byte, e.g. 0 is "able". */
export function wordFor(byte: number): string {
  return BLOB.slice(byte * 4, byte * 4 + 4);
}

/** The two-letter form for a byte, e.g. 0 is "ae". */
export function minimalFor(byte: number): string {
  return BLOB[byte * 4]! + BLOB[byte * 4 + 3]!;
}

/** Lazily built, because most callers only ever decode one style. */
let fullIndex: Map<string, number> | null = null;
let minimalIndex: Map<string, number> | null = null;

function indexes(): { full: Map<string, number>; minimal: Map<string, number> } {
  if (!fullIndex || !minimalIndex) {
    fullIndex = new Map();
    minimalIndex = new Map();
    for (let i = 0; i < 256; i++) {
      fullIndex.set(wordFor(i), i);
      minimalIndex.set(minimalFor(i), i);
    }
  }
  return { full: fullIndex, minimal: minimalIndex };
}

// ---------------------------------------------------------------------------
// Encoding

function withChecksum(payload: Uint8Array): Uint8Array {
  const crc = crc32(payload);
  const out = new Uint8Array(payload.length + 4);
  out.set(payload, 0);
  // Big-endian, which is what the reference implementation writes and
  // therefore what every wallet on the other side expects to read.
  out[payload.length] = (crc >>> 24) & 0xff;
  out[payload.length + 1] = (crc >>> 16) & 0xff;
  out[payload.length + 2] = (crc >>> 8) & 0xff;
  out[payload.length + 3] = crc & 0xff;
  return out;
}

/** Write bytes as bytewords, checksum included. */
export function bytewordsEncode(payload: Uint8Array, style: BytewordStyle = 'minimal'): string {
  const full = withChecksum(payload);
  if (style === 'minimal') {
    let out = '';
    for (const byte of full) out += minimalFor(byte);
    return out;
  }
  const words: string[] = [];
  for (const byte of full) words.push(wordFor(byte));
  return words.join(style === 'uri' ? '-' : ' ');
}

// ---------------------------------------------------------------------------
// Decoding

/**
 * Read bytewords back, or null.
 *
 * Null for every kind of wrong: an unknown word, a ragged length, a checksum
 * that disagrees. A caller cannot tell those apart and should not want to,
 * because the answer to all three is the same one: scan it again.
 */
export function bytewordsDecode(text: string, style: BytewordStyle = 'minimal'): Uint8Array | null {
  const clean = String(text ?? '').trim().toLowerCase();
  const { full, minimal } = indexes();
  const bytes: number[] = [];

  if (style === 'minimal') {
    if (!/^[a-z]*$/.test(clean) || clean.length % 2 !== 0) return null;
    for (let i = 0; i < clean.length; i += 2) {
      const value = minimal.get(clean.slice(i, i + 2));
      if (value === undefined) return null;
      bytes.push(value);
    }
  } else {
    const parts = clean.length ? clean.split(style === 'uri' ? '-' : /\s+/) : [];
    for (const part of parts) {
      const value = full.get(part);
      if (value === undefined) return null;
      bytes.push(value);
    }
  }

  // Four bytes of checksum and nothing to check them against is not a message.
  if (bytes.length < 4) return null;
  const payload = new Uint8Array(bytes.slice(0, bytes.length - 4));
  const claimed =
    ((bytes[bytes.length - 4]! << 24) |
      (bytes[bytes.length - 3]! << 16) |
      (bytes[bytes.length - 2]! << 8) |
      bytes[bytes.length - 1]!) >>>
    0;
  if (crc32(payload) !== claimed) return null;
  return payload;
}

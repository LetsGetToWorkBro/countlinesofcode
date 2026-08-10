/**
 * A QR code encoder, written here rather than pulled from a library.
 *
 * QR is a published standard (ISO/IEC 18004) and the whole of it is here: the
 * three data modes, Reed-Solomon error correction over GF(256), the version
 * and block tables, the finder/timing/alignment patterns, the eight data
 * masks scored by the standard's own penalty rules, and the BCH-protected
 * format and version information. The output is a square of booleans; the page
 * paints it. Nothing is fetched, and there is no service generating the image
 * somewhere and handing it back — which is the whole reason to have written
 * it, because a QR generator that phones home has seen every address and
 * secret anyone made a code of.
 */

// ---------------------------------------------------------------------------
// GF(256), the field Reed-Solomon works in (primitive polynomial 0x11d).
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** The generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** The `degree` Reed-Solomon check codewords for a block of data codewords. */
export function rsEncode(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree); // monic, length degree + 1
  // Polynomial division of data*x^degree by the generator; the remainder is
  // the error-correction codewords.
  const res = data.concat(new Array(degree).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = res[i]!;
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) res[i + j] = res[i + j]! ^ gfMul(gen[j]!, coef);
    }
  }
  return res.slice(data.length);
}

// ---------------------------------------------------------------------------
// Modes and capacity
// ---------------------------------------------------------------------------

export type ErrorLevel = 'L' | 'M' | 'Q' | 'H';
const EC_ORDER: ErrorLevel[] = ['L', 'M', 'Q', 'H'];

type Mode = 'numeric' | 'alphanumeric' | 'byte';
const MODE_BITS: Record<Mode, number> = { numeric: 0b0001, alphanumeric: 0b0010, byte: 0b0100 };
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export function detectMode(text: string): Mode {
  if (/^[0-9]*$/.test(text)) return 'numeric';
  if ([...text].every((c) => ALNUM.indexOf(c) !== -1)) return 'alphanumeric';
  return 'byte';
}

/** The count-of-characters field width, which grows with the version. */
function charCountBits(mode: Mode, version: number): number {
  const group = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  return { numeric: [10, 12, 14], alphanumeric: [9, 11, 13], byte: [8, 16, 16] }[mode][group]!;
}

/**
 * Block structure for every (version, EC level): total data codewords, the
 * EC codewords per block, and how the data splits into short and long blocks.
 * Packed as [ecPerBlock, group1Blocks, group1DataCw, group2Blocks, group2DataCw]
 * so the whole 40x4 table stays legible.
 */
const BLOCKS: Record<ErrorLevel, [number, number, number, number, number][]> = {
  L: [[7,1,19,0,0],[10,1,34,0,0],[15,1,55,0,0],[20,1,80,0,0],[26,1,108,0,0],[18,2,68,0,0],[20,2,78,0,0],[24,2,97,0,0],[30,2,116,0,0],[18,2,68,2,69],[20,4,81,0,0],[24,2,92,2,93],[26,4,107,0,0],[30,3,115,1,116],[22,5,87,1,88],[24,5,98,1,99],[28,1,107,5,108],[30,5,120,1,121],[28,3,113,4,114],[28,3,107,5,108],[28,4,116,4,117],[28,2,111,7,112],[30,4,121,5,122],[30,6,117,4,118],[26,8,106,4,107],[28,10,114,2,115],[30,8,122,4,123],[30,3,117,10,118],[30,7,116,7,117],[30,5,115,10,116],[30,13,115,3,116],[30,17,115,0,0],[30,17,115,1,116],[30,13,115,6,116],[30,12,121,7,122],[30,6,121,14,122],[30,17,122,4,123],[30,4,122,18,123],[30,20,117,4,118],[30,19,118,6,119]],
  M: [[10,1,16,0,0],[16,1,28,0,0],[26,1,44,0,0],[18,2,32,0,0],[24,2,43,0,0],[16,4,27,0,0],[18,4,31,0,0],[22,2,38,2,39],[22,3,36,2,37],[26,4,43,1,44],[30,1,50,4,51],[22,6,36,2,37],[22,8,37,1,38],[24,4,40,5,41],[24,5,41,5,42],[28,7,45,3,46],[28,10,46,1,47],[26,9,43,4,44],[26,3,44,11,45],[26,3,41,13,42],[26,17,42,0,0],[28,17,46,0,0],[28,4,47,14,48],[28,6,45,14,46],[28,8,47,13,48],[28,19,46,4,47],[28,22,45,3,46],[28,3,45,23,46],[28,21,45,7,46],[28,19,47,10,48],[28,2,46,29,47],[28,10,46,23,47],[28,14,46,21,47],[28,14,46,23,47],[28,12,47,26,48],[28,6,47,34,48],[28,29,46,14,47],[28,13,46,32,47],[28,40,47,7,48],[28,18,47,31,48]],
  Q: [[13,1,13,0,0],[22,1,22,0,0],[18,2,17,0,0],[26,2,24,0,0],[18,2,15,2,16],[24,4,19,0,0],[18,2,14,4,15],[22,4,18,2,19],[20,4,16,4,17],[24,6,19,2,20],[28,4,22,4,23],[26,4,20,6,21],[24,8,20,4,21],[20,11,16,5,17],[30,5,24,7,25],[24,15,19,2,20],[28,1,22,15,23],[28,17,22,1,23],[26,17,21,4,22],[30,15,24,5,25],[28,17,22,6,23],[30,7,24,16,25],[30,11,24,14,25],[30,11,24,16,25],[30,7,24,22,25],[28,28,22,6,23],[30,8,23,26,24],[30,4,24,31,25],[30,1,23,37,24],[30,15,24,25,25],[30,42,24,1,25],[30,10,24,35,25],[30,29,24,19,25],[30,44,24,7,25],[30,39,24,14,25],[30,46,24,10,25],[30,49,24,10,25],[30,48,24,14,25],[30,43,24,22,25],[30,34,24,34,25]],
  H: [[17,1,9,0,0],[28,1,16,0,0],[22,2,13,0,0],[16,4,9,0,0],[22,2,11,2,12],[28,4,15,0,0],[26,4,13,1,14],[26,4,14,2,15],[24,4,12,4,13],[28,6,15,2,16],[24,3,12,8,13],[28,7,14,4,15],[22,12,11,4,12],[24,11,12,5,13],[24,11,12,7,13],[30,3,15,13,16],[28,2,14,17,15],[28,2,14,19,15],[26,9,13,16,14],[28,15,15,10,16],[30,19,16,6,17],[24,34,13,0,0],[30,16,15,14,16],[30,30,16,2,17],[30,22,15,13,16],[30,33,16,4,17],[30,12,15,28,16],[30,11,15,31,16],[30,19,15,26,16],[30,23,15,25,16],[30,23,15,28,16],[30,19,15,35,16],[30,11,15,46,16],[30,59,16,1,17],[30,22,15,41,16],[30,2,15,64,16],[30,24,15,46,16],[30,42,15,32,16],[30,10,15,67,16],[30,20,15,61,16]],
};

function dataCodewords(version: number, ec: ErrorLevel): number {
  const [, g1, d1, g2, d2] = BLOCKS[ec][version - 1]!;
  return g1 * d1 + g2 * d2;
}

/** The smallest version that holds this text at this EC level, or 0 if none. */
export function chooseVersion(text: string, ec: ErrorLevel): number {
  const mode = detectMode(text);
  const bytes = new TextEncoder().encode(text);
  const dataChars = mode === 'byte' ? bytes.length : text.length;
  for (let version = 1; version <= 40; version++) {
    const header = 4 + charCountBits(mode, version);
    let payload: number;
    if (mode === 'numeric') payload = 10 * Math.floor(dataChars / 3) + [0, 4, 7][dataChars % 3]!;
    else if (mode === 'alphanumeric') payload = 11 * Math.floor(dataChars / 2) + 6 * (dataChars % 2);
    else payload = 8 * dataChars;
    if (header + payload <= dataCodewords(version, ec) * 8) return version;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The bit stream
// ---------------------------------------------------------------------------

class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
}

function encodeData(text: string, version: number, ec: ErrorLevel): number[] {
  const mode = detectMode(text);
  const buf = new BitBuffer();
  buf.put(MODE_BITS[mode], 4);

  if (mode === 'numeric') {
    buf.put(text.length, charCountBits(mode, version));
    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      buf.put(Number(chunk), chunk.length * 3 + 1);
    }
  } else if (mode === 'alphanumeric') {
    buf.put(text.length, charCountBits(mode, version));
    for (let i = 0; i < text.length; i += 2) {
      if (i + 1 < text.length) buf.put(ALNUM.indexOf(text[i]!) * 45 + ALNUM.indexOf(text[i + 1]!), 11);
      else buf.put(ALNUM.indexOf(text[i]!), 6);
    }
  } else {
    const bytes = new TextEncoder().encode(text);
    buf.put(bytes.length, charCountBits(mode, version));
    for (const byte of bytes) buf.put(byte, 8);
  }

  const capacity = dataCodewords(version, ec) * 8;
  // Terminator, then pad to a byte, then the two alternating pad codewords.
  buf.put(0, Math.min(4, capacity - buf.bits.length));
  while (buf.bits.length % 8 !== 0) buf.bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < buf.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | buf.bits[i + j]!;
    codewords.push(byte);
  }
  const pads = [0xec, 0x11];
  let p = 0;
  while (codewords.length < capacity / 8) codewords.push(pads[p++ % 2]!);
  return codewords;
}

/** Interleave the data and EC codewords across the version's blocks. */
function buildCodewords(text: string, version: number, ec: ErrorLevel): number[] {
  const data = encodeData(text, version, ec);
  const [ecCount, g1, d1, g2, d2] = BLOCKS[ec][version - 1]!;

  const blocks: { data: number[]; ecc: number[] }[] = [];
  let at = 0;
  for (let i = 0; i < g1; i++) { const d = data.slice(at, at + d1); at += d1; blocks.push({ data: d, ecc: rsEncode(d, ecCount) }); }
  for (let i = 0; i < g2; i++) { const d = data.slice(at, at + d2); at += d2; blocks.push({ data: d, ecc: rsEncode(d, ecCount) }); }

  const out: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  for (let i = 0; i < ecCount; i++) for (const b of blocks) out.push(b.ecc[i]!);
  return out;
}

// ---------------------------------------------------------------------------
// The module matrix
// ---------------------------------------------------------------------------

const ALIGN_POS: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
  [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];

interface Grid {
  size: number;
  modules: (boolean | null)[][];
  reserved: boolean[][];
}

function newGrid(version: number): Grid {
  const size = version * 4 + 17;
  return {
    size,
    modules: Array.from({ length: size }, () => new Array(size).fill(null)),
    reserved: Array.from({ length: size }, () => new Array(size).fill(false)),
  };
}

function placeFinder(g: Grid, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= g.size || cc < 0 || cc >= g.size) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      g.modules[rr]![cc] = inRing || inCore;
      g.reserved[rr]![cc] = true;
    }
  }
}

function placeFunctionPatterns(g: Grid, version: number): void {
  placeFinder(g, 0, 0);
  placeFinder(g, 0, g.size - 7);
  placeFinder(g, g.size - 7, 0);

  // Alignment patterns, wherever they don't collide with a finder. Placed
  // before the timing pattern on purpose: from version 7 up, some alignment
  // centres land on row 6 or column 6, and there the pattern must overwrite
  // the timing line, exactly as a reader expects. The finder corners are the
  // only cells reserved so far, so the centre check skips just those; the
  // timing loop below then fills only what the alignment patterns left open.
  const pos = ALIGN_POS[version - 1]!;
  for (const r of pos) {
    for (const c of pos) {
      if (g.reserved[r]![c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          g.modules[r + dr]![c + dc] = on;
          g.reserved[r + dr]![c + dc] = true;
        }
      }
    }
  }

  // Timing patterns, filling only the cells no alignment pattern claimed.
  for (let i = 8; i < g.size - 8; i++) {
    const on = i % 2 === 0;
    if (g.modules[6]![i] === null) { g.modules[6]![i] = on; g.reserved[6]![i] = true; }
    if (g.modules[i]![6] === null) { g.modules[i]![6] = on; g.reserved[i]![6] = true; }
  }

  // The dark module, always set, and the format/version areas reserved.
  g.modules[g.size - 8]![8] = true;
  g.reserved[g.size - 8]![8] = true;
  reserveFormat(g);
  if (version >= 7) reserveVersion(g);
}

function reserveFormat(g: Grid): void {
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) { g.reserved[8]![i] = true; g.reserved[i]![8] = true; }
  }
  for (let i = 0; i < 8; i++) { g.reserved[8]![g.size - 1 - i] = true; g.reserved[g.size - 1 - i]![8] = true; }
}

function reserveVersion(g: Grid): void {
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      g.reserved[i]![g.size - 11 + j] = true;
      g.reserved[g.size - 11 + j]![i] = true;
    }
  }
}

/** Data, snaked up and down the two-column strips from the bottom right. */
function placeData(g: Grid, codewords: number[]): void {
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);

  let idx = 0;
  let upward = true;
  for (let col = g.size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < g.size; i++) {
      const row = upward ? g.size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (g.reserved[row]![cc]) continue;
        g.modules[row]![cc] = idx < bits.length ? bits[idx]! === 1 : false;
        idx++;
      }
    }
    upward = !upward;
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number): Grid {
  const out: Grid = { size: g.size, modules: g.modules.map((row) => row.slice()), reserved: g.reserved };
  for (let r = 0; r < g.size; r++) {
    for (let c = 0; c < g.size; c++) {
      if (!g.reserved[r]![c] && MASKS[mask]!(r, c)) out.modules[r]![c] = !out.modules[r]![c];
    }
  }
  return out;
}

/** The standard's four penalty rules, summed, for choosing the least-bad mask. */
function penalty(g: Grid): number {
  const n = g.size;
  const m = g.modules as boolean[][];
  let score = 0;

  // Rule 1: runs of five or more same-colour modules in a row or column.
  for (let r = 0; r < n; r++) {
    for (let dir = 0; dir < 2; dir++) {
      let run = 1;
      for (let c = 1; c < n; c++) {
        const a = dir === 0 ? m[r]![c] : m[c]![r];
        const b = dir === 0 ? m[r]![c - 1] : m[c - 1]![r];
        if (a === b) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
        else run = 1;
      }
    }
  }
  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = m[r]![c];
      if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3;
    }
  }
  // Rule 3: the finder-like 1:1:3:1:1 pattern, either orientation.
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c <= n - 11; c++) {
      let ok1 = true;
      let ok2 = true;
      let ok3 = true;
      let ok4 = true;
      for (let k = 0; k < 11; k++) {
        if (m[r]![c + k] !== pat1[k]) ok1 = false;
        if (m[r]![c + k] !== pat2[k]) ok2 = false;
        if (m[c + k]![r] !== pat1[k]) ok3 = false;
        if (m[c + k]![r] !== pat2[k]) ok4 = false;
      }
      if (ok1 || ok2) score += 40;
      if (ok3 || ok4) score += 40;
    }
  }
  // Rule 4: overall balance of dark to light.
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r]![c]) dark++;
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

// BCH-protected format information (15 bits) per EC level and mask.
function formatBits(ec: ErrorLevel, mask: number): number {
  const ecField = { L: 1, M: 0, Q: 3, H: 2 }[ec];
  let data = (ecField << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0x537 : 0);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) & 1 ? 0x1f25 : 0);
  return (version << 12) | (rem & 0xfff);
}

function placeFormat(g: Grid, ec: ErrorLevel, mask: number): void {
  const bits = formatBits(ec, mask);
  const size = g.size;
  // Each of the 15 bits is written twice (the two redundant copies), placed
  // exactly as the standard specifies: LSB first, one run up column 8 and one
  // along row 8, jumping over the two timing lines. This is the placement a
  // reader inverts, so it has to be bit-for-bit right.
  for (let i = 0; i < 15; i++) {
    const mod = ((bits >> i) & 1) === 1;
    if (i < 6) g.modules[i]![8] = mod;
    else if (i < 8) g.modules[i + 1]![8] = mod;
    else g.modules[size - 15 + i]![8] = mod;

    if (i < 8) g.modules[8]![size - i - 1] = mod;
    else if (i < 9) g.modules[8]![15 - i] = mod;
    else g.modules[8]![15 - i - 1] = mod;
  }
  g.modules[size - 8]![8] = true; // the fixed dark module
}

function placeVersion(g: Grid, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const on = ((bits >> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    g.modules[r]![g.size - 11 + c] = on;
    g.modules[g.size - 11 + c]![r] = on;
  }
}

export interface QrResult {
  size: number;
  modules: boolean[][];
  version: number;
  ec: ErrorLevel;
  mask: number;
}

/**
 * Encode a string into a QR matrix.
 *
 * `ec` defaults to M, the middle error-correction level. A version large
 * enough is chosen automatically; if the text is too long even for version
 * 40 at this level, it throws rather than truncate.
 */
export function encodeQr(text: string, ec: ErrorLevel = 'M'): QrResult {
  if (!text) throw new Error('There is nothing to make a code of.');
  const version = chooseVersion(text, ec);
  if (!version) throw new Error('That is too long to fit in a QR code, even at the lowest error correction.');

  const codewords = buildCodewords(text, version, ec);
  const base = newGrid(version);
  placeFunctionPatterns(base, version);
  placeData(base, codewords);

  // Try all eight masks, keep the least-penalised, as the standard requires.
  let best: Grid | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(base, mask);
    placeFormat(masked, ec, mask);
    if (version >= 7) placeVersion(masked, version);
    const score = penalty(masked);
    if (score < bestScore) { bestScore = score; best = masked; bestMask = mask; }
  }

  return {
    size: best!.size,
    modules: best!.modules as boolean[][],
    version,
    ec,
    mask: bestMask,
  };
}

/** The matrix as an SVG string, with a quiet zone, at one module per unit. */
export function qrSvg(qr: QrResult, options: { scale?: number; margin?: number; dark?: string; light?: string } = {}): string {
  const scale = options.scale ?? 8;
  const margin = options.margin ?? 4;
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';
  const dim = (qr.size + margin * 2) * scale;
  let path = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r]![c]) {
        path += `M${(c + margin) * scale} ${(r + margin) * scale}h${scale}v${scale}h-${scale}z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}

// ===========================================================================
// Reading a QR code back out of an image.
//
// The encoder above is only half of a QR tool; a code you cannot read back is
// a picture. The browser does ship a reader (BarcodeDetector), but only some
// browsers do — not Firefox, not Safari, not older phones — so a page that
// leaned on it would work for some visitors and quietly fail for the rest.
// This decodes the image itself, the same way any scanner does and the reverse
// of the encoder above: threshold the pixels to black and white, find the
// three big square finder patterns by their 1:1:3:1:1 signature, read the grid
// they define, undo the mask, pull the codewords back out of the snake, and
// let Reed-Solomon repair the damage a photograph adds. It runs in every
// browser because it asks nothing of the browser but the pixels.
// ===========================================================================

/** a / b in GF(256). */
function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('divide by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[(LOG[a]! - LOG[b]! + 255) % 255]!;
}

/** Otsu's threshold: split the image into ink and paper by the grey level that
 *  best separates the two peaks of its histogram. Right for a clean scan or a
 *  screenshot; good enough for an evenly lit photo. */
function toDark(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const n = width * height;
  const gray = new Uint8Array(n);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) {
    const y = (data[i * 4]! * 77 + data[i * 4 + 1]! * 150 + data[i * 4 + 2]! * 29) >> 8;
    gray[i] = y;
    hist[y]++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let max = -1;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; thr = t; }
  }
  const dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) dark[i] = gray[i]! <= thr ? 1 : 0;
  return dark;
}

interface Finder { x: number; y: number; module: number; }

/** Does a run of five counts look like a finder's 1:1:3:1:1 cross? Returns the
 *  estimated module width if so, or 0. */
function finderRatio(c: number[]): number {
  let total = 0;
  for (let i = 0; i < 5; i++) { if (c[i]! === 0) return 0; total += c[i]!; }
  if (total < 7) return 0;
  const mod = total / 7;
  const tol = mod * 0.5;
  return Math.abs(c[0]! - mod) < tol && Math.abs(c[1]! - mod) < tol &&
    Math.abs(c[2]! - 3 * mod) < tol * 2 && Math.abs(c[3]! - mod) < tol && Math.abs(c[4]! - mod) < tol
    ? mod : 0;
}

/** Confirm a finder centre found on a row by checking the column through it has
 *  the same 1:1:3:1:1 profile, and return the refined vertical centre. */
function crossVertical(dark: Uint8Array, width: number, height: number, cx: number, cy: number, mod: number): number {
  const at = (y: number) => (y >= 0 && y < height ? dark[y * width + cx]! : 0);
  const c: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  let y = cy;
  while (y >= 0 && at(y)) { c[2]++; y--; }
  while (y >= 0 && !at(y) && c[1]! <= mod * 2) { c[1]++; y--; }
  while (y >= 0 && at(y) && c[0]! <= mod * 2) { c[0]++; y--; }
  y = cy + 1;
  while (y < height && at(y)) { c[2]++; y++; }
  while (y < height && !at(y) && c[3]! <= mod * 2) { c[3]++; y++; }
  while (y < height && at(y) && c[4]! <= mod * 2) { c[4]++; y++; }
  if (!finderRatio(c)) return -1;
  return y - c[4]! - c[3]! - c[2]! / 2;
}

/** Find the three finder patterns by scanning every row for the horizontal
 *  1:1:3:1:1 signature and confirming each hit vertically, then clustering the
 *  confirmed crossings into centres. */
function locateFinders(dark: Uint8Array, width: number, height: number): Finder[] {
  const hits: Finder[] = [];
  for (let y = 0; y < height; y++) {
    const c: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    let state = 0;
    for (let x = 0; x < width; x++) {
      const px = dark[y * width + x]!;
      if (px === 1) {
        if ((state & 1) === 1) state++;
        c[state] = c[state]! + 1;
      } else {
        if ((state & 1) === 0) {
          if (state === 4) {
            const mod = finderRatio(c);
            if (mod) {
              const cx = Math.round(x - c[4]! - c[3]! - c[2]! / 2);
              const cyr = crossVertical(dark, width, height, cx, y, mod);
              if (cyr >= 0) hits.push({ x: cx, y: cyr, module: mod });
            }
            c[0] = c[2]!; c[1] = c[3]!; c[2] = c[4]!; c[3] = 1; c[4] = 0; state = 3;
          } else { state++; c[state] = c[state]! + 1; }
        } else c[state] = c[state]! + 1;
      }
    }
  }
  // Cluster hits that fall within a module of each other; average each cluster.
  const centres: (Finder & { n: number })[] = [];
  for (const h of hits) {
    const near = centres.find((c) => Math.abs(c.x - h.x) < h.module * 2 && Math.abs(c.y - h.y) < h.module * 2);
    if (near) {
      near.x = (near.x * near.n + h.x) / (near.n + 1);
      near.y = (near.y * near.n + h.y) / (near.n + 1);
      near.module = (near.module * near.n + h.module) / (near.n + 1);
      near.n++;
    } else centres.push({ ...h, n: 1 });
  }
  return centres.filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 8);
}

/** Order three finder centres as [topLeft, topRight, bottomLeft]. The top-left
 *  is the corner opposite the longest side; the other two are told apart by the
 *  sign of their cross product. */
function orderFinders(f: Finder[]): [Finder, Finder, Finder] | null {
  if (f.length < 3) return null;
  const d = (a: Finder, b: Finder) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const [a, b, c] = f;
  const dab = d(a!, b!);
  const dac = d(a!, c!);
  const dbc = d(b!, c!);
  let tl: Finder;
  let p: Finder;
  let q: Finder;
  if (dbc >= dab && dbc >= dac) { tl = a!; p = b!; q = c!; }
  else if (dac >= dab && dac >= dbc) { tl = b!; p = a!; q = c!; }
  else { tl = c!; p = a!; q = b!; }
  // Cross product of (p-tl) x (q-tl): positive means p is the top-right in
  // image coordinates (y down), q the bottom-left; negative means swap.
  const cross = (p.x - tl.x) * (q.y - tl.y) - (p.y - tl.y) * (q.x - tl.x);
  return cross >= 0 ? [tl, p, q] : [tl, q, p];
}

/** Sample the module grid an affine map from the three finder centres defines.
 *  Flat images (screenshots, scans, generated codes) are exactly affine; an
 *  angled photo is approximated. Returns the boolean matrix and its version. */
function sampleMatrix(dark: Uint8Array, width: number, height: number, ordered: [Finder, Finder, Finder]): { modules: boolean[][]; size: number; version: number } | null {
  const [tl, tr, bl] = ordered;
  const modAvg = (tl.module + tr.module + bl.module) / 3;
  const distTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const distLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  // Centres sit 3.5 modules in from each edge, so they are (size - 7) apart.
  let size = Math.round(((distTop + distLeft) / 2) / modAvg) + 7;
  size = Math.round((size - 17) / 4) * 4 + 17; // snap to a real QR dimension
  if (size < 21 || size > 177) return null;
  const version = (size - 17) / 4;

  // image(module) = tl + ((mx-3.5)/(size-7))*(tr-tl) + ((my-3.5)/(size-7))*(bl-tl)
  const span = size - 7;
  const ux = (tr.x - tl.x) / span;
  const uy = (tr.y - tl.y) / span;
  const vx = (bl.x - tl.x) / span;
  const vy = (bl.y - tl.y) / span;
  const modules: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) {
      const mx = c + 0.5 - 3.5;
      const my = r + 0.5 - 3.5;
      const px = Math.round(tl.x + mx * ux + my * vx);
      const py = Math.round(tl.y + mx * uy + my * vy);
      row.push(px >= 0 && px < width && py >= 0 && py < height ? dark[py * width + px]! === 1 : false);
    }
    modules.push(row);
  }
  return { modules, size, version };
}

/** Read the format information (EC level and mask) back, choosing the valid
 *  15-bit word closest to what was sampled so a few wrong modules do no harm. */
function readFormat(modules: boolean[][], size: number): { ec: ErrorLevel; mask: number } | null {
  // The same two placements the encoder wrote, read back into a 15-bit number.
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    let m: boolean;
    if (i < 6) m = modules[i]![8]!;
    else if (i < 8) m = modules[i + 1]![8]!;
    else m = modules[size - 15 + i]![8]!;
    if (m) bits |= 1 << i;
  }
  let best = -1;
  let bestDist = 99;
  for (let ecI = 0; ecI < 4; ecI++) {
    for (let mask = 0; mask < 8; mask++) {
      const cand = formatBits(EC_ORDER[ecI]!, mask);
      let dist = 0;
      let x = cand ^ bits;
      while (x) { dist += x & 1; x >>= 1; }
      if (dist < bestDist) { bestDist = dist; best = (ecI << 3) | mask; }
    }
  }
  if (best < 0 || bestDist > 3) return null;
  return { ec: EC_ORDER[best >> 3]!, mask: best & 7 };
}

/** Reverse of placeData: walk the same snake and collect the data-region bits,
 *  grouped back into codewords (still interleaved across blocks). */
function readDataRegion(modules: boolean[][], reserved: boolean[][], size: number, mask: number): number[] {
  const bits: number[] = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserved[row]![cc]) continue;
        const bit = (modules[row]![cc]! ? 1 : 0) ^ (MASKS[mask]!(row, cc) ? 1 : 0);
        bits.push(bit);
      }
    }
    upward = !upward;
  }
  const cws: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    cws.push(b);
  }
  return cws;
}

/** Undo the block interleave, returning each block's data+EC codewords. */
function deinterleave(all: number[], version: number, ec: ErrorLevel): number[][] {
  const [ecCount, g1, d1, g2, d2] = BLOCKS[ec][version - 1]!;
  const blocks: number[][] = [];
  const dataLens: number[] = [];
  for (let i = 0; i < g1; i++) { blocks.push([]); dataLens.push(d1); }
  for (let i = 0; i < g2; i++) { blocks.push([]); dataLens.push(d2); }
  let idx = 0;
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) for (let b = 0; b < blocks.length; b++) if (i < dataLens[b]!) blocks[b]!.push(all[idx++]!);
  for (let i = 0; i < ecCount; i++) for (let b = 0; b < blocks.length; b++) blocks[b]!.push(all[idx++]!);
  return blocks;
}

/** Reed-Solomon decode one block (data followed by EC codewords). Returns the
 *  corrected data codewords, or null if the errors are past repair. */
function rsDecodeBlock(msg: number[], ecCount: number): number[] | null {
  const synd = new Array(ecCount).fill(0);
  let hasError = false;
  for (let i = 0; i < ecCount; i++) {
    let s = 0;
    for (let j = 0; j < msg.length; j++) s = gfMul(s, EXP[i]!) ^ msg[j]!;
    synd[i] = s;
    if (s !== 0) hasError = true;
  }
  if (!hasError) return msg.slice(0, msg.length - ecCount);

  // Berlekamp-Massey for the error locator polynomial.
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let n = 0; n < ecCount; n++) {
    let d = synd[n];
    for (let i = 1; i <= L; i++) d ^= gfMul(C[i] || 0, synd[n - i]);
    if (d === 0) { m++; }
    else if (2 * L <= n) {
      const T = C.slice();
      const coef = gfDiv(d, b);
      while (C.length < B.length + m) C.push(0);
      for (let i = 0; i < B.length; i++) C[i + m] = (C[i + m] || 0) ^ gfMul(coef, B[i]!);
      L = n + 1 - L; B = T; b = d; m = 1;
    } else {
      const coef = gfDiv(d, b);
      while (C.length < B.length + m) C.push(0);
      for (let i = 0; i < B.length; i++) C[i + m] = (C[i + m] || 0) ^ gfMul(coef, B[i]!);
      m++;
    }
  }
  if (L === 0 || L > ecCount / 2) return null;

  // Chien search: the error positions are the powers whose inverse is a root.
  const n = msg.length;
  const positions: number[] = [];
  for (let k = 0; k < n; k++) {
    const p = n - 1 - k;
    let val = 0;
    for (let i = 0; i < C.length; i++) val ^= gfMul(C[i]!, EXP[(i * ((255 - p) % 255)) % 255]!);
    if (val === 0) positions.push(k);
  }
  if (positions.length !== L) return null;

  // Forney: the magnitude at each error position.
  const omega = new Array(ecCount).fill(0);
  for (let i = 0; i < ecCount; i++) {
    let s = 0;
    for (let j = 0; j <= i && j < C.length; j++) s ^= gfMul(synd[i - j], C[j]!);
    omega[i] = s;
  }
  const out = msg.slice();
  for (const k of positions) {
    const p = n - 1 - k;
    const xVal = EXP[p % 255]!;        // X = alpha^p, the error-position value
    const xExp = (255 - p) % 255;      // the exponent of X^-1 = alpha^-p
    let omegaVal = 0;
    for (let i = 0; i < ecCount; i++) omegaVal ^= gfMul(omega[i], EXP[(i * xExp) % 255]!);
    let deriv = 0;
    for (let i = 1; i < C.length; i += 2) deriv ^= gfMul(C[i]!, EXP[((i - 1) * xExp) % 255]!);
    if (deriv === 0) return null;
    // Forney with generator base 0: e = X * Omega(X^-1) / Lambda'(X^-1).
    const magnitude = gfMul(gfMul(xVal, omegaVal), gfDiv(1, deriv));
    out[k] = out[k]! ^ magnitude;
  }

  // Confirm the correction actually cleared the syndromes.
  for (let i = 0; i < ecCount; i++) {
    let s = 0;
    for (let j = 0; j < out.length; j++) s = gfMul(s, EXP[i]!) ^ out[j]!;
    if (s !== 0) return null;
  }
  return out.slice(0, msg.length - ecCount);
}

/** Read the data codewords back into their original text. Mirrors encodeData:
 *  a mode nibble, a character count, then the characters in that mode. */
function parseBitstream(codewords: number[], version: number): string {
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let pos = 0;
  const read = (len: number) => {
    let v = 0;
    for (let i = 0; i < len; i++) v = (v << 1) | (bits[pos++] ?? 0);
    return v;
  };
  let out = '';
  const bytes: number[] = [];
  while (pos + 4 <= bits.length) {
    const mode = read(4);
    if (mode === 0) break; // terminator
    if (mode === 0b0001) {
      const count = read(charCountBits('numeric', version));
      let left = count;
      while (left >= 3) { out += String(read(10)).padStart(3, '0'); left -= 3; }
      if (left === 2) out += String(read(7)).padStart(2, '0');
      else if (left === 1) out += String(read(4));
    } else if (mode === 0b0010) {
      const count = read(charCountBits('alphanumeric', version));
      let left = count;
      while (left >= 2) { const v = read(11); out += ALNUM[Math.floor(v / 45)]! + ALNUM[v % 45]!; left -= 2; }
      if (left === 1) out += ALNUM[read(6)]!;
    } else if (mode === 0b0100) {
      const count = read(charCountBits('byte', version));
      for (let i = 0; i < count; i++) bytes.push(read(8));
    } else {
      break; // a mode this encoder never writes (ECI, kanji, structured append)
    }
  }
  // Byte-mode data was collected raw; decode it as UTF-8 in one pass so a
  // multi-byte character split across the loop still comes back whole.
  if (bytes.length) {
    const decoded = new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    // Byte segments always follow any numeric/alnum ones here because the
    // encoder only ever emits a single segment; append is safe.
    out += decoded;
  }
  return out;
}

/**
 * Decode a QR code from raw RGBA pixels (as a canvas ImageData gives them).
 *
 * Returns the text, or null if no readable code is found. The pipeline is the
 * exact reverse of the encoder: threshold, find the finders, sample the grid,
 * read the format, unmask, de-interleave, Reed-Solomon repair, and parse.
 */
export function decodeQr(data: Uint8ClampedArray, width: number, height: number): string | null {
  const dark = toDark(data, width, height);
  const finders = locateFinders(dark, width, height);
  // Try the strongest triples of finder candidates until one decodes.
  for (let a = 0; a < finders.length; a++) {
    for (let b = a + 1; b < finders.length; b++) {
      for (let c = b + 1; c < finders.length; c++) {
        const ordered = orderFinders([finders[a]!, finders[b]!, finders[c]!]);
        if (!ordered) continue;
        const text = tryDecode(dark, width, height, ordered);
        if (text !== null) return text;
      }
    }
  }
  return null;
}

function tryDecode(dark: Uint8Array, width: number, height: number, ordered: [Finder, Finder, Finder]): string | null {
  const sampled = sampleMatrix(dark, width, height, ordered);
  if (!sampled) return null;
  const { modules, size, version } = sampled;
  const fmt = readFormat(modules, size);
  if (!fmt) return null;

  const grid = newGrid(version);
  placeFunctionPatterns(grid, version);
  const codewords = readDataRegion(modules, grid.reserved, size, fmt.mask);

  const total = BLOCKS[fmt.ec][version - 1]!;
  const [ecCount, g1, d1, g2, d2] = total;
  const wanted = g1 * (d1 + ecCount) + g2 * (d2 + ecCount);
  if (codewords.length < wanted) return null;

  const blocks = deinterleave(codewords.slice(0, wanted), version, fmt.ec);
  const dataOut: number[] = [];
  for (const block of blocks) {
    const fixed = rsDecodeBlock(block, ecCount);
    if (!fixed) return null;
    dataOut.push(...fixed);
  }
  try {
    const text = parseBitstream(dataOut, version);
    return text || null;
  } catch {
    return null;
  }
}

const globalScope = globalThis as unknown as { LOC1999_QR?: Record<string, unknown> };
globalScope.LOC1999_QR = {
  encodeQr,
  decodeQr,
  qrSvg,
  detectMode,
  chooseVersion,
  rsEncode,
};

/**
 * The audio tool's engine: everything that can be done to a sound without a
 * browser in the room.
 *
 * The page decodes with the browser's own decoder and renders edits through an
 * OfflineAudioContext, because those are the two things a browser genuinely
 * does better than anything we could write. Everything else — the arithmetic
 * of trimming, fading, normalising, and the two encoders' plumbing — lives
 * here, where a test can run it on a known signal and check the numbers.
 *
 * The MP3 encoder itself is LAME, as the lamejs port, vendored at
 * /vendor/lame/lame.min.js and hash-pinned like every other library here. It
 * is handed IN to these functions rather than imported, for the same reason
 * pgpkit does not import OpenPGP.js: the page loads it lazily on first use,
 * and the tests load the identical vendored file, so what is tested is what
 * ships.
 *
 * WAV is written by hand below. It is forty lines of byte layout, there is
 * nothing to get subtly wrong the way a cipher or a psychoacoustic model can
 * be wrong, and a library for it would be a dependency that exists to save
 * forty lines.
 */

// ---------------------------------------------------------------------------
// What a file is
// ---------------------------------------------------------------------------

export type AudioKind =
  | 'mp3' | 'wav' | 'ogg' | 'flac' | 'm4a' | 'webm' | 'aiff' | 'wma' | '';

/**
 * Decided from the bytes, not the name: a file saved off a phone or a chat
 * app routinely arrives as .mp3 holding AAC. The browser's decoder is the
 * authority on whether it can be opened; this exists so that when it says no,
 * the error can say what the file actually was.
 */
export function sniffAudio(bytes: Uint8Array): AudioKind {
  const b = bytes;
  if (b.length < 12) return '';
  const tag = (at: number, text: string) =>
    text.split('').every((ch, i) => b[at + i] === ch.charCodeAt(0));
  if (tag(0, 'ID3')) return 'mp3';
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return 'mp3';
  if (tag(0, 'RIFF') && tag(8, 'WAVE')) return 'wav';
  if (tag(0, 'OggS')) return 'ogg';
  if (tag(0, 'fLaC')) return 'flac';
  if (tag(4, 'ftyp')) return 'm4a';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (tag(0, 'FORM') && (tag(8, 'AIFF') || tag(8, 'AIFC'))) return 'aiff';
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return 'wma';
  return '';
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

/**
 * A selection, made sane. Whatever was typed or dragged: start lands inside
 * the file, end lands after start, and an end of 0 or nonsense means "to the
 * end", because that is what an untouched box should mean.
 */
export function clampRange(
  durationSec: number,
  startSec: number,
  endSec: number,
): { start: number; end: number } {
  const dur = Math.max(0, Number(durationSec) || 0);
  let start = Number(startSec);
  let end = Number(endSec);
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (start > dur) start = dur;
  if (!Number.isFinite(end) || end <= start || end > dur) end = dur;
  return { start, end };
}

export function dbToLinear(db: number): number {
  const n = Number(db);
  if (!Number.isFinite(n)) return 1;
  return Math.pow(10, n / 20);
}

/** The loudest single sample, which is what clipping cares about. */
export function peakOf(channels: Float32Array[]): number {
  let peak = 0;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]!);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/**
 * Peak-normalise in place to -1 dBFS and say by how much.
 *
 * Peak, not loudness: proper loudness normalising is LUFS, a gated,
 * frequency-weighted measurement with a spec of its own, and pretending a
 * peak scale is that would be the sort of quiet lie this site exists to not
 * tell. Peak-to-just-under-full is still the thing most people reaching for
 * "normalize" want: as loud as it can be without clipping.
 */
export function normalize(channels: Float32Array[]): number {
  const peak = peakOf(channels);
  if (peak === 0) return 1;
  const factor = dbToLinear(-1) / peak;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) data[i]! *= factor;
  }
  return factor;
}

/** A flat gain, in place. */
export function applyGain(channels: Float32Array[], factor: number): void {
  if (factor === 1) return;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) data[i]! *= factor;
  }
}

/**
 * Linear fades, in place. Linear rather than logarithmic on purpose: over the
 * half-second to few-second fades this page is for, the difference is
 * inaudible, and linear is checkable by eye in a test.
 */
export function applyFades(
  channels: Float32Array[],
  sampleRate: number,
  fadeInSec: number,
  fadeOutSec: number,
): void {
  const length = channels[0] ? channels[0].length : 0;
  if (!length) return;
  const inN = Math.min(length, Math.max(0, Math.round((Number(fadeInSec) || 0) * sampleRate)));
  const outN = Math.min(length, Math.max(0, Math.round((Number(fadeOutSec) || 0) * sampleRate)));
  for (const data of channels) {
    for (let i = 0; i < inN; i++) data[i]! *= i / inN;
    for (let i = 0; i < outN; i++) data[length - 1 - i]! *= i / outN;
  }
}

/** Several renders end to end, for the playlist's join. */
export function concatSegments(segments: Float32Array[][]): Float32Array[] {
  if (!segments.length) return [];
  const channelCount = Math.max(...segments.map((s) => s.length));
  const total = segments.reduce((sum, s) => sum + (s[0] ? s[0].length : 0), 0);
  const out: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch++) {
    const joined = new Float32Array(total);
    let at = 0;
    for (const seg of segments) {
      // A mono segment in a stereo join contributes its one channel to both
      // sides rather than silence to one of them.
      const source = seg[ch] || seg[0];
      if (source) joined.set(source, at);
      at += seg[0] ? seg[0].length : 0;
    }
    out.push(joined);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The encoders
// ---------------------------------------------------------------------------

/** Float samples to the 16-bit integers both encoders eat, clamped. */
export function toInt16(data: Float32Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(-1, Math.min(1, data[i]!));
    out[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
  }
  return out;
}

/**
 * A WAV file: 16-bit PCM, interleaved, little-endian. The format every
 * editor, sampler and DAW since 1991 opens without looking at it twice.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const numCh = channels.length || 1;
  const frames = channels[0] ? channels[0].length : 0;
  const dataBytes = frames * numCh * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);

  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);            // fmt chunk size
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);  // byte rate
  view.setUint16(32, numCh * 2, true);     // block align
  view.setUint16(34, 16, true);            // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  const ints = channels.map(toInt16);
  let at = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < numCh; ch++) {
      view.setInt16(at, ints[ch]![frame]!, true);
      at += 2;
    }
  }
  return out;
}

/** The bitrates worth offering, which is not every bitrate MP3 has. */
export const MP3_BITRATES = [128, 192, 320];

/**
 * The sample rates LAME's MPEG-1 and MPEG-2 layers actually accept. A render
 * at anything else has to be resampled first; the page does that through an
 * OfflineAudioContext before it ever gets here.
 */
export const MP3_RATES = [32000, 44100, 48000, 22050, 24000, 16000];

/* What the vendored encoder looks like from here. */
interface LameEncoder {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
  flush(): Int8Array;
}
interface LameModule {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => LameEncoder;
}

export interface Mp3Job {
  /** Encode up to `maxBlocks` more blocks. Null when there is nothing left. */
  step(maxBlocks: number): Uint8Array | null;
  /** How far along, 0..1, for a progress line. */
  fraction(): number;
  /** Everything produced so far, in order. Call after step() returns null. */
  finish(): Uint8Array;
}

/**
 * MP3, as a job rather than a call.
 *
 * Encoding a podcast on a phone takes real seconds, and a function that eats
 * them in one bite freezes the tab with no way to say how it is going. The
 * page runs step() in a timeout loop and repaints between steps; the tests
 * run step() in a while loop and get the identical bytes. 1152 samples is an
 * MP3 frame, which is the granularity LAME wants anyway.
 */
export function mp3Job(
  lame: LameModule,
  channels: Float32Array[],
  sampleRate: number,
  kbps: number,
): Mp3Job {
  if (MP3_RATES.indexOf(sampleRate) === -1) {
    throw new Error('MP3 cannot hold ' + sampleRate + ' Hz; resample first.');
  }
  const stereo = channels.length > 1;
  const left = toInt16(channels[0] || new Float32Array(0));
  const right = stereo ? toInt16(channels[1]!) : left;
  const encoder = new lame.Mp3Encoder(stereo ? 2 : 1, sampleRate, kbps);

  const BLOCK = 1152;
  const total = left.length;
  let at = 0;
  let flushed = false;
  const parts: Uint8Array[] = [];

  return {
    step(maxBlocks: number): Uint8Array | null {
      if (flushed) return null;
      let made = 0;
      const stop = Math.min(total, at + BLOCK * Math.max(1, maxBlocks));
      while (at < stop) {
        const end = Math.min(at + BLOCK, total);
        const chunk = stereo
          ? encoder.encodeBuffer(left.subarray(at, end), right.subarray(at, end))
          : encoder.encodeBuffer(left.subarray(at, end));
        if (chunk.length) {
          const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length);
          parts.push(bytes.slice());
          made += chunk.length;
        }
        at = end;
      }
      if (at >= total) {
        const tail = encoder.flush();
        if (tail.length) {
          parts.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.length).slice());
        }
        flushed = true;
        return null;
      }
      return parts[parts.length - 1] || new Uint8Array(0);
    },
    fraction(): number {
      return total ? Math.min(1, at / total) : 1;
    },
    finish(): Uint8Array {
      const size = parts.reduce((sum, p) => sum + p.length, 0);
      const out = new Uint8Array(size);
      let cursor = 0;
      for (const p of parts) {
        out.set(p, cursor);
        cursor += p.length;
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// The words on the display
// ---------------------------------------------------------------------------

/** 205 -> "3:25"; 3725 -> "1:02:05". The LCD never shows a bare number. */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => (n < 10 ? '0' + n : String(n));
  return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

/** What the file averages, which is all a decoded buffer can know. */
export function averageKbps(fileBytes: number, seconds: number): number {
  if (!seconds || !Number.isFinite(seconds)) return 0;
  return Math.round((fileBytes * 8) / seconds / 1000);
}

/** song.mp3 -> song-edit.mp3; keeps the stem, replaces the coat. */
export function outName(sourceName: string, suffix: string, ext: string): string {
  const stem = String(sourceName || 'audio').replace(/\.[^.]+$/, '') || 'audio';
  return stem + '-' + suffix + '.' + ext;
}

// ---------------------------------------------------------------------------
// What the page can reach
// ---------------------------------------------------------------------------

const globalScope = globalThis as unknown as { LOC1999_AUDIO?: Record<string, unknown> };
globalScope.LOC1999_AUDIO = {
  sniffAudio,
  clampRange,
  dbToLinear,
  peakOf,
  normalize,
  applyGain,
  applyFades,
  concatSegments,
  toInt16,
  encodeWav,
  mp3Job,
  MP3_BITRATES,
  MP3_RATES,
  formatTime,
  averageKbps,
  outName,
};

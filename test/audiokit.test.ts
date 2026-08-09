/**
 * The audio tool's engine.
 *
 * The two encoders get the attention, because their output leaves this site
 * and has to open in software that has never heard of it. The WAV writer is
 * checked by parsing its own bytes back and comparing samples; the MP3 path
 * is checked by running the ACTUAL vendored LAME build — the same file the
 * page loads — over a known signal and reading the frame headers back out of
 * what it produced. A mock encoder here would test the mock.
 *
 * The arithmetic (trim, gain, fades, normalise) is checked on signals small
 * enough to reason about by hand, because "the fade is a fade" is exactly the
 * sort of claim that quietly becomes false during a refactor.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MP3_BITRATES,
  MP3_RATES,
  applyFades,
  applyGain,
  averageKbps,
  clampRange,
  concatSegments,
  dbToLinear,
  encodeWav,
  formatTime,
  mp3Job,
  normalize,
  outName,
  peakOf,
  sniffAudio,
  toInt16,
} from '../src/client/audiokit';

/* The vendored encoder, loaded exactly as shipped. It is an IIFE that
 * declares `var lamejs`, so evaluating it and returning the name hands back
 * the same object the page gets from its script tag. */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const lame = new Function(
  `${readFileSync('public/vendor/lame/lame.min.js', 'utf8')}; return lamejs;`,
)() as Parameters<typeof mp3Job>[0];

const sine = (seconds: number, rate: number, hz = 440, amp = 0.5): Float32Array => {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
};

describe('sniffAudio', () => {
  const bytes = (...b: (number | string)[]) => {
    const out: number[] = [];
    for (const item of b) {
      if (typeof item === 'string') for (const ch of item) out.push(ch.charCodeAt(0));
      else out.push(item);
    }
    while (out.length < 16) out.push(0);
    return new Uint8Array(out);
  };

  it('recognises the formats people actually have', () => {
    expect(sniffAudio(bytes('ID3', 4, 0))).toBe('mp3');
    expect(sniffAudio(bytes(0xff, 0xfb, 0x90))).toBe('mp3');
    expect(sniffAudio(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))).toBe('wav');
    expect(sniffAudio(bytes('OggS'))).toBe('ogg');
    expect(sniffAudio(bytes('fLaC'))).toBe('flac');
    expect(sniffAudio(bytes(0, 0, 0, 32, 'ftypM4A '))).toBe('m4a');
    expect(sniffAudio(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe('webm');
    expect(sniffAudio(bytes('FORM', 0, 0, 0, 0, 'AIFF'))).toBe('aiff');
    expect(sniffAudio(bytes(0x30, 0x26, 0xb2, 0x75))).toBe('wma');
  });

  it('says nothing rather than guessing', () => {
    expect(sniffAudio(bytes('%PDF'))).toBe('');
    expect(sniffAudio(new Uint8Array(3))).toBe('');
  });
});

describe('clampRange', () => {
  it('leaves a sensible selection alone', () => {
    expect(clampRange(100, 10, 20)).toEqual({ start: 10, end: 20 });
  });

  it('reads an untouched end box as "to the end"', () => {
    expect(clampRange(100, 10, 0)).toEqual({ start: 10, end: 100 });
    expect(clampRange(100, 0, Number.NaN)).toEqual({ start: 0, end: 100 });
  });

  it('refuses to build an inside-out selection', () => {
    expect(clampRange(100, 40, 30)).toEqual({ start: 40, end: 100 });
    expect(clampRange(100, -5, 200)).toEqual({ start: 0, end: 100 });
  });
});

describe('the arithmetic', () => {
  it('converts decibels the way the label promises', () => {
    expect(dbToLinear(0)).toBe(1);
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 2);
    expect(dbToLinear(6)).toBeCloseTo(1.995, 2);
    expect(dbToLinear(Number.NaN)).toBe(1);
  });

  it('normalises the peak to -1 dBFS and not a hair over', () => {
    const channels = [sine(0.1, 44100, 440, 0.25)];
    normalize(channels);
    expect(peakOf(channels)).toBeCloseTo(dbToLinear(-1), 3);
  });

  it('applies a flat gain by exactly the factor asked', () => {
    const channels = [sine(0.05, 8000, 100, 0.25)];
    applyGain(channels, dbToLinear(6));
    expect(peakOf(channels)).toBeCloseTo(0.25 * dbToLinear(6), 3);
    // The page hands 1 for "untouched"; that must cost nothing and change nothing.
    const before = channels[0]!.slice();
    applyGain(channels, 1);
    expect(channels[0]).toEqual(before);
  });

  it('leaves silence alone instead of dividing by zero', () => {
    const channels = [new Float32Array(64)];
    expect(normalize(channels)).toBe(1);
    expect(peakOf(channels)).toBe(0);
  });

  it('fades from nothing and back to nothing', () => {
    const data = new Float32Array(1000).fill(1);
    applyFades([data], 1000, 0.1, 0.1);   // 100 samples each end
    expect(data[0]).toBe(0);
    expect(data[50]!).toBeCloseTo(0.5, 1);
    expect(data[500]).toBe(1);            // the middle is untouched
    expect(data[999]).toBe(0);
    expect(data[949]!).toBeCloseTo(0.5, 1);
  });

  it('joins segments end to end, and lends a mono segment to both sides', () => {
    const stereo = [new Float32Array([1, 1]), new Float32Array([2, 2])];
    const mono = [new Float32Array([3, 3])];
    const joined = concatSegments([stereo, mono]);
    expect(joined.length).toBe(2);
    expect(Array.from(joined[0]!)).toEqual([1, 1, 3, 3]);
    expect(Array.from(joined[1]!)).toEqual([2, 2, 3, 3]);
  });

  it('clamps rather than wrapping when a sample is over full scale', () => {
    // 1.5 wrapping to a negative number is the classic integer-overflow
    // click; it has to pin at the rail instead.
    const ints = toInt16(new Float32Array([1.5, -1.5, 0]));
    expect(ints[0]).toBe(32767);
    expect(ints[1]).toBe(-32768);
    expect(ints[2]).toBe(0);
  });
});

describe('encodeWav', () => {
  it('writes a header any parser would agree with', () => {
    const rate = 44100;
    const wav = encodeWav([sine(0.05, rate), sine(0.05, rate)], rate);
    const view = new DataView(wav.buffer);
    const text = (at: number, n: number) => String.fromCharCode(...wav.slice(at, at + n));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1);        // PCM
    expect(view.getUint16(22, true)).toBe(2);        // stereo
    expect(view.getUint32(24, true)).toBe(rate);
    expect(view.getUint16(34, true)).toBe(16);       // bits
    expect(view.getUint32(40, true)).toBe(wav.length - 44);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
  });

  it('survives a round trip within quantisation error', () => {
    const rate = 8000;
    const original = sine(0.02, rate, 200, 0.8);
    const wav = encodeWav([original], rate);
    const view = new DataView(wav.buffer);
    for (let i = 0; i < original.length; i++) {
      const sample = view.getInt16(44 + i * 2, true) / 32767;
      // Half a step of rounding, plus the 32768-encode/32767-decode
      // asymmetry on the negative side: under two steps, never more.
      expect(Math.abs(sample - original[i]!)).toBeLessThan(2 / 32767);
    }
  });
});

describe('mp3Job, against the encoder that actually ships', () => {
  const encode = (channels: Float32Array[], rate: number, kbps: number) => {
    const job = mp3Job(lame, channels, rate, kbps);
    while (job.step(64) !== null) { /* the page does this in a timeout loop */ }
    expect(job.fraction()).toBe(1);
    return job.finish();
  };

  it('produces real MPEG frames with the asked-for numbers in them', () => {
    const rate = 44100;
    const out = encode([sine(0.3, rate), sine(0.3, rate)], rate, 128);
    expect(out.length).toBeGreaterThan(2000);
    // Frame sync: eleven set bits.
    expect(out[0]).toBe(0xff);
    expect((out[1]! & 0xe0)).toBe(0xe0);
    expect((out[1]! & 0x18) >> 3).toBe(3);                 // MPEG-1
    expect((out[1]! & 0x06) >> 1).toBe(1);                 // Layer III
    const bitrateIndex = (out[2]! & 0xf0) >> 4;
    const RATES_128 = 9;                                   // MPEG-1 L3 table
    expect(bitrateIndex).toBe(RATES_128);
    expect((out[2]! & 0x0c) >> 2).toBe(0);                 // 44100
  });

  it('comes out around the size the bitrate promises', () => {
    const rate = 44100;
    const seconds = 0.5;
    const out = encode([sine(seconds, rate)], rate, 128);
    const expected = (128000 / 8) * seconds;
    expect(out.length).toBeGreaterThan(expected * 0.8);
    expect(out.length).toBeLessThan(expected * 1.4);       // headers, padding
  });

  it('refuses a rate MP3 cannot hold instead of writing a broken file', () => {
    expect(() => mp3Job(lame, [sine(0.01, 11025)], 11025, 128)).toThrow(/resample/i);
    for (const rate of MP3_RATES) {
      expect(() => mp3Job(lame, [sine(0.01, rate)], rate, 128)).not.toThrow();
    }
  });

  it('offers bitrates people search for, not the whole table', () => {
    expect(MP3_BITRATES).toEqual([128, 192, 320]);
  });
});

describe('the words on the display', () => {
  it('formats time like a player, not like a float', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(205)).toBe('3:25');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(-3)).toBe('0:00');
  });

  it('averages the bitrate from what a buffer can actually know', () => {
    expect(averageKbps(960_000, 60)).toBe(128);
    expect(averageKbps(1000, 0)).toBe(0);
  });

  it('names the output after the input, in its new coat', () => {
    expect(outName('song.mp3', 'edit', 'wav')).toBe('song-edit.wav');
    expect(outName('a.very.long.name.flac', 'edit', 'mp3')).toBe('a.very.long.name-edit.mp3');
    expect(outName('', 'join', 'mp3')).toBe('audio-join.mp3');
  });
});

/**
 * Two small WAV files for driving the audio tool in a browser test, written
 * by the same encoder the page uses, which is itself covered by the suite.
 *
 *   npx vite-node scripts/make-audio-fixtures.ts -- <output-dir>
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from '../src/client/audiokit';

const sine = (sec: number, rate: number, hz: number, amp: number): Float32Array => {
  const out = new Float32Array(Math.round(sec * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
};

const dir = process.argv[process.argv.length - 1]!;
writeFileSync(join(dir, 'tone.wav'), encodeWav([sine(4, 44100, 440, 0.4), sine(4, 44100, 550, 0.4)], 44100));
writeFileSync(join(dir, 'blip.wav'), encodeWav([sine(1, 44100, 220, 0.2)], 44100));
console.log('fixtures written to', dir);

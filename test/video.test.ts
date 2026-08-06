/**
 * The video planner.
 *
 * The thing actually worth testing here is the copy-versus-re-encode
 * prediction. It is the page's headline claim, it is the only reason the tool
 * is faster and better than the sites people currently use, and getting it
 * wrong means promising someone a lossless cut and handing them a re-encode.
 */

import { describe, expect, it } from 'vitest';
import {
  OUTPUT_FORMATS,
  canCopyAll,
  changesPicture,
  codecName,
  cutStart,
  describeMedia,
  estimateBytes,
  explainPlan,
  findFormat,
  defaultFormatId,
  fitFor,
  fitFormat,
  formatBytes,
  formatForContainer,
  formatTime,
  gifPlanFor,
  instructionsFor,
  isWholeFile,
  judgeTarget,
  targetAlreadyMet,
  copySize,
  describeEstimate,
  bitrateForTarget,
  bitsPerPixel,
  TARGET_AUDIO_BITRATE,
  outputName,
  parseTime,
  planTrim,
  scaleTo,
  sizeChoices,
  willCopyAudio,
  willCopyVideo,
  type Encodable,
  type MediaInfo,
} from '../src/client/video';

const h264: MediaInfo = {
  format: 'MP4',
  duration: 120,
  size: 40 * 1024 * 1024,
  video: { codec: 'avc', width: 1920, height: 1080, frameRate: 30, bitrate: 2.4e6, decodable: true },
  audio: { codec: 'aac', channels: 2, sampleRate: 48000, bitrate: 128e3, decodable: true },
};

/** A phone recording: 1080p at the ~20 Mbps phones actually write. */
const phone: MediaInfo = {
  format: 'MP4',
  duration: 120,
  size: 302 * 1000 * 1000,
  video: { codec: 'avc', width: 1920, height: 1080, frameRate: 30, bitrate: 20e6, decodable: true },
  audio: { codec: 'aac', channels: 2, sampleRate: 48000, bitrate: 128e3, decodable: true },
};

/** A browser without the licensed codecs — no H.264, no AAC. Real, and common. */
const open: Encodable = { video: ['vp9', 'vp8', 'av1'], audio: ['opus', 'vorbis', 'flac', 'pcm-s16'] };
const full: Encodable = { video: ['avc', 'hevc', 'vp9', 'vp8', 'av1'], audio: ['aac', 'opus', 'mp3', 'flac', 'pcm-s16'] };

const mp4 = findFormat('mp4')!;
const webm = findFormat('webm')!;
const mkv = findFormat('mkv')!;

describe('parseTime', () => {
  it('reads the forms people actually type', () => {
    expect(parseTime('90')).toBe(90);
    expect(parseTime('1:30')).toBe(90);
    expect(parseTime('0:01:30')).toBe(90);
    expect(parseTime('1:02:03')).toBe(3723);
  });

  it('keeps fractions of a second', () => {
    expect(parseTime('1:30.25')).toBe(90.25);
  });

  it('refuses what is not a time, rather than guessing zero', () => {
    // Silently treating a typo as 0 cuts the wrong part of someone's video.
    for (const bad of ['', 'abc', '1:2:3:4', '-5', '1:', 'twelve', '1,5']) {
      expect(parseTime(bad), `${bad} should not parse`).toBeNull();
    }
  });

  it('round-trips through formatTime', () => {
    for (const seconds of [0, 7, 65, 90.2, 3723, 3600]) {
      expect(parseTime(formatTime(seconds))).toBeCloseTo(seconds, 1);
    }
  });
});

describe('formatTime', () => {
  it('leaves hours out of a short clip', () => {
    expect(formatTime(7)).toBe('0:07');
    expect(formatTime(65)).toBe('1:05');
  });

  it('shows hours when there are hours', () => {
    expect(formatTime(3723)).toBe('1:02:03');
  });

  it('carries when the tenths round up', () => {
    // 9.97 must not become "0:09.10".
    expect(formatTime(9.97)).toBe('0:10');
  });

  it('survives nonsense', () => {
    expect(formatTime(NaN)).toBe('0:00');
    expect(formatTime(-3)).toBe('0:00');
  });
});

describe('formatBytes', () => {
  it('scales the unit to the number', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  });
});

describe('describeMedia', () => {
  it('says what is in the file in one line', () => {
    const line = describeMedia(h264);
    expect(line).toContain('MP4');
    expect(line).toContain('2:00');
    expect(line).toContain('1920×1080');
    expect(line).toContain('H.264');
    expect(line).toContain('stereo');
  });

  it('handles a file with no sound', () => {
    expect(describeMedia({ ...h264, audio: null })).not.toContain('stereo');
  });
});

describe('codecName', () => {
  it('uses the name people know, not the container id', () => {
    expect(codecName('avc')).toBe('H.264');
    expect(codecName('vp9')).toBe('VP9');
  });

  it('says so when the codec is unknown rather than printing null', () => {
    expect(codecName(null)).toBe('unknown');
  });

  it('describes PCM as uncompressed', () => {
    expect(codecName('pcm-s16')).toContain('uncompressed');
  });
});

describe('formatForContainer', () => {
  it('matches the demuxer name, whatever its capitalisation', () => {
    // The name comes from the demuxer, not the extension: an .mov holding an
    // MP4 is routine, and the extension would send it to the wrong branch.
    expect(formatForContainer('MP4')?.id).toBe('mp4');
    expect(formatForContainer('WebM')?.id).toBe('webm');
    expect(formatForContainer('Matroska')?.id).toBe('mkv');
    expect(formatForContainer('QuickTime File Format')?.id).toBe('mov');
  });

  it('has nothing for a container it cannot write', () => {
    expect(formatForContainer('MPEG Transport Stream')).toBeUndefined();
  });
});

describe('defaultFormatId', () => {
  it('defaults to the file’s own container, so the default copies', () => {
    // A default that re-encodes by accident is the exact behaviour this page
    // exists to be the opposite of.
    expect(defaultFormatId(h264, full)).toBe('mp4');
  });

  it('does not default to a container it could only transcode into', () => {
    // MP4 is writable on a browser without H.264 — but only as AV1, which is a
    // re-encode. It has no claim over the general choice.
    const webmFile: MediaInfo = { ...h264, format: 'WebM', video: { ...h264.video!, codec: 'vp9' } };
    expect(defaultFormatId(webmFile, open)).toBe('webm');
  });

  it('picks something usable for a container it cannot write back', () => {
    const ts: MediaInfo = { ...h264, format: 'MPEG Transport Stream' };
    expect(defaultFormatId(ts, full)).toBe('mp4');
  });

  it('offers an audio format for a file with no picture', () => {
    const soundOnly: MediaInfo = { ...h264, format: 'MP3', video: null };
    expect(findFormat(defaultFormatId(soundOnly, full)!)?.kind).toBe('audio');
  });

  it('still offers a remux on a browser that can encode nothing at all', () => {
    // Copying needs no encoder, so with zero encoders the file's own container
    // is still writable — and that is the only thing worth offering.
    expect(defaultFormatId(h264, { video: [], audio: [] })).toBe('mp4');
  });

  it('has nothing to offer for a codec no container here can hold', () => {
    const exotic: MediaInfo = { ...h264, format: 'Matroska', video: { ...h264.video!, codec: 'theora' } };
    expect(defaultFormatId(exotic, { video: [], audio: [] })).toBeNull();
  });
});

describe('fitFormat', () => {
  it('picks the best codec the browser can actually encode', () => {
    expect(fitFormat(mp4, full).video).toBe('avc');
    expect(fitFormat(mp4, full).audio).toBe('aac');
  });

  it('falls back down the preference list on a browser without the licensed codecs', () => {
    // Chromium builds without H.264 and AAC exist and are not rare. MP4 can
    // still hold AV1 and Opus, so the format stays usable.
    const fit = fitFormat(mp4, open);
    expect(fit.usable).toBe(true);
    expect(fit.video).toBe('av1');
    expect(fit.audio).toBe('opus');
  });

  it('refuses a container it cannot fill, with a reason', () => {
    const fit = fitFormat(webm, { video: ['avc'], audio: ['aac'] });
    expect(fit.usable).toBe(false);
    expect(fit.reason).toBeTruthy();
  });

  it('still allows a video container with no encodable audio codec', () => {
    // Silent output beats no output, and the page says the sound was dropped.
    const fit = fitFormat(webm, { video: ['vp9'], audio: [] });
    expect(fit.usable).toBe(true);
    expect(fit.audio).toBeNull();
  });

  it('judges an audio-only format on its audio alone', () => {
    expect(fitFormat(findFormat('wav')!, open).usable).toBe(true);
    expect(fitFormat(findFormat('mp3')!, open).usable).toBe(false);
  });
});

describe('fitFor', () => {
  it('keeps the file’s own codec when the container can hold it, so it can copy', () => {
    // MP4 holds VP9 perfectly well. Re-encoding it to H.264 to "convert to MP4"
    // costs a generation of quality and buys nothing.
    const vp9: MediaInfo = { ...h264, format: 'WebM', video: { ...h264.video!, codec: 'vp9' }, audio: { ...h264.audio!, codec: 'opus' } };
    const fit = fitFor({ formatId: 'mp4' }, mp4, full, vp9);
    expect(fit.video).toBe('vp9');
    expect(fit.audio).toBe('opus');
    expect(willCopyVideo({ formatId: 'mp4' }, vp9, fit)).toBe(true);
  });

  it('carries a codec across that this browser cannot even encode', () => {
    // Copying packets needs no encoder and no decoder. A browser with no H.264
    // encoder can still remux an H.264 file into another container.
    const fit = fitFor({ formatId: 'mkv' }, mkv, open, h264);
    expect(fit.video).toBe('avc');
    expect(willCopyVideo({ formatId: 'mkv' }, h264, fit)).toBe(true);
  });

  it('will not keep an unencodable codec once the picture has to be re-encoded', () => {
    // Resizing means encoding, and this browser has no H.264 encoder — keeping
    // 'avc' here would fail at the encoder instead of falling back.
    const fit = fitFor({ formatId: 'mp4', maxHeight: 720 }, mp4, open, h264);
    expect(fit.video).not.toBe('avc');
    expect(open.video).toContain(fit.video!);
  });

  it('falls back for the sound too once the sound is being re-encoded', () => {
    const fit = fitFor({ formatId: 'mp4', quality: 'low' }, mp4, open, h264);
    expect(fit.audio).not.toBe('aac');
    expect(open.audio).toContain(fit.audio!);
  });
});

describe('changesPicture', () => {
  it('is false for a plain trim', () => {
    expect(changesPicture({ formatId: 'mp4', start: 10, end: 20 }, h264)).toBe(false);
  });

  it('is true for anything that alters the frames themselves', () => {
    expect(changesPicture({ formatId: 'mp4', maxHeight: 720 }, h264)).toBe(true);
    expect(changesPicture({ formatId: 'mp4', rotate: 90 }, h264)).toBe(true);
    expect(changesPicture({ formatId: 'mp4', frameRate: 24 }, h264)).toBe(true);
    expect(changesPicture({ formatId: 'mp4', quality: 'low' }, h264)).toBe(true);
  });

  it('is true for an exact mid-file cut, which is why that costs a re-encode', () => {
    expect(changesPicture({ formatId: 'mp4', start: 10, exact: true }, h264)).toBe(true);
    expect(changesPicture({ formatId: 'mp4', exact: true }, h264)).toBe(false);
  });
});

describe('planTrim', () => {
  it('clamps to the file', () => {
    const range = planTrim({ formatId: 'mp4', start: -5, end: 999 }, 120);
    expect(range.start).toBe(0);
    expect(range.end).toBe(120);
  });

  it('defaults to the whole file', () => {
    expect(planTrim({ formatId: 'mp4' }, 120)).toMatchObject({ start: 0, end: 120, duration: 120 });
  });

  it('refuses a range that ends before it starts', () => {
    expect(planTrim({ formatId: 'mp4', start: 60, end: 30 }, 120).error).toBeTruthy();
  });

  it('refuses a clip too short to be one', () => {
    expect(planTrim({ formatId: 'mp4', start: 10, end: 10.005 }, 120).error).toBeTruthy();
  });

  it('refuses a file with no duration', () => {
    expect(planTrim({ formatId: 'mp4' }, 0).error).toBeTruthy();
  });
});

describe('isWholeFile', () => {
  it('is true for an untrimmed file', () => {
    expect(isWholeFile(planTrim({ formatId: 'mp4' }, 120), 120)).toBe(true);
  });

  it('is false once either end moves', () => {
    expect(isWholeFile(planTrim({ formatId: 'mp4', start: 1 }, 120), 120)).toBe(false);
    expect(isWholeFile(planTrim({ formatId: 'mp4', end: 119 }, 120), 120)).toBe(false);
  });
});

describe('scaleTo', () => {
  it('keeps the aspect ratio', () => {
    expect(scaleTo(1920, 1080, 720)).toEqual({ width: 1280, height: 720 });
  });

  it('never scales up', () => {
    // A bigger file of exactly the same picture.
    expect(scaleTo(640, 360, 1080)).toEqual({ width: 640, height: 360 });
  });

  it('returns even dimensions, which every codec here requires', () => {
    const size = scaleTo(1001, 563, 360);
    expect(size.width % 2).toBe(0);
    expect(size.height % 2).toBe(0);
  });

  it('treats zero as "leave it alone"', () => {
    expect(scaleTo(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('willCopyVideo', () => {
  it('copies when nothing about the picture changes', () => {
    // The whole point: an MP4 trimmed to MP4 is a cut, not a re-encode.
    expect(willCopyVideo({ formatId: 'mp4', start: 10, end: 20 }, h264, fitFormat(mp4, full))).toBe(true);
  });

  it('re-encodes when an exact cut is demanded mid-file', () => {
    // Cutting precisely where asked means the first frame is not a keyframe,
    // and there is nothing to describe it against.
    expect(willCopyVideo({ formatId: 'mp4', start: 10, end: 20, exact: true }, h264, fitFormat(mp4, full))).toBe(false);
  });

  it('still copies an exact cut that starts at the beginning', () => {
    // Zero is already a keyframe, so "exact" costs nothing there.
    expect(willCopyVideo({ formatId: 'mp4', end: 20, exact: true }, h264, fitFormat(mp4, full))).toBe(true);
  });

  it('cannot copy a mid-file cut whose sound has to be re-encoded', () => {
    // The packet-copy engine encodes nothing, so a track it cannot copy has to
    // go through the converter — which re-encodes the picture too.
    const flac: MediaInfo = { ...h264, audio: { codec: 'flac', channels: 2, sampleRate: 48000, decodable: true } };
    expect(willCopyVideo({ formatId: 'mp4', start: 10, end: 20 }, flac, fitFormat(mp4, full))).toBe(false);
    // Unless the sound is being dropped anyway.
    expect(willCopyVideo({ formatId: 'mp4', start: 10, end: 20, mute: true }, flac, fitFormat(mp4, full))).toBe(true);
  });

  it('copies a cut from the very start even when the sound is re-encoded', () => {
    // mediabunny's own converter handles this: it copies the picture and
    // transcodes the audio, as long as the cut begins at zero.
    const flac: MediaInfo = { ...h264, audio: { codec: 'flac', channels: 2, sampleRate: 48000, decodable: true } };
    expect(willCopyVideo({ formatId: 'mp4', end: 20 }, flac, fitFormat(mp4, full))).toBe(true);
  });

  it('re-encodes when the codec changes', () => {
    expect(willCopyVideo({ formatId: 'webm' }, h264, fitFormat(webm, full))).toBe(false);
  });

  it('re-encodes when the size changes', () => {
    expect(willCopyVideo({ formatId: 'mp4', maxHeight: 720 }, h264, fitFormat(mp4, full))).toBe(false);
  });

  it('does not re-encode for a resize that is not one', () => {
    // Asking for 1080p when the file is already 1080p must not cost a re-encode.
    expect(willCopyVideo({ formatId: 'mp4', maxHeight: 1080 }, h264, fitFormat(mp4, full))).toBe(true);
  });

  it('re-encodes for rotation, frame rate or a quality change', () => {
    const fit = fitFormat(mp4, full);
    expect(willCopyVideo({ formatId: 'mp4', rotate: 90 }, h264, fit)).toBe(false);
    expect(willCopyVideo({ formatId: 'mp4', frameRate: 24 }, h264, fit)).toBe(false);
    expect(willCopyVideo({ formatId: 'mp4', quality: 'low' }, h264, fit)).toBe(false);
  });

  it('cannot copy on a browser that has to change the codec to write the file', () => {
    // The same MP4-to-MP4 trim that copies above re-encodes here, because this
    // browser cannot encode H.264 at all.
    expect(willCopyVideo({ formatId: 'mp4', start: 10, end: 20 }, h264, fitFormat(mp4, open))).toBe(false);
  });

  it('copies an H.264 file into Matroska, which can hold it', () => {
    expect(willCopyVideo({ formatId: 'mkv' }, h264, fitFormat(mkv, full))).toBe(true);
  });
});

describe('willCopyAudio', () => {
  it('copies matching audio', () => {
    expect(willCopyAudio({ formatId: 'mp4' }, h264, fitFormat(mp4, full))).toBe(true);
  });

  it('does not copy what is being thrown away', () => {
    expect(willCopyAudio({ formatId: 'mp4', mute: true }, h264, fitFormat(mp4, full))).toBe(false);
  });

  it('does not copy into a container that cannot hold the codec', () => {
    expect(willCopyAudio({ formatId: 'webm' }, h264, fitFormat(webm, full))).toBe(false);
  });
});

describe('estimateBytes', () => {
  it('scales a copied stream by how much of it is kept', () => {
    const whole = estimateBytes({ formatId: 'mp4' }, h264, fitFormat(mp4, full));
    const half = estimateBytes({ formatId: 'mp4', start: 0, end: 60 }, h264, fitFormat(mp4, full));
    expect(half / whole).toBeCloseTo(0.5, 1);
  });

  it('predicts a smaller file at a lower quality', () => {
    const fit = fitFormat(mp4, full);
    const low = estimateBytes({ formatId: 'mp4', quality: 'low' }, h264, fit);
    const high = estimateBytes({ formatId: 'mp4', quality: 'very-high' }, h264, fit);
    expect(low).toBeLessThan(high);
  });

  it('predicts a smaller file at a smaller size', () => {
    const fit = fitFormat(mp4, full);
    const small = estimateBytes({ formatId: 'mp4', quality: 'medium', maxHeight: 480 }, h264, fit);
    const big = estimateBytes({ formatId: 'mp4', quality: 'medium' }, h264, fit);
    expect(small).toBeLessThan(big);
  });

  it('makes audio-only far smaller than the video', () => {
    const audio = estimateBytes({ formatId: 'opus' }, h264, fitFormat(findFormat('opus')!, full));
    expect(audio).toBeLessThan(estimateBytes({ formatId: 'mp4' }, h264, fitFormat(mp4, full)) / 5);
  });

  it('makes WAV much bigger than Opus, because it is', () => {
    const wav = estimateBytes({ formatId: 'wav' }, h264, fitFormat(findFormat('wav')!, full));
    const opus = estimateBytes({ formatId: 'opus' }, h264, fitFormat(findFormat('opus')!, full));
    expect(wav).toBeGreaterThan(opus * 5);
  });

  it('returns nothing for an impossible trim rather than a negative size', () => {
    expect(estimateBytes({ formatId: 'mp4', start: 60, end: 30 }, h264, fitFormat(mp4, full))).toBe(0);
  });
});

describe('instructionsFor', () => {
  it('sends no trim when the whole file is kept', () => {
    // A pointless trim range makes mediabunny seek and re-derive timestamps for
    // no reason.
    expect(instructionsFor({ formatId: 'mp4' }, h264, fitFormat(mp4, full)).trim).toBeUndefined();
  });

  it('sends the trim when there is one', () => {
    const out = instructionsFor({ formatId: 'mp4', start: 10, end: 20 }, h264, fitFormat(mp4, full));
    expect(out.trim).toEqual({ start: 10, end: 20 });
  });

  it('omits width and height when the size is unchanged', () => {
    const out = instructionsFor({ formatId: 'mp4' }, h264, fitFormat(mp4, full));
    expect(out.video?.width).toBeUndefined();
  });

  it('sets both dimensions when resizing, and the fit they require', () => {
    // mediabunny refuses a conversion that sets both width and height without
    // a fit — measured, and it threw at init rather than picking a default.
    const out = instructionsFor({ formatId: 'mp4', maxHeight: 720 }, h264, fitFormat(mp4, full));
    expect(out.video).toMatchObject({ width: 1280, height: 720, fit: 'contain' });
  });

  it('never sets one dimension without the other', () => {
    for (const maxHeight of [0, 240, 720, 1080, 2160]) {
      const out = instructionsFor({ formatId: 'mp4', maxHeight }, h264, fitFormat(mp4, full));
      expect(Boolean(out.video?.width), `maxHeight ${maxHeight}`).toBe(Boolean(out.video?.height));
      if (out.video?.width) expect(out.video.fit, `maxHeight ${maxHeight}`).toBeTruthy();
    }
  });

  it('does not resize an anamorphic odd-dimension source when no downscale is asked', () => {
    // The re-audit case: a 16:9 480p source is 853 wide (853 = round(480*16/9)).
    // scaleTo evens that to 854, and setting width:854 forced a re-encode while
    // explainPlan promised a lossless copy. With no downscale requested the
    // engine must leave the dimensions alone so the two paths agree.
    const odd: MediaInfo = { ...h264, video: { ...h264.video!, width: 853, height: 480 } };
    const plan = { formatId: 'mp4' };
    const fit = fitFormat(mp4, full);
    // This is a copy case (avc into mp4, untouched), so the UI promises lossless.
    expect(willCopyVideo(plan, odd, fit)).toBe(true);
    expect(explainPlan(plan, odd, fit).lossless).toBe(true);
    // The engine instruction must therefore not smuggle in a resize.
    const out = instructionsFor(plan, odd, fit);
    expect(out.video?.width).toBeUndefined();
    expect(out.video?.height).toBeUndefined();
  });

  it('discards the picture for an audio-only format', () => {
    const out = instructionsFor({ formatId: 'mp3' }, h264, fitFormat(findFormat('mp3')!, full));
    expect(out.video?.discard).toBe(true);
    expect(out.audio?.codec).toBe('mp3');
  });

  it('discards the sound when muting', () => {
    expect(instructionsFor({ formatId: 'mp4', mute: true }, h264, fitFormat(mp4, full)).audio?.discard).toBe(true);
  });

  it('refuses to extract sound from a file that has none', () => {
    const silent = { ...h264, audio: null };
    expect(instructionsFor({ formatId: 'mp3' }, silent, fitFormat(findFormat('mp3')!, full)).error).toBeTruthy();
  });

  it('refuses a video output for a file with no picture', () => {
    const soundOnly: MediaInfo = { ...h264, video: null };
    expect(instructionsFor({ formatId: 'mp4' }, soundOnly, fitFormat(mp4, full)).error).toBeTruthy();
  });

  it('reports the format problem rather than producing half a plan', () => {
    const out = instructionsFor({ formatId: 'webm' }, h264, fitFormat(webm, { video: ['avc'], audio: [] }));
    expect(out.error).toBeTruthy();
    expect(out.video).toBeNull();
  });

  it('refuses an unknown format', () => {
    expect(instructionsFor({ formatId: 'nope' }, h264, fitFormat(mp4, full)).error).toBeTruthy();
  });

  it('discards audio the container cannot hold rather than failing', () => {
    const out = instructionsFor({ formatId: 'webm' }, h264, fitFormat(webm, { video: ['vp9'], audio: [] }));
    expect(out.error).toBeUndefined();
    expect(out.audio?.discard).toBe(true);
  });
});

describe('explainPlan', () => {
  it('leads with the lossless copy when that is what will happen', () => {
    const out = explainPlan({ formatId: 'mp4', start: 10, end: 20 }, h264, fitFormat(mp4, full));
    expect(out.lossless).toBe(true);
    expect(out.headline).toMatch(/copied/i);
    expect(out.notes.join(' ')).toMatch(/bit for bit/i);
  });

  it('says where a copied cut will really begin, and offers the exact one', () => {
    // The single honest cost of a copied cut. Naming it in seconds beats
    // letting someone find it in the output.
    const out = explainPlan({ formatId: 'mp4', start: 10, end: 20 }, h264, fitFormat(mp4, full), 8.5);
    expect(out.notes.join(' ')).toMatch(/keyframe/i);
    expect(out.notes.join(' ')).toContain('0:08.5');
    expect(out.offerExact).toBe(true);
  });

  it('says nothing about keyframes when the cut already lands on one', () => {
    const out = explainPlan({ formatId: 'mp4', start: 10, end: 20 }, h264, fitFormat(mp4, full), 10);
    expect(out.notes.join(' ')).not.toMatch(/keyframe/i);
    expect(out.offerExact).toBeFalsy();
  });

  it('explains that an exact cut is why it is re-encoding', () => {
    const out = explainPlan({ formatId: 'mp4', start: 10, end: 20, exact: true }, h264, fitFormat(mp4, full), 8.5);
    expect(out.lossless).toBe(false);
    expect(out.notes.join(' ')).toMatch(/exactly where you asked/i);
  });

  it('says it is re-encoding, and why', () => {
    const out = explainPlan({ formatId: 'webm' }, h264, fitFormat(webm, full));
    expect(out.lossless).toBe(false);
    expect(out.headline).toMatch(/re-encod/i);
    expect(out.notes.join(' ')).toContain('H.264');
    expect(out.notes.join(' ')).toContain('VP9');
  });

  it('is not lossless when the picture is copied but the sound is re-encoded', () => {
    // Half a copy is not a lossless conversion, and claiming otherwise is the
    // exact overstatement this page exists to avoid.
    const flac: MediaInfo = { ...h264, audio: { codec: 'flac', channels: 2, sampleRate: 48000, decodable: true } };
    const out = explainPlan({ formatId: 'mp4' }, flac, fitFormat(mp4, full));
    expect(willCopyVideo({ formatId: 'mp4' }, flac, fitFormat(mp4, full))).toBe(true);
    expect(out.lossless).toBe(false);
  });

  it('is lossless when the picture is copied and the sound deliberately dropped', () => {
    const out = explainPlan({ formatId: 'mp4', mute: true }, h264, fitFormat(mp4, full));
    expect(out.lossless).toBe(true);
  });

  it('only says a lossless track becomes lossy when the source actually was lossless', () => {
    // FLAC copied-video-re-encoded-audio: the "becomes lossy" phrasing is true.
    const flac: MediaInfo = { ...h264, audio: { codec: 'flac', channels: 2, sampleRate: 48000, decodable: true } };
    const flacOut = explainPlan({ formatId: 'mp4' }, flac, fitFormat(mp4, full));
    expect(flacOut.notes.join(' ')).toMatch(/lossless audio track becomes lossy/i);

    // MP3 (already lossy) re-encoded to Opus for WebM while VP9 video copies:
    // the note must not claim a lossless track is being degraded.
    const vp9mp3: MediaInfo = {
      ...h264,
      format: 'Matroska',
      video: { ...h264.video!, codec: 'vp9' },
      audio: { codec: 'mp3', channels: 2, sampleRate: 48000, bitrate: 128e3, decodable: true },
    };
    const mp3Out = explainPlan({ formatId: 'webm' }, vp9mp3, fitFormat(webm, full));
    expect(willCopyVideo({ formatId: 'webm' }, vp9mp3, fitFormat(webm, full))).toBe(true);
    expect(mp3Out.notes.join(' ')).toMatch(/sound is re-encoded/i);
    expect(mp3Out.notes.join(' ')).not.toMatch(/lossless audio track becomes lossy/i);
  });

  it('warns when the output will be silent because the browser cannot encode audio', () => {
    const out = explainPlan({ formatId: 'webm' }, h264, fitFormat(webm, { video: ['vp9'], audio: [] }));
    expect(out.notes.join(' ')).toMatch(/silent/i);
  });

  it('explains an audio extraction', () => {
    const out = explainPlan({ formatId: 'mp3' }, h264, fitFormat(findFormat('mp3')!, full));
    expect(out.notes.join(' ')).toMatch(/picture is dropped/i);
  });

  it('says how much is being kept', () => {
    const out = explainPlan({ formatId: 'mp4', start: 30, end: 60 }, h264, fitFormat(mp4, full));
    expect(out.notes.join(' ')).toContain('0:30');
  });

  it('reports a bad trim instead of a plan', () => {
    expect(explainPlan({ formatId: 'mp4', start: 60, end: 30 }, h264, fitFormat(mp4, full)).lossless).toBe(false);
  });
});

describe('cutStart', () => {
  it('reports the keyframe as the real start, and the drift', () => {
    expect(cutStart({ formatId: 'mp4', start: 10 }, 8.5)).toEqual({ at: 8.5, drift: 1.5 });
  });

  it('has no drift when the start is already a keyframe', () => {
    expect(cutStart({ formatId: 'mp4', start: 10 }, 10)).toEqual({ at: 10, drift: 0 });
  });

  it('leaves the start alone when no keyframe is known', () => {
    expect(cutStart({ formatId: 'mp4', start: 10 }, null)).toEqual({ at: 10, drift: 0 });
  });

  it('ignores a keyframe that is somehow after the start', () => {
    expect(cutStart({ formatId: 'mp4', start: 10 }, 12)).toEqual({ at: 10, drift: 0 });
  });
});

describe('canCopyAll', () => {
  it('is true when every kept track comes through untouched', () => {
    expect(canCopyAll({ formatId: 'mp4' }, h264, fitFormat(mp4, full))).toBe(true);
  });

  it('is false when an exact cut is demanded mid-file', () => {
    expect(canCopyAll({ formatId: 'mp4', start: 10, exact: true }, h264, fitFormat(mp4, full))).toBe(false);
  });

  it('is unaffected by "exact" on a cut that starts at zero', () => {
    // Zero is already a keyframe, so there is nothing for exactness to cost.
    expect(canCopyAll({ formatId: 'mp4', exact: true }, h264, fitFormat(mp4, full))).toBe(true);
  });

  it('is false when the sound would have to be re-encoded', () => {
    expect(canCopyAll({ formatId: 'webm' }, h264, fitFormat(webm, full))).toBe(false);
  });

  it('handles an audio-only output on its audio alone', () => {
    expect(canCopyAll({ formatId: 'mp3' }, h264, fitFormat(findFormat('mp3')!, full))).toBe(false);
    const mp3In: MediaInfo = { ...h264, audio: { ...h264.audio!, codec: 'mp3' } };
    expect(canCopyAll({ formatId: 'mp3' }, mp3In, fitFormat(findFormat('mp3')!, full))).toBe(true);
  });
});

describe('bitrateForTarget', () => {
  it('is a size divided by a duration, less the sound', () => {
    // 10 MB over 100s with no audio is about 800 kbps, minus muxing overhead.
    const rate = bitrateForTarget(10 * 1024 * 1024, 100, 0);
    expect(rate).toBeGreaterThan(760e3);
    expect(rate).toBeLessThan(840e3);
  });

  it('spends the sound first, because it is spent either way', () => {
    const withSound = bitrateForTarget(10 * 1024 * 1024, 100, 96e3);
    const without = bitrateForTarget(10 * 1024 * 1024, 100, 0);
    expect(without - withSound).toBeCloseTo(96e3, -3);
  });

  it('never goes negative when the sound alone overruns the target', () => {
    expect(bitrateForTarget(1000, 600, 128e3)).toBe(0);
  });

  it('is nothing for a nonsense target', () => {
    expect(bitrateForTarget(0, 100, 0)).toBe(0);
    expect(bitrateForTarget(1e6, 0, 0)).toBe(0);
  });
});

describe('bitsPerPixel', () => {
  it('normalises for resolution, which is the whole point', () => {
    // The same bitrate is generous at 480p and hopeless at 4K.
    const small = bitsPerPixel(2e6, 854, 480, 30);
    const large = bitsPerPixel(2e6, 3840, 2160, 30);
    expect(small).toBeGreaterThan(large * 15);
  });

  it('normalises for frame rate too', () => {
    expect(bitsPerPixel(2e6, 1920, 1080, 30)).toBeCloseTo(bitsPerPixel(2e6, 1920, 1080, 60) * 2, 6);
  });
});

describe('judgeTarget', () => {
  const fit = fitFormat(mp4, full);

  it('says nothing when no target is set', () => {
    expect(judgeTarget({ formatId: 'mp4' }, h264, fit)).toBeNull();
  });

  it('says a limit the file already meets needs nothing done', () => {
    expect(judgeTarget({ formatId: 'mp4', targetBytes: 200 * 1024 * 1024 }, h264, fit)?.verdict).toBe('already');
  });

  it('is happy with a target that is smaller but still generous', () => {
    // Squeezing a phone's 20 Mbps down to 5 Mbps is what a streaming service
    // gives 1080p, and looks it.
    expect(judgeTarget({ formatId: 'mp4', targetBytes: 75 * 1024 * 1024 }, phone, fit)!.verdict).toBe('good');
  });

  it('rates an ordinary 1080p bitrate as fair rather than poor', () => {
    // ~2.2 Mbps at 1080p is compressed but perfectly watchable; calling that
    // "poor" would make the whole judgement useless.
    expect(judgeTarget({ formatId: 'mp4', targetBytes: 34 * 1024 * 1024 }, phone, fit)!.verdict).toBe('fair');
  });

  it('calls a hopeless target what it is, and says to drop the resolution', () => {
    // 8 MB of 1080p over two minutes is a smeared mess, and every converter
    // that accepts it without comment wastes someone's afternoon.
    const judged = judgeTarget({ formatId: 'mp4', targetBytes: 8 * 1024 * 1024 }, phone, fit)!;
    expect(judged.verdict).toBe('poor');
    expect(judged.suggestHeight).toBeGreaterThan(0);
    expect(judged.suggestHeight).toBeLessThan(1080);
    expect(judged.advice).toMatch(/sharp/i);
  });

  it('suggests a height that actually fixes it', () => {
    const plan = { formatId: 'mp4', targetBytes: 8 * 1024 * 1024 };
    const judged = judgeTarget(plan, phone, fit)!;
    const fixed = judgeTarget({ ...plan, maxHeight: judged.suggestHeight }, phone, fit)!;
    expect(fixed.verdict).toBe('good');
  });

  it('refuses a target the sound alone would overrun', () => {
    const judged = judgeTarget({ formatId: 'mp4', targetBytes: 100 * 1024 }, phone, fit)!;
    expect(judged.verdict).toBe('impossible');
    expect(judged.advice).toMatch(/sound/i);
  });

  it('blames the length, not the sound, when the sound is already off', () => {
    const judged = judgeTarget({ formatId: 'mp4', targetBytes: 100 * 1024, mute: true }, phone, fit)!;
    expect(judged.verdict).toBe('impossible');
    expect(judged.advice).not.toMatch(/sound/i);
  });

  it('credits a newer codec with needing fewer bits', () => {
    // The same target is a better picture in AV1 than in H.264.
    const av1Fit = fitFormat(mp4, { video: ['av1'], audio: ['opus'] });
    const plan = { formatId: 'mp4', targetBytes: 20 * 1024 * 1024 };
    expect(judgeTarget(plan, phone, av1Fit)!.bpp).toBeGreaterThan(judgeTarget(plan, phone, fit)!.bpp);
  });

  it('scales with how much of the file is kept', () => {
    // The same target over ten seconds instead of two minutes is luxurious.
    const whole = judgeTarget({ formatId: 'mp4', targetBytes: 8 * 1024 * 1024 }, phone, fit)!;
    const clip = judgeTarget({ formatId: 'mp4', targetBytes: 8 * 1024 * 1024, start: 0, end: 30 }, phone, fit)!;
    // A quarter of the length, so roughly four times the bitrate to spend.
    expect(clip.bitrate).toBeGreaterThan(whole.bitrate * 4);
  });
});

describe('a size limit that is already met', () => {
  const fit = fitFormat(mp4, full);
  // 40 MB of H.264; asking it to fit under 100 MB is asking for nothing.
  const roomy = { formatId: 'mp4', targetBytes: 100 * 1024 * 1024 };

  it('leaves the file alone rather than inflating it to fill the limit', () => {
    // "Fit under 25 MB" must never make a 3 MB file bigger. A limit is a
    // ceiling, not a goal.
    expect(targetAlreadyMet(roomy, h264)).toBe(true);
    expect(changesPicture(roomy, h264)).toBe(false);
    expect(willCopyVideo(roomy, h264, fit)).toBe(true);
  });

  it('estimates the copy, not the limit', () => {
    expect(estimateBytes(roomy, h264, fit)).toBeLessThan(roomy.targetBytes);
  });

  it('gives the encoder no bitrate, because there is no encoder', () => {
    const out = instructionsFor(roomy, h264, fit);
    expect(out.video?.bitrate).toBeUndefined();
    expect(out.audio?.bitrate).toBeUndefined();
  });

  it('says so rather than staying silent', () => {
    const out = explainPlan(roomy, h264, fit);
    expect(out.lossless).toBe(true);
    expect(out.notes.join(' ')).toMatch(/already fits/i);
  });

  it('notices once a trim makes a too-small limit reachable', () => {
    const tight = { formatId: 'mp4', targetBytes: 4 * 1024 * 1024 };
    expect(targetAlreadyMet(tight, h264)).toBe(false);
    // Ten seconds of the same file is well under it.
    expect(targetAlreadyMet({ ...tight, start: 0, end: 10 }, h264)).toBe(true);
  });
});

describe('copySize', () => {
  it('uses the measured bitrates when the file gave them up', () => {
    // 2.4 Mbps video + 128 kbps audio over 120s.
    expect(copySize({ formatId: 'mp4' }, h264)).toBeCloseTo(((2.4e6 + 128e3) * 120) / 8, -4);
  });

  it('drops the sound from the sum when the sound is being dropped', () => {
    expect(copySize({ formatId: 'mp4', mute: true }, h264)).toBeLessThan(copySize({ formatId: 'mp4' }, h264));
  });

  it('falls back to a share of the file when no bitrate is known', () => {
    const blind: MediaInfo = { ...h264, video: { ...h264.video!, bitrate: undefined }, audio: { ...h264.audio!, bitrate: undefined } };
    expect(copySize({ formatId: 'mp4', start: 0, end: 60 }, blind)).toBeCloseTo(blind.size / 2, -4);
  });
});

describe('describeEstimate', () => {
  const fit = fitFormat(mp4, full);

  it('calls a target a ceiling, because that is what it is', () => {
    expect(describeEstimate({ formatId: 'mp4', targetBytes: 8 * 1024 * 1024 }, h264, fit)).toMatch(/^at most/);
  });

  it('calls a GIF figure a ceiling, since differencing only ever subtracts', () => {
    expect(describeEstimate({ formatId: 'gif', start: 0, end: 2 }, h264, fitFormat(findFormat('gif')!, full)))
      .toMatch(/^up to/);
  });

  it('calls everything else an estimate', () => {
    expect(describeEstimate({ formatId: 'mp4' }, h264, fit)).toMatch(/^roughly/);
    expect(describeEstimate({ formatId: 'mp4' }, h264, fit)).toMatch(/not a promise/);
  });

  it('calls a met target an estimate too, since nothing is being aimed at', () => {
    expect(describeEstimate({ formatId: 'mp4', targetBytes: 999 * 1024 * 1024 }, h264, fit)).toMatch(/^roughly/);
  });
});

describe('fitting a size, end to end', () => {
  const fit = fitFormat(mp4, full);

  it('aims at the target rather than estimating around it', () => {
    const target = 20 * 1024 * 1024;
    expect(estimateBytes({ formatId: 'mp4', targetBytes: target }, phone, fit)).toBe(target);
  });

  it('gives the encoder an explicit budget for both tracks', () => {
    const out = instructionsFor({ formatId: 'mp4', targetBytes: 20 * 1024 * 1024 }, phone, fit);
    expect(out.video?.bitrate).toBeGreaterThan(0);
    expect(out.audio?.bitrate).toBe(TARGET_AUDIO_BITRATE);
  });

  it('refuses an impossible target instead of producing a plan', () => {
    const out = instructionsFor({ formatId: 'mp4', targetBytes: 100 * 1024 }, phone, fit);
    expect(out.error).toBeTruthy();
    expect(out.video).toBeNull();
  });

  it('is never a copy, because shrinking means re-encoding', () => {
    expect(willCopyVideo({ formatId: 'mp4', targetBytes: 20 * 1024 * 1024 }, phone, fit)).toBe(false);
    expect(changesPicture({ formatId: 'mp4', targetBytes: 20 * 1024 * 1024 }, phone)).toBe(true);
  });

  it('says the target is why it is re-encoding, and how many kbps that is', () => {
    const out = explainPlan({ formatId: 'mp4', targetBytes: 20 * 1024 * 1024 }, phone, fit);
    expect(out.notes.join(' ')).toMatch(/fitting 20\.0 MB/i);
    expect(out.notes.join(' ')).toMatch(/kbps/);
  });
});

describe('GIF as an output', () => {
  const gif = findFormat('gif')!;
  const fit = fitFormat(gif, full);

  it('needs no encoder, because it has no codecs', () => {
    // Even a browser that can encode nothing at all can write a GIF.
    expect(fitFormat(gif, { video: [], audio: [] }).usable).toBe(true);
  });

  it('always redraws — nothing can ever be copied into a GIF', () => {
    expect(changesPicture({ formatId: 'gif' }, h264)).toBe(true);
    expect(willCopyVideo({ formatId: 'gif' }, h264, fit)).toBe(false);
  });

  it('refuses a source this browser cannot decode, and says why', () => {
    // Copying needs no decoder; redrawing every frame does.
    const opaque: MediaInfo = { ...h264, video: { ...h264.video!, decodable: false } };
    const out = instructionsFor({ formatId: 'gif' }, opaque, fit);
    expect(out.error).toMatch(/decode/i);
  });

  it('refuses a file with no picture', () => {
    expect(instructionsFor({ formatId: 'gif' }, { ...h264, video: null }, fit).error).toBeTruthy();
  });

  it('routes to the GIF engine, carrying the trim', () => {
    const out = instructionsFor({ formatId: 'gif', start: 5, end: 8 }, h264, fit);
    expect(out.mode).toBe('gif');
    expect(out.trim).toEqual({ start: 5, end: 8 });
  });

  it('estimates from the frame count and size, not the video bitrate', () => {
    const short = estimateBytes({ formatId: 'gif', start: 0, end: 2, maxHeight: 240 }, h264, fit);
    const long = estimateBytes({ formatId: 'gif', start: 0, end: 8, maxHeight: 240 }, h264, fit);
    const big = estimateBytes({ formatId: 'gif', start: 0, end: 2 }, h264, fit);
    expect(long).toBeGreaterThan(short);
    expect(big).toBeGreaterThan(short);
  });

  it('says there is no sound and no copying', () => {
    const out = explainPlan({ formatId: 'gif', start: 0, end: 3 }, h264, fit);
    expect(out.lossless).toBe(false);
    expect(out.headline).toMatch(/GIF/);
    expect(out.notes.join(' ')).toMatch(/no sound/i);
    expect(out.notes.join(' ')).toMatch(/256 colours/i);
  });

  it('warns before someone waits five minutes for a quarter of a gigabyte', () => {
    const out = explainPlan({ formatId: 'gif', start: 0, end: 60 }, h264, fit);
    expect(out.notes.join(' ')).toMatch(/shorten|enormous|big for a gif|extra steps/i);
  });

  it('plans fewer frames at a lower rate', () => {
    const slow = gifPlanFor({ formatId: 'gif', start: 0, end: 4, gifFps: 5 }, h264)!;
    const fast = gifPlanFor({ formatId: 'gif', start: 0, end: 4, gifFps: 20 }, h264)!;
    expect(slow.frames).toBe(20);
    expect(fast.frames).toBe(80);
    expect(fast.bytes).toBeGreaterThan(slow.bytes);
  });

  it('follows the size control', () => {
    expect(gifPlanFor({ formatId: 'gif', maxHeight: 240 }, h264)!.height).toBe(240);
  });
});

describe('outputName', () => {
  it('keeps the name and swaps the extension', () => {
    expect(outputName('holiday.mov', mp4, false)).toBe('holiday-converted.mp4');
  });

  it('marks a trimmed file as a clip', () => {
    expect(outputName('holiday.mov', mp4, true)).toBe('holiday-clip.mp4');
  });

  it('marks an extraction as audio', () => {
    expect(outputName('lecture.mp4', findFormat('mp3')!, false)).toBe('lecture-audio.mp3');
  });

  it('copes with a name that has no extension', () => {
    expect(outputName('video', mp4, false)).toBe('video-converted.mp4');
  });

  it('does not eat a dot in the middle of a name', () => {
    expect(outputName('2026.01.03 party.mp4', mp4, true)).toBe('2026.01.03 party-clip.mp4');
  });
});

describe('sizeChoices', () => {
  it('offers only sizes smaller than the source', () => {
    const heights = sizeChoices(720).map((c) => c.height);
    expect(heights).toContain(480);
    expect(heights).not.toContain(1080);
  });

  it('always offers the original', () => {
    expect(sizeChoices(240)[0]).toMatchObject({ height: 0 });
  });
});

describe('OUTPUT_FORMATS', () => {
  it('gives every format a unique id and an extension', () => {
    const ids = OUTPUT_FORMATS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const format of OUTPUT_FORMATS) {
      expect(format.extension, format.id).toMatch(/^[a-z0-9]+$/);
      expect(format.note.length, format.id).toBeGreaterThan(10);
    }
  });

  it('lists codecs only for the kinds of output that have them', () => {
    for (const format of OUTPUT_FORMATS) {
      expect(format.video.length > 0, format.id).toBe(format.kind === 'video');
      // GIF has neither: it is drawn pixel by pixel and carries no sound.
      expect(format.audio.length > 0, format.id).toBe(format.kind !== 'gif');
    }
  });

  it('never lands on GIF by default', () => {
    // Twenty times the size of the same clip as video; nobody means to make one
    // by accident.
    for (const encodable of [full, open, { video: [], audio: [] }]) {
      expect(defaultFormatId(h264, encodable)).not.toBe('gif');
    }
  });
});

describe('audio re-encode honesty (finding: MKV H.264+FLAC -> MP4)', () => {
  const flacInMkv: MediaInfo = {
    format: 'Matroska',
    duration: 60,
    size: 50 * 1024 * 1024,
    video: { codec: 'avc', width: 1920, height: 1080, frameRate: 30, bitrate: 5e6, decodable: true },
    audio: { codec: 'flac', channels: 2, sampleRate: 48000, bitrate: 900e3, decodable: true },
  };

  it('does not claim "no quality is lost" when the FLAC track is re-encoded to AAC', () => {
    const plan = { formatId: 'mp4' };
    const fit = fitFor(plan, mp4, full, flacInMkv);
    const explained = explainPlan(plan, flacInMkv, fit);
    expect(explained.lossless).toBe(false);
    expect(explained.headline).not.toMatch(/no quality is lost/i);
    expect(explained.headline).toMatch(/sound re-encoded/i);
    expect(explained.notes.join(' ')).toMatch(/sound is re-encoded/i);
  });

  it('still calls a true copy lossless', () => {
    const plan = { formatId: 'mkv' };
    const fit = fitFor(plan, mkv, full, h264);
    const explained = explainPlan(plan, h264, fit);
    expect(explained.lossless).toBe(true);
    expect(explained.headline).toMatch(/no quality is lost/i);
  });
});

describe('odd anamorphic dimensions do not defeat the copy path', () => {
  const anamorphic: MediaInfo = {
    format: 'MP4',
    duration: 30,
    size: 10 * 1024 * 1024,
    // Display width 873 (odd): NTSC 16:9 anamorphic.
    video: { codec: 'avc', width: 873, height: 480, frameRate: 30, bitrate: 3e6, decodable: true },
    audio: { codec: 'aac', channels: 2, sampleRate: 48000, bitrate: 128e3, decodable: true },
  };

  it('reports no picture change for a plain container move', () => {
    expect(changesPicture({ formatId: 'mkv' }, anamorphic)).toBe(false);
  });

  it('reports no picture change for a start trim at original size', () => {
    expect(changesPicture({ formatId: 'mp4', start: 5, end: 20 }, anamorphic)).toBe(false);
  });

  it('offers the lossless copy despite the odd width', () => {
    const plan = { formatId: 'mkv' };
    const fit = fitFor(plan, mkv, full, anamorphic);
    expect(willCopyVideo(plan, anamorphic, fit)).toBe(true);
  });

  it('still re-encodes when an actual downscale is requested', () => {
    expect(changesPicture({ formatId: 'mp4', maxHeight: 360 }, anamorphic)).toBe(true);
  });
});

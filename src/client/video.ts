/**
 * Video: trim, convert, shrink and extract audio, in the tab.
 *
 * This is the part of the video tool with no DOM and no mediabunny in it, so it
 * can be unit tested. The page loads mediabunny from /vendor and hands the
 * facts about the opened file in here as plain objects; what comes back is a
 * plan — which codecs, which size, which time range — that the page turns into
 * mediabunny's own option objects.
 *
 * Two things are worth understanding before reading the rest.
 *
 * **The browser has the codecs, but not the files.** WebCodecs will decode and
 * encode frames, and has done since 2021. What it will not do is read an MP4 or
 * write one: everything between the codec and the file — the boxes, the sample
 * tables, the timescales — is missing, and that is most of the work. mediabunny
 * supplies exactly that half, which is why this tool exists at all and why it
 * needs no ffmpeg, no WebAssembly and no server.
 *
 * **A trim does not have to re-encode.** If the output codec matches the input
 * and nothing about the picture is being changed, the encoded packets can be
 * copied across into the new container untouched. That is bit-for-bit the
 * original video, cut, in a few seconds — not a generation-loss re-encode. Half
 * the honesty of this tool is saying clearly which of the two is about to
 * happen, because every other site quietly re-encodes everything.
 *
 * Which codecs are available is a property of the browser, not of this code, so
 * nothing here is hardcoded to "MP4 works". A Chromium build without the
 * patent-encumbered codecs can encode VP9, Opus and AV1 and nothing else, and
 * the page has to offer what the browser actually has rather than fail at the
 * end of a long conversion.
 */

import { GIF_RATES, planGif, type GifPlan } from './gif';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Parse a timestamp the way a person would type one.
 *
 * `90`, `1:30`, `0:01:30`, `1:30.25` all mean the same thing. Returns null for
 * anything that is not a time, so the caller can say so rather than silently
 * treating a typo as zero and cutting the wrong part of someone's video.
 */
export function parseTime(text: string): number | null {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(clean)) return null;

  const parts = clean.split(':');
  if (parts.length > 3) return null;
  // Only the last part may carry a fraction; the earlier ones are whole units.
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + Number(part);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Seconds as a timestamp.
 *
 * Hours appear only when there are hours, because `0:00:07` for a seven second
 * clip reads like a bug. Tenths appear only when the value has them.
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const tenths = Math.round((seconds - whole) * 10);
  // Rounding up to a whole second must carry, or 9.97 formats as "0:09.10".
  const total = tenths === 10 ? whole + 1 : whole;
  const frac = tenths === 10 ? '' : tenths ? `.${tenths}` : '';

  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}${frac}`;
}

/** A file size a person can read. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// What is in the file
// ---------------------------------------------------------------------------

export interface VideoTrackInfo {
  codec: string | null;
  width: number;
  height: number;
  /** Frames per second, where the container admits to one. */
  frameRate?: number;
  /** Bits per second, measured over a sample of packets. */
  bitrate?: number;
  /** Whether this browser can decode it. Measured, not assumed. */
  decodable: boolean;
  /** Rotation the container asks players to apply. */
  rotation?: number;
}

export interface AudioTrackInfo {
  codec: string | null;
  channels: number;
  sampleRate: number;
  bitrate?: number;
  decodable: boolean;
}

export interface MediaInfo {
  /** Container name, as the demuxer identified it — not from the extension. */
  format: string;
  duration: number;
  size: number;
  video: VideoTrackInfo | null;
  audio: AudioTrackInfo | null;
}

/** Codec ids as the containers spell them, in words a person recognises. */
const CODEC_NAMES: Record<string, string> = {
  avc: 'H.264',
  hevc: 'H.265 / HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  prores: 'ProRes',
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  ac3: 'Dolby Digital',
  eac3: 'Dolby Digital Plus',
};

export function codecName(codec: string | null | undefined): string {
  if (!codec) return 'unknown';
  if (CODEC_NAMES[codec]) return CODEC_NAMES[codec]!;
  return codec.startsWith('pcm-') ? `uncompressed (${codec.slice(4)})` : codec;
}

/**
 * Whether an audio codec keeps every bit of the original.
 *
 * Only these lose nothing: FLAC and ALAC (lossless compression) and any PCM
 * (uncompressed). Re-encoding one of these to AAC/Opus/MP3 genuinely discards
 * quality. Re-encoding an already-lossy source (MP3 to AAC) also loses quality,
 * but it was never lossless to begin with, so the "a lossless track becomes
 * lossy" phrasing would be a false claim about the input.
 */
export function isLosslessAudio(codec: string | null | undefined): boolean {
  if (!codec) return false;
  return codec === 'flac' || codec === 'alac' || codec.startsWith('pcm-') || codec.startsWith('pcm');
}

/** One line describing what was opened, for the page to print. */
export function describeMedia(info: MediaInfo): string {
  const parts = [info.format, formatTime(info.duration), formatBytes(info.size)];
  if (info.video) {
    const fps = info.video.frameRate ? `, ${Math.round(info.video.frameRate)} fps` : '';
    parts.push(`${info.video.width}×${info.video.height} ${codecName(info.video.codec)}${fps}`);
  }
  if (info.audio) {
    const ch = info.audio.channels === 1 ? 'mono' : info.audio.channels === 2 ? 'stereo' : `${info.audio.channels}ch`;
    parts.push(`${codecName(info.audio.codec)} ${ch}`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Output formats
// ---------------------------------------------------------------------------

export type VideoCodecId = 'avc' | 'hevc' | 'vp9' | 'vp8' | 'av1';
export type AudioCodecId = 'aac' | 'opus' | 'mp3' | 'vorbis' | 'flac' | 'pcm-s16';

export interface OutputFormat {
  id: string;
  label: string;
  extension: string;
  /**
   * What sort of output this is.
   *
   * 'gif' is its own thing rather than a video container: it has no codecs, no
   * sound, and nothing can ever be copied into it — every frame is decoded and
   * redrawn from scratch.
   */
  kind: 'video' | 'audio' | 'gif';
  /**
   * Codecs this container can hold, best first. "Best" means most likely to
   * play on a phone someone hands to their mother, not most efficient.
   */
  video: VideoCodecId[];
  audio: AudioCodecId[];
  /** Shown next to the option, so the choice is informed rather than a guess. */
  note: string;
}

export const OUTPUT_FORMATS: OutputFormat[] = [
  {
    id: 'mp4',
    label: 'MP4',
    extension: 'mp4',
    kind: 'video',
    video: ['avc', 'hevc', 'av1', 'vp9'],
    audio: ['aac', 'opus', 'mp3'],
    note: 'Plays on everything. The one to pick unless you have a reason.',
  },
  {
    id: 'webm',
    label: 'WebM',
    extension: 'webm',
    kind: 'video',
    video: ['vp9', 'av1', 'vp8'],
    audio: ['opus', 'vorbis'],
    note: 'Smaller for the same quality, and every browser plays it. Some TVs and older phones do not.',
  },
  {
    id: 'mkv',
    label: 'Matroska (.mkv)',
    extension: 'mkv',
    kind: 'video',
    video: ['avc', 'hevc', 'vp9', 'av1', 'vp8'],
    audio: ['aac', 'opus', 'flac', 'vorbis', 'mp3'],
    note: 'Holds any codec, which makes it the best chance of a copy rather than a re-encode.',
  },
  {
    id: 'mov',
    label: 'QuickTime (.mov)',
    extension: 'mov',
    kind: 'video',
    video: ['avc', 'hevc', 'av1', 'vp9'],
    audio: ['aac', 'opus', 'pcm-s16'],
    note: 'What Apple software expects.',
  },
  {
    id: 'gif',
    label: 'Animated GIF',
    extension: 'gif',
    kind: 'gif',
    video: [],
    audio: [],
    note: 'Plays anywhere, silently, and is enormous. For a short loop, not a video.',
  },
  {
    id: 'mp3',
    label: 'MP3 (audio only)',
    extension: 'mp3',
    kind: 'audio',
    video: [],
    audio: ['mp3'],
    note: 'Sound only. Universally playable, and the format people mean by "the audio".',
  },
  {
    id: 'opus',
    label: 'Opus in Ogg (audio only)',
    extension: 'ogg',
    kind: 'audio',
    video: [],
    audio: ['opus', 'vorbis', 'flac'],
    note: 'Sound only, and much better than MP3 at the same size.',
  },
  {
    id: 'wav',
    label: 'WAV (audio only)',
    extension: 'wav',
    kind: 'audio',
    video: [],
    audio: ['pcm-s16'],
    note: 'Sound only, uncompressed. Large, and what audio editors want.',
  },
];

export function findFormat(id: string): OutputFormat | undefined {
  return OUTPUT_FORMATS.find((f) => f.id === id);
}

/**
 * The output format matching the container the file already uses.
 *
 * Matched from the demuxer's own name for the container rather than from the
 * file extension, because the extension is a guess and the demuxer is not — an
 * .mp4 holding Matroska is rare but a .mov holding MP4 is routine.
 */
const CONTAINERS: Record<string, string> = {
  mp4: 'mp4',
  webm: 'webm',
  matroska: 'mkv',
  'quicktime file format': 'mov',
  mp3: 'mp3',
  ogg: 'opus',
  wave: 'wav',
};

export function formatForContainer(containerName: string): OutputFormat | undefined {
  const id = CONTAINERS[String(containerName ?? '').toLowerCase()];
  return id ? findFormat(id) : undefined;
}

/** What this browser turned out to be able to encode. Measured by the page. */
export interface Encodable {
  video: string[];
  audio: string[];
}

/**
 * Whether a format can be produced at all here, and with what.
 *
 * A container the browser cannot fill is not offered. Chromium builds without
 * the licensed codecs cannot encode H.264 or AAC, which rules out MP4 entirely
 * on those builds — better to grey it out with a reason than to fail after
 * someone has waited three minutes.
 */
export interface FormatFit {
  usable: boolean;
  video: VideoCodecId | null;
  audio: AudioCodecId | null;
  reason?: string;
}

export interface FitOptions {
  /** The file being converted, whose codecs are preferred where they can be. */
  source?: MediaInfo;
  /** The picture is being changed, so it must be re-encoded. */
  encodingVideo?: boolean;
  /** The sound is being changed, so it must be re-encoded. */
  encodingAudio?: boolean;
}

export function fitFormat(format: OutputFormat, encodable: Encodable, options: FitOptions = {}): FormatFit {
  /* The codec the file already uses comes first when the container can hold it,
   * ahead of whatever this list calls "best".
   *
   * That single rule turns "convert this WebM to MP4" from a full transcode
   * into a remux: MP4 can hold VP9 perfectly well, so there is nothing to gain
   * from re-encoding it to H.264 and a generation of quality to lose. It also
   * means a codec this browser cannot encode at all can still come through —
   * copying packets needs no encoder, and no decoder either.
   */
  const first = <T extends string>(wanted: T[], have: string[], own: string | null | undefined): T | null => {
    // Only when the track is coming through untouched: a codec that is about to
    // be re-encoded has to be one this browser can actually encode, and
    // preferring an unencodable one there would fail at the encoder instead.
    if (own && wanted.includes(own as T)) return own as T;
    return wanted.find((c) => have.includes(c)) ?? null;
  };

  const { source } = options;
  const video = first(
    format.video,
    encodable.video,
    options.encodingVideo ? null : source?.video?.codec,
  ) as VideoCodecId | null;
  const audio = first(
    format.audio,
    encodable.audio,
    options.encodingAudio ? null : source?.audio?.codec,
  ) as AudioCodecId | null;

  if (format.kind === 'gif') {
    // GIF is written by hand here, pixel by pixel — there is no codec to ask
    // the browser for. What it does need is to be able to *decode* the source,
    // which is checked where the file is known.
    return { usable: true, video: null, audio: null };
  }
  if (format.kind === 'audio') {
    return audio
      ? { usable: true, video: null, audio }
      : { usable: false, video: null, audio: null, reason: `this browser cannot encode ${format.label} audio` };
  }
  // A video container with no encodable picture codec is no use, but one with
  // no encodable audio codec still is — silent output beats no output, and the
  // page says so.
  return video
    ? { usable: true, video, audio }
    : { usable: false, video: null, audio: null, reason: `this browser cannot encode any codec ${format.label} can hold` };
}

/**
 * Which format to select before anyone has chosen one.
 *
 * The file's own container, when this browser can write it — because that is
 * the choice that copies the video instead of re-encoding it, and a default
 * that quietly costs a generation of quality is the behaviour this page exists
 * to be the opposite of. Falling back to the first format that works at all.
 */
export function defaultFormatId(info: MediaInfo, encodable: Encodable): string | null {
  const wantsVideo = Boolean(info.video);
  // GIF is never a default: nobody opens a video converter meaning to make one
  // by accident, and it is twenty times the size of the same clip as video.
  const usable = OUTPUT_FORMATS.filter(
    (f) => f.kind === (wantsVideo ? 'video' : 'audio') && fitFormat(f, encodable, { source: info }).usable,
  );

  const own = formatForContainer(info.format);
  if (own && usable.includes(own)) {
    const fit = fitFormat(own, encodable, { source: info });
    // Only worth defaulting to if it actually copies; a container we can write
    // but only by transcoding has no claim over the general-purpose choice.
    if (!info.video || fit.video === info.video.codec) return own.id;
  }
  return usable[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type QualityLevel = 'very-low' | 'low' | 'medium' | 'high' | 'very-high';

export interface Plan {
  formatId: string;
  /** Seconds. Omitted ends mean "from the start" and "to the end". */
  start?: number;
  end?: number;
  /** Longest edge target, or 0 to keep the original size. */
  maxHeight?: number;
  quality?: QualityLevel;
  rotate?: 0 | 90 | 180 | 270;
  /** Throw the sound away. */
  mute?: boolean;
  frameRate?: number;
  /**
   * Squeeze the output under a size, in bytes.
   *
   * The reason most people open a video converter at all: something has to fit
   * under a limit and does not. Overrides `quality`, and always re-encodes —
   * there is no other way to make a file smaller.
   */
  targetBytes?: number;
  /** Frames a second for a GIF. The format cannot express more than 50. */
  gifFps?: number;
  /** Spread each pixel's colour error into its neighbours. */
  gifDither?: boolean;
  /**
   * Cut precisely where asked, at the cost of re-encoding.
   *
   * A copied cut can only begin at a keyframe, because every frame after one is
   * described relative to it and there is nothing to describe the first frame
   * against otherwise. Asking for the frame you actually pointed at means
   * decoding and re-encoding the picture.
   */
  exact?: boolean;
}

export interface TrimRange {
  start: number;
  end: number;
  duration: number;
  error?: string;
}

/**
 * Clamp and check a trim range against the file.
 *
 * Trimming to nothing, or to a range that ends before it starts, is a mistake
 * worth naming rather than a conversion worth running.
 */
export function planTrim(plan: Plan, duration: number): TrimRange {
  const start = Math.max(0, Math.min(plan.start ?? 0, duration));
  const end = Math.min(plan.end ?? duration, duration);
  if (!(duration > 0)) return { start: 0, end: 0, duration: 0, error: 'this file has no duration' };
  if (end <= start) return { start, end, duration: 0, error: 'the end has to come after the start' };
  if (end - start < 0.02) return { start, end, duration: end - start, error: 'that is too short to be a clip' };
  return { start, end, duration: end - start };
}

/** Whether the trim actually removes anything. */
export function isWholeFile(range: TrimRange, duration: number): boolean {
  return range.start <= 0.001 && range.end >= duration - 0.001;
}

/**
 * The output size, keeping aspect ratio and never scaling up.
 *
 * Encoders want even dimensions — chroma is stored at half resolution in every
 * codec here, so an odd width has half a pixel of it — and a request to enlarge
 * a video is a request to make a bigger blurry file, so it is ignored.
 */
export function scaleTo(width: number, height: number, maxHeight: number): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  if (!maxHeight || height <= maxHeight) return { width: even(width), height: even(height) };
  const scale = maxHeight / height;
  return { width: even(width * scale), height: even(height * scale) };
}

/** Whether the cut begins somewhere other than the very start of the file. */
function trimsTheStart(plan: Plan): boolean {
  return (plan.start ?? 0) > 0.001;
}

/**
 * Whether the plan asks for a different picture, rather than merely less of it.
 *
 * Deliberately independent of which codec was chosen, because the codec choice
 * depends on this answer: a track that is coming through untouched keeps its
 * own codec, and one that is being re-encoded has to use a codec this browser
 * can encode. Working that out the other way round is circular.
 */
export function changesPicture(plan: Plan, info: MediaInfo): boolean {
  if (findFormat(plan.formatId)?.kind === 'gif') return true;
  if (plan.rotate || plan.frameRate || plan.quality) return true;
  // A size limit is a ceiling, not a goal: a file that already fits is left
  // alone rather than inflated to fill it.
  if (plan.targetBytes && !targetAlreadyMet(plan, info)) return true;
  if (plan.exact && trimsTheStart(plan)) return true;
  if (!info.video) return false;
  // Only an actual downscale changes the picture. scaleTo rounds to even
  // dimensions (encoders need them), but that rounding must not count as a
  // change when no resize was asked for: an anamorphic source with an odd
  // display width (873) is unchanged, and evening it to 874 used to defeat the
  // lossless copy path for a plain container change or start-trim.
  const maxHeight = plan.maxHeight ?? 0;
  return maxHeight > 0 && info.video.height > maxHeight;
}

export function changesSound(plan: Plan, info?: MediaInfo): boolean {
  if (plan.quality) return true;
  return Boolean(plan.targetBytes) && !(info && targetAlreadyMet(plan, info));
}

/**
 * The codecs to use for a particular plan on a particular file.
 *
 * This is what the page calls: it folds in both "what can this browser encode"
 * and "what is this conversion actually going to touch", which together decide
 * whether the file's own codecs can be kept.
 */
export function fitFor(plan: Plan, format: OutputFormat, encodable: Encodable, info: MediaInfo): FormatFit {
  return fitFormat(format, encodable, {
    source: info,
    encodingVideo: changesPicture(plan, info),
    encodingAudio: changesSound(plan, info),
  });
}

/** Nothing about the picture is being changed — only, perhaps, its extent. */
function pictureUntouched(plan: Plan, info: MediaInfo, fit: FormatFit): boolean {
  if (!info.video || !fit.video) return false;
  if (fit.video !== info.video.codec) return false;
  return !changesPicture(plan, info);
}

function soundUntouched(plan: Plan, info: MediaInfo, fit: FormatFit): boolean {
  if (!info.audio || !fit.audio) return false;
  return fit.audio === info.audio.codec && !changesSound(plan, info);
}

// ---------------------------------------------------------------------------
// Fitting a size
// ---------------------------------------------------------------------------

/** What the sound costs when a size is being budgeted for. */
export const TARGET_AUDIO_BITRATE = 96e3;

/** Container overhead, as a fraction. Muxing is not free. */
const OVERHEAD = 1.03;

/**
 * The video bitrate that lands the output on a target size.
 *
 * Arithmetic, not a guess: a bitrate *is* a size divided by a duration. The
 * sound is subtracted first because it is spent whatever happens to the
 * picture, and it is what makes short clips at small targets impossible —
 * fifteen seconds of audio at 96 kbps is already 180 KB.
 */
export function bitrateForTarget(targetBytes: number, duration: number, audioBitrate = 0): number {
  if (!(targetBytes > 0) || !(duration > 0)) return 0;
  const available = (targetBytes * 8) / OVERHEAD - audioBitrate * duration;
  return Math.max(0, available / duration);
}

/**
 * How much information a bitrate buys, per pixel per frame.
 *
 * The only honest way to answer "will this look alright?", because a bitrate on
 * its own means nothing: two megabits is generous for a phone clip and
 * catastrophic for 4K. Bits per pixel normalises for both resolution and frame
 * rate, and the thresholds below are where the picture visibly falls apart.
 */
export function bitsPerPixel(bitrate: number, width: number, height: number, frameRate: number): number {
  const pixels = width * height * (frameRate || 30);
  return pixels > 0 ? bitrate / pixels : 0;
}

export type TargetVerdict = 'already' | 'good' | 'fair' | 'poor' | 'impossible';

/**
 * What the output would weigh if nothing were re-encoded.
 *
 * Measured bitrates where the file gave them up, and a share of the file's own
 * size where it did not. Used to answer the question a size limit should always
 * ask first: does this already fit?
 */
export function copySize(plan: Plan, info: MediaInfo): number {
  const range = planTrim(plan, info.duration);
  if (range.error) return 0;
  const known = (info.video?.bitrate ?? 0) + (plan.mute ? 0 : info.audio?.bitrate ?? 0);
  if (known > 0) return Math.round((known * range.duration) / 8);
  const share = info.duration > 0 ? range.duration / info.duration : 1;
  return Math.round(info.size * share);
}

/** Whether a size limit is already met without touching the file. */
export function targetAlreadyMet(plan: Plan, info: MediaInfo): boolean {
  return Boolean(plan.targetBytes) && copySize(plan, info) <= plan.targetBytes!;
}

export interface TargetJudgement {
  verdict: TargetVerdict;
  /** Video bits per second the target allows. */
  bitrate: number;
  bpp: number;
  /** What to say about it. */
  advice: string;
  /** A height at which the same target would look decent, where one exists. */
  suggestHeight?: number;
}

/* Bits per pixel at which H.264 starts to look soft, then bad.
 *
 * Calibrated against bitrates people actually meet, at 1080p30:
 *
 *   YouTube's recommended upload   8 Mbps   0.129
 *   a streaming service            5 Mbps   0.080
 *   ordinary web video             3 Mbps   0.048
 *   visibly compressed             2 Mbps   0.032
 *   unwatchable                    1 Mbps   0.016
 *
 * Newer codecs carry the same picture in fewer bits, so the measure is divided
 * by their efficiency before being compared. */
const BPP_GOOD = 0.07;
const BPP_FAIR = 0.028;

function codecEfficiency(codec: string | null): number {
  return codec === 'av1' ? 0.55 : codec === 'vp9' || codec === 'hevc' ? 0.7 : 1;
}

/**
 * Whether a target size is achievable, and at what cost.
 *
 * The useful part is the suggestion. "8 MB" and "4K" together mean a smeared
 * mess, and every converter that accepts both without comment is wasting
 * someone's afternoon. Dropping the resolution is nearly always the right
 * answer — a sharp 480p clip beats a mushy 1080p one at the same size — so
 * where a height exists that would land the same target in the clear, it is
 * named.
 */
export function judgeTarget(plan: Plan, info: MediaInfo, fit: FormatFit): TargetJudgement | null {
  if (!plan.targetBytes || !info.video) return null;

  const range = planTrim(plan, info.duration);
  if (range.error) return null;

  if (targetAlreadyMet(plan, info)) {
    return {
      verdict: 'already',
      bitrate: info.video.bitrate ?? 0,
      bpp: 0,
      advice: `It already fits: about ${formatBytes(copySize(plan, info))}. Nothing is re-encoded.`,
    };
  }

  const audioBitrate = plan.mute || !info.audio ? 0 : TARGET_AUDIO_BITRATE;
  const bitrate = bitrateForTarget(plan.targetBytes, range.duration, audioBitrate);
  const size = scaleTo(info.video.width, info.video.height, plan.maxHeight ?? 0);
  const frameRate = plan.frameRate || info.video.frameRate || 30;
  const efficiency = codecEfficiency(fit.video);
  const bpp = bitsPerPixel(bitrate, size.width, size.height, frameRate) / efficiency;

  if (bitrate < 24e3) {
    const spent = formatBytes((audioBitrate * range.duration) / 8);
    return {
      verdict: 'impossible',
      bitrate,
      bpp,
      advice:
        audioBitrate > 0
          ? `The sound alone needs about ${spent} of that. Shorten the clip, or remove the sound.`
          : 'That is too small for a clip this long. Shorten it.',
    };
  }

  // The largest standard height at which this target would look clear.
  const better = sizeChoices(info.video.height)
    .filter((c) => c.height > 0 && c.height < size.height)
    .find((c) => {
      const at = scaleTo(info.video!.width, info.video!.height, c.height);
      return bitsPerPixel(bitrate, at.width, at.height, frameRate) / efficiency >= BPP_GOOD;
    });

  if (bpp >= BPP_GOOD) {
    return { verdict: 'good', bitrate, bpp, advice: 'That fits comfortably at this size.' };
  }
  if (bpp >= BPP_FAIR) {
    return {
      verdict: 'fair',
      bitrate,
      bpp,
      advice: better
        ? `It will fit, but detail and fast movement will suffer. At ${better.label} it would stay sharp.`
        : 'It will fit, but detail and fast movement will suffer.',
      ...(better ? { suggestHeight: better.height } : {}),
    };
  }
  return {
    verdict: 'poor',
    bitrate,
    bpp,
    advice: better
      ? `At this size that is far too little to look like anything. Drop to ${better.label} and it becomes watchable: a sharp small picture beats a smeared large one.`
      : 'That is far too little for a picture this size. Shorten the clip or accept a blurry result.',
    ...(better ? { suggestHeight: better.height } : {}),
  };
}

/**
 * Whether the packet-copy engine can do this job.
 *
 * That engine reads the already-compressed packets and writes them straight
 * into a new container, so it can only be used when *every* track it keeps
 * comes through untouched. It is the only way to cut the start off a video
 * without re-encoding it — mediabunny's own converter re-encodes the picture
 * whenever the trim begins anywhere but zero, which was measured rather than
 * assumed.
 */
export function canCopyAll(plan: Plan, info: MediaInfo, fit: FormatFit): boolean {
  if (plan.exact && trimsTheStart(plan)) return false;
  const format = findFormat(plan.formatId);
  if (!format || !fit.usable) return false;

  if (format.kind === 'audio') return soundUntouched(plan, info, fit);
  if (!pictureUntouched(plan, info, fit)) return false;
  // Audio that is being dropped does not have to be copyable; audio that is
  // being kept does, because this engine cannot encode anything.
  return Boolean(plan.mute) || !info.audio || soundUntouched(plan, info, fit);
}

/**
 * Whether the encoded video comes through untouched.
 *
 * This is the difference between a lossless cut that takes seconds and a
 * re-encode that takes minutes and costs a generation of quality, and it is
 * the page's headline claim, so it is worked out rather than hoped for.
 *
 * There are two engines behind it. mediabunny's converter copies the picture
 * when nothing about it changes — but only if the cut starts at zero; give it
 * any other start and it re-encodes the whole range to land the first frame
 * exactly where you asked. The packet-copy engine here has no such limit, but
 * it can only be used when every kept track copies. So a mid-file cut is
 * lossless exactly when the copy engine can take it.
 */
export function willCopyVideo(plan: Plan, info: MediaInfo, fit: FormatFit): boolean {
  if (!pictureUntouched(plan, info, fit)) return false;
  if (findFormat(plan.formatId)?.kind !== 'video') return false;
  // A cut that starts at zero already begins on a keyframe, so there is nothing
  // for "exact" to buy and the converter copies regardless.
  if (!trimsTheStart(plan)) return true;
  return canCopyAll(plan, info, fit);
}

export function willCopyAudio(plan: Plan, info: MediaInfo, fit: FormatFit): boolean {
  if (plan.mute || !soundUntouched(plan, info, fit)) return false;
  if (!trimsTheStart(plan)) return true;
  return canCopyAll(plan, info, fit);
}

/**
 * Where a copied cut will really begin.
 *
 * Every frame in a compressed video is described as a change from the one
 * before it, all the way back to a keyframe — a frame stored whole. A copy can
 * therefore only start at a keyframe, because there is nothing to describe the
 * first frame against otherwise. `keyframe` is the time of the last one at or
 * before the requested start, which the page reads out of the file.
 */
export interface CutStart {
  /** Where the output will actually begin. */
  at: number;
  /** How much earlier than asked, in seconds. */
  drift: number;
}

export function cutStart(plan: Plan, keyframe: number | null): CutStart {
  const asked = plan.start ?? 0;
  if (keyframe === null || !Number.isFinite(keyframe) || keyframe > asked) return { at: asked, drift: 0 };
  return { at: keyframe, drift: asked - keyframe };
}

/** The bitrates the quality levels roughly correspond to, per megapixel. */
const QUALITY_BITS: Record<QualityLevel, number> = {
  'very-low': 0.6e6,
  low: 1.2e6,
  medium: 2.4e6,
  high: 4.8e6,
  'very-high': 9e6,
};

/**
 * Roughly how big the output will be.
 *
 * Deliberately rough, and labelled as such wherever it is shown. A copy is
 * predictable — the same packets, less of them — but a re-encode depends on
 * what is in the picture, and any number given to two significant figures here
 * would be a lie. The purpose is to stop someone converting a two hour film to
 * "very high" without realising it will not fit on their phone.
 */
export function estimateBytes(plan: Plan, info: MediaInfo, fit: FormatFit): number {
  const range = planTrim(plan, info.duration);
  if (range.error) return 0;
  if (findFormat(plan.formatId)?.kind === 'gif') return gifPlanFor(plan, info)?.bytes ?? 0;
  // A size target is not estimated, it is aimed at — unless the file already
  // fits, in which case nothing changes and the copy is the answer.
  if (plan.targetBytes && !targetAlreadyMet(plan, info) && judgeTarget(plan, info, fit)?.verdict !== 'impossible') {
    return plan.targetBytes;
  }
  const share = info.duration > 0 ? range.duration / info.duration : 1;

  let bits = 0;
  if (info.video && fit.video && fit.usable && findFormat(plan.formatId)?.kind === 'video') {
    if (willCopyVideo(plan, info, fit) && info.video.bitrate) {
      bits += info.video.bitrate * range.duration;
    } else {
      const size = scaleTo(info.video.width, info.video.height, plan.maxHeight ?? 0);
      const megapixels = (size.width * size.height) / 1e6;
      const perMegapixel = QUALITY_BITS[plan.quality ?? 'medium'];
      // Modern codecs need fewer bits for the same picture.
      const efficiency = fit.video === 'av1' ? 0.6 : fit.video === 'vp9' || fit.video === 'hevc' ? 0.75 : 1;
      bits += megapixels * perMegapixel * efficiency * range.duration;
    }
  }
  if (info.audio && fit.audio && !plan.mute) {
    const rate =
      willCopyAudio(plan, info, fit) && info.audio.bitrate
        ? info.audio.bitrate
        : fit.audio === 'pcm-s16'
          ? info.audio.sampleRate * info.audio.channels * 16
          : fit.audio === 'flac'
            ? 700e3
            : 128e3;
    bits += rate * range.duration;
  }
  // Container overhead is small but not nothing.
  return Math.round((bits / 8) * 1.02) || Math.round(info.size * share);
}

// ---------------------------------------------------------------------------
// Turning a plan into instructions
// ---------------------------------------------------------------------------

export interface TrackOptions {
  discard?: boolean;
  width?: number;
  height?: number;
  /**
   * How to reconcile the requested box with the picture. Required whenever both
   * dimensions are given — mediabunny refuses the conversion without it rather
   * than picking for you. Both dimensions are always given here, because the
   * point is to control the exact even-numbered output size, and both are
   * derived from the source's own aspect ratio, so 'contain' neither crops nor
   * letterboxes: it is simply the choice that cannot distort.
   */
  fit?: 'fill' | 'contain' | 'cover';
  rotate?: number;
  frameRate?: number;
  codec?: string;
  quality?: QualityLevel;
  /** An explicit bits-per-second budget, used when fitting a size. */
  bitrate?: number;
  numberOfChannels?: number;
}

export interface Instructions {
  /**
   * Which engine does the work.
   *
   * `copy` reads the compressed packets and writes them into a new container
   * untouched — the only way to cut the start off a video losslessly.
   * `convert` hands the job to mediabunny's converter, which decodes and
   * re-encodes whatever has to change.
   */
  mode: 'copy' | 'convert' | 'gif';
  /** Options for the picture, or null when the output has none. */
  video: TrackOptions | null;
  audio: TrackOptions | null;
  trim?: { start: number; end: number };
  error?: string;
}

/**
 * The plan as instructions the page can hand to mediabunny.
 *
 * Plain objects rather than mediabunny's own types, so this file stays testable
 * without loading 600 KB of demuxer. The page swaps the quality name for the
 * library's constant and adds the input and output objects.
 */
export function instructionsFor(plan: Plan, info: MediaInfo, fit: FormatFit): Instructions {
  const bad = (error: string): Instructions => ({ mode: 'convert', video: null, audio: null, error });

  const format = findFormat(plan.formatId);
  if (!format) return bad('unknown output format');
  if (!fit.usable) return bad(fit.reason ?? 'this browser cannot write that format');

  const range = planTrim(plan, info.duration);
  if (range.error) return bad(range.error);

  if (format.kind === 'gif') {
    if (!info.video) return bad('there is no picture in this file to animate');
    // Every frame has to be decoded and redrawn; without a decoder there is
    // nothing to draw.
    if (!info.video.decodable) {
      return bad(`this browser cannot decode ${codecName(info.video.codec)}, and a GIF has to redraw every frame`);
    }
    return { mode: 'gif', video: null, audio: null, ...(isWholeFile(range, info.duration) ? {} : { trim: { start: range.start, end: range.end } }) };
  }

  const audioOnly = format.kind === 'audio';
  if (audioOnly && !info.audio) return bad('there is no sound in this file to extract');
  if (!audioOnly && !info.video) return bad('there is no picture in this file');

  const target = judgeTarget(plan, info, fit);
  if (target?.verdict === 'impossible') return bad(`${formatBytes(plan.targetBytes!)} is not enough. ${target.advice}`);

  let video: TrackOptions | null = null;
  if (audioOnly) {
    video = { discard: true };
  } else if (info.video) {
    video = { codec: fit.video ?? undefined };
    const size = scaleTo(info.video.width, info.video.height, plan.maxHeight ?? 0);
    if (size.width !== info.video.width || size.height !== info.video.height) {
      video.width = size.width;
      video.height = size.height;
      video.fit = 'contain';
    }
    if (plan.rotate) video.rotate = plan.rotate;
    if (plan.frameRate) video.frameRate = plan.frameRate;
    if (plan.quality) video.quality = plan.quality;
    if (plan.targetBytes && !targetAlreadyMet(plan, info)) {
      const judged = judgeTarget(plan, info, fit);
      if (judged) video.bitrate = Math.round(judged.bitrate);
    }
  }

  let audio: TrackOptions | null = null;
  if (plan.mute || !info.audio || !fit.audio) {
    audio = { discard: true };
  } else {
    audio = { codec: fit.audio };
    if (plan.quality) audio.quality = plan.quality;
    // A size budget has to cover the sound too, or the output overshoots.
    if (plan.targetBytes && !targetAlreadyMet(plan, info)) audio.bitrate = TARGET_AUDIO_BITRATE;
  }

  const instructions: Instructions = {
    // The copy engine is only worth invoking for a cut it alone can make; for
    // everything else the converter is the same result with less of our code
    // between the file and the user.
    mode: canCopyAll(plan, info, fit) && trimsTheStart(plan) ? 'copy' : 'convert',
    video,
    audio,
  };
  if (!isWholeFile(range, info.duration)) instructions.trim = { start: range.start, end: range.end };
  return instructions;
}

/**
 * What is about to happen, in one sentence.
 *
 * The point of the whole page: nobody else tells you whether your video is
 * being copied or re-encoded, and it is the only thing that determines whether
 * you get your video back or a slightly worse copy of it.
 */
export interface Explanation {
  headline: string;
  lossless: boolean;
  notes: string[];
  /** True when an exact cut is available and would cost a re-encode. */
  offerExact?: boolean;
}

export function explainPlan(
  plan: Plan,
  info: MediaInfo,
  fit: FormatFit,
  /** Time of the last keyframe at or before the requested start, if known. */
  keyframe: number | null = null,
): Explanation {
  const format = findFormat(plan.formatId);
  const notes: string[] = [];

  if (!format || !fit.usable) {
    return { headline: fit.reason ?? 'that output is not available here', lossless: false, notes };
  }

  const range = planTrim(plan, info.duration);
  if (range.error) return { headline: range.error, lossless: false, notes };

  if (format.kind === 'gif') {
    const gif = gifPlanFor(plan, info);
    if (!gif) return { headline: 'there is no picture in this file', lossless: false, notes };
    if (!isWholeFile(range, info.duration)) notes.push(`Keeping ${formatTime(range.duration)} of ${formatTime(info.duration)}.`);
    notes.push(
      `${gif.frames} frames at ${gif.width}×${gif.height}, ${gif.fps} a second. ` +
        'There is no sound in a GIF, and no copying: every frame is decoded and redrawn into 256 colours.',
    );
    if (gif.warning) notes.push(gif.warning);
    return { headline: 'Redrawn as a GIF', lossless: false, notes };
  }

  if (format.kind === 'audio') {
    const copy = willCopyAudio(plan, info, fit);
    notes.push('The picture is dropped; only the sound is written out.');
    if (copy) notes.push('The audio is copied across untouched, so it is bit for bit the original.');
    return {
      headline: copy ? 'Sound extracted with no re-encoding' : `Sound re-encoded to ${codecName(fit.audio)}`,
      lossless: copy,
      notes,
    };
  }

  const copyVideo = willCopyVideo(plan, info, fit);
  const copyAudio = willCopyAudio(plan, info, fit);

  if (!isWholeFile(range, info.duration)) {
    notes.push(`Keeping ${formatTime(range.duration)} of ${formatTime(info.duration)}.`);
  }
  let offerExact = false;
  if (copyVideo) {
    notes.push('The picture is copied across rather than re-encoded, so the result is bit for bit the original video.');
    const cut = cutStart(plan, keyframe);
    if (cut.drift > 0.05) {
      // The one honest cost of a copied cut, named in seconds rather than left
      // for someone to discover in the output.
      notes.push(
        `It will start at ${formatTime(cut.at)} rather than ${formatTime(plan.start ?? 0)}, ` +
          `${cut.drift.toFixed(1)}s earlier, because that is the last keyframe before your start point, ` +
          'and a copy has nothing to describe its first frame against otherwise.',
      );
      offerExact = true;
    }
  } else if (info.video) {
    const reasons: string[] = [];
    if (fit.video !== info.video.codec) reasons.push(`${codecName(info.video.codec)} to ${codecName(fit.video)}`);
    const size = scaleTo(info.video.width, info.video.height, plan.maxHeight ?? 0);
    if (size.height !== info.video.height) reasons.push(`resize to ${size.width}×${size.height}`);
    if (plan.rotate) reasons.push(`rotate ${plan.rotate}°`);
    if (plan.frameRate) reasons.push(`${plan.frameRate} fps`);
    if (plan.quality) reasons.push('a quality change');
    if (plan.targetBytes && !targetAlreadyMet(plan, info)) reasons.push(`fitting ${formatBytes(plan.targetBytes)}`);
    if (plan.exact && trimsTheStart(plan)) reasons.push('cutting exactly where you asked');
    notes.push(`Re-encoding because of: ${reasons.join(', ') || 'the requested output'}. Expect it to take a while.`);
  }
  const target = judgeTarget(plan, info, fit);
  if (target?.verdict === 'already') {
    notes.push(`Asked to fit ${formatBytes(plan.targetBytes!)}. ${target.advice}`);
  } else if (target) {
    notes.push(
      `${formatBytes(plan.targetBytes!)} over ${formatTime(range.duration)} is ${Math.round(target.bitrate / 1000)} kbps of picture. ` +
        target.advice,
    );
  }
  // Whether the sound is being re-encoded: there is audio, it is not muted, the
  // browser can encode it, and it is not being copied. This is the case the old
  // headline ignored — an MKV of H.264 + FLAC copied to MP4 keeps the picture
  // bit for bit but re-encodes FLAC to lossy AAC, which is not "no quality lost".
  const soundReencoded = !plan.mute && Boolean(info.audio) && Boolean(fit.audio) && !copyAudio;

  if (plan.mute) notes.push('The sound is dropped.');
  else if (!fit.audio && info.audio) notes.push('This browser cannot encode any audio codec this container holds, so the result is silent.');
  else if (copyAudio) notes.push('The sound is copied across untouched.');
  else if (soundReencoded) {
    // Only claim a lossless track is being degraded when the source actually is
    // lossless; an MP3 re-encoded to AAC was already lossy.
    notes.push(
      isLosslessAudio(info.audio!.codec)
        ? `The sound is re-encoded to ${codecName(fit.audio!)}, so a lossless audio track becomes lossy.`
        : `The sound is re-encoded to ${codecName(fit.audio!)}.`,
    );
  }

  const lossless = copyVideo && (copyAudio || !info.audio || Boolean(plan.mute));

  return {
    // The headline may only say "no quality is lost" when both tracks are copied
    // (or there is no sound). Picture-copied-sound-re-encoded gets its own line.
    headline: lossless
      ? 'Copied, not re-encoded: no quality is lost'
      : copyVideo && soundReencoded
        ? 'Picture copied; sound re-encoded'
        : 'Re-encoded',
    lossless,
    notes,
    offerExact,
  };
}

/**
 * The size line under the button, worded for what it actually is.
 *
 * A target is a ceiling and an estimate is a guess, and calling either one the
 * other is the kind of small dishonesty this page is supposed to be free of.
 */
export function describeEstimate(plan: Plan, info: MediaInfo, fit: FormatFit): string {
  const bytes = estimateBytes(plan, info, fit);
  const from = ` (from ${formatBytes(info.size)})`;
  if (plan.targetBytes && !targetAlreadyMet(plan, info)) {
    return `at most ${formatBytes(bytes)}${from} (aimed at, not guessed)`;
  }
  if (findFormat(plan.formatId)?.kind === 'gif') {
    // Only the part of each frame that moved is encoded, so the figure is a
    // ceiling that full-frame motion approaches and a static shot falls far
    // under. Calling it an estimate would be understating how loose it is.
    return `up to ${formatBytes(bytes)}${from} (a still scene comes in far under)`;
  }
  return `roughly ${formatBytes(bytes)}${from} (an estimate, not a promise)`;
}

/**
 * What a GIF of this clip would come to.
 *
 * Delegated to the encoder's own planner, which knows what the format costs;
 * this just supplies the clip's length and the requested size.
 */
export function gifPlanFor(plan: Plan, info: MediaInfo): GifPlan | null {
  if (!info.video) return null;
  const range = planTrim(plan, info.duration);
  if (range.error) return null;
  const target = scaleTo(info.video.width, info.video.height, plan.maxHeight ?? 0);
  return planGif(
    range.duration,
    info.video.width,
    info.video.height,
    target.width,
    plan.gifFps ?? DEFAULT_GIF_FPS,
    plan.gifDither !== false,
  );
}

export const DEFAULT_GIF_FPS = 12;

/** The download name: the original, with the new extension. */
export function outputName(source: string, format: OutputFormat, trimmed: boolean): string {
  const stem = String(source ?? '').replace(/\.[^.\s]{1,5}$/, '') || 'video';
  const suffix = format.kind === 'audio' ? '-audio' : trimmed ? '-clip' : '-converted';
  return `${stem}${suffix}.${format.extension}`;
}

// ---------------------------------------------------------------------------
// Resolution choices
// ---------------------------------------------------------------------------

export interface SizeChoice {
  height: number;
  label: string;
}

/**
 * The sizes worth offering for a particular video.
 *
 * Only ones smaller than the source, because upscaling produces a bigger file
 * of exactly the same picture and every site that offers it is selling
 * something.
 */
export function sizeChoices(height: number): SizeChoice[] {
  const all = [
    { height: 2160, label: '4K' },
    { height: 1440, label: '1440p' },
    { height: 1080, label: '1080p' },
    { height: 720, label: '720p' },
    { height: 480, label: '480p' },
    { height: 360, label: '360p' },
    { height: 240, label: '240p' },
  ];
  return [{ height: 0, label: 'original' }, ...all.filter((s) => s.height < height)];
}

const globalScope = globalThis as unknown as { LOC1999_VIDEO?: Record<string, unknown> };
globalScope.LOC1999_VIDEO = {
  parseTime,
  formatTime,
  formatBytes,
  codecName,
  isLosslessAudio,
  describeMedia,
  OUTPUT_FORMATS,
  findFormat,
  formatForContainer,
  defaultFormatId,
  fitFormat,
  planTrim,
  isWholeFile,
  scaleTo,
  fitFor,
  judgeTarget,
  targetAlreadyMet,
  copySize,
  describeEstimate,
  bitrateForTarget,
  bitsPerPixel,
  TARGET_AUDIO_BITRATE,
  changesPicture,
  changesSound,
  willCopyVideo,
  willCopyAudio,
  canCopyAll,
  cutStart,
  estimateBytes,
  instructionsFor,
  explainPlan,
  outputName,
  sizeChoices,
  gifPlanFor,
  GIF_RATES,
  DEFAULT_GIF_FPS,
};

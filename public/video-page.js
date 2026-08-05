/* 1999.LOC video page. Vanilla JS, no build step.
 *
 * Loaded on first file open, both from this origin:
 *   /vendor/mediabunny/mediabunny.min.mjs — reads and writes MP4, WebM, MKV…
 *   /video.js                             — the planner, built from src/client/video.ts
 *
 * Nothing here uploads anything. There is no fetch() to any endpoint.
 *
 * The thing worth understanding: the browser already has the codecs. WebCodecs
 * will decode and encode frames using the same hardware engine a video call
 * uses. What it will not do is read or write a *file* — the boxes, sample
 * tables and timescales that make an MP4 an MP4 are not its problem. mediabunny
 * is that half, and the two together are a video converter with no ffmpeg, no
 * WebAssembly and no server.
 *
 * The second thing: when the output container can hold the codec the input
 * already uses, and nothing about the picture changes, mediabunny copies the
 * encoded packets across instead of decoding and re-encoding them. That is a
 * lossless cut in seconds. The planner predicts which of the two is about to
 * happen so the page can say so first.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var dropzone = $('drop');
  var fileInput = $('file-input');
  var statusEl = $('status');
  var errorEl = $('error');
  var loadedEl = $('loaded');
  var mediaLine = $('media-line');
  var previewEl = $('preview');
  var planEl = $('plan');
  var progressEl = $('progress');
  var outputEl = $('output');
  var estimateEl = $('estimate');
  var runBtn = $('run');
  var cancelBtn = $('cancel');
  var exactBox = $('exact-box');
  var suggestBox = $('suggest-box');

  var mb = null;          // the mediabunny module
  var gif = null;         // window.LOC1999_GIF, the encoder
  var planner = null;     // window.LOC1999_VIDEO
  var sourceFile = null;  // the File itself, re-read for every conversion
  var input = null;       // mediabunny Input, for probing only
  var info = null;        // MediaInfo
  var encodable = null;   // { video: [...], audio: [...] }
  var sourceName = 'video';
  var sourceSize = 0;
  var conversion = null;
  var copyCancelled = false;   // the copy engine's own stop flag
  var running = false;
  var keyframe = null;         // last keyframe at or before the requested start
  var suggestion = 0;          // a height that would rescue the chosen size limit
  var liveUrls = [];
  var clipStop = null;    // playhead limit while previewing just the clip

  var QUALITY = {};       // filled once mediabunny is loaded

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function setStatus(m) { statusEl.textContent = m; }
  function fail(m) { errorEl.textContent = m; statusEl.textContent = ''; }
  function clearError() { errorEl.textContent = ''; }

  function objectUrl(blob) {
    var url = URL.createObjectURL(blob);
    liveUrls.push(url);
    return url;
  }
  function releaseUrls() {
    liveUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    liveUrls = [];
  }

  // -------------------------------------------------------------- loading

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(el);
    });
  }

  function ensureEngines() {
    if (mb && planner) return Promise.resolve();
    setStatus('Loading the video engine…');
    return Promise.all([
      planner ? null : loadScript('/video.js'),
      mb ? null : import('/vendor/mediabunny/mediabunny.min.mjs'),
    ]).then(function (results) {
      if (results[1]) mb = results[1];
      planner = window.LOC1999_VIDEO;
      gif = window.LOC1999_GIF;
      if (!planner || !gif) throw new Error('the planner did not load');
      QUALITY = {
        'very-low': mb.QUALITY_VERY_LOW,
        low: mb.QUALITY_LOW,
        medium: mb.QUALITY_MEDIUM,
        high: mb.QUALITY_HIGH,
        'very-high': mb.QUALITY_VERY_HIGH,
      };
    });
  }

  /* Which formats the mediabunny classes correspond to. Kept here rather than
     in the planner so the planner stays free of the library. */
  function outputFormatFor(id) {
    if (id === 'mp4') return new mb.Mp4OutputFormat();
    if (id === 'webm') return new mb.WebMOutputFormat();
    if (id === 'mkv') return new mb.MkvOutputFormat();
    if (id === 'mov') return new mb.MovOutputFormat();
    if (id === 'mp3') return new mb.Mp3OutputFormat();
    if (id === 'opus') return new mb.OggOutputFormat();
    if (id === 'wav') return new mb.WavOutputFormat();
    return null;
  }

  // ------------------------------------------------------------- reading

  function readFile(file) {
    clearError();
    releaseUrls();
    outputEl.innerHTML = '';
    progressEl.textContent = '';
    sourceName = file.name || 'video';
    sourceSize = file.size;
    sourceFile = file;

    return ensureEngines()
      .then(function () {
        setStatus('Reading ' + sourceName + '…');
        input = openInput();
        return probe(file);
      })
      .then(function () {
        return capabilities();
      })
      .then(function () {
        previewEl.src = objectUrl(file);
        loadedEl.classList.remove('hidden');
        mediaLine.textContent = planner.describeMedia(info);
        buildControls();
        setStatus('');
      })
      .catch(function (err) {
        loadedEl.classList.add('hidden');
        fail(readableError(err));
      });
  }

  /* A fresh reader over the same file.
   *
   * An Input is consumed by the conversion that reads it, so converting twice
   * from one Input hangs rather than failing — which is exactly what happened
   * the first time this page was driven end to end. Opening a new one costs
   * nothing: a BlobSource reads lazily off the file on disk, so nothing is
   * copied and the file is never held in memory twice.
   */
  function openInput() {
    return new mb.Input({ source: new mb.BlobSource(sourceFile), formats: mb.ALL_FORMATS });
  }

  function readableError(err) {
    var message = (err && err.message) || String(err);
    if (/format|demux|parse|unsupported/i.test(message)) {
      return 'That file could not be read as a video. MP4, MOV, WebM, MKV, Ogg, MP3 and WAV work; ' +
        'AVI, WMV and FLV do not: they are old container formats with no browser support.';
    }
    return message;
  }

  function probe(file) {
    return input.getFormat().then(function (format) {
      return Promise.all([
        input.computeDuration(),
        input.getVideoTracks(),
        input.getAudioTracks(),
      ]).then(function (parts) {
        var duration = parts[0];
        var video = parts[1][0] || null;
        var audio = parts[2][0] || null;
        info = {
          format: format.name,
          duration: duration,
          size: file.size,
          video: null,
          audio: null,
        };
        var work = [];
        if (video) {
          info.video = {
            codec: video.codec,
            width: video.displayWidth,
            height: video.displayHeight,
            decodable: false,
            rotation: video.rotation,
          };
          work.push(video.canDecode().then(function (can) { info.video.decodable = can; }));
          /* Frame rate and bitrate are measured from a sample of packets rather
             than trusted from a header, because plenty of files lie or say
             nothing. It is a handful of reads, not a full pass. */
          work.push(video.computePacketStats(80).then(function (stats) {
            info.video.frameRate = stats.averagePacketRate;
            info.video.bitrate = stats.averageBitrate;
          }, function () { /* a stat is a nicety; a missing one is not an error */ }));
        }
        if (audio) {
          info.audio = {
            codec: audio.codec,
            channels: audio.numberOfChannels,
            sampleRate: audio.sampleRate,
            decodable: false,
          };
          work.push(audio.canDecode().then(function (can) { info.audio.decodable = can; }));
          work.push(audio.computePacketStats(80).then(function (stats) {
            info.audio.bitrate = stats.averageBitrate;
          }, function () {}));
        }
        if (!video && !audio) throw new Error('There are no video or audio tracks in that file.');
        return Promise.all(work);
      });
    });
  }

  /* What this browser can actually encode. Asked, not assumed: a Chromium
     without the licensed codecs cannot write H.264 or AAC, and finding that out
     at the end of a three minute conversion is not acceptable. */
  function capabilities() {
    return Promise.all([
      mb.getEncodableVideoCodecs(),
      mb.getEncodableAudioCodecs(),
    ]).then(function (parts) {
      encodable = { video: parts[0], audio: parts[1] };
    });
  }

  // ------------------------------------------------------------- controls

  function buildControls() {
    var decodeWarning = $('decode-warning');
    var undecodable = (info.video && !info.video.decodable) || (info.audio && !info.audio.decodable);
    if (undecodable) {
      var which = [];
      if (info.video && !info.video.decodable) which.push('the ' + planner.codecName(info.video.codec) + ' video');
      if (info.audio && !info.audio.decodable) which.push('the ' + planner.codecName(info.audio.codec) + ' audio');
      $('decode-detail').textContent =
        'This browser has no decoder for ' + which.join(' or ') + '. Copying it into another container ' +
        'still works, because that does not require decoding, but resizing, re-encoding and the preview ' +
        'above will not.';
      decodeWarning.classList.remove('hidden');
    } else {
      decodeWarning.classList.add('hidden');
    }

    // Formats the browser can actually produce for this file.
    var select = $('format');
    select.innerHTML = '';
    var offered = 0;
    planner.OUTPUT_FORMATS.forEach(function (format) {
      var fit = planner.fitFormat(format, encodable, { source: info });
      if (format.kind === 'video' && !info.video) return;   // no picture to write
      if (format.kind === 'audio' && !info.audio) return;   // no sound to extract
      var option = document.createElement('option');
      option.value = format.id;
      option.textContent = format.label;
      if (!fit.usable) {
        option.disabled = true;
        option.textContent = format.label + ' (not available in this browser)';
      } else {
        offered++;
      }
      select.appendChild(option);
    });
    if (!offered) {
      fail('This browser cannot encode any format this file could be written to.');
      return;
    }
    // The planner picks the default: the file's own container where writing it
    // would copy rather than re-encode.
    select.value = planner.defaultFormatId(info, encodable) || firstEnabled(select);

    var sizes = $('size');
    sizes.innerHTML = '';
    planner.sizeChoices(info.video ? info.video.height : 0).forEach(function (choice) {
      var option = document.createElement('option');
      option.value = String(choice.height);
      option.textContent = choice.label;
      sizes.appendChild(option);
    });

    var rates = $('gif-fps');
    rates.innerHTML = '';
    planner.GIF_RATES.forEach(function (rate) {
      var option = document.createElement('option');
      option.value = String(rate);
      option.textContent = rate + ' fps';
      if (rate === planner.DEFAULT_GIF_FPS) option.selected = true;
      rates.appendChild(option);
    });

    // Trim range, as thousandths of the duration.
    $('start-range').value = '0';
    $('end-range').value = '1000';
    $('start-time').value = planner.formatTime(0);
    $('end-time').value = planner.formatTime(info.duration);
    keyframe = 0;
    $('exact').checked = false;
    $('target').value = '';
    $('quality').value = '';

    refresh();
  }

  function firstEnabled(select) {
    for (var i = 0; i < select.options.length; i++) {
      if (!select.options[i].disabled) return select.options[i].value;
    }
    return '';
  }

  function currentTrim() {
    var start = planner.parseTime($('start-time').value);
    var end = planner.parseTime($('end-time').value);
    return {
      start: start === null ? null : start,
      end: end === null ? null : end,
    };
  }

  function currentPlan() {
    var trim = currentTrim();
    var plan = { formatId: $('format').value };
    if (trim.start !== null) plan.start = trim.start;
    if (trim.end !== null) plan.end = trim.end;
    var maxHeight = Number($('size').value);
    if (maxHeight) plan.maxHeight = maxHeight;
    if ($('quality').value) plan.quality = $('quality').value;
    var rotate = Number($('rotate').value);
    if (rotate) plan.rotate = rotate;
    if ($('mute').checked) plan.mute = true;
    if ($('exact').checked) plan.exact = true;
    plan.gifFps = Number($('gif-fps').value) || planner.DEFAULT_GIF_FPS;
    plan.gifDither = $('gif-dither').checked;
    var target = targetBytes();
    if (target) plan.targetBytes = target;
    return plan;
  }

  /* The size limit, in bytes, or 0 for none.
     Megabytes here means what a chat app means by it — 1024 × 1024 — because
     that is the number the limit is actually enforced in. */
  function targetBytes() {
    var choice = $('target').value;
    if (!choice) return 0;
    var mb = choice === 'custom' ? Number($('target-mb').value) : Number(choice);
    return mb > 0 ? Math.round(mb * 1024 * 1024) : 0;
  }

  /* Recompute everything derived from the controls: the verdict, the estimate,
     the trim summary. Cheap — it is all arithmetic — so it runs on every input
     rather than trying to be clever about which control changed. */
  function refresh() {
    if (!info || !planner) return;

    var trim = currentTrim();
    markField($('start-time'), trim.start !== null);
    markField($('end-time'), trim.end !== null);

    var plan = currentPlan();
    var format = planner.findFormat(plan.formatId);
    var fit = format ? planner.fitFor(plan, format, encodable, info) : { usable: false };
    $('format-note').textContent = format ? format.note : '';

    var range = planner.planTrim(plan, info.duration);
    $('trim-summary').textContent = range.error
      ? ''
      : 'clip is ' + planner.formatTime(range.duration) + ' of ' + planner.formatTime(info.duration);

    var audioOnly = format && format.kind === 'audio';
    var isGif = format && format.kind === 'gif';
    $('gif-box').classList.toggle('hidden', !isGif);
    // A GIF has no sound, no bitrate and no container to rotate metadata into,
    // so those controls would be lying if they stayed live.
    $('size').disabled = audioOnly;
    $('rotate').disabled = audioOnly || isGif;
    $('mute').disabled = audioOnly || isGif;

    var explained = planner.explainPlan(plan, info, fit, keyframe);
    var notes = explained.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
    planEl.innerHTML = '<p class="headline">' + esc(explained.headline) + '</p>' +
      (notes ? '<ul class="plain">' + notes + '</ul>' : '');
    planEl.classList.toggle('is-lossless', explained.lossless);
    // The choice only appears when there is one: a copied cut that lands early,
    // or an exact one already chosen.
    exactBox.classList.toggle('hidden', !explained.offerExact && !plan.exact);

    // A size limit sets the bitrate, so a quality level on top of it means
    // nothing; say so by disabling it rather than quietly ignoring it.
    var hasTarget = Boolean(plan.targetBytes);
    $('quality').disabled = audioOnly || hasTarget || isGif;
    var custom = $('target').value === 'custom';
    $('target-mb').classList.toggle('hidden', !custom);
    $('target-mb-unit').classList.toggle('hidden', !custom);
    $('target').disabled = audioOnly || isGif;

    // "Drop to 480p and it becomes watchable" is only worth saying if the page
    // will also do it for you.
    var judged = hasTarget ? planner.judgeTarget(plan, info, fit) : null;
    suggestion = judged && judged.suggestHeight ? judged.suggestHeight : 0;
    suggestBox.classList.toggle('hidden', !suggestion);
    if (suggestion) {
      $('apply-suggestion').textContent = 'Drop to ' + suggestion + 'p';
    }

    var instructions = planner.instructionsFor(plan, info, fit);
    runBtn.disabled = Boolean(instructions.error) || running;
    estimateEl.textContent = instructions.error ? instructions.error : planner.describeEstimate(plan, info, fit);
  }

  function markField(field, ok) {
    field.classList.toggle('is-bad', !ok);
  }

  /* Where the last keyframe before the requested start is.
   *
   * Read out of the file rather than guessed from a typical interval, because
   * intervals vary from half a second on a phone to ten on a screen recording,
   * and this number is shown to the visitor as a fact. Cheap: the demuxer seeks
   * to it rather than scanning.
   */
  var keyframeToken = 0;
  function findKeyframe() {
    var plan = currentPlan();
    var start = plan.start || 0;
    if (!info || !info.video || start <= 0) { keyframe = start > 0 ? null : 0; refresh(); return; }
    var token = ++keyframeToken;
    input.getPrimaryVideoTrack()
      .then(function (track) {
        return new mb.EncodedPacketSink(track).getKeyPacket(start, { metadataOnly: true });
      })
      .then(function (packet) {
        if (token !== keyframeToken) return;   // a later edit already superseded this
        keyframe = packet ? packet.timestamp : null;
        refresh();
      })
      .catch(function () { if (token === keyframeToken) { keyframe = null; refresh(); } });
  }

  // The two halves of the trim control drive each other: dragging the slider
  // writes the timestamp, typing a timestamp moves the slider.
  function sliderToTime(which) {
    var range = $(which + '-range');
    var seconds = (Number(range.value) / 1000) * info.duration;
    $(which + '-time').value = planner.formatTime(seconds);
    seekPreview(seconds);
    clampEnds(which);
    refresh();
    if (which === 'start') findKeyframe();
  }

  function timeToSlider(which) {
    var seconds = planner.parseTime($(which + '-time').value);
    if (seconds === null || !info.duration) { refresh(); return; }
    $(which + '-range').value = String(Math.round(Math.min(seconds / info.duration, 1) * 1000));
    clampEnds(which);
    refresh();
    if (which === 'start') findKeyframe();
  }

  /* Keep the handles in order. Dragging start past end is a mistake worth
     preventing rather than reporting. */
  function clampEnds(moved) {
    var start = Number($('start-range').value);
    var end = Number($('end-range').value);
    if (start >= end) {
      if (moved === 'start') {
        $('start-range').value = String(Math.max(0, end - 1));
        $('start-time').value = planner.formatTime((Math.max(0, end - 1) / 1000) * info.duration);
      } else {
        $('end-range').value = String(Math.min(1000, start + 1));
        $('end-time').value = planner.formatTime((Math.min(1000, start + 1) / 1000) * info.duration);
      }
    }
  }

  function seekPreview(seconds) {
    if (previewEl.readyState > 0 && isFinite(seconds)) {
      clipStop = null;
      try { previewEl.currentTime = seconds; } catch (e) { /* not seekable yet */ }
    }
  }

  function usePlayhead(which) {
    if (!isFinite(previewEl.currentTime)) return;
    $(which + '-time').value = planner.formatTime(previewEl.currentTime);
    timeToSlider(which);
  }

  // ------------------------------------------------------------ converting

  function run() {
    var plan = currentPlan();
    var format = planner.findFormat(plan.formatId);
    var fit = planner.fitFor(plan, format, encodable, info);
    var instructions = planner.instructionsFor(plan, info, fit);
    if (instructions.error) { fail(instructions.error); return; }

    clearError();
    outputEl.innerHTML = '';
    runBtn.disabled = true;
    cancelBtn.classList.remove('hidden');
    setStatus('');
    showProgress(0);

    var started = Date.now();
    copyCancelled = false;
    running = true;

    var work = instructions.mode === 'gif'
      ? makeGif(plan)
      : instructions.mode === 'copy'
        ? copyCut(instructions, plan, format)
        : convert(instructions, plan);

    work
      .then(function (result) {
        if (!result.buffer) throw new Error('the conversion produced nothing');
        finish(new Blob([result.buffer], { type: result.mimeType }), format, Date.now() - started, plan, result.startedAt);
      })
      .catch(function (err) {
        if (mb.ConversionCanceledError && err instanceof mb.ConversionCanceledError) {
          progressEl.textContent = 'Stopped.';
        } else {
          fail((err && err.message) || String(err));
          progressEl.textContent = '';
        }
      })
      .then(function () {
        conversion = null;
        running = false;
        cancelBtn.classList.add('hidden');
        refresh();
      });
  }

  /* Everything that is not a straight copy: mediabunny decodes and re-encodes
     whatever has to change, and reports how far along it is. */
  function convert(instructions, plan) {
    var target = new mb.BufferTarget();
    var output = new mb.Output({ format: outputFormatFor(plan.formatId), target: target });
    var options = {
      input: openInput(),
      output: output,
      video: toTrackOptions(instructions.video),
      audio: toTrackOptions(instructions.audio),
    };
    if (instructions.trim) options.trim = instructions.trim;

    return mb.Conversion.init(options).then(function (created) {
      conversion = created;
      // Progress only exists if the callback is attached before execute().
      conversion.onProgress = function (fraction) { showProgress(fraction); };
      if (!conversion.isValid) throw new Error(discardReason(conversion));
      return conversion.execute().then(function () {
        return { buffer: target.buffer, mimeType: output.format.mimeType };
      });
    });
  }

  /* Cut without re-encoding.
   *
   * mediabunny's converter re-encodes the picture whenever a trim begins
   * anywhere but zero — it wants the first frame to be exactly the one you
   * asked for, and the only way to get that is to decode and encode again.
   * Cutting the boring start off a video is the single most common thing
   * anyone wants to do to one, so it is worth not paying for.
   *
   * This does what `ffmpeg -ss … -c copy` does: find the keyframe at or before
   * the requested start, and write every packet from there to the end point
   * straight into a new container without touching it. Both tracks shift by
   * the same offset, or the sound drifts out of sync with the picture.
   *
   * It only runs when every track it keeps can be copied — it has no encoder in
   * it at all. instructionsFor decides that; this just carries it out.
   */
  function copyCut(instructions, plan, format) {
    var input = openInput();
    var output = new mb.Output({ format: outputFormatFor(plan.formatId), target: new mb.BufferTarget() });
    var range = planner.planTrim(plan, info.duration);
    var wantsVideo = format.kind === 'video';

    return Promise.all([
      wantsVideo ? input.getPrimaryVideoTrack() : null,
      instructions.audio && instructions.audio.discard ? null : input.getPrimaryAudioTrack(),
    ]).then(function (tracks) {
      var parts = [];
      if (tracks[0]) parts.push({ kind: 'video', track: tracks[0] });
      if (tracks[1]) parts.push({ kind: 'audio', track: tracks[1] });
      if (!parts.length) throw new Error('there is nothing in this file to copy');

      return Promise.all(parts.map(function (part) {
        part.sink = new mb.EncodedPacketSink(part.track);
        return Promise.all([
          part.track.getDecoderConfig(),
          part.sink.getKeyPacket(range.start, { verifyKeyPackets: true }),
        ]).then(function (both) {
          part.config = both[0];
          part.key = both[1];
        });
      })).then(function () {
        // The picture decides where the clip begins; the sound follows it.
        var lead = parts.find(function (p) { return p.kind === 'video'; }) || parts[0];
        var offset = lead.key ? lead.key.timestamp : 0;

        parts.forEach(function (part) {
          part.source = part.kind === 'video'
            ? new mb.EncodedVideoPacketSource(part.track.codec)
            : new mb.EncodedAudioPacketSource(part.track.codec);
          if (part.kind === 'video') output.addVideoTrack(part.source, { rotation: part.track.rotation });
          else output.addAudioTrack(part.source);
        });

        return output.start().then(function () {
          var span = Math.max(0.001, range.end - offset);
          // One track at a time; the muxer interleaves them itself.
          return parts.reduce(function (chain, part) {
            return chain.then(function () {
              return copyPackets(part, offset, range.end, span, parts.length);
            });
          }, Promise.resolve());
        }).then(function () {
          return output.finalize();
        }).then(function () {
          return { buffer: output.target.buffer, mimeType: output.format.mimeType, startedAt: offset };
        });
      });
    });
  }

  function copyPackets(part, offset, end, span, trackCount) {
    var first = true;
    var iterator = part.sink.packets(part.key || undefined);
    var cancelled = false;

    function step() {
      if (copyCancelled) { cancelled = true; return Promise.resolve(); }
      return iterator.next().then(function (next) {
        if (next.done) return undefined;
        var packet = next.value;
        if (packet.timestamp >= end - 1e-9) {
          // Nothing after the end point is wanted; stop reading rather than
          // walking the rest of a two hour file.
          return iterator.return ? iterator.return().then(function () {}) : undefined;
        }
        // Audio packets wholly before the picture's keyframe would play before
        // the first frame appears.
        if (part.kind === 'audio' && packet.timestamp + packet.duration <= offset - 1e-9) return step();

        showProgress(((packet.timestamp - offset) / span) / trackCount + (part.kind === 'audio' ? 1 / trackCount : 0));
        return part.source
          .add(packet.clone({ timestamp: packet.timestamp - offset }), first ? { decoderConfig: part.config } : undefined)
          .then(function () { first = false; return step(); });
      });
    }
    return step().then(function () {
      if (cancelled) throw new mb.ConversionCanceledError('stopped');
    });
  }

  /* Redraw the clip as an animated GIF.
   *
   * Nothing about this is a container change: GIF has no codecs, so every frame
   * is decoded to pixels, scaled, reduced to 256 colours and compressed by our
   * own LZW. The palette is chosen once, from frames sampled across the whole
   * clip, so the colours do not lurch when the scene changes — a per-frame
   * palette looks slightly better and costs 768 bytes a frame, which on a
   * hundred-frame GIF is most of a saving nobody wants to give up.
   *
   * The size win comes from the format's one good idea: a frame may cover part
   * of the canvas and let the rest show through. Everything that did not move
   * is marked transparent and simply is not encoded.
   */
  function makeGif(plan) {
    var gifPlan = planner.gifPlanFor(plan, info);
    if (!gifPlan) return Promise.reject(new Error('there is no picture in this file'));
    var range = planner.planTrim(plan, info.duration);

    var canvas = new OffscreenCanvas(gifPlan.width, gifPlan.height);
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var input = openInput();
    var dither = plan.gifDither !== false;

    return input.getPrimaryVideoTrack().then(function (track) {
      var sink = new mb.VideoSampleSink(track);
      // Ask for one frame per output frame rather than decoding everything and
      // throwing most of it away.
      var times = [];
      for (var i = 0; i < gifPlan.frames; i++) times.push(range.start + i / gifPlan.fps);

      var frames = [];
      var samples = [];
      var iterator = sink.samplesAtTimestamps(times);

      function collect() {
        if (copyCancelled) throw new mb.ConversionCanceledError('stopped');
        return iterator.next().then(function (next) {
          if (next.done) return undefined;
          var sample = next.value;
          if (sample) {
            // A VideoSample is not itself drawable; its own draw() unwraps the
            // frame and applies the rotation the container asked for, which
            // drawImage on the raw frame would ignore.
            sample.draw(ctx, 0, 0, gifPlan.width, gifPlan.height);
            sample.close();
            samples.push(ctx.getImageData(0, 0, gifPlan.width, gifPlan.height).data);
            // Half the progress bar is decoding, half is encoding.
            showProgress((samples.length / gifPlan.frames) * 0.5);
          }
          return collect();
        });
      }

      return collect().then(function () {
        if (!samples.length) throw new Error('no frames could be read out of that clip');

        // One palette for the whole animation, from frames spread across it.
        var pool = [];
        var step = Math.max(1, Math.floor(samples.length / 12));
        for (var i = 0; i < samples.length; i += step) pool.push(gif.samplePixels(samples[i], 12000));
        var merged = new Uint8Array(pool.reduce(function (n, p) { return n + p.length; }, 0));
        var at = 0;
        pool.forEach(function (p) { merged.set(p, at); at += p.length; });

        // One entry is spent on transparency so unchanged regions can be
        // dropped; it is worth far more than the colour it costs.
        var palette = gif.medianCut(merged, 255);
        var colors = palette.length / 3;
        var transparentIndex = colors;
        var withTransparent = new Uint8Array((colors + 1) * 3);
        withTransparent.set(palette);
        var matcher = new gif.PaletteMatcher(palette);

        var delay = 1000 / gifPlan.fps;
        for (var f = 0; f < samples.length; f++) {
          if (copyCancelled) throw new mb.ConversionCanceledError('stopped');
          var current = samples[f];
          if (f === 0) {
            frames.push({
              indices: gif.quantise(current, gifPlan.width, gifPlan.height, matcher, { dither: dither }),
              width: gifPlan.width, height: gifPlan.height, x: 0, y: 0, delayMs: delay,
            });
          } else {
            var rect = gif.changedRect(samples[f - 1], current, gifPlan.width, gifPlan.height);
            if (!rect) {
              // Nothing moved: extend the previous frame rather than repeating it.
              frames[frames.length - 1].delayMs += delay;
              continue;
            }
            frames.push(cropFrame(current, samples[f - 1], rect, gifPlan, matcher, transparentIndex, dither, delay));
          }
          showProgress(0.5 + ((f + 1) / samples.length) * 0.5);
        }

        var bytes = gif.buildGif(frames, withTransparent, gifPlan.width, gifPlan.height);
        return { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), mimeType: 'image/gif' };
      });
    });
  }

  /* One frame, cut down to the rectangle that changed, with the pixels inside
     it that did not change marked transparent. */
  function cropFrame(current, previous, rect, gifPlan, matcher, transparentIndex, dither, delay) {
    var sub = new Uint8ClampedArray(rect.width * rect.height * 4);
    var keep = new Uint8Array(rect.width * rect.height);
    for (var y = 0; y < rect.height; y++) {
      for (var x = 0; x < rect.width; x++) {
        var src = ((y + rect.y) * gifPlan.width + (x + rect.x)) * 4;
        var dst = (y * rect.width + x) * 4;
        sub[dst] = current[src];
        sub[dst + 1] = current[src + 1];
        sub[dst + 2] = current[src + 2];
        sub[dst + 3] = 255;
        if (current[src] === previous[src] && current[src + 1] === previous[src + 1] && current[src + 2] === previous[src + 2]) {
          keep[y * rect.width + x] = 1;
        }
      }
    }
    return {
      indices: gif.quantise(sub, rect.width, rect.height, matcher, { dither: dither, transparentIndex: transparentIndex, keep: keep }),
      width: rect.width,
      height: rect.height,
      x: rect.x,
      y: rect.y,
      delayMs: delay,
      transparentIndex: transparentIndex,
    };
  }

  /* The planner speaks in plain objects; mediabunny wants its own Quality
     instances. This is the only place the two meet. */
  function toTrackOptions(options) {
    if (!options) return undefined;
    var out = {};
    Object.keys(options).forEach(function (key) {
      if (key === 'quality') out.quality = QUALITY[options.quality];
      else out[key] = options[key];
    });
    return out;
  }

  /* When a conversion is invalid it is because a track could not be carried;
     mediabunny says which and why, so pass that on rather than "failed". */
  function discardReason(conv) {
    var reasons = (conv.discardedTracks || []).map(function (d) {
      if (d.reason === 'no_encodable_target_codec') return 'this browser cannot encode a codec that fits in this format';
      if (d.reason === 'undecodable_source_codec') return 'this browser cannot decode the ' + d.track.type + ' in this file';
      if (d.reason === 'unknown_source_codec') return 'the ' + d.track.type + ' in this file is in a codec nothing here recognises';
      return d.reason.replace(/_/g, ' ');
    });
    return reasons.length ? 'Cannot make that file: ' + reasons.join('; ') + '.' : 'Cannot make that file.';
  }

  function showProgress(fraction) {
    var percent = Math.max(0, Math.min(1, fraction || 0));
    var filled = Math.round(percent * 30);
    progressEl.innerHTML = '<span class="bar">[' +
      new Array(filled + 1).join('#') + new Array(30 - filled + 1).join('.') +
      ']</span> ' + Math.round(percent * 100) + '%';
  }

  // Output blob URLs are tracked apart from the loaded-file preview: a new run
  // must revoke the previous *output* (which can be a large video) without
  // revoking the source preview the <video> above is still using.
  var outputUrls = [];
  function outputUrl(blob) {
    var url = URL.createObjectURL(blob);
    outputUrls.push(url);
    return url;
  }
  function clearOutputUrls() {
    outputUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    outputUrls = [];
  }

  function finish(blob, format, elapsed, plan, startedAt) {
    progressEl.textContent = '';
    // Revoke the previous run's output before minting a new one, and use a
    // single URL for both the download link and the media element.
    clearOutputUrls();
    var url = outputUrl(blob);
    var trimmed = !planner.isWholeFile(planner.planTrim(plan, info.duration), info.duration);
    var name = planner.outputName(sourceName, format, trimmed);
    var seconds = Math.max(0.1, elapsed / 1000);
    var change = sourceSize ? Math.round((1 - blob.size / sourceSize) * 100) : 0;
    var sizeNote = change > 0 ? ', ' + change + '% smaller' : change < 0 ? ', ' + (-change) + '% larger' : '';

    outputEl.innerHTML =
      '<p><a id="download" download="' + esc(name) + '" href="' + url + '">Download ' + esc(name) + '</a> ' +
      '<span class="note">' + esc(planner.formatBytes(blob.size)) + esc(sizeNote) +
      ', in ' + seconds.toFixed(1) + 's' +
      (typeof startedAt === 'number' && Math.abs(startedAt - (plan.start || 0)) > 0.05
        ? ', starting at ' + esc(planner.formatTime(startedAt))
        : '') +
      '</span></p>' +
      // An extraction has nothing to show, and a black rectangle with a play bar
      // in it looks like a video that failed to load.
      (format.kind === 'audio'
        ? '<p><audio controls src="' + url + '"></audio></p>'
        : format.kind === 'gif'
          ? '<p><img class="gif-result" alt="the GIF that was just made" src="' + url + '"></p>'
          : '<div class="video-stage"><video controls playsinline src="' + url + '"></video></div>');
  }

  // ---------------------------------------------------------------- wiring

  dropzone.addEventListener('click', function () { fileInput.click(); });
  dropzone.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
  });
  dropzone.addEventListener('dragover', function (event) {
    event.preventDefault();
    dropzone.classList.add('is-over');
  });
  dropzone.addEventListener('dragleave', function () { dropzone.classList.remove('is-over'); });
  dropzone.addEventListener('drop', function (event) {
    event.preventDefault();
    dropzone.classList.remove('is-over');
    var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) readFile(file);
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files[0]) readFile(fileInput.files[0]);
  });

  $('start-range').addEventListener('input', function () { sliderToTime('start'); });
  $('end-range').addEventListener('input', function () { sliderToTime('end'); });
  $('start-time').addEventListener('change', function () { timeToSlider('start'); });
  $('end-time').addEventListener('change', function () { timeToSlider('end'); });
  $('start-here').addEventListener('click', function () { usePlayhead('start'); });
  $('end-here').addEventListener('click', function () { usePlayhead('end'); });

  $('play-clip').addEventListener('click', function () {
    var trim = currentTrim();
    if (trim.start === null || trim.end === null) return;
    clipStop = trim.end;
    try { previewEl.currentTime = trim.start; } catch (e) { /* not seekable */ }
    previewEl.play().catch(function () { /* autoplay refused; the controls still work */ });
  });
  $('reset-trim').addEventListener('click', function () {
    $('start-range').value = '0';
    $('end-range').value = '1000';
    $('start-time').value = planner.formatTime(0);
    $('end-time').value = planner.formatTime(info.duration);
    keyframe = 0;
    $('exact').checked = false;
    refresh();
  });
  previewEl.addEventListener('timeupdate', function () {
    if (clipStop !== null && previewEl.currentTime >= clipStop) {
      previewEl.pause();
      clipStop = null;
    }
  });

  ['format', 'size', 'quality', 'rotate', 'mute', 'exact', 'target', 'gif-fps', 'gif-dither'].forEach(function (id) {
    $(id).addEventListener('change', refresh);
  });
  $('target-mb').addEventListener('input', refresh);

  $('apply-suggestion').addEventListener('click', function () {
    if (!suggestion) return;
    $('size').value = String(suggestion);
    refresh();
  });

  runBtn.addEventListener('click', run);
  cancelBtn.addEventListener('click', function () {
    copyCancelled = true;
    if (conversion) conversion.cancel();
  });
})();

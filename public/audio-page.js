/* 1999.LOC audio page. Vanilla JS, no build step.
 *
 * Loaded on first use, both from this origin:
 *   /audiokit.js            - the arithmetic and the two encoders' plumbing
 *   /vendor/lame/lame.min.js - LAME itself, only when an MP3 is saved
 *
 * The browser does the two things browsers are genuinely good at: decoding
 * (AudioContext.decodeAudioData) and rendering edits (OfflineAudioContext).
 * Everything else comes from audiokit, where the tests can reach it.
 *
 * Nothing here uploads anything. There is no endpoint to upload to.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var kit = null;          // window.LOC1999_AUDIO
  var lame = null;         // window.lamejs, loaded on first MP3 save
  var actx = null;         // one AudioContext for the whole page
  var liveUrls = [];

  /* The playlist. Every opened file lands here decoded; `current` is the one
   * in the player and the one the edits apply to. */
  var tracks = [];         // { name, size, buffer }
  var current = -1;

  /* Playback state. The source node is disposable (a WebAudio source plays
   * once); what persists is where we are and whether we are moving. */
  var source = null;
  var gainNode = null;
  var analyser = null;
  var playingFrom = 0;     // seconds into the buffer where this run started
  var startedAt = 0;       // actx.currentTime when it started
  var playing = false;
  var raf = 0;
  var showRemaining = false;
  var stopTimer = null;

  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fail(m) { $('error').textContent = m; $('status').textContent = ''; }
  function clearError() { $('error').textContent = ''; }
  function setStatus(m) { $('status').textContent = m; }

  // ------------------------------------------------------------- loading

  function ready() {
    if (kit) return Promise.resolve();
    setStatus('Loading the engine…');
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = '/audiokit.js';
      el.onload = function () {
        kit = window.LOC1999_AUDIO;
        setStatus('');
        kit ? resolve() : reject(new Error('the engine did not load'));
      };
      el.onerror = function () { reject(new Error('could not load the engine')); };
      document.head.appendChild(el);
    });
  }

  /* LAME arrives only when somebody saves an MP3: it is 165 KB that a person
   * who only ever trims WAVs never needs. */
  function readyLame() {
    if (lame) return Promise.resolve();
    setStatus('Loading the MP3 encoder…');
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = '/vendor/lame/lame.min.js';
      el.onload = function () {
        lame = window.lamejs;
        setStatus('');
        lame ? resolve() : reject(new Error('the MP3 encoder did not load'));
      };
      el.onerror = function () { reject(new Error('could not load the MP3 encoder')); };
      document.head.appendChild(el);
    });
  }

  function context() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      actx = new AC();
      gainNode = actx.createGain();
      analyser = actx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.72;
      gainNode.connect(analyser);
      analyser.connect(actx.destination);
      gainNode.gain.value = Number($('volume').value) / 100;
    }
    return actx;
  }

  function openFiles(files) {
    clearError();
    if (!files || !files.length) return;
    var list = Array.prototype.slice.call(files);
    // Each file is opened on its own: one WMA in a folder of MP3s should cost
    // that one file an error line, not the whole drop. Failures are collected
    // and reported together once everything has been attempted.
    var problems = [];
    ready().then(function () {
      var chain = Promise.resolve();
      list.forEach(function (file) {
        chain = chain.then(function () {
          return openOne(file).catch(function (err) {
            problems.push((err && err.message) || String(err));
          });
        });
      });
      return chain;
    }).then(function () {
      if (problems.length) { setStatus(''); fail(problems.join(' ')); }
    }).catch(function (err) {
      setStatus('');
      fail((err && err.message) || String(err));
    });
  }

  function openOne(file) {
    setStatus('Opening ' + file.name + '…');
    return file.arrayBuffer().then(function (buf) {
      var kind = kit.sniffAudio(new Uint8Array(buf.slice(0, 16)));
      return context().decodeAudioData(buf).then(function (buffer) {
        tracks.push({ name: file.name, size: file.size, buffer: buffer });
        setStatus('');
        $('loaded').classList.remove('hidden');
        renderPlaylist();
        // The first file goes straight into the player; later ones queue.
        if (current === -1) load(tracks.length - 1);
      }, function () {
        var seen = kind === 'wma' ? 'a WMA file, which browsers do not decode'
          : kind === 'aiff' ? 'an AIFF file, which most browsers do not decode'
          : kind ? 'recognised as ' + kind + ', but this browser could not decode it'
          : 'not anything this browser recognises as audio';
        throw new Error('"' + file.name + '" is ' + seen +
          '. MP3, WAV, OGG, FLAC and M4A are the safe kinds.');
      });
    });
  }

  // ------------------------------------------------------------ the deck

  function track() { return tracks[current]; }

  function load(index) {
    if (!tracks[index]) return;
    stop();
    current = index;
    var t = track();
    var dur = t.buffer.duration;

    $('wa-kbps').textContent = String(kit.averageKbps(t.size, dur) || '---');
    $('wa-khz').textContent = String(Math.round(t.buffer.sampleRate / 1000));
    $('lamp-mono').classList.toggle('is-lit', t.buffer.numberOfChannels === 1);
    $('lamp-stereo').classList.toggle('is-lit', t.buffer.numberOfChannels > 1);
    var title = (index + 1) + '. ' + t.name + ' (' + kit.formatTime(dur) + ')';
    // The marquee: repeated with the era's separator so the loop has no seam,
    // and only when it actually overflows would it move (CSS decides). With
    // reduced motion the CSS stops the animation, so the doubled loop text
    // would just sit there doubled; a still title gets the plain name once.
    $('wa-title').textContent = REDUCED ? title : title + '  ***  ' + title + '  ***  ';
    $('wa-title').setAttribute('data-still', title);

    // Fresh file, fresh edits: a selection from the last song makes no sense
    // against this one.
    $('start-range').value = '0';
    $('end-range').value = '1000';
    $('start-time').value = kit.formatTime(0);
    $('end-time').value = kit.formatTime(dur);
    $('gain').value = '0';
    $('gain-value').textContent = '+0 dB';
    $('normalize').checked = false;
    $('gain').disabled = false;
    $('fade-in').value = '0';
    $('fade-out').value = '0';
    $('speed').value = '1';
    summarise();
    paintLcd(0);
    renderPlaylist();
  }

  function playhead() {
    if (!playing) return playingFrom;
    return Math.min(track().buffer.duration, playingFrom + (actx.currentTime - startedAt));
  }

  function play(fromSec, untilSec) {
    var t = track();
    if (!t) return;
    stop();
    var ctx = context();
    // Browsers park a context started outside a gesture; every play call is
    // inside one here, but resume() costs nothing and un-parks the first.
    if (ctx.state === 'suspended') ctx.resume();
    var from = Math.max(0, Math.min(t.buffer.duration, fromSec || 0));
    source = ctx.createBufferSource();
    source.buffer = t.buffer;
    source.connect(gainNode);
    source.start(0, from);
    playingFrom = from;
    startedAt = ctx.currentTime;
    playing = true;
    source.onended = function () { if (playing) { playing = false; paintLcd(playhead()); stopVis(); } };
    if (untilSec && untilSec > from) {
      stopTimer = setTimeout(function () { pause(); }, ((untilSec - from) * 1000) | 0);
    }
    startVis();
    tick();
  }

  function pause() {
    if (!playing) return;
    playingFrom = playhead();
    silence();
  }

  function stop() {
    playingFrom = 0;
    silence();
    if (track()) paintLcd(0);
    $('seek').value = '0';
  }

  /* The part pause and stop share: the source goes quiet and the loops end. */
  function silence() {
    playing = false;
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (source) {
      source.onended = null;
      try { source.stop(); } catch (e) { /* already ended */ }
      source = null;
    }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    stopVis();
  }

  function tick() {
    if (!playing) return;
    var t = track();
    var at = playhead();
    paintLcd(at);
    if (t.buffer.duration > 0) {
      $('seek').value = String(Math.round((at / t.buffer.duration) * 1000));
    }
    raf = requestAnimationFrame(tick);
  }

  function paintLcd(at) {
    var t = track();
    if (!t) return;
    var shown = showRemaining ? Math.max(0, t.buffer.duration - at) : at;
    $('time-lcd').textContent = (showRemaining ? '-' : '') + kit.formatTime(shown);
  }

  // ---- the spectrum ----------------------------------------------------
  /* Winamp's analyser, and a real one: bars fed by the playing audio, with
   * peak caps that fall. Pure decoration, so with animations reduced in the
   * system settings it stays dark rather than flickering anyway. */
  var visRaf = 0;
  var peaks = null;

  function startVis() {
    if (REDUCED) return;
    var canvas = $('spectrum');
    var ctx2d = canvas.getContext('2d');
    var bins = new Uint8Array(analyser.frequencyBinCount);   // 64
    var BARS = 19;
    if (!peaks) { peaks = new Float32Array(BARS); }

    function frame() {
      analyser.getByteFrequencyData(bins);
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      var barW = Math.floor(canvas.width / BARS);
      for (var i = 0; i < BARS; i++) {
        // Low bins are where music lives; sample them densely and the top
        // sparsely, which is roughly what the original's bands did.
        var from = Math.floor(Math.pow(i / BARS, 1.7) * bins.length);
        var to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / BARS, 1.7) * bins.length));
        var sum = 0;
        for (var b = from; b < to; b++) sum += bins[b];
        var level = (sum / (to - from)) / 255;
        var h = Math.round(level * (canvas.height - 4));

        // The classic ramp: green floor, yellow middle, red tip.
        var grad = ctx2d.createLinearGradient(0, canvas.height, 0, 0);
        grad.addColorStop(0, '#00c400');
        grad.addColorStop(0.6, '#c8c400');
        grad.addColorStop(1, '#c40000');
        ctx2d.fillStyle = grad;
        ctx2d.fillRect(i * barW + 1, canvas.height - h, barW - 2, h);

        if (level >= peaks[i]) peaks[i] = level;
        else peaks[i] = Math.max(0, peaks[i] - 0.012);
        var py = canvas.height - Math.round(peaks[i] * (canvas.height - 4)) - 2;
        ctx2d.fillStyle = '#cfd5de';
        ctx2d.fillRect(i * barW + 1, py, barW - 2, 1);
      }
      visRaf = requestAnimationFrame(frame);
    }
    if (!visRaf) frame();
  }

  function stopVis() {
    if (visRaf) { cancelAnimationFrame(visRaf); visRaf = 0; }
    var canvas = $('spectrum');
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }

  // ------------------------------------------------------------ the edits

  function selection() {
    var t = track();
    return kit.clampRange(t.buffer.duration,
      parseTime($('start-time').value), parseTime($('end-time').value));
  }

  /* "1:23", "83", "1:02:03" all mean what a person means by them. */
  function parseTime(text) {
    var parts = String(text || '').trim().split(':');
    if (!parts.length) return 0;
    var seconds = 0;
    for (var i = 0; i < parts.length; i++) {
      seconds = seconds * 60 + (parseFloat(parts[i]) || 0);
    }
    return seconds;
  }

  function summarise() {
    var t = track();
    if (!t) return;
    var range = selection();
    var speed = Number($('speed').value) || 1;
    var out = (range.end - range.start) / speed;
    var whole = range.start === 0 && range.end >= t.buffer.duration - 0.01;
    $('trim-summary').textContent = (whole ? 'the whole file' :
      kit.formatTime(range.start) + ' to ' + kit.formatTime(range.end)) +
      ', comes out ' + kit.formatTime(out);
  }

  function syncFromRanges() {
    var t = track();
    if (!t) return;
    var dur = t.buffer.duration;
    var start = (Number($('start-range').value) / 1000) * dur;
    var end = (Number($('end-range').value) / 1000) * dur;
    if (end < start) { var swap = start; start = end; end = swap; }
    $('start-time').value = kit.formatTime(start);
    $('end-time').value = kit.formatTime(Math.max(1, Math.round(end)));
    summarise();
  }

  function syncFromFields() {
    var t = track();
    if (!t) return;
    var range = selection();
    $('start-range').value = String(Math.round((range.start / t.buffer.duration) * 1000));
    $('end-range').value = String(Math.round((range.end / t.buffer.duration) * 1000));
    summarise();
  }

  // ---------------------------------------------------------- rendering

  /* One edited track, as raw channels. The browser renders the trim and the
   * speed (an OfflineAudioContext is exact about both); the kit then shapes
   * gain, fades and normalisation where the tests can see the same code. */
  function renderCurrent(targetRate) {
    var t = track();
    var range = selection();
    var speed = Number($('speed').value) || 1;
    var rate = targetRate || t.buffer.sampleRate;
    var seconds = (range.end - range.start) / speed;
    var frames = Math.max(1, Math.ceil(seconds * rate));
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var off = new OAC(t.buffer.numberOfChannels, frames, rate);
    var node = off.createBufferSource();
    node.buffer = t.buffer;
    node.playbackRate.value = speed;
    node.connect(off.destination);
    node.start(0, range.start, range.end - range.start);
    return off.startRendering().then(function (rendered) {
      var channels = [];
      for (var ch = 0; ch < rendered.numberOfChannels; ch++) {
        channels.push(rendered.getChannelData(ch));
      }
      if ($('normalize').checked) {
        kit.normalize(channels);
      } else {
        kit.applyGain(channels, kit.dbToLinear(Number($('gain').value) || 0));
      }
      kit.applyFades(channels, rate, Number($('fade-in').value) || 0, Number($('fade-out').value) || 0);
      return { channels: channels, rate: rate };
    });
  }

  /* Every track whole, at one rate, end to end, for the join. */
  function renderAll(rate) {
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var chain = Promise.resolve();
    var segments = [];
    tracks.forEach(function (t) {
      chain = chain.then(function () {
        var frames = Math.max(1, Math.ceil(t.buffer.duration * rate));
        var channels = Math.max.apply(null, tracks.map(function (x) { return x.buffer.numberOfChannels; }));
        var off = new OAC(channels, frames, rate);
        var node = off.createBufferSource();
        node.buffer = t.buffer;
        node.connect(off.destination);
        node.start(0);
        return off.startRendering().then(function (rendered) {
          var out = [];
          for (var ch = 0; ch < rendered.numberOfChannels; ch++) out.push(rendered.getChannelData(ch));
          segments.push(out);
        });
      });
    });
    return chain.then(function () { return kit.concatSegments(segments); });
  }

  // ------------------------------------------------------------- saving

  function mp3Rate(rate) {
    return kit.MP3_RATES.indexOf(rate) !== -1 ? rate : 44100;
  }

  function saveRendered(rendered, baseName, suffix, doneNote) {
    var format = $('format').value;
    if (format === 'wav') {
      var wav = kit.encodeWav(rendered.channels, rendered.rate);
      deliver(new Blob([wav], { type: 'audio/wav' }), kit.outName(baseName, suffix, 'wav'), doneNote);
      return Promise.resolve();
    }
    var kbps = Number($('bitrate').value) || 192;
    return readyLame().then(function () {
      return new Promise(function (resolve, reject) {
        var job;
        try {
          job = kit.mp3Job(lame, rendered.channels, rendered.rate, kbps);
        } catch (err) { reject(err); return; }
        (function step() {
          var more;
          try { more = job.step(96); } catch (err) { reject(err); return; }
          if (more === null) {
            $('progress').textContent = '';
            var out = job.finish();
            deliver(new Blob([out], { type: 'audio/mpeg' }), kit.outName(baseName, suffix, 'mp3'), doneNote);
            resolve();
            return;
          }
          $('progress').textContent = 'Encoding… ' + Math.round(job.fraction() * 100) + '%';
          setTimeout(step, 0);
        })();
      });
    });
  }

  function deliver(blob, name, note) {
    var url = URL.createObjectURL(blob);
    liveUrls.push(url);
    var size = blob.size < 1048576
      ? (blob.size / 1024).toFixed(1) + ' KB'
      : (blob.size / 1048576).toFixed(2) + ' MB';
    $('output').innerHTML = '<ul class="plain"><li><a href="' + url + '" download="' + esc(name) + '">' +
      esc(name) + '</a> <span class="note">' + size + (note ? ', ' + esc(note) : '') + '</span></li></ul>';
    var link = $('output').querySelector('a');
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); liveUrls = liveUrls.filter(function (u) { return u !== url; }); }, 60000);
  }

  function save() {
    var t = track();
    if (!t) { fail('Open a file first.'); return; }
    clearError();
    $('save').disabled = true;
    $('save-note').textContent = 'Rendering…';
    var wantRate = $('format').value === 'mp3' ? mp3Rate(t.buffer.sampleRate) : t.buffer.sampleRate;
    renderCurrent(wantRate)
      .then(function (rendered) {
        $('save-note').textContent = '';
        return saveRendered(rendered, t.name, 'edit', '');
      })
      .catch(function (err) { fail((err && err.message) || String(err)); })
      .then(function () { $('save').disabled = false; $('save-note').textContent = ''; });
  }

  function join() {
    if (tracks.length < 2) { fail('The playlist needs at least two files to join.'); return; }
    clearError();
    $('join').disabled = true;
    $('join-note').textContent = 'Rendering ' + tracks.length + ' files…';
    // One rate for everything: the highest any file uses, so nothing is
    // downsampled by the stitch, clamped to what MP3 can hold if MP3 is out.
    var rate = Math.max.apply(null, tracks.map(function (t) { return t.buffer.sampleRate; }));
    if ($('format').value === 'mp3') rate = mp3Rate(rate);
    renderAll(rate)
      .then(function (channels) {
        $('join-note').textContent = '';
        return saveRendered({ channels: channels, rate: rate }, tracks[0].name, 'joined',
          tracks.length + ' files, in playlist order');
      })
      .catch(function (err) { fail((err && err.message) || String(err)); })
      .then(function () { $('join').disabled = false; $('join-note').textContent = ''; });
  }

  // ----------------------------------------------------------- playlist

  function renderPlaylist() {
    var box = $('playlist');
    if (!tracks.length) {
      box.innerHTML = '<p class="wa-pl-empty">nothing here yet</p>';
      return;
    }
    box.innerHTML = tracks.map(function (t, i) {
      return '<div class="wa-pl-row' + (i === current ? ' is-current' : '') + '" data-index="' + i + '" tabindex="0">' +
        '<span class="wa-pl-name">' + (i + 1) + '. ' + esc(t.name) + '</span>' +
        '<span class="wa-pl-time">' + kit.formatTime(t.buffer.duration) + '</span>' +
        '<span class="wa-pl-acts">' +
          '<button type="button" class="wa-pl-up small" data-index="' + i + '" aria-label="Move up"' + (i === 0 ? ' disabled' : '') + '>up</button>' +
          '<button type="button" class="wa-pl-down small" data-index="' + i + '" aria-label="Move down"' + (i === tracks.length - 1 ? ' disabled' : '') + '>down</button>' +
          '<button type="button" class="wa-pl-drop small" data-index="' + i + '" aria-label="Remove">x</button>' +
        '</span></div>';
    }).join('');
  }

  $('playlist').addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('button') : null;
    if (button) {
      var i = Number(button.dataset.index);
      if (button.classList.contains('wa-pl-drop')) {
        tracks.splice(i, 1);
        if (current === i) { stop(); current = -1; if (tracks.length) load(Math.min(i, tracks.length - 1)); }
        else if (current > i) current -= 1;
        if (!tracks.length) { current = -1; $('loaded').classList.add('hidden'); }
        renderPlaylist();
      } else if (button.classList.contains('wa-pl-up') && i > 0) {
        var up = tracks.splice(i, 1)[0];
        tracks.splice(i - 1, 0, up);
        if (current === i) current = i - 1; else if (current === i - 1) current = i;
        renderPlaylist();
      } else if (button.classList.contains('wa-pl-down') && i < tracks.length - 1) {
        var down = tracks.splice(i, 1)[0];
        tracks.splice(i + 1, 0, down);
        if (current === i) current = i + 1; else if (current === i + 1) current = i;
        renderPlaylist();
      }
      return;
    }
    var row = event.target.closest ? event.target.closest('.wa-pl-row') : null;
    if (row) load(Number(row.dataset.index));
  });

  $('playlist').addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var row = event.target.closest ? event.target.closest('.wa-pl-row') : null;
    if (row) { event.preventDefault(); load(Number(row.dataset.index)); }
  });

  // -------------------------------------------------------------- wiring

  var dropzone = $('drop');
  var fileInput = $('file-input');
  dropzone.addEventListener('click', function () { fileInput.click(); });
  dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', function () {
    openFiles(fileInput.files);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach(function (n) {
    dropzone.addEventListener(n, function (e) { e.preventDefault(); dropzone.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (n) {
    dropzone.addEventListener(n, function (e) { e.preventDefault(); dropzone.classList.remove('is-over'); });
  });
  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer) openFiles(e.dataTransfer.files);
  });
  $('add-files').addEventListener('click', function () { fileInput.click(); });

  $('play').addEventListener('click', function () { if (track()) play(playingFrom >= track().buffer.duration ? 0 : playingFrom); });
  $('pause').addEventListener('click', pause);
  $('stop').addEventListener('click', stop);
  $('prev-track').addEventListener('click', function () { if (current > 0) { load(current - 1); play(0); } });
  $('next-track').addEventListener('click', function () { if (current < tracks.length - 1) { load(current + 1); play(0); } });

  $('seek').addEventListener('input', function () {
    var t = track();
    if (!t) return;
    var to = (Number($('seek').value) / 1000) * t.buffer.duration;
    if (playing) play(to);
    else { playingFrom = to; paintLcd(to); }
  });
  $('volume').addEventListener('input', function () {
    if (gainNode) gainNode.gain.value = Number($('volume').value) / 100;
  });
  $('time-lcd').addEventListener('click', function () {
    showRemaining = !showRemaining;
    if (track()) paintLcd(playing ? playhead() : playingFrom);
  });

  ['start-range', 'end-range'].forEach(function (id) {
    $(id).addEventListener('input', syncFromRanges);
  });
  ['start-time', 'end-time'].forEach(function (id) {
    $(id).addEventListener('change', syncFromFields);
  });
  $('start-here').addEventListener('click', function () {
    if (!track()) return;
    $('start-time').value = kit.formatTime(playing ? playhead() : playingFrom);
    syncFromFields();
  });
  $('end-here').addEventListener('click', function () {
    if (!track()) return;
    $('end-time').value = kit.formatTime(playing ? playhead() : playingFrom);
    syncFromFields();
  });
  $('play-clip').addEventListener('click', function () {
    if (!track()) return;
    var range = selection();
    play(range.start, range.end);
  });
  $('reset-edits').addEventListener('click', function () { if (track()) load(current); });

  $('gain').addEventListener('input', function () {
    var db = Number($('gain').value);
    $('gain-value').textContent = (db >= 0 ? '+' : '') + db + ' dB';
  });
  $('normalize').addEventListener('change', function () {
    // One lever at a time: normalise decides the level, so the slider
    // pretending to matter alongside it would be a lie.
    $('gain').disabled = $('normalize').checked;
  });
  ['speed', 'fade-in', 'fade-out'].forEach(function (id) {
    $(id).addEventListener('change', summarise);
  });

  $('format').addEventListener('change', function () {
    $('bitrate-box').classList.toggle('hidden', $('format').value !== 'mp3');
  });
  $('save').addEventListener('click', save);
  $('join').addEventListener('click', join);

  window.addEventListener('pagehide', function () {
    liveUrls.forEach(function (u) { URL.revokeObjectURL(u); });
  });
})();

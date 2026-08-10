/* 1999.LOC video timeline and toolbar. Vanilla JS, no build step.
 *
 * A presentation layer over video-page.js, which owns the engine and the
 * export pipeline and is left untouched. This script adds three things and
 * drives them entirely through the controls that page already wired:
 *
 *   - a timeline under the preview, whose two handles set the clip by moving
 *     the hidden #start-range / #end-range sliders and firing their 'input'
 *     event, which is exactly what the page listens for;
 *   - a toolbar whose buttons click the controls the menu already points at;
 *   - three modes (Clip / Convert / GIF) that show the right controls and pick
 *     a sensible output, by setting #format and clicking #reset-trim.
 *
 * Because it only reads and writes public DOM, it cannot break the conversion
 * logic: at worst a handle would not move.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var preview = $('preview');
  var loaded = $('loaded');
  var track = $('timeline');
  var tlIn = $('tl-in');
  var tlOut = $('tl-out');
  var tlSel = $('tl-sel');
  var tlPlay = $('tl-play');
  var startRange = $('start-range');
  var endRange = $('end-range');
  var format = $('format');
  var runBtn = $('run');
  if (!preview || !track || !startRange) return; // not the video page

  var mode = 'clip';
  var lastNonGif = ''; // the format to return to when leaving GIF mode

  function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

  // ------------------------------------------------------------ visuals
  function syncFromRanges() {
    var a = Number(startRange.value) / 1000;
    var b = Number(endRange.value) / 1000;
    tlIn.style.left = (a * 100) + '%';
    tlOut.style.left = (b * 100) + '%';
    tlSel.style.left = (a * 100) + '%';
    tlSel.style.width = Math.max(0, (b - a) * 100) + '%';
    tlIn.setAttribute('aria-valuenow', Math.round(a * 100));
    tlOut.setAttribute('aria-valuenow', Math.round(b * 100));
  }
  function syncLater() { setTimeout(syncFromRanges, 0); }

  function syncPlayhead() {
    var d = preview.duration;
    if (!d || !isFinite(d)) { tlPlay.style.left = '0%'; return; }
    tlPlay.style.left = clamp(preview.currentTime / d, 0, 1) * 100 + '%';
  }

  // ------------------------------------------------------------ dragging
  function setHandle(which, frac) {
    var range = which === 'in' ? startRange : endRange;
    range.value = String(Math.round(clamp(frac, 0, 1) * 1000));
    // The page's own listener reads this, moves the playhead, clamps the ends,
    // recomputes the plan, and (for the start) finds the keyframe.
    range.dispatchEvent(new Event('input', { bubbles: true }));
    syncFromRanges();
  }

  function fracFromClientX(clientX) {
    var rect = track.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  }

  function dragHandle(which, ev) {
    ev.preventDefault();
    var id = ev.pointerId;
    function move(e) { setHandle(which, fracFromClientX(e.clientX)); }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    if (which === 'in') tlIn.focus(); else tlOut.focus();
    move(ev);
    void id;
  }

  tlIn.addEventListener('pointerdown', function (e) { dragHandle('in', e); });
  tlOut.addEventListener('pointerdown', function (e) { dragHandle('out', e); });

  // A press on the track away from the handles scrubs the playhead.
  track.addEventListener('pointerdown', function (ev) {
    if (ev.target === tlIn || ev.target === tlOut) return;
    var d = preview.duration;
    if (!d || !isFinite(d)) return;
    function seek(e) { try { preview.currentTime = fracFromClientX(e.clientX) * d; } catch (x) { /* not seekable */ } }
    function up() { window.removeEventListener('pointermove', seek); window.removeEventListener('pointerup', up); }
    window.addEventListener('pointermove', seek);
    window.addEventListener('pointerup', up);
    seek(ev);
  });

  // Keyboard: arrows nudge, Home/End jump; each is 1% of the duration.
  function keyHandle(which, e) {
    var range = which === 'in' ? startRange : endRange;
    var v = Number(range.value);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v -= e.shiftKey ? 100 : 10;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v += e.shiftKey ? 100 : 10;
    else if (e.key === 'Home') v = 0;
    else if (e.key === 'End') v = 1000;
    else return;
    e.preventDefault();
    setHandle(which, clamp(v, 0, 1000) / 1000);
  }
  tlIn.addEventListener('keydown', function (e) { keyHandle('in', e); });
  tlOut.addEventListener('keydown', function (e) { keyHandle('out', e); });

  // Keep the handles in step when the page changes the range some other way:
  // a typed timestamp, the "set" buttons, or "Whole video".
  startRange.addEventListener('input', syncFromRanges);
  endRange.addEventListener('input', syncFromRanges);
  ['start-time', 'end-time'].forEach(function (id) { var el = $(id); if (el) el.addEventListener('change', syncLater); });
  ['reset-trim', 'start-here', 'end-here'].forEach(function (id) { var el = $(id); if (el) el.addEventListener('click', syncLater); });

  preview.addEventListener('timeupdate', syncPlayhead);
  preview.addEventListener('seeked', syncPlayhead);
  preview.addEventListener('loadedmetadata', syncPlayhead);

  // ------------------------------------------------------------ modes
  function gifOption() {
    if (!format) return null;
    for (var i = 0; i < format.options.length; i++) {
      if (/gif/i.test(format.options[i].value)) return format.options[i];
    }
    return null;
  }

  function applyVisibility() {
    var groups = loaded.querySelectorAll('[data-modes]');
    for (var i = 0; i < groups.length; i++) {
      var modes = groups[i].getAttribute('data-modes').split(/\s+/);
      groups[i].classList.toggle('hidden', modes.indexOf(mode) === -1);
    }
  }

  function setFormat(value) {
    if (!format || format.value === value) return;
    var opt = null;
    for (var i = 0; i < format.options.length; i++) if (format.options[i].value === value) opt = format.options[i];
    if (!opt || opt.disabled) return;
    format.value = value;
    format.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function runLabel() {
    var label = mode === 'gif' ? 'Make the GIF' : mode === 'convert' ? 'Convert the file' : 'Save the clip';
    if (runBtn) runBtn.textContent = label;
    var exp = $('mp-export');
    if (exp) { var svg = exp.querySelector('svg'); exp.textContent = mode === 'gif' ? 'Save GIF' : mode === 'convert' ? 'Convert' : 'Save clip'; if (svg) exp.insertBefore(svg, exp.firstChild); }
  }

  function setMode(next, opts) {
    opts = opts || {};
    var gif = gifOption();
    if (next === 'gif' && (!gif || gif.disabled)) return; // no GIF here
    var was = mode;
    mode = next;
    loaded.setAttribute('data-mode', mode);
    var btns = document.querySelectorAll('.mp-mode');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-mode') === mode;
      btns[i].classList.toggle('is-on', on);
      btns[i].setAttribute('aria-checked', String(on));
    }
    applyVisibility();
    if (!opts.silent) {
      if (mode === 'gif') {
        if (format && !/gif/i.test(format.value)) lastNonGif = format.value;
        if (gif) setFormat(gif.value);
      } else {
        if (was === 'gif' && lastNonGif) setFormat(lastNonGif);
        if (mode === 'convert') { var whole = $('reset-trim'); if (whole) whole.click(); }
      }
    }
    runLabel();
  }

  // ------------------------------------------------------------ toolbar
  function wire(id, targetId) {
    var b = $(id);
    var t = $(targetId);
    if (b && t) b.addEventListener('click', function () { t.click(); });
  }
  wire('mp-open', 'drop');
  wire('mp-play', 'play-clip');
  wire('mp-whole', 'reset-trim');
  wire('mp-export', 'run');
  var modeBtns = document.querySelectorAll('.mp-mode');
  for (var m = 0; m < modeBtns.length; m++) {
    (function (btn) { btn.addEventListener('click', function () { setMode(btn.getAttribute('data-mode')); }); })(modeBtns[m]);
  }

  // ------------------------------------------------------------ on load
  function enable() {
    ['mode-clip', 'mode-convert', 'mp-play', 'mp-whole', 'mp-export'].forEach(function (id) {
      var b = $(id); if (b) b.disabled = false;
    });
    var drop = $('drop'); if (drop) drop.classList.add('mp-drop-slim');
    // The intro hint is guidance for the empty screen; the toolbar says the
    // rest once a file is open, so it steps out of the way (it dominated a
    // phone otherwise). Inline style, to beat the flex display on .mp-hint.
    var hint = $('mp-hint'); if (hint) hint.style.display = 'none';
    var g = $('mode-gif');
    var opt = gifOption();
    if (g) g.disabled = !opt || opt.disabled;
    // Remember the starting (non-GIF) format so GIF mode can hand it back.
    if (format && !/gif/i.test(format.value)) lastNonGif = format.value;
    // Re-assert the current mode against the freshly built controls.
    setMode(mode, { silent: mode !== 'gif' });
    syncFromRanges();
    syncPlayhead();
  }
  preview.addEventListener('loadedmetadata', enable);
  // If a file is somehow already loaded (bfcache), catch up.
  if (preview.readyState >= 1 && !loaded.classList.contains('hidden')) enable();
})();

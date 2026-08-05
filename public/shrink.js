/* LOC.1999 shrink tool. Vanilla JS, no build step.
 *
 * Re-renders each page at a chosen resolution and re-compresses it, which is
 * what makes an oversized scan small. The text is laid back over each page
 * invisibly so it stays selectable. It never claims a saving it did not make:
 * the before and after are measured and shown, and a result that came out
 * larger says so.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var dropzone = $('drop');
  var fileInput = $('file-input');
  var statusEl = $('status');
  var errorEl = $('error');
  var controls = $('controls');
  var resultEl = $('result');
  var outputEl = $('output');

  var doc = null;
  var sourceSize = 0;
  var sourceName = '';
  var liveUrls = [];

  /* Each strength is a render scale (roughly a target DPI: scale 1 is 72 DPI)
   * and a JPEG quality. Medium — about 100 DPI — is the sweet spot for a scan
   * that is readable but not oversized. */
  var STRENGTHS = {
    light: { scale: 2.0, quality: 0.82 },
    medium: { scale: 1.4, quality: 0.72 },
    strong: { scale: 1.0, quality: 0.58 },
  };

  function setStatus(m) { statusEl.textContent = m; }
  function fail(m) { errorEl.textContent = m; statusEl.textContent = ''; $('shrink').disabled = false; }
  function clearError() { errorEl.textContent = ''; }
  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function bytesLabel(n) {
    return n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
  }
  function strength() {
    var picked = document.querySelector('input[name="strength"]:checked');
    return STRENGTHS[picked ? picked.value : 'medium'];
  }

  function resetOutput() {
    liveUrls.forEach(URL.revokeObjectURL);
    liveUrls = [];
    outputEl.innerHTML = '';
    resultEl.textContent = '';
  }

  function open(file) {
    clearError();
    resetOutput();
    controls.className = 'hidden';
    window.LOC1999_RENDER.loadEngines(setStatus)
      .then(function () { return file.arrayBuffer(); })
      .then(function (buf) {
        setStatus('Opening…');
        return window.LOC1999_RENDER.open(new Uint8Array(buf)).then(function (opened) {
          doc = opened;
          sourceSize = file.size;
          sourceName = file.name;
          setStatus('');
          controls.className = '';
          resultEl.innerHTML = '<strong>Opened:</strong> ' + doc.numPages + ' page' +
            (doc.numPages === 1 ? '' : 's') + ', ' + bytesLabel(sourceSize) + '. Pick a strength and shrink.';
        });
      })
      .catch(function (err) {
        fail(err && err.name === 'PasswordException'
          ? 'That PDF needs a password to open. Unlock it first, then shrink it.'
          : (err && err.message) || 'Could not open that PDF.');
      });
  }

  function shrink() {
    if (!doc) return;
    clearError();
    resetOutput();
    $('shrink').disabled = true;
    var s = strength();
    var withText = $('keep-text').checked;
    var total = doc.numPages;
    var pages = [];
    var chain = Promise.resolve();

    for (var i = 0; i < total; i++) {
      (function (index) {
        chain = chain.then(function () {
          setStatus('Shrinking… page ' + (index + 1) + ' of ' + total);
          return window.LOC1999_RENDER.renderPage(doc, index, {
            scale: s.scale, mime: 'image/jpeg', quality: s.quality, withText: withText,
          }).then(function (page) { pages.push(page); });
        });
      })(i);
    }

    chain.then(function () {
      setStatus('Writing the smaller PDF…');
      return window.LOC1999_SIGN.buildPdfFromPages(pages);
    }).then(function (out) {
      setStatus('');
      $('shrink').disabled = false;
      var blob = new Blob([out], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      liveUrls.push(url);
      var outName = (sourceName || 'document').replace(/\.[^.]+$/, '') + '-small.pdf';
      var smaller = blob.size < sourceSize;
      var pct = Math.round((1 - blob.size / sourceSize) * 100);
      resultEl.innerHTML = smaller
        ? '<strong>Was ' + bytesLabel(sourceSize) + ' &rarr; now ' + bytesLabel(blob.size) + '</strong> (' +
          pct + '% smaller).'
        : '<strong>No smaller.</strong> Was ' + bytesLabel(sourceSize) + ', this came out ' + bytesLabel(blob.size) +
          '. This PDF was already efficient &mdash; keep your original.';
      outputEl.innerHTML = '<ul class="plain"><li><a href="' + url + '" download="' + esc(outName) + '">' +
        esc(outName) + '</a>' + (smaller ? '' : ' <span class="note">(the shrunk version, if you still want it)</span>') +
        '</li></ul>';
    }).catch(function (err) {
      fail((err && err.message) || 'Could not shrink that PDF.');
    });
  }

  // ------------------------------------------------------------------ wiring
  dropzone.addEventListener('click', function () { fileInput.click(); });
  dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files[0]) open(fileInput.files[0]);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach(function (n) {
    dropzone.addEventListener(n, function (e) { e.preventDefault(); dropzone.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (n) {
    dropzone.addEventListener(n, function (e) { e.preventDefault(); dropzone.classList.remove('is-over'); });
  });
  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files[0]) open(e.dataTransfer.files[0]);
  });
  $('shrink').addEventListener('click', shrink);
})();

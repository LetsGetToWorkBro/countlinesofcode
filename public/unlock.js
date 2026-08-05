/* LOC.1999 unlock tool. Vanilla JS, no build step.
 *
 * Removes an owner restriction (no-print/no-copy) by opening the PDF with
 * pdf.js — which decrypts it to render — and rebuilding it as a fresh, entirely
 * unencrypted document. A file that needs a password to *open* is properly
 * encrypted; the reader asks for that password, and it is never sent anywhere,
 * because there is nowhere to send it.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var dropzone = $('drop');
  var fileInput = $('file-input');
  var statusEl = $('status');
  var errorEl = $('error');
  var resultEl = $('result');
  var outputEl = $('output');

  var liveUrls = [];
  // High enough that text stays crisp when it becomes an image; JPEG keeps the
  // size sane. Text is laid back over the image as an invisible selectable layer.
  var SCALE = 2;
  var QUALITY = 0.92;

  function setStatus(m) { statusEl.textContent = m; }
  function fail(m) { errorEl.textContent = m; statusEl.textContent = ''; }
  function clearError() { errorEl.textContent = ''; }
  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function bytesLabel(n) {
    return n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
  }

  function resetOutput() {
    liveUrls.forEach(URL.revokeObjectURL);
    liveUrls = [];
    outputEl.innerHTML = '';
    resultEl.textContent = '';
  }

  /* Open with pdf.js, asking for a password only if the file truly needs one to
   * open. An owner-restricted file opens with an empty password, so most files
   * never see a prompt. */
  function openDocument(bytes) {
    function attempt(password) {
      return window.LOC1999_RENDER.open(bytes, { password: password }).catch(function (err) {
        if (err && (err.name === 'PasswordException' || err.code === 1 || err.code === 2)) {
          var again = err.code === 2; // 2 = an incorrect password was given
          var entered = window.prompt(
            again
              ? 'That password was not right. Try again, or Cancel:'
              : 'This PDF needs a password to open. It stays in your browser:',
          );
          if (entered === null) throw new Error('Cancelled — this PDF needs its open password.');
          return attempt(entered);
        }
        throw err;
      });
    }
    return attempt('');
  }

  function open(file) {
    clearError();
    resetOutput();
    window.LOC1999_RENDER.loadEngines(setStatus)
      .then(function () { return file.arrayBuffer(); })
      .then(function (buf) {
        var bytes = new Uint8Array(buf);
        setStatus('Opening…');
        return openDocument(bytes).then(function (doc) {
          return rebuild(doc, file.name);
        });
      })
      .catch(function (err) {
        fail((err && err.message) || 'Could not open that PDF.');
      });
  }

  function rebuild(doc, name) {
    var total = doc.numPages;
    var pages = [];
    var chain = Promise.resolve();
    for (var i = 0; i < total; i++) {
      (function (index) {
        chain = chain.then(function () {
          setStatus('Rebuilding… page ' + (index + 1) + ' of ' + total);
          return window.LOC1999_RENDER.renderPage(doc, index, {
            scale: SCALE, mime: 'image/jpeg', quality: QUALITY, withText: true,
          }).then(function (page) { pages.push(page); });
        });
      })(i);
    }
    return chain.then(function () {
      setStatus('Writing the unlocked PDF…');
      return window.LOC1999_SIGN.buildPdfFromPages(pages);
    }).then(function (out) {
      setStatus('');
      var blob = new Blob([out], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      liveUrls.push(url);
      var outName = (name || 'document').replace(/\.[^.]+$/, '') + '-unlocked.pdf';
      resultEl.innerHTML = '<strong>Unlocked.</strong> ' + total + ' page' + (total === 1 ? '' : 's') +
        ', ' + bytesLabel(blob.size) + '. No restrictions, text still selectable.';
      outputEl.innerHTML = '<ul class="plain"><li><a href="' + url + '" download="' + esc(outName) + '">' +
        esc(outName) + '</a></li></ul>';
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
})();

/* 1999.LOC shrink tool. Vanilla JS, no build step.
 *
 * Two kinds of file, one idea: something was stored at a far higher resolution
 * than anyone needs, so re-encode it at a sensible one.
 *
 * A PDF has each page re-rendered and re-compressed, which is what makes an
 * oversized scan small, with the text laid back over each page invisibly so it
 * stays selectable. A picture is scaled to a sensible longest side and
 * re-encoded. The strengths mean the same thing to both.
 *
 * It never claims a saving it did not make: the before and after are measured
 * and shown, and a result that came out larger says so.
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

  var doc = null;          // an open PDF, or null
  var picture = null;      // a loaded <img>, or null. Never both.
  var sourceSize = 0;
  var sourceName = '';
  var sourceType = '';
  var liveUrls = [];

  /* Each strength is a render scale (roughly a target DPI: scale 1 is 72 DPI)
   * and a JPEG quality. Medium — about 100 DPI — is the sweet spot for a scan
   * that is readable but not oversized. */
  var STRENGTHS = {
    light: { scale: 2.0, quality: 0.82 },
    medium: { scale: 1.4, quality: 0.72 },
    strong: { scale: 1.0, quality: 0.58 },
  };

  /* The same three names for a picture, where the lever is a longest side
   * rather than a render scale. 1800px is a photograph that still looks like
   * one on any screen somebody is going to open it on; 1200 is small enough
   * that you can tell, which is what Strong is for. */
  var PICTURE_STRENGTHS = {
    light: { maxSide: 2600, quality: 0.85 },
    medium: { maxSide: 1800, quality: 0.74 },
    strong: { maxSide: 1200, quality: 0.60 },
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
  function strengthName() {
    var picked = document.querySelector('input[name="strength"]:checked');
    return picked ? picked.value : 'medium';
  }
  function strength() { return STRENGTHS[strengthName()]; }
  function pictureStrength() { return PICTURE_STRENGTHS[strengthName()]; }

  function resetOutput() {
    liveUrls.forEach(URL.revokeObjectURL);
    liveUrls = [];
    outputEl.innerHTML = '';
    resultEl.textContent = '';
  }

  /* What this is, decided by the bytes rather than by the extension: a file
     saved from a phone routinely arrives as .jpg holding a PNG, and a wrong
     guess here is a confusing error three steps later. */
  function sniff(bytes) {
    var b = bytes;
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return '';
  }

  function open(file) {
    clearError();
    resetOutput();
    controls.className = 'hidden';
    doc = null;
    picture = null;

    file.arrayBuffer().then(function (buf) {
      var kind = sniff(new Uint8Array(buf.slice(0, 16)));
      if (kind === 'pdf') return openPdf(file);
      if (kind === 'gif') {
        throw new Error('A GIF would come back as a single frame, which is not a smaller version of what you gave it. Video tools is where a GIF belongs.');
      }
      if (kind) return openPicture(file, kind);
      throw new Error('That is not a PDF or a picture this can read. It takes PDF, JPEG, PNG, WebP and BMP.');
    }).catch(function (err) {
      fail((err && err.message) || 'Could not open that file.');
    });
  }

  function openPicture(file, mime) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        picture = img;
        sourceSize = file.size;
        sourceName = file.name;
        sourceType = mime;
        setStatus('');
        controls.className = '';
        // The text layer is a PDF idea and means nothing to a picture.
        $('keep-text-row').className = 'note hidden';
        resultEl.innerHTML = '<strong>Opened:</strong> ' + img.naturalWidth + ' &times; ' +
          img.naturalHeight + ', ' + bytesLabel(sourceSize) + '. Pick a strength and shrink.';
        if ($('shrink')) $('shrink').focus();
        resolve();
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That picture could not be opened. It may be damaged.'));
      };
      img.src = url;
    });
  }

  function openPdf(file) {
    $('keep-text-row').className = 'note';
    return window.LOC1999_RENDER.loadEngines(setStatus)
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
          // Focus the action so it is one key away once a file is open.
          if ($('shrink')) $('shrink').focus();
        });
      })
      .catch(function (err) {
        throw new Error(err && err.name === 'PasswordException'
          ? 'That PDF needs a password to open. Unlock it first, then shrink it.'
          : (err && err.message) || 'Could not open that PDF.');
      });
  }

  // ------------------------------------------------------------- pictures

  /* Whether any pixel is see-through, which decides what it can be saved as.
     Only asked of the formats that can carry transparency: a JPEG never can,
     and scanning one would be megabytes of work to learn nothing. */
  function hasAlpha(canvas, ctx) {
    var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (var i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
    return false;
  }

  function shrinkPicture() {
    var s = pictureStrength();
    var w = picture.naturalWidth;
    var h = picture.naturalHeight;
    var longest = Math.max(w, h);
    // Only ever down. A picture blown up to meet the setting would be bigger
    // in both senses, which is the opposite of the one thing this does.
    var factor = longest > s.maxSide ? s.maxSide / longest : 1;
    var outW = Math.max(1, Math.round(w * factor));
    var outH = Math.max(1, Math.round(h * factor));

    var canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(picture, 0, 0, outW, outH);

    var seeThrough = (sourceType === 'image/png' || sourceType === 'image/webp') && hasAlpha(canvas, ctx);
    // Transparency has to survive, and WebP is the only thing here that keeps
    // it and still compresses. Where a browser cannot write WebP, toBlob hands
    // back a PNG under a different name, so the answer is checked rather than
    // assumed.
    var want = seeThrough ? 'image/webp' : 'image/jpeg';

    setStatus('Shrinking…');
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error('This browser would not re-encode that picture.')); return; }
        resolve({ blob: blob, width: outW, height: outH, from: [w, h] });
      }, want, s.quality);
    });
  }

  /* One place that reports a result, because the honesty is the feature: the
     two sizes, the percentage, and a plain sentence when it did not work. */
  function report(blob, outName, extra) {
    var url = URL.createObjectURL(blob);
    liveUrls.push(url);
    var smaller = blob.size < sourceSize;
    var pct = Math.round((1 - blob.size / sourceSize) * 100);
    resultEl.innerHTML = (smaller
      ? '<strong>Was ' + bytesLabel(sourceSize) + ' &rarr; now ' + bytesLabel(blob.size) + '</strong> (' +
        pct + '% smaller).'
      : '<strong>No smaller.</strong> Was ' + bytesLabel(sourceSize) + ', this came out ' +
        bytesLabel(blob.size) + '. It was already efficient, so keep your original.') +
      (extra ? ' <span class="note">' + extra + '</span>' : '');
    outputEl.innerHTML = '<ul class="plain"><li><a href="' + url + '" download="' + esc(outName) + '">' +
      esc(outName) + '</a>' + (smaller ? '' : ' <span class="note">(the shrunk version, if you still want it)</span>') +
      '</li></ul>';
  }

  function stem() { return (sourceName || 'file').replace(/\.[^.]+$/, ''); }

  function shrink() {
    if (!doc && !picture) return;
    clearError();
    resetOutput();
    $('shrink').disabled = true;

    if (picture) {
      shrinkPicture().then(function (out) {
        setStatus('');
        $('shrink').disabled = false;
        var ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }[out.blob.type] || 'jpg';
        var sized = out.from[0] === out.width
          ? 'Kept at ' + out.width + ' &times; ' + out.height + ', re-encoded.'
          : out.from[0] + ' &times; ' + out.from[1] + ' &rarr; ' + out.width + ' &times; ' + out.height + '.';
        report(out.blob, stem() + '-small.' + ext, sized + ' Saved as ' + ext.toUpperCase() + '.');
      }).catch(function (err) {
        fail((err && err.message) || 'Could not shrink that picture.');
      });
      return;
    }

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
      report(blob, stem() + '-small.pdf', total + (total === 1 ? ' page.' : ' pages.'));
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

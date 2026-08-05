/* LOC.1999 sign & redact. Vanilla JS, no build step.
 *
 * Two heavy things load on first file open, both from this origin:
 *   /vendor/pdf.min.mjs  — pdf.js, to render pages so you can see where to click
 *   /pdfsign.js          — pdf-lib, to write the result
 *
 * Nothing in this file uploads anything. There is no fetch() to any endpoint,
 * and that is a property worth keeping.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var dropzone = $('drop');
  var fileInput = $('file-input');
  var statusEl = $('status');
  var errorEl = $('error');
  var editor = $('editor');
  var view = $('view');
  var overlay = $('overlay');
  var pageLabel = $('page-label');
  var editsEl = $('edits');
  var summaryEl = $('summary');
  var outputEl = $('output');
  var sigPad = $('sig-pad');

  var pdfjs = null;      // the pdf.js module
  var doc = null;        // pdf.js document
  var sourceBytes = null;
  var pageIndex = 0;
  var viewport = null;   // pdf.js viewport for the page on screen
  var edits = [];
  var liveUrls = [];

  /* Rendering wide enough to click accurately without melting a phone. The
   * value is a display scale; redaction re-renders at twice this for output. */
  var VIEW_WIDTH = 660;
  var RASTER_SCALE = 2;

  // ---------------------------------------------------------------- helpers
  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fail(message) { errorEl.textContent = message; statusEl.textContent = ''; }
  function clearError() { errorEl.textContent = ''; }
  function currentTool() {
    var picked = document.querySelector('input[name="tool"]:checked');
    return picked ? picked.value : 'text';
  }
  function bytesLabel(n) {
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // ------------------------------------------------------------- the engines
  var loading = null;
  function loadEngines() {
    if (pdfjs && window.LOC1999_SIGN) return Promise.resolve();
    if (loading) return loading;
    statusEl.textContent = 'Loading the PDF engines (about 700 KB, once)…';
    loading = Promise.all([
      import('/vendor/pdf.min.mjs').then(function (mod) {
        pdfjs = mod;
        // The renderer runs in a Worker. Same origin, so the CSP allows it.
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
      }),
      new Promise(function (resolve, reject) {
        if (window.LOC1999_SIGN) return resolve();
        var script = document.createElement('script');
        script.src = '/pdfsign.js';
        script.onload = resolve;
        script.onerror = function () { reject(new Error('Could not load the PDF writer.')); };
        document.head.appendChild(script);
      }),
    ]).then(function () { statusEl.textContent = ''; }, function (err) {
      loading = null;
      throw err;
    });
    return loading;
  }

  // ------------------------------------------------------------ opening a file
  function open(file) {
    clearError();
    resetOutput();
    loadEngines()
      .then(function () { return file.arrayBuffer(); })
      .then(function (data) {
        sourceBytes = new Uint8Array(data);
        // pdf.js takes ownership of the buffer it is given, so it gets a copy.
        /* standardFontDataUrl and cMapUrl matter more here than in a viewer.
         * Without them pdf.js substitutes fonts and blanks CJK text — and on a
         * page you redact, whatever was rendered is what the output *becomes*.
         * A wrong render would be baked in permanently. Both are fetched from
         * this origin, per document, only when one is actually needed. */
        return pdfjs.getDocument({
          data: sourceBytes.slice(),
          standardFontDataUrl: '/vendor/standard_fonts/',
          cMapUrl: '/vendor/cmaps/',
          cMapPacked: true,
        }).promise;
      })
      .then(function (loaded) {
        doc = loaded;
        pageIndex = 0;
        edits = [];
        editor.className = '';
        return renderPage();
      })
      .catch(function (err) {
        fail(
          err && err.name === 'PasswordException'
            ? 'That PDF needs a password to open, so this tool cannot open it either. That is deliberate.'
            : (err && err.message) || 'Could not open that PDF.',
        );
      });
  }

  function renderPage() {
    return doc.getPage(pageIndex + 1).then(function (page) {
      var base = page.getViewport({ scale: 1 });
      var scale = VIEW_WIDTH / base.width;
      viewport = page.getViewport({ scale: scale });

      view.width = Math.floor(viewport.width);
      view.height = Math.floor(viewport.height);
      overlay.width = view.width;
      overlay.height = view.height;

      pageLabel.textContent = 'Page ' + (pageIndex + 1) + ' of ' + doc.numPages;
      return page.render({ canvasContext: view.getContext('2d'), viewport: viewport }).promise;
    }).then(drawOverlay);
  }

  /* The overlay shows what you have added, in the same place it will end up.
   * It is drawn from the same edit list the writer consumes, so the preview
   * cannot drift from the result. */
  function drawOverlay() {
    var ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    var s = viewport.scale;

    edits.forEach(function (edit) {
      if (edit.page !== pageIndex) return;
      if (edit.kind === 'redact') {
        ctx.fillStyle = '#000000';
        ctx.fillRect(edit.rect.x * s, overlay.height - (edit.rect.y + edit.rect.height) * s,
          edit.rect.width * s, edit.rect.height * s);
      } else if (edit.kind === 'text') {
        ctx.fillStyle = '#000000';
        ctx.font = (edit.size * s) + 'px Helvetica, Arial, sans-serif';
        ctx.textBaseline = 'alphabetic';
        edit.value.split('\n').forEach(function (line, i) {
          ctx.fillText(line, edit.at.x * s, overlay.height - edit.at.y * s + i * edit.size * s * 1.2);
        });
      } else if (edit.kind === 'stamp') {
        var img = edit.preview;
        if (!img) return;
        var w = edit.width * s;
        var h = (img.height / img.width) * w;
        ctx.drawImage(img, edit.at.x * s, overlay.height - edit.at.y * s);
        void h;
      }
    });

    var mine = edits.filter(function (e) { return e.page === pageIndex; }).length;
    var reds = window.LOC1999_SIGN.usefulRedactions(edits).length;
    editsEl.innerHTML = edits.length
      ? esc(edits.length + ' edit' + (edits.length === 1 ? '' : 's') + ' in total, ' + mine + ' on this page.') +
        (reds ? ' <strong>' + reds + ' redaction' + (reds === 1 ? '' : 's') +
          '</strong> — those pages will be flattened to images when you save.' : '')
      : 'Nothing added yet.';
  }

  // ------------------------------------------------------------- placing edits
  function canvasPoint(event) {
    var rect = overlay.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (overlay.width / rect.width),
      y: (event.clientY - rect.top) * (overlay.height / rect.height),
    };
  }

  var dragFrom = null;

  overlay.addEventListener('pointerdown', function (event) {
    if (!doc) return;
    if (currentTool() === 'redact') {
      dragFrom = canvasPoint(event);
      overlay.setPointerCapture(event.pointerId);
    }
  });

  overlay.addEventListener('pointermove', function (event) {
    if (!dragFrom) return;
    var to = canvasPoint(event);
    drawOverlay();
    var ctx = overlay.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(Math.min(dragFrom.x, to.x), Math.min(dragFrom.y, to.y),
      Math.abs(to.x - dragFrom.x), Math.abs(to.y - dragFrom.y));
  });

  overlay.addEventListener('pointerup', function (event) {
    if (!doc) return;
    var point = canvasPoint(event);

    if (dragFrom) {
      var rect = window.LOC1999_SIGN.canvasRectToPdf(dragFrom, point, viewport);
      dragFrom = null;
      if (rect.width < window.LOC1999_SIGN.MIN_REDACTION_POINTS ||
          rect.height < window.LOC1999_SIGN.MIN_REDACTION_POINTS) {
        drawOverlay();
        return fail('That box is too small to be a selection. Drag across the text you want gone.');
      }
      clearError();
      edits.push({ kind: 'redact', page: pageIndex, rect: rect });
      return drawOverlay();
    }

    var at = window.LOC1999_SIGN.canvasToPdf(point, viewport);

    if (currentTool() === 'text') {
      var value = $('text-value').value;
      if (!value) return fail('Type the text first, then click where it goes.');
      clearError();
      edits.push({ kind: 'text', page: pageIndex, at: at, value: value, size: Number($('text-size').value) || 12 });
      return drawOverlay();
    }

    if (currentTool() === 'stamp') {
      signaturePng().then(function (png) {
        if (!png) return fail('Draw or type a signature first, then click where it goes.');
        clearError();
        var img = new Image();
        img.onload = function () {
          edits.push({
            kind: 'stamp', page: pageIndex, at: at, png: png.bytes,
            width: Number($('sig-width').value) || 160, preview: img,
          });
          drawOverlay();
        };
        img.src = png.url;
      });
    }
  });

  // --------------------------------------------------------------- signature
  var padCtx = sigPad.getContext('2d');
  var drawing = false;
  var padUsed = false;

  function padPoint(event) {
    var rect = sigPad.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (sigPad.width / rect.width),
      y: (event.clientY - rect.top) * (sigPad.height / rect.height),
    };
  }

  padCtx.lineWidth = 2.5;
  padCtx.lineCap = 'round';
  padCtx.lineJoin = 'round';
  padCtx.strokeStyle = '#000000';

  sigPad.addEventListener('pointerdown', function (event) {
    drawing = true;
    padUsed = true;
    sigPad.setPointerCapture(event.pointerId);
    var p = padPoint(event);
    padCtx.beginPath();
    padCtx.moveTo(p.x, p.y);
    event.preventDefault();
  });
  sigPad.addEventListener('pointermove', function (event) {
    if (!drawing) return;
    var p = padPoint(event);
    padCtx.lineTo(p.x, p.y);
    padCtx.stroke();
    event.preventDefault();
  });
  sigPad.addEventListener('pointerup', function () { drawing = false; });
  $('sig-clear').addEventListener('click', function () {
    padCtx.clearRect(0, 0, sigPad.width, sigPad.height);
    padUsed = false;
  });

  /* Turn whatever the signature box holds into a transparent PNG, trimmed to
   * the ink so it does not place a big empty rectangle on the page. */
  function signaturePng() {
    var typed = $('sig-typed').value.trim();
    var canvas;

    if (padUsed) {
      canvas = sigPad;
    } else if (typed) {
      canvas = document.createElement('canvas');
      canvas.width = 900;
      canvas.height = 220;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000000';
      ctx.font = '86px ' + $('sig-font').value;
      ctx.textBaseline = 'middle';
      ctx.fillText(typed, 10, canvas.height / 2);
    } else {
      return Promise.resolve(null);
    }

    var trimmed = trim(canvas);
    return new Promise(function (resolve) {
      trimmed.toBlob(function (blob) {
        blob.arrayBuffer().then(function (buf) {
          resolve({ bytes: new Uint8Array(buf), url: URL.createObjectURL(blob) });
        });
      }, 'image/png');
    });
  }

  function trim(canvas) {
    var ctx = canvas.getContext('2d');
    var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    var minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0, found = false;
    for (var y = 0; y < canvas.height; y++) {
      for (var x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] > 8) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!found) return canvas;
    var pad = 6;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(canvas.width - 1, maxX + pad); maxY = Math.min(canvas.height - 1, maxY + pad);

    var out = document.createElement('canvas');
    out.width = maxX - minX + 1;
    out.height = maxY - minY + 1;
    out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  // -------------------------------------------------------------------- save
  function resetOutput() {
    liveUrls.forEach(URL.revokeObjectURL);
    liveUrls = [];
    outputEl.innerHTML = '';
    summaryEl.textContent = '';
  }

  /* Render one page to a PNG with its redaction boxes painted in. This is what
   * makes a redaction real: the output page is these pixels, and the original
   * content stream is never copied across. */
  function rasterise(index) {
    return doc.getPage(index + 1).then(function (page) {
      var vp = page.getViewport({ scale: RASTER_SCALE });
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      var ctx = canvas.getContext('2d');
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        ctx.fillStyle = '#000000';
        window.LOC1999_SIGN.usefulRedactions(edits)
          .filter(function (e) { return e.page === index; })
          .forEach(function (e) {
            ctx.fillRect(
              e.rect.x * RASTER_SCALE,
              canvas.height - (e.rect.y + e.rect.height) * RASTER_SCALE,
              e.rect.width * RASTER_SCALE,
              e.rect.height * RASTER_SCALE,
            );
          });
        return new Promise(function (resolve) {
          canvas.toBlob(function (blob) {
            blob.arrayBuffer().then(function (buf) {
              resolve({ page: index, png: new Uint8Array(buf) });
            });
          }, 'image/png');
        });
      });
    });
  }

  function save() {
    clearError();
    resetOutput();
    if (!edits.length) return fail('Nothing has been added yet.');

    var needed = Array.from(window.LOC1999_SIGN.pagesNeedingRaster(
      window.LOC1999_SIGN.usefulRedactions(edits),
    ));
    statusEl.textContent = needed.length
      ? 'Flattening ' + needed.length + ' redacted page' + (needed.length === 1 ? '' : 's') + '…'
      : 'Writing the PDF…';
    $('save').disabled = true;

    needed
      .reduce(function (chain, index) {
        return chain.then(function (list) {
          return rasterise(index).then(function (raster) { return list.concat([raster]); });
        });
      }, Promise.resolve([]))
      .then(function (rasters) {
        statusEl.textContent = 'Writing the PDF…';
        return window.LOC1999_SIGN.applyEdits(sourceBytes, edits, rasters);
      })
      .then(function (out) {
        $('save').disabled = false;
        statusEl.textContent = '';
        var blob = new Blob([out], { type: 'application/pdf' });
        var url = URL.createObjectURL(blob);
        liveUrls.push(url);
        summaryEl.textContent =
          edits.length + ' edit' + (edits.length === 1 ? '' : 's') + ' applied' +
          (needed.length ? ', ' + needed.length + ' page' + (needed.length === 1 ? '' : 's') + ' flattened' : '') +
          '. ' + bytesLabel(blob.size) + '.';
        outputEl.innerHTML = '<ul class="plain"><li><a href="' + url + '" download="signed.pdf">signed.pdf</a></li></ul>';
      })
      .catch(function (err) {
        $('save').disabled = false;
        fail((err && err.message) || 'Could not write that PDF.');
      });
  }

  // ------------------------------------------------------------------ wiring
  dropzone.addEventListener('click', function () { fileInput.click(); });
  dropzone.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
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

  $('prev').addEventListener('click', function () {
    if (pageIndex > 0) { pageIndex--; renderPage(); }
  });
  $('next').addEventListener('click', function () {
    if (doc && pageIndex < doc.numPages - 1) { pageIndex++; renderPage(); }
  });
  $('undo').addEventListener('click', function () {
    edits.pop();
    clearError();
    drawOverlay();
  });
  $('save').addEventListener('click', save);
  $('sig-width').addEventListener('input', function () {
    $('sig-mm').textContent = Math.round((Number($('sig-width').value) || 0) / 72 * 25.4);
  });
})();

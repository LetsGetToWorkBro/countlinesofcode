/* 1999.LOC file inspector. Vanilla JS, no build step.
 *
 * Loaded on first file open, both from this origin:
 *   /vendor/pdf.min.mjs  — pdf.js, to render pages and list their text
 *   /convert.js          — the ZIP reader and the leak checks
 *
 * Nothing here uploads anything. There is no fetch() to any endpoint, which for
 * this tool in particular is the whole point.
 *
 * The interesting part is the invisible-text check. Rather than trying to
 * understand *how* something was hidden — a black rectangle, white ink, an
 * image laid on top — it renders the page and asks whether each piece of
 * extractable text is actually visible where it claims to be. Flat pixels mean
 * nothing is drawn there that an eye could read, so the text is present but
 * hidden. One test, all three tricks.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var dropzone = $('drop');
  var fileInput = $('file-input');
  var statusEl = $('status');
  var errorEl = $('error');
  var reportEl = $('report');

  var engine = null;
  var pdfjs = null;

  /* Rendering every page of a long document to check it is slow and, past a
   * point, pointless — the leaks repeat. This covers the front of the document,
   * where the damage almost always is, and the page says so. */
  var MAX_PAGES_CHECKED = 20;
  var RENDER_SCALE = 2;

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function setStatus(m) { statusEl.textContent = m; }
  function fail(m) { errorEl.textContent = m; statusEl.textContent = ''; }
  function clearError() { errorEl.textContent = ''; }

  var loading = null;
  function loadEngines() {
    if (pdfjs && window.LOC1999_CONVERT) return Promise.resolve();
    if (loading) return loading;
    setStatus('Loading the inspector (about 700 KB, once)…');
    loading = Promise.all([
      import('/vendor/pdf.min.mjs').then(function (mod) {
        pdfjs = mod;
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
      }),
      new Promise(function (resolve, reject) {
        if (window.LOC1999_CONVERT) return resolve();
        var s = document.createElement('script');
        s.src = '/convert.js';
        s.onload = resolve;
        s.onerror = function () { reject(new Error('Could not load the inspector.')); };
        document.head.appendChild(s);
      }),
    ]).then(function () { engine = window.LOC1999_CONVERT; setStatus(''); },
      function (err) { loading = null; throw err; });
    return loading;
  }

  // ------------------------------------------------- the invisible-text check
  /**
   * For one page: render it, then measure the pixels under every piece of text.
   * A patch with almost no variation in brightness has nothing legible drawn on
   * it, whatever the file thinks is there.
   */
  function hiddenTextOn(doc, index) {
    return doc.getPage(index + 1).then(function (page) {
      // rotation: 0 so the sampled canvas is in the same unrotated user space as
      // the text-item transforms getTextContent returns. Without this, a page
      // with /Rotate 90 renders its pixels rotated while the text coordinates
      // stay unrotated, so every patch is sampled from the wrong place and a
      // black box over a name on a rotated scan is missed entirely.
      var viewport = page.getViewport({ scale: RENDER_SCALE, rotation: 0 });
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      // White backing: an unpainted page is transparent, and transparent pixels
      // would read as flat black and flag the whole page.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      return page.render({ canvasContext: ctx, viewport: viewport }).promise
        .then(function () { return page.getTextContent(); })
        .then(function (content) {
          var found = [];
          var pageHeight = viewport.height / RENDER_SCALE;
          content.items.forEach(function (item) {
            if (!item.str || !item.str.trim()) return;
            var size = Math.hypot(item.transform[2], item.transform[3]) || item.height || 10;
            var width = item.width || size * item.str.length * 0.5;
            // Built from the transform, so rotated text — figure axes, table
            // headers — is measured where it really is rather than beside it.
            var box = engine.textBox(item.transform, width, size, pageHeight, RENDER_SCALE);
            var x = Math.max(0, Math.min(box.x, canvas.width - 1));
            var y = Math.max(0, Math.min(box.y, canvas.height - 1));
            var w = Math.min(box.w, canvas.width - x);
            var h = Math.min(box.h, canvas.height - y);
            if (w <= 0 || h <= 0) return;
            var stats = engine.patchStats(ctx.getImageData(x, y, w, h).data);
            if (engine.looksHidden(stats)) found.push({ page: index, text: item.str });
          });
          return found;
        });
    });
  }

  function inspectPdfFile(bytes) {
    return pdfjs.getDocument({
      data: bytes.slice(),
      standardFontDataUrl: '/vendor/standard_fonts/',
      cMapUrl: '/vendor/cmaps/',
      cMapPacked: true,
    }).promise.then(function (doc) {
      var checked = Math.min(doc.numPages, MAX_PAGES_CHECKED);
      var hidden = [];
      var authors = [];
      var chain = Promise.resolve();

      for (var i = 0; i < checked; i++) {
        (function (index) {
          chain = chain.then(function () {
            setStatus('Checking page ' + (index + 1) + ' of ' + checked + '…');
            return hiddenTextOn(doc, index).then(function (found) {
              hidden = hidden.concat(found);
              return doc.getPage(index + 1).then(function (page) {
                return page.getAnnotations().then(function (annots) {
                  annots.forEach(function (a) { if (a.titleObj && a.titleObj.str) authors.push(a.titleObj.str); });
                }).catch(function () {});
              });
            });
          });
        })(i);
      }

      return chain
        .then(function () {
          return Promise.all([
            doc.getMetadata().catch(function () { return null; }),
            // Read attachments and document JavaScript from pdf.js's parsed
            // structure, not a raw-byte regex: modern PDFs keep these inside
            // compressed object streams the byte scan cannot see, and missing
            // them produced a false "no files attached / no JavaScript" clean.
            doc.getAttachments().catch(function () { return null; }),
            doc.getJSActions().catch(function () { return null; }),
          ]);
        })
        .then(function (res) {
          var meta = res[0];
          var attachments = res[1];
          var jsActions = res[2];
          setStatus('');
          var features = engine.pdfFeaturesFromBytes(bytes);
          features.hiddenText = hidden;
          features.annotationAuthors = authors;
          features.pages = doc.numPages;
          features.pagesChecked = checked;
          if (attachments && Object.keys(attachments).length) features.hasEmbeddedFiles = true;
          if (jsActions && Object.keys(jsActions).length) features.hasJavaScript = true;
          return engine.inspectPdf((meta && meta.info) || {}, features);
        });
    });
  }

  function inspectOfficeFile(bytes, name) {
    return engine.unzip(bytes).then(function (parts) {
      var kind = /\.xlsx$/i.test(name) ? 'xlsx' : /\.pptx$/i.test(name) ? 'pptx' : 'docx';
      // A .docx is the only one with word/document.xml; trust the contents over
      // the file extension, which anyone can rename.
      var names = parts.map(function (p) { return p.name; });
      if (names.indexOf('xl/workbook.xml') >= 0) kind = 'xlsx';
      else if (names.some(function (n) { return n.indexOf('ppt/slides/') === 0; })) kind = 'pptx';
      else if (names.indexOf('word/document.xml') >= 0) kind = 'docx';
      return engine.inspectOoxml(parts, kind);
    });
  }

  // ----------------------------------------------------------------- display
  var WORDS = { high: 'Serious', medium: 'Worth knowing', low: 'Minor' };

  function show(report) {
    var serious = report.leaks.filter(function (l) { return l.severity === 'high'; }).length;
    var kind = report.kind === 'pdf' ? 'PDF'
      : report.kind === 'docx' ? 'Word document'
        : report.kind === 'xlsx' ? 'spreadsheet'
          : report.kind === 'pptx' ? 'presentation' : 'file';

    $('summary').innerHTML = report.leaks.length
      ? '<strong>' + report.leaks.length + ' thing' + (report.leaks.length === 1 ? '' : 's') +
        ' found in this ' + esc(kind) + '</strong>' +
        (serious ? ', <strong class="sev-high">' + serious + ' of them serious</strong>.' : '.')
      : '<strong>Nothing found in this ' + esc(kind) + '.</strong> Every check below came back clean.';

    $('leaks').innerHTML = report.leaks.map(function (leak) {
      return '<div class="leak leak-' + leak.severity + '">' +
        '<p class="leak-head"><span class="sev sev-' + leak.severity + '">' + esc(WORDS[leak.severity]) + '</span> ' +
        '<strong>' + esc(leak.title) + '</strong></p>' +
        '<p class="note">' + esc(leak.detail) + '</p>' +
        (leak.advice ? '<p class="note leak-advice">' + esc(leak.advice) + '</p>' : '') +
        '</div>';
    }).join('');

    $('clean').innerHTML = report.clean.map(function (c) {
      return '<li class="good">&#10003; ' + esc(c) + '</li>';
    }).join('') || '<li class="note">No checks applied to this file type.</li>';
    $('clean-box').className = report.clean.length ? '' : 'hidden';

    reportEl.className = '';
  }

  function open(file) {
    clearError();
    reportEl.className = 'hidden';
    loadEngines()
      .then(function () { return file.arrayBuffer(); })
      .then(function (buf) {
        var bytes = new Uint8Array(buf);
        var isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
        var isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
        setStatus('Reading…');
        if (isPdf) return inspectPdfFile(bytes).then(show);
        if (isZip) return inspectOfficeFile(bytes, file.name).then(function (r) { setStatus(''); show(r); });
        throw new Error('This checks PDFs and Office files (.docx, .xlsx, .pptx). That is neither.');
      })
      .catch(function (err) {
        fail(err && err.name === 'PasswordException'
          ? 'That PDF needs a password to open, so it cannot be checked here.'
          : (err && err.message) || 'Could not read that file.');
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

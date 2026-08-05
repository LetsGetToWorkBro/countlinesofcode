/* 1999.LOC PDF <-> Word page. Vanilla JS, no build step.
 *
 * Loaded on first file open, both from this origin:
 *   /vendor/pdf.min.mjs  — pdf.js, to read PDFs and their structure trees
 *   /convert.js          — the document model, both converters, the verdict
 *
 * Nothing here uploads anything. There is no fetch() to any endpoint.
 *
 * The one thing worth understanding: a tagged PDF describes its own structure,
 * and this reads it. `getStructTree()` gives the roles — H1, P, Table, LI — and
 * the leaves carry marked-content ids; asking for the text content *with*
 * marked content lets each id be joined to the words drawn under it. That join
 * is the difference between translating a document and guessing at one.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var dropzone = $('drop');
  var fileInput = $('file-input');
  var statusEl = $('status');
  var errorEl = $('error');
  var reportEl = $('report');
  var verdictEl = $('verdict');
  var countsEl = $('counts');
  var resultEl = $('result');
  var outputEl = $('output');
  var previewEl = $('preview');

  var engine = null;       // window.LOC1999_CONVERT
  var pdfjs = null;
  var source = null;       // { kind: 'pdf' | 'docx', ... }
  var liveUrls = [];

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function setStatus(m) { statusEl.textContent = m; }
  function fail(m) { errorEl.textContent = m; statusEl.textContent = ''; }
  function clearError() { errorEl.textContent = ''; }
  function bytesLabel(n) {
    return n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
  }

  var loading = null;
  function loadEngines() {
    if (pdfjs && window.LOC1999_CONVERT) return Promise.resolve();
    if (loading) return loading;
    setStatus('Loading the converter (about 700 KB, once)…');
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
        s.onerror = function () { reject(new Error('Could not load the converter.')); };
        document.head.appendChild(s);
      }),
    ]).then(function () {
      engine = window.LOC1999_CONVERT;
      setStatus('');
    }, function (err) { loading = null; throw err; });
    return loading;
  }

  // ------------------------------------------------------------ reading a PDF
  /**
   * Pull out everything the model needs from one page: the positioned text, the
   * structure tree, and the id -> text join. Marked content has to be requested
   * explicitly, and it is what makes the tagged path possible.
   */
  function readPdfPage(doc, index, textById) {
    return doc.getPage(index + 1).then(function (page) {
      var viewport = page.getViewport({ scale: 1 });
      return Promise.all([
        page.getTextContent({ includeMarkedContent: true }),
        page.getStructTree().catch(function () { return null; }),
        page.getOperatorList().catch(function () { return null; }),
      ]).then(function (all) {
        var content = all[0];
        var pieces = [];
        var openIds = [];

        content.items.forEach(function (item) {
          if (item.type === 'beginMarkedContentProps') {
            openIds.push(item.id || null);
            return;
          }
          if (item.type === 'beginMarkedContent') { openIds.push(null); return; }
          if (item.type === 'endMarkedContent') { openIds.pop(); return; }
          if (item.str === undefined) return;

          var id = null;
          for (var i = openIds.length - 1; i >= 0; i--) {
            if (openIds[i]) { id = openIds[i]; break; }
          }
          if (id) textById.set(id, (textById.get(id) || '') + item.str);
          if (!item.str) return;

          var t = item.transform;
          pieces.push({
            str: item.str,
            x: t[4],
            y: t[5],
            width: item.width || 0,
            height: Math.hypot(t[2], t[3]) || item.height || 10,
            fontName: item.fontName || '',
            markedId: id || undefined,
          });
        });

        // Ruling lines mean a drawn table, which changes the advice given.
        var hasLines = false;
        var ops = all[2];
        if (ops && ops.fnArray && pdfjs.OPS) {
          for (var j = 0; j < ops.fnArray.length; j++) {
            if (ops.fnArray[j] === pdfjs.OPS.constructPath) { hasLines = true; break; }
          }
        }

        return {
          page: { width: viewport.width, height: viewport.height, pieces: pieces, hasLines: hasLines },
          tree: all[1],
        };
      });
    });
  }

  function openPdf(bytes, name) {
    return pdfjs.getDocument({
      data: bytes.slice(),
      standardFontDataUrl: '/vendor/standard_fonts/',
      cMapUrl: '/vendor/cmaps/',
      cMapPacked: true,
    }).promise.then(function (doc) {
      var textById = new Map();
      var pages = [];
      var trees = [];
      var chain = Promise.resolve();
      for (var i = 0; i < doc.numPages; i++) {
        (function (index) {
          chain = chain.then(function () {
            setStatus('Reading page ' + (index + 1) + ' of ' + doc.numPages + '…');
            return readPdfPage(doc, index, textById).then(function (got) {
              pages.push(got.page);
              trees.push(got.tree);
            });
          });
        })(i);
      }
      return chain
        .then(function () { return doc.getMetadata().catch(function () { return null; }); })
        .then(function (meta) {
          setStatus('');
          source = {
            kind: 'pdf',
            name: name,
            pdfDoc: doc,
            input: { pages: pages, trees: trees, textById: textById,
              producer: meta && meta.info ? (meta.info.Producer || meta.info.Creator || '') : '',
              title: meta && meta.info ? meta.info.Title || '' : '' },
          };
        });
    });
  }

  // --------------------------------------------------------------------- OCR
  /* A scanned PDF is a photograph of a page: there is no text in it to recover,
   * so the only way through is to read the letters off the picture. Tesseract
   * is vendored here rather than fetched from a CDN — telling a third party
   * that somebody is OCR'ing their payslip is exactly what this site exists not
   * to do — and it is loaded only when someone actually asks for it, because it
   * is eight megabytes. */
  var OCR_MAX_PAGES = 30;
  var OCR_SCALE = 2.2;
  var tesseract = null;

  function loadOcr() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/vendor/tesseract/tesseract.min.js';
      s.onload = function () { resolve(window.Tesseract); };
      s.onerror = function () { reject(new Error('Could not load the text reader.')); };
      document.head.appendChild(s);
    });
  }

  function ocrWorker() {
    if (tesseract) return Promise.resolve(tesseract);
    return loadOcr().then(function (T) {
      // workerBlobURL:false matters: tesseract builds its worker from a blob:
      // URL by default, and this site's policy refuses that. Pointing it at the
      // real file is the fix; widening the policy would not have been.
      return T.createWorker('eng', 1, {
        workerPath: '/vendor/tesseract/worker.min.js',
        corePath: '/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
        langPath: '/vendor/tesseract/',
        gzip: false,
        workerBlobURL: false,
      }).then(function (w) { tesseract = w; return w; });
    });
  }

  /** Read one page's picture, and turn the lines into paragraphs. */
  function ocrPage(doc, index, worker) {
    return doc.getPage(index + 1).then(function (page) {
      var viewport = page.getViewport({ scale: OCR_SCALE });
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return page.render({ canvasContext: ctx, viewport: viewport }).promise
        .then(function () { return worker.recognize(canvas); })
        .then(function (result) { return result.data.text || ''; });
    });
  }

  function runOcr() {
    if (!source || source.kind !== 'pdf') return;
    clearError();
    resetOutput();
    $('ocr').disabled = true;
    var doc = source.pdfDoc;
    var total = Math.min(doc.numPages, OCR_MAX_PAGES);
    var texts = [];

    setStatus('Loading the text reader (about 8 MB, once)…');
    ocrWorker().then(function (worker) {
      var chain = Promise.resolve();
      for (var i = 0; i < total; i++) {
        (function (index) {
          chain = chain.then(function () {
            setStatus('Reading page ' + (index + 1) + ' of ' + total + '… this is slower than it looks');
            return ocrPage(doc, index, worker).then(function (text) { texts.push(text); });
          });
        })(i);
      }
      return chain;
    }).then(function () {
      setStatus('');
      $('ocr').disabled = false;
      var blocks = [];
      texts.forEach(function (text, page) {
        if (page > 0) blocks.push({ kind: 'pageBreak', runs: [] });
        // A blank line is a paragraph break; single newlines are just where the
        // scan ran out of room, so they join with a space.
        text.split(/\n\s*\n/).forEach(function (para) {
          var value = para.replace(/\s*\n\s*/g, ' ').trim();
          if (value) blocks.push({ kind: 'paragraph', runs: [{ text: value }] });
        });
      });
      var built = { blocks: blocks, title: source.input.title || '' };
      source.conversion.doc = built;
      source.conversion.counts = engine.describe(built);
      var c = source.conversion.counts;
      countsEl.innerHTML = '<strong>Read from the picture:</strong> ' + c.paragraphs + ' paragraph' +
        (c.paragraphs === 1 ? '' : 's') + ', ' + c.words.toLocaleString() + ' words' +
        (doc.numPages > total ? ', from the first ' + total + ' of ' + doc.numPages + ' pages.' : '.');
      showVerdict({
        confidence: 'medium',
        summary: 'The text was read off the picture. It is usually good on a clean scan and poor on a bad one.',
        findings: [
          { label: 'Every word came from optical recognition, so proofread it', good: false },
          { label: 'Layout, tables and columns are not recovered: you get the words in order', good: false },
          { label: 'Nothing was uploaded: the reader runs in this tab like everything else', good: true },
        ],
      });
      renderPreview(built);
      $('convert').disabled = false;
      $('ocr-box').className = 'hidden';
    }).catch(function (err) {
      $('ocr').disabled = false;
      fail((err && err.message) || 'Could not read that scan.');
    });
  }

  // ----------------------------------------------------------------- verdict
  function showVerdict(verdict) {
    var word = verdict.confidence === 'high' ? 'Very well'
      : verdict.confidence === 'medium' ? 'Reasonably well' : 'Not well';
    verdictEl.className = 'verdict verdict-' + verdict.confidence;
    verdictEl.innerHTML =
      '<p class="verdict-head"><strong>How well this will go: ' + esc(word) + '</strong></p>' +
      '<p class="note">' + esc(verdict.summary) + '</p>' +
      '<ul class="plain verdict-list">' +
      verdict.findings.map(function (f) {
        return '<li class="' + (f.good ? 'good' : 'caveat') + '">' +
          (f.good ? '&#10003; ' : '&#33; ') + esc(f.label) + '</li>';
      }).join('') + '</ul>';
  }

  function analysePdf() {
    var profile = engine.loadProfile(source.input.producer);
    var conversion = engine.convertPdf(source.input, { headingRatio: profile.headingRatio });
    source.conversion = conversion;
    source.profile = profile;
    showVerdict(conversion.verdict);
    var c = conversion.counts;
    countsEl.innerHTML = '<strong>Found:</strong> ' + c.headings + ' heading' + (c.headings === 1 ? '' : 's') +
      ', ' + c.paragraphs + ' paragraph' + (c.paragraphs === 1 ? '' : 's') +
      ', ' + c.lists + ' list item' + (c.lists === 1 ? '' : 's') +
      ', ' + c.tables + ' table' + (c.tables === 1 ? '' : 's') +
      ', ' + c.words.toLocaleString() + ' words' +
      (conversion.tier === 'tags' ? ', read from the file’s own structure.' : ', worked out from the layout.') +
      (profile.corrections
        ? ' <em>Using ' + profile.corrections + ' correction' + (profile.corrections === 1 ? '' : 's') +
          ' you made for documents from this source.</em>'
        : '');
    $('target-format').className = '';
    $('convert').textContent = 'Convert';
    $('tune').className = conversion.tier === 'geometry' ? '' : 'hidden';
    var isScan = conversion.survey.pieces === 0;
    $('ocr-box').className = isScan ? '' : 'hidden';
    $('convert').disabled = isScan;
    if (isScan) $('tune').className = 'hidden';
    reportEl.className = '';
    renderPreview(conversion.doc);
  }

  function analyseDocx(doc) {
    source.doc = doc;
    var counts = engine.describe(doc);
    showVerdict({
      confidence: 'high',
      summary: 'A Word document says exactly what it is, so nothing has to be guessed.',
      findings: [
        { label: 'Headings, lists and tables are read straight out of the file', good: true },
        { label: 'The PDF gets real selectable text, not a picture of the page', good: true },
        { label: 'Lines break where this typesetter breaks them, not exactly where Word does', good: false },
        { label: 'Images, headers, footers and footnotes are not carried across', good: false },
      ],
    });
    countsEl.innerHTML = '<strong>Found:</strong> ' + counts.headings + ' headings, ' + counts.paragraphs +
      ' paragraphs, ' + counts.lists + ' list items, ' + counts.tables + ' tables, ' +
      counts.words.toLocaleString() + ' words.';
    // A Word document only converts one way here, so the picker is hidden.
    $('target-format').className = 'hidden';
    $('convert').textContent = 'Convert to PDF';
    $('tune').className = 'hidden';
    reportEl.className = '';
    renderPreview(doc);
  }

  /** A plain rendering of the model, so the structure is visible before opening. */
  function renderPreview(doc) {
    var html = '';
    var shown = 0;
    for (var i = 0; i < doc.blocks.length && shown < 40; i++) {
      var b = doc.blocks[i];
      var text = (b.runs || []).map(function (r) { return r.text; }).join('');
      if (b.kind === 'heading') {
        var level = Math.min(Math.max(b.level || 1, 1), 6);
        html += '<p class="pv-h pv-h' + level + '">' + esc(text) + '</p>';
      } else if (b.kind === 'listItem') {
        // Indent by class, not by a style attribute: style-src is 'self', so an
        // inline style is refused and the list would render flat.
        var depth = Math.min(Math.max(b.level || 1, 1), 6);
        html += '<p class="pv-li pv-i' + depth + '">' +
          (b.ordered ? '#' : '&bull;') + ' ' + esc(text) + '</p>';
      } else if (b.kind === 'table') {
        html += '<table class="pv-table">' + (b.rows || []).map(function (row) {
          return '<tr>' + row.map(function (cell) {
            return '<td>' + esc(cell.runs.map(function (r) { return r.text; }).join('')) + '</td>';
          }).join('') + '</tr>';
        }).join('') + '</table>';
      } else if (b.kind === 'pageBreak') {
        html += '<hr class="pv-break">';
      } else {
        html += '<p class="pv-p">' + esc(text) + '</p>';
      }
      shown++;
    }
    if (doc.blocks.length > shown) {
      html += '<p class="note">… and ' + (doc.blocks.length - shown) + ' more blocks.</p>';
    }
    previewEl.innerHTML = html || '<p class="note">Nothing was recovered from this file.</p>';
  }

  // -------------------------------------------------------------------- open
  function open(file) {
    clearError();
    resetOutput();
    reportEl.className = 'hidden';
    source = null;
    loadEngines()
      .then(function () { return file.arrayBuffer(); })
      .then(function (buf) {
        var bytes = new Uint8Array(buf);
        var isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
        var isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
        if (isPdf) {
          setStatus('Reading the PDF…');
          return openPdf(bytes, file.name).then(analysePdf);
        }
        if (isZip) {
          setStatus('Reading the Word document…');
          return engine.readDocx(bytes).then(function (doc) {
            source = { kind: 'docx', name: file.name };
            setStatus('');
            analyseDocx(doc);
          });
        }
        throw new Error('That is neither a PDF nor a .docx. Those are the two this converts between.');
      })
      .catch(function (err) {
        fail(err && err.name === 'PasswordException'
          ? 'That PDF needs a password to open. Unlock it first, then convert it.'
          : (err && err.message) || 'Could not open that file.');
      });
  }

  function resetOutput() {
    liveUrls.forEach(URL.revokeObjectURL);
    liveUrls = [];
    outputEl.innerHTML = '';
    resultEl.textContent = '';
  }

  function offer(bytes, name, type) {
    var blob = new Blob([bytes], { type: type });
    var url = URL.createObjectURL(blob);
    liveUrls.push(url);
    outputEl.innerHTML = '<ul class="plain"><li><a href="' + url + '" download="' + esc(name) + '">' +
      esc(name) + '</a> <span class="note">' + bytesLabel(blob.size) + '</span></li></ul>';
  }

  function baseName(name) { return (name || 'document').replace(/\.[^.]+$/, ''); }

  function convert() {
    if (!source) return;
    clearError();
    resetOutput();
    $('convert').disabled = true;
    setStatus('Converting…');

    var work;
    if (source.kind !== 'pdf') {
      work = engine.writePdf(source.doc).then(function (out) {
        offer(out, baseName(source.name) + '.pdf', 'application/pdf');
        resultEl.innerHTML = '<strong>Converted to PDF.</strong> The text is real text: you can select and search it.';
      });
    } else if ($('target-format').value === 'epub') {
      work = engine.writeEpub(source.conversion.doc, { title: source.input.title || baseName(source.name) })
        .then(function (out) {
          offer(out, baseName(source.name) + '.epub', 'application/epub+zip');
          resultEl.innerHTML = '<strong>Converted to EPUB.</strong> Send it to a phone or e-reader; the text re-flows to the screen.';
        });
    } else {
      work = engine.writeDocx(source.conversion.doc).then(function (out) {
        offer(out, baseName(source.name) + '.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        resultEl.innerHTML = '<strong>Converted to Word.</strong> Open it and check the parts the verdict warned about.';
      });
    }

    work.then(function () {
      $('convert').disabled = false;
      setStatus('');
    }).catch(function (err) {
      $('convert').disabled = false;
      fail((err && err.message) || 'Could not convert that file.');
    });
  }

  /* Local learning: a nudge is stored against the producer of the PDF, in this
   * browser only, and re-applied the next time a document from the same source
   * is opened. */
  function nudge(direction) {
    if (!source || source.kind !== 'pdf') return;
    var profile = engine.learn(source.input.producer, direction);
    $('learned').innerHTML = ' <em>Remembered (' + profile.corrections + ' correction' +
      (profile.corrections === 1 ? '' : 's') + ' for this source).</em>';
    resetOutput();
    analysePdf();
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

  $('convert').addEventListener('click', convert);
  $('ocr').addEventListener('click', runOcr);
  $('fewer').addEventListener('click', function () { nudge('fewer'); });
  $('more').addEventListener('click', function () { nudge('more'); });
})();

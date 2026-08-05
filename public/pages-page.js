/* 1999.LOC PDF page arranger. Vanilla JS, no build step.
 *
 * Loaded on first file open, both from this origin:
 *   /vendor/pdf.min.mjs — pdf.js, to draw the thumbnails
 *   /pdfsign.js         — the engine, which carries pdf-lib and the page model
 *
 * Nothing here uploads anything. There is no fetch() to any endpoint.
 *
 * The state is one flat array of page references — which document, which page,
 * how far turned. Every button rewrites that array and re-renders; the PDF is
 * only built when someone saves. Thumbnails are rendered once per source page
 * and cached, so reordering a hundred pages costs nothing.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $('status');
  var errorEl = $('error');
  var gridEl = $('grid');

  var engine = null;       // window.LOC1999_PAGES
  var pdfjs = null;
  var sources = [];        // [{ name, bytes }]
  var docs = null;         // pdf-lib documents, loaded once
  var pages = [];          // PageRef[]
  var chosen = new Set();  // indices into `pages`
  var thumbs = new Map();  // "doc:page" -> data URL
  var liveUrls = [];
  var dragFrom = -1;

  var THUMB_WIDTH = 120;

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

  function loadEngines() {
    if (engine && pdfjs) return Promise.resolve();
    setStatus('Loading…');
    return Promise.all([
      engine ? null : new Promise(function (resolve, reject) {
        var el = document.createElement('script');
        el.src = '/pdfsign.js';
        el.onload = function () {
          engine = window.LOC1999_PAGES;
          engine ? resolve() : reject(new Error('the page engine did not load'));
        };
        el.onerror = function () { reject(new Error('could not load the page engine')); };
        document.head.appendChild(el);
      }),
      pdfjs ? null : import('/vendor/pdf.min.mjs').then(function (mod) {
        mod.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
        pdfjs = mod;
      }),
    ]);
  }

  // ------------------------------------------------------------- opening

  function addFiles(files) {
    clearError();
    releaseUrls();
    $('output').innerHTML = '';

    return loadEngines()
      .then(function () {
        var reads = [];
        for (var i = 0; i < files.length; i++) {
          (function (file) {
            reads.push(file.arrayBuffer().then(function (buffer) {
              return { name: file.name || 'document.pdf', bytes: new Uint8Array(buffer) };
            }));
          })(files[i]);
        }
        return Promise.all(reads);
      })
      .then(function (added) {
        setStatus('Reading…');
        var startAt = sources.length;
        sources = sources.concat(added);
        // pdf-lib has to re-read everything, because a document object cannot
        // be moved between builds.
        return engine.loadSources(sources).then(function (loaded) {
          docs = loaded;
          return countPages(added, startAt);
        });
      })
      .then(function () {
        $('workspace').classList.remove('hidden');
        renderSources();
        return renderGrid();
      })
      .then(function () { setStatus(''); })
      .catch(function (err) {
        fail((err && err.message) || String(err));
      });
  }

  /* pdf.js is the authority on how many pages a document has, and it is opened
     anyway for the thumbnails. */
  function countPages(added, startAt) {
    var work = added.map(function (source, i) {
      // pdf.js takes ownership of the buffer it is handed, which would empty
      // the copy pdf-lib is holding.
      return pdfjs.getDocument({ data: source.bytes.slice(), cMapUrl: '/vendor/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/vendor/standard_fonts/' }).promise.then(function (doc) {
        source.pdf = doc;
        for (var p = 0; p < doc.numPages; p++) pages.push({ doc: startAt + i, page: p, rotation: 0 });
      });
    });
    return Promise.all(work);
  }

  function renderSources() {
    var counts = engine.countByDoc(pages, sources.length);
    $('sources').textContent = sources.map(function (s, i) {
      return s.name + ' (' + counts[i] + (counts[i] === 1 ? ' page' : ' pages') + ')';
    }).join(' · ') + ', ' + pages.length + (pages.length === 1 ? ' page in all' : ' pages in all');
  }

  // ----------------------------------------------------------- thumbnails

  /* The thumbnail is rendered at its rotation rather than rotated afterwards
     with CSS.
     A portrait page turned sideways becomes landscape, and a CSS transform does
     not reflow — the image escapes its card, which is what it did the first
     time this was built. Asking pdf.js for a rotated viewport gives a correctly
     shaped picture, and it is also exactly what the saved page will look like.
     Cached per page *and* rotation, so turning is one small re-render. */
  function thumbFor(ref) {
    var key = ref.doc + ':' + ref.page + ':' + ref.rotation;
    if (thumbs.has(key)) return Promise.resolve(thumbs.get(key));
    var source = sources[ref.doc];
    if (!source || !source.pdf) return Promise.resolve(null);

    return source.pdf.getPage(ref.page + 1).then(function (page) {
      var upright = page.getViewport({ scale: 1 });
      // The page's own rotation is already in `upright`; ours adds to it.
      var scale = THUMB_WIDTH / (ref.rotation % 180 ? upright.height : upright.width);
      var viewport = page.getViewport({ scale: scale, rotation: (page.rotate + ref.rotation) % 360 });
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function () {
        // A data URL rather than a blob: one string, cached, and it survives
        // the grid being rebuilt on every change.
        var url = canvas.toDataURL('image/jpeg', 0.7);
        thumbs.set(key, url);
        return url;
      });
    });
  }

  function renderGrid() {
    if (!pages.length) {
      gridEl.innerHTML = '<p class="note">No pages left. Open a PDF, or start again.</p>';
      updateSelection();
      return Promise.resolve();
    }

    return Promise.all(pages.map(thumbFor)).then(function (urls) {
      gridEl.innerHTML = pages.map(function (ref, i) {
        var url = urls[i];
        var label = sources[ref.doc] ? sources[ref.doc].name : '?';
        return '<div class="page-card' + (chosen.has(i) ? ' is-chosen' : '') + '" data-index="' + i + '"' +
          ' draggable="true" tabindex="0" role="button" aria-pressed="' + (chosen.has(i) ? 'true' : 'false') +
          '" aria-label="Page ' + (i + 1) + ' of ' + esc(label) + '">' +
          '<span class="page-number">' + (i + 1) + '</span>' +
          (url
            ? '<img class="page-thumb" alt="" src="' + url + '">'
            : '<span class="page-thumb is-blank"></span>') +
          '<span class="page-from">' + esc(shortName(label)) + ' p' + (ref.page + 1) + '</span>' +
          '</div>';
      }).join('');
      updateSelection();
    });
  }

  function shortName(name) {
    var stem = name.replace(/\.pdf$/i, '');
    return stem.length > 14 ? stem.slice(0, 12) + '…' : stem;
  }

  function updateSelection() {
    $('selection').textContent = chosen.size
      ? chosen.size + (chosen.size === 1 ? ' page selected' : ' pages selected')
      : 'nothing selected';
    var none = chosen.size === 0;
    ['rotate-left', 'rotate-right', 'delete', 'to-front', 'to-back'].forEach(function (id) {
      $(id).disabled = none;
    });
    $('save-one').disabled = pages.length === 0;
    $('save-note').textContent = pages.length
      ? pages.length + (pages.length === 1 ? ' page' : ' pages') + ', in this order'
      : '';
    describeSplit();
  }

  // -------------------------------------------------------------- actions

  function act(next) {
    pages = next;
    chosen = new Set();
    renderSources();
    renderGrid();
  }

  function chosenIndices() {
    return [...chosen].sort(function (a, b) { return a - b; });
  }

  function moveChosen(toFront) {
    var picked = chosenIndices();
    var rest = pages.filter(function (_, i) { return !chosen.has(i); });
    var moved = picked.map(function (i) { return pages[i]; });
    act(toFront ? moved.concat(rest) : rest.concat(moved));
  }

  // ------------------------------------------------------------- saving

  function saveOne() {
    if (!pages.length) return;
    clearError();
    $('output').innerHTML = '';
    $('progress').textContent = 'Building…';

    engine.buildPdf(docs, pages)
      .then(function (bytes) {
        $('progress').textContent = '';
        var name = engine.outputName(sources.map(function (s) { return s.name; }), 'merged');
        offer(name, new Blob([bytes], { type: 'application/pdf' }));
      })
      .catch(function (err) {
        $('progress').textContent = '';
        fail((err && err.message) || String(err));
      });
  }

  function splitRequest() {
    var mode = $('split-mode').value;
    return {
      mode: mode,
      size: Number($('split-size').value),
      ranges: $('split-ranges').value,
    };
  }

  function describeSplit() {
    var mode = $('split-mode').value;
    $('split-size').classList.toggle('hidden', mode !== 'every');
    $('split-ranges').classList.toggle('hidden', mode !== 'ranges');
    if (!pages.length) { $('split-note').textContent = ''; return; }

    var plan = engine.planSplit(pages.length, splitRequest());
    $('split-note').textContent = plan.error
      ? plan.error
      : 'makes ' + plan.groups.length + (plan.groups.length === 1 ? ' file' : ' files') +
        (plan.groups.length > 1 ? ', delivered as one ZIP' : '');
    $('save-split').disabled = Boolean(plan.error);
  }

  function saveSplit() {
    var plan = engine.planSplit(pages.length, splitRequest());
    if (plan.error) { fail(plan.error); return; }

    clearError();
    $('output').innerHTML = '';
    $('progress').textContent = 'Building…';

    var stem = engine.outputName(sources.map(function (s) { return s.name; }), 'split').replace(/-split\.pdf$/, '');
    var built = [];

    plan.groups.reduce(function (promise, group, n) {
      return promise.then(function () {
        return engine.buildPdf(docs, group.pages.map(function (i) { return pages[i]; })).then(function (bytes) {
          built.push({ name: stem + '-' + group.label + '.pdf', data: bytes });
          $('progress').textContent = 'Building… ' + built.length + ' of ' + plan.groups.length;
        });
      });
    }, Promise.resolve())
      .then(function () {
        $('progress').textContent = '';
        if (built.length === 1) {
          offer(built[0].name, new Blob([built[0].data], { type: 'application/pdf' }));
          return undefined;
        }
        // A browser blocks a burst of downloads, so several files come back as
        // one archive.
        return loadZip().then(function (zip) {
          return zip(built).then(function (bytes) {
            offer(stem + '-split.zip', new Blob([bytes], { type: 'application/zip' }));
          });
        });
      })
      .catch(function (err) {
        $('progress').textContent = '';
        fail((err && err.message) || String(err));
      });
  }

  /* The archive writer, borrowed from the ZIP tool rather than duplicated. */
  function loadZip() {
    if (window.LOC1999_ZIP) return Promise.resolve(window.LOC1999_ZIP.zip);
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = '/zipkit.js';
      el.onload = function () {
        window.LOC1999_ZIP ? resolve(window.LOC1999_ZIP.zip) : reject(new Error('the archive engine did not load'));
      };
      el.onerror = function () { reject(new Error('could not load the archive engine')); };
      document.head.appendChild(el);
    });
  }

  function offer(name, blob) {
    $('output').innerHTML = '<p><a id="download" download="' + esc(name) + '" href="' + objectUrl(blob) +
      '">Download ' + esc(name) + '</a> <span class="note">' + Math.round(blob.size / 1024) + ' KB</span></p>';
  }

  // ---------------------------------------------------------------- wiring

  $('drop').addEventListener('click', function () { $('file-input').click(); });
  $('drop').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('file-input').click(); }
  });
  $('drop').addEventListener('dragover', function (event) {
    event.preventDefault();
    $('drop').classList.add('is-over');
  });
  $('drop').addEventListener('dragleave', function () { $('drop').classList.remove('is-over'); });
  $('drop').addEventListener('drop', function (event) {
    event.preventDefault();
    $('drop').classList.remove('is-over');
    var files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) addFiles(files);
  });
  $('file-input').addEventListener('change', function () {
    if ($('file-input').files && $('file-input').files.length) addFiles($('file-input').files);
  });

  // One listener for the whole grid: it is rebuilt on every change, and a
  // hundred cards means a hundred listeners otherwise.
  gridEl.addEventListener('click', function (event) {
    var card = event.target.closest ? event.target.closest('.page-card') : null;
    if (!card) return;
    var index = Number(card.dataset.index);
    chosen.has(index) ? chosen.delete(index) : chosen.add(index);
    card.classList.toggle('is-chosen', chosen.has(index));
    card.setAttribute('aria-pressed', chosen.has(index) ? 'true' : 'false');
    updateSelection();
  });
  gridEl.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var card = event.target.closest ? event.target.closest('.page-card') : null;
    if (!card) return;
    event.preventDefault();
    card.click();
  });

  gridEl.addEventListener('dragstart', function (event) {
    var card = event.target.closest ? event.target.closest('.page-card') : null;
    if (!card) return;
    dragFrom = Number(card.dataset.index);
    event.dataTransfer.effectAllowed = 'move';
    // Firefox will not start a drag without data on it.
    event.dataTransfer.setData('text/plain', String(dragFrom));
  });
  gridEl.addEventListener('dragover', function (event) {
    if (dragFrom < 0) return;
    event.preventDefault();
    var card = event.target.closest ? event.target.closest('.page-card') : null;
    gridEl.querySelectorAll('.is-target').forEach(function (el) { el.classList.remove('is-target'); });
    if (card) card.classList.add('is-target');
  });
  gridEl.addEventListener('drop', function (event) {
    if (dragFrom < 0) return;
    event.preventDefault();
    var card = event.target.closest ? event.target.closest('.page-card') : null;
    gridEl.querySelectorAll('.is-target').forEach(function (el) { el.classList.remove('is-target'); });
    if (card) {
      var to = Number(card.dataset.index);
      pages = engine.movePage(pages, dragFrom, to);
      chosen = new Set();
      renderGrid();
    }
    dragFrom = -1;
  });
  gridEl.addEventListener('dragend', function () {
    dragFrom = -1;
    gridEl.querySelectorAll('.is-target').forEach(function (el) { el.classList.remove('is-target'); });
  });

  $('rotate-left').addEventListener('click', function () { act(engine.rotatePages(pages, chosen, -90)); });
  $('rotate-right').addEventListener('click', function () { act(engine.rotatePages(pages, chosen, 90)); });
  $('delete').addEventListener('click', function () { act(engine.removePages(pages, chosen)); });
  $('to-front').addEventListener('click', function () { moveChosen(true); });
  $('to-back').addEventListener('click', function () { moveChosen(false); });

  $('select-all').addEventListener('click', function () {
    chosen = new Set(pages.map(function (_, i) { return i; }));
    renderGrid();
  });
  $('select-none').addEventListener('click', function () {
    chosen = new Set();
    renderGrid();
  });
  $('reset').addEventListener('click', function () {
    // Every page of every open document, back in its original order.
    pages = [];
    sources.forEach(function (source, i) {
      for (var p = 0; p < (source.pdf ? source.pdf.numPages : 0); p++) {
        pages.push({ doc: i, page: p, rotation: 0 });
      }
    });
    act(pages);
  });

  $('range-go').addEventListener('click', function () {
    var picked = engine.parseRanges($('range').value, pages.length);
    if (picked === null) { fail('That is not a page range. Try something like 1-3, 8, 12-'); return; }
    clearError();
    chosen = new Set(picked);
    renderGrid();
  });
  $('range').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); $('range-go').click(); }
  });

  $('save-one').addEventListener('click', saveOne);
  $('save-split').addEventListener('click', saveSplit);
  ['split-mode', 'split-size', 'split-ranges'].forEach(function (id) {
    $(id).addEventListener('input', describeSplit);
    $(id).addEventListener('change', describeSplit);
  });
})();

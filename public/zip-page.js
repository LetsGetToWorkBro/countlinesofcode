/* 1999.LOC archive page. Vanilla JS, no build step.
 *
 * Loads /zipkit.js on first use — about seven kilobytes, because the
 * decompression itself is the browser's own DecompressionStream and there is
 * no library to fetch. Nothing is uploaded.
 *
 * The one thing worth understanding: a ZIP keeps an index of its contents at
 * the very end of the file. That means the list of what is inside a 500 MB
 * archive can be read without unpacking a single byte, and only the entries
 * someone actually asks for are ever decompressed. Listing and extracting are
 * separate calls for exactly that reason.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $('status');
  var errorEl = $('error');

  var kit = null;          // window.LOC1999_ZIP
  var raw = null;          // the archive's bytes
  var listing = [];        // ZipListing[], sorted
  var chosen = null;       // Set of names
  var sourceName = 'archive.zip';
  var basket = [];         // Files queued for a new archive
  var liveUrls = [];

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

  function loadKit() {
    if (kit) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = '/zipkit.js';
      el.onload = function () {
        kit = window.LOC1999_ZIP;
        kit ? resolve() : reject(new Error('the archive engine did not load'));
      };
      el.onerror = function () { reject(new Error('could not load the archive engine')); };
      document.head.appendChild(el);
    });
  }

  // ------------------------------------------------------------ opening

  function openArchive(file) {
    clearError();
    releaseUrls();
    $('output').innerHTML = '';
    $('preview-box').classList.add('hidden');
    sourceName = file.name || 'archive.zip';
    setStatus('Reading ' + sourceName + '…');

    return loadKit()
      .then(function () { return file.arrayBuffer(); })
      .then(function (buffer) {
        raw = new Uint8Array(buffer);
        listing = kit.sortListing(kit.listZip(raw));
        chosen = new Set(listing.filter(function (e) { return !e.directory; }).map(function (e) { return e.name; }));
        $('archive').classList.remove('hidden');
        showSummary();
        render();
        setStatus('');
      })
      .catch(function (err) {
        $('archive').classList.add('hidden');
        fail((err && err.message) || String(err));
      });
  }

  function showSummary() {
    var s = kit.summarise(listing);
    $('summary').textContent =
      s.files + (s.files === 1 ? ' file' : ' files') +
      (s.folders ? ', ' + s.folders + (s.folders === 1 ? ' folder' : ' folders') : '') +
      ', ' + kit.formatBytes(s.size) + ' packed into ' + kit.formatBytes(s.compressedSize) +
      (s.size > 0 ? ' (' + s.saved + '% smaller)' : '');

    // Anything this cannot open is said here, once, rather than at the moment
    // someone clicks a file and it fails.
    $('problems').innerHTML = s.problems.length
      ? '<div class="notice-box">' + s.problems.map(function (p) { return '<p class="note">' + esc(p) + '</p>'; }).join('') + '</div>'
      : '';
  }

  function visible() {
    var filter = $('filter').value.trim().toLowerCase();
    if (!filter) return listing;
    return listing.filter(function (e) { return e.name.toLowerCase().indexOf(filter) >= 0; });
  }

  function render() {
    var rows = visible().map(function (e, i) {
      if (e.directory) {
        return '<div class="zip-row is-folder"><span class="zip-name">' + esc(e.name) + '</span></div>';
      }
      var openable = !e.encrypted && (e.method === 0 || e.method === 8);
      return '<div class="zip-row' + (openable ? '' : ' is-locked') + '">' +
        '<input type="checkbox" class="zip-pick" data-name="' + esc(e.name) + '"' +
          (chosen.has(e.name) ? ' checked' : '') + (openable ? '' : ' disabled') +
          ' aria-label="Include ' + esc(e.name) + '">' +
        '<span class="zip-name">' + esc(e.name) + '</span>' +
        '<span class="zip-kind">' + esc(e.encrypted ? 'locked' : kit.kindOf(e.name)) + '</span>' +
        '<span class="zip-size">' + esc(kit.formatBytes(e.size)) + '</span>' +
        (kit.previewable(e)
          ? '<button type="button" class="small zip-view" data-name="' + esc(e.name) + '">view</button>'
          : '<span class="zip-view"></span>') +
        '</div>';
    }).join('');

    $('listing').innerHTML = rows || '<p class="note">Nothing matches that filter.</p>';
    updateSelection();
  }

  function updateSelection() {
    var picked = listing.filter(function (e) { return chosen.has(e.name); });
    var bytes = picked.reduce(function (n, e) { return n + e.size; }, 0);
    $('selection').textContent = picked.length
      ? picked.length + ' selected, ' + kit.formatBytes(bytes)
      : 'nothing selected';
    $('extract').disabled = picked.length === 0;
  }

  function byName(name) {
    return listing.find(function (e) { return e.name === name; });
  }

  // --------------------------------------------------------- extracting

  function extract(entries, asArchive) {
    if (!entries.length) return;
    clearError();
    $('output').innerHTML = '';
    $('progress').textContent = 'Unpacking…';

    var done = 0;
    var collected = [];
    var taken = new Set();

    // One at a time: a hundred parallel inflates would hold the whole
    // uncompressed archive in memory at once, which is the thing to avoid.
    var chain = entries.reduce(function (promise, entry) {
      return promise.then(function () {
        return kit.extractEntry(raw, entry).then(function (data) {
          var name = kit.uniqueName(kit.safeName(entry.name), taken);
          taken.add(name);
          collected.push({ name: name, data: data, original: entry.name });
          done++;
          $('progress').textContent = 'Unpacking… ' + done + ' of ' + entries.length;
        });
      });
    }, Promise.resolve());

    chain
      .then(function () {
        $('progress').textContent = '';
        if (!asArchive && collected.length === 1) {
          var one = collected[0];
          offer([{ name: one.name, blob: new Blob([one.data]) }]);
          return undefined;
        }
        // Several files come back as one archive rather than as a burst of
        // downloads a browser would block half of.
        // The folder structure is kept, but a path that climbs out of the
        // archive is not: an archive this tool writes must not carry the trick
        // it warns about in one it reads.
        return kit.zip(collected.map(function (c) { return { name: kit.safePath(c.original), data: c.data }; }))
          .then(function (bytes) {
            var stem = sourceName.replace(/\.zip$/i, '');
            offer([{ name: stem + '-extracted.zip', blob: new Blob([bytes], { type: 'application/zip' }) }]);
          });
      })
      .catch(function (err) {
        $('progress').textContent = '';
        fail((err && err.message) || String(err));
      });
  }

  function offer(files) {
    $('output').innerHTML = files.map(function (f) {
      return '<p><a download="' + esc(f.name) + '" href="' + objectUrl(f.blob) + '">Download ' +
        esc(f.name) + '</a> <span class="note">' + esc(kit.formatBytes(f.blob.size)) + '</span></p>';
    }).join('');
  }

  // ---------------------------------------------------------- previewing

  function preview(name) {
    var entry = byName(name);
    if (!entry) return;
    $('preview-box').classList.remove('hidden');
    $('preview-name').textContent = entry.name + ', ' + kit.formatBytes(entry.size);
    $('preview').textContent = 'Reading…';

    kit.extractEntry(raw, entry).then(function (data) {
      var kind = kit.kindOf(entry.name);
      if (kind === 'image') {
        // Without a type the blob is octet-stream and the <img> refuses to
        // decode it — the preview came up blank until this was set.
        var url = objectUrl(new Blob([data], { type: kit.mimeOf(entry.name) }));
        $('preview').innerHTML = '<img class="zip-image" alt="' + esc(entry.name) + '" src="' + url + '">';
        return;
      }
      var text = kit.asText(data);
      if (text === null) {
        $('preview').textContent = 'That is not text: it is binary data, so there is nothing readable to show.';
        return;
      }
      var truncated = data.length > 200000;
      $('preview').innerHTML = '<pre>' + esc(text) + '</pre>' +
        (truncated ? '<p class="note">Showing the first 200 KB.</p>' : '');
    }).catch(function (err) {
      $('preview').textContent = (err && err.message) || String(err);
    });
  }

  // -------------------------------------------------------------- making

  function addFiles(files) {
    $('make-error').textContent = '';
    for (var i = 0; i < files.length; i++) basket.push(files[i]);
    renderBasket();
  }

  function renderBasket() {
    if (!basket.length) {
      $('basket').classList.add('hidden');
      return;
    }
    $('basket').classList.remove('hidden');
    var total = basket.reduce(function (n, f) { return n + f.size; }, 0);
    $('basket-summary').textContent =
      basket.length + (basket.length === 1 ? ' file' : ' files') + ', ' + kit.formatBytes(total);

    $('basket-list').innerHTML = basket.map(function (f, i) {
      return '<div class="zip-row">' +
        '<span class="zip-name">' + esc(f.name) + '</span>' +
        '<span class="zip-kind">' + esc(kit.kindOf(f.name)) + '</span>' +
        '<span class="zip-size">' + esc(kit.formatBytes(f.size)) + '</span>' +
        '<button type="button" class="small basket-drop" data-index="' + i + '">remove</button>' +
        '</div>';
    }).join('');
    $('build-note').textContent = '';
  }

  function build() {
    if (!basket.length) return;
    $('make-error').textContent = '';
    $('build-note').textContent = 'Packing…';
    $('make-output').innerHTML = '';

    var taken = new Set();
    var entries = [];

    basket.reduce(function (promise, file) {
      return promise.then(function () {
        return file.arrayBuffer().then(function (buffer) {
          // Two files dropped from different folders can share a name.
          var name = kit.uniqueName(kit.safePath(file.name), taken);
          taken.add(name);
          entries.push({ name: name, data: new Uint8Array(buffer) });
          $('build-note').textContent = 'Packing… ' + entries.length + ' of ' + basket.length;
        });
      });
    }, Promise.resolve())
      .then(function () { return kit.zip(entries); })
      .then(function (bytes) {
        var before = basket.reduce(function (n, f) { return n + f.size; }, 0);
        var saved = before > 0 ? Math.max(0, Math.round((1 - bytes.length / before) * 100)) : 0;
        $('build-note').textContent = saved > 0 ? saved + '% smaller than the files' : 'no smaller: these files were already compressed';
        var name = kit.archiveName(basket.map(function (f) { return f.name; }));
        $('make-output').innerHTML = '<p><a download="' + esc(name) + '" href="' +
          objectUrl(new Blob([bytes], { type: 'application/zip' })) + '">Download ' + esc(name) +
          '</a> <span class="note">' + esc(kit.formatBytes(bytes.length)) + '</span></p>';
      })
      .catch(function (err) {
        $('build-note').textContent = '';
        $('make-error').textContent = (err && err.message) || String(err);
      });
  }

  // ---------------------------------------------------------------- wiring

  function wireDrop(zone, input, handler) {
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
    });
    zone.addEventListener('dragover', function (event) {
      event.preventDefault();
      zone.classList.add('is-over');
    });
    zone.addEventListener('dragleave', function () { zone.classList.remove('is-over'); });
    zone.addEventListener('drop', function (event) {
      event.preventDefault();
      zone.classList.remove('is-over');
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length) handler(files);
    });
    input.addEventListener('change', function () {
      if (input.files && input.files.length) handler(input.files);
    });
  }

  wireDrop($('drop'), $('file-input'), function (files) { openArchive(files[0]); });
  wireDrop($('make-drop'), $('make-input'), function (files) {
    loadKit().then(function () { addFiles(files); }).catch(function (err) { $('make-error').textContent = err.message; });
  });

  $('tab-open').addEventListener('click', function () { switchMode('open'); });
  $('tab-make').addEventListener('click', function () { switchMode('make'); });

  function switchMode(mode) {
    var opening = mode === 'open';
    $('mode-open').classList.toggle('hidden', !opening);
    $('mode-make').classList.toggle('hidden', opening);
    $('tab-open').classList.toggle('is-active', opening);
    $('tab-make').classList.toggle('is-active', !opening);
  }

  // The listing can be hundreds of rows, so it is one listener rather than one
  // per row.
  $('listing').addEventListener('change', function (event) {
    var box = event.target.closest ? event.target.closest('.zip-pick') : null;
    if (!box) return;
    box.checked ? chosen.add(box.dataset.name) : chosen.delete(box.dataset.name);
    updateSelection();
  });
  $('listing').addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.zip-view') : null;
    if (button && button.dataset.name) preview(button.dataset.name);
  });

  $('basket-list').addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.basket-drop') : null;
    if (!button) return;
    basket.splice(Number(button.dataset.index), 1);
    renderBasket();
  });

  $('select-all').addEventListener('click', function () {
    visible().forEach(function (e) { if (!e.directory && !e.encrypted) chosen.add(e.name); });
    render();
  });
  $('select-none').addEventListener('click', function () {
    visible().forEach(function (e) { chosen.delete(e.name); });
    render();
  });
  $('filter').addEventListener('input', render);

  $('extract').addEventListener('click', function () {
    extract(listing.filter(function (e) { return !e.directory && chosen.has(e.name); }), false);
  });
  $('extract-all').addEventListener('click', function () {
    extract(listing.filter(function (e) { return !e.directory && !e.encrypted; }), true);
  });

  $('build').addEventListener('click', build);
  $('basket-clear').addEventListener('click', function () {
    basket = [];
    $('make-output').innerHTML = '';
    renderBasket();
  });
})();

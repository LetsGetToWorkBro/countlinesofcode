/* LOC.1999 PDF tool. Vanilla JS, no build step, no dependencies of its own.
 *
 * The heavy lifting lives in /pdfkit.js (pdf-lib, 424 KB), which is loaded the
 * first time somebody adds a file rather than on page load. That keeps this
 * page a few KB for anyone who only came to read what it refuses to do.
 *
 * The one rule worth remembering: nothing here uploads. There is no fetch() to
 * any endpoint in this file, and that is a property worth preserving.
 */
(function () {
  'use strict';

  var dropzone = document.getElementById('drop');
  var fileInput = document.getElementById('file-input');
  var statusEl = document.getElementById('status');
  var errorEl = document.getElementById('error');
  var filesEl = document.getElementById('files');
  var workspace = document.getElementById('workspace');
  var rangeInput = document.getElementById('range');
  var rotateInput = document.getElementById('rotate');
  var numbersInput = document.getElementById('numbers');
  var numPosition = document.getElementById('num-position');
  var numStart = document.getElementById('num-start');
  var numFirst = document.getElementById('num-first');
  var imgSize = document.getElementById('img-size');
  var buildButton = document.getElementById('build');
  var splitButton = document.getElementById('split');
  var summaryEl = document.getElementById('summary');
  var outputEl = document.getElementById('output');

  /* Loaded documents, in the order they were added. Each item is either a PDF
   * ({kind:'pdf', doc}) or a single image already normalised to JPEG/PNG. */
  var items = [];
  /* Object URLs handed to download links, revoked when replaced so a long
   * session does not pin every result it ever produced in memory. */
  var liveUrls = [];

  // ---------------------------------------------------------------- helpers
  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function num(value) {
    return Number(value).toLocaleString('en-US');
  }

  function bytes(value) {
    if (value < 1024) return value + ' B';
    if (value < 1048576) return (value / 1024).toFixed(1) + ' KB';
    return (value / 1048576).toFixed(1) + ' MB';
  }

  function fail(message) {
    errorEl.textContent = message;
    statusEl.textContent = '';
  }

  function clearError() {
    errorEl.textContent = '';
  }

  function setBusy(busy, label) {
    buildButton.disabled = busy;
    splitButton.disabled = busy;
    statusEl.textContent = busy ? label : '';
  }

  /** Total pages across every loaded item, which is what the range refers to. */
  function totalPages() {
    return items.reduce(function (sum, item) {
      return sum + (item.kind === 'pdf' ? item.doc.pageCount : 1);
    }, 0);
  }

  // ------------------------------------------------------------ the engine
  var enginePromise = null;

  function loadEngine() {
    if (window.LOC1999_PDF) return Promise.resolve();
    if (enginePromise) return enginePromise;
    statusEl.textContent = 'Loading the PDF engine (424 KB, once)…';
    enginePromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = '/pdfkit.js';
      script.onload = resolve;
      script.onerror = function () {
        enginePromise = null;
        reject(new Error('Could not load the PDF engine. Reload and try again.'));
      };
      document.head.appendChild(script);
    });
    return enginePromise;
  }

  // ------------------------------------------------------------ adding files
  /* PDF embeds JPEG and PNG only. Anything else the browser can decode gets
   * re-encoded to PNG here — lossless, larger, and said out loud in the file
   * list rather than done silently. HEIC fails in every browser but Safari,
   * which is a browser limitation and is reported as one. */
  function normaliseImage(file, data) {
    if (file.type === 'image/jpeg' || file.type === 'image/png') {
      return Promise.resolve({ type: file.type, data: data, converted: false });
    }
    return createImageBitmap(new Blob([data], { type: file.type }))
      .then(function (bitmap) {
        var canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (blob) {
            if (!blob) return reject(new Error('Could not convert ' + file.name + '.'));
            blob.arrayBuffer().then(function (buf) {
              resolve({ type: 'image/png', data: buf, converted: true });
            }, reject);
          }, 'image/png');
        });
      })
      .catch(function () {
        throw new Error(
          file.name + ': this browser cannot read ' + (file.type || 'that format') +
          (/heic|heif/i.test(file.type + file.name)
            ? '. Only Safari decodes HEIC — on an iPhone, Settings → Camera → Formats → Most Compatible saves JPEGs instead.'
            : '.'),
        );
      });
  }

  function addFiles(fileList) {
    var chosen = [].slice.call(fileList);
    if (!chosen.length) return;
    clearError();

    loadEngine()
      .then(function () {
        statusEl.textContent = 'Reading ' + chosen.length + ' file' + (chosen.length === 1 ? '' : 's') + '…';
        return chosen.reduce(function (chain, file) {
          return chain.then(function () {
            return file.arrayBuffer().then(function (data) {
              var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
              if (isPdf) {
                return window.LOC1999_PDF.loadPdf(file.name, data).then(function (doc) {
                  items.push({ kind: 'pdf', name: file.name, size: file.size, doc: doc });
                }, function () {
                  throw new Error(
                    file.name + ': this does not open. If it needs a password to read, ' +
                    'this tool cannot open it either — that is deliberate.',
                  );
                });
              }
              return normaliseImage(file, data).then(function (image) {
                items.push({
                  kind: 'image',
                  name: file.name,
                  size: file.size,
                  type: image.type,
                  data: image.data,
                  converted: image.converted,
                });
              });
            });
          });
        }, Promise.resolve());
      })
      .then(function () {
        statusEl.textContent = '';
        render();
      })
      .catch(function (err) {
        render();
        fail(err.message || 'Could not read that file.');
      });
  }

  function render() {
    if (!items.length) {
      filesEl.innerHTML = '';
      workspace.className = 'hidden';
      return;
    }
    workspace.className = '';

    var rows = '';
    var offset = 0;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var count = item.kind === 'pdf' ? item.doc.pageCount : 1;
      var first = offset + 1;
      var last = offset + count;
      offset = last;

      var detail;
      if (item.kind === 'pdf') {
        detail = num(count) + ' page' + (count === 1 ? '' : 's') + ' · ' + describe(item.doc);
        if (item.doc.encrypted) detail += ' · restricted, opened read-only';
      } else {
        detail = 'image' + (item.converted ? ' · converted to PNG to embed it' : '');
      }

      rows += '<tr>' +
        '<td class="n">' + (count === 1 ? num(first) : num(first) + '&ndash;' + num(last)) + '</td>' +
        '<td>' + esc(item.name) + '<br><span class="note">' + detail + '</span></td>' +
        '<td class="n">' + bytes(item.size) + '</td>' +
        '<td><button type="button" class="remove" data-index="' + i + '">Remove</button></td>' +
        '</tr>';
    }

    filesEl.innerHTML =
      '<h3>Loaded</h3>' +
      '<table><thead><tr><th class="n">Pages</th><th>File</th><th class="n">Size</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<p class="note">' + num(totalPages()) + ' page' + (totalPages() === 1 ? '' : 's') +
      ' in total. Page numbers below refer to this combined order.</p>';

    var buttons = filesEl.querySelectorAll('.remove');
    for (var b = 0; b < buttons.length; b++) {
      buttons[b].addEventListener('click', function (event) {
        items.splice(Number(event.currentTarget.dataset.index), 1);
        clearError();
        render();
      });
    }
  }

  function describe(doc) {
    var seen = [];
    for (var i = 0; i < doc.sizes.length; i++) {
      var label = window.LOC1999_PDF.describeSize(doc.sizes[i]);
      if (seen.indexOf(label) === -1) seen.push(label);
      if (seen.length > 2) return 'mixed page sizes';
    }
    return seen.join(' and ');
  }

  // ----------------------------------------------------------- building out
  /** Map the combined page range onto (file, page) pairs the engine wants. */
  function selectedPages() {
    var flat = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.kind === 'pdf') {
        for (var p = 0; p < item.doc.pageCount; p++) flat.push({ item: i, page: p });
      } else {
        flat.push({ item: i, page: 0 });
      }
    }
    var picked = window.LOC1999_PDF.parseRange(rangeInput.value, flat.length);
    return picked.map(function (index) {
      return flat[index];
    });
  }

  /**
   * Images and PDF pages cannot be interleaved in one pass, because images have
   * to become a PDF before their pages can be copied. So: build a PDF of the
   * selected images first, then treat it as one more source document.
   */
  function assembleSelection(selection) {
    var pdfSources = [];
    var sourceIndex = {};
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'pdf') {
        sourceIndex[i] = pdfSources.length;
        pdfSources.push(items[i].doc);
      }
    }

    var imagePicks = selection.filter(function (s) {
      return items[s.item].kind === 'image';
    });

    var prepared = Promise.resolve(null);
    if (imagePicks.length) {
      prepared = window.LOC1999_PDF.imagesToPdf(
        imagePicks.map(function (s) {
          return { name: items[s.item].name, type: items[s.item].type, data: items[s.item].data };
        }),
        { pageSize: imgSize.value, marginPt: 36 },
      ).then(function (built) {
        return window.LOC1999_PDF.loadPdf('images.pdf', built.buffer ? built.buffer : built);
      });
    }

    return prepared.then(function (imageDoc) {
      var imageSourceIndex = -1;
      if (imageDoc) {
        imageSourceIndex = pdfSources.length;
        pdfSources.push(imageDoc);
      }

      var rotate = Number(rotateInput.value) || 0;
      var imageCursor = 0;
      var refs = selection.map(function (s) {
        if (items[s.item].kind === 'image') {
          return { file: imageSourceIndex, page: imageCursor++, rotate: rotate };
        }
        return { file: sourceIndex[s.item], page: s.page, rotate: rotate };
      });

      return window.LOC1999_PDF.assemble(pdfSources, refs);
    });
  }

  function maybeNumber(bytesOut) {
    if (!numbersInput.checked) return Promise.resolve(bytesOut);
    return window.LOC1999_PDF.addPageNumbers(bytesOut, {
      startAt: Math.max(1, Number(numStart.value) || 1),
      firstNumber: Number(numFirst.value) || 1,
      position: numPosition.value,
      size: 10,
    });
  }

  function offer(name, data) {
    var blob = new Blob([data], { type: 'application/pdf' });
    var url = URL.createObjectURL(blob);
    liveUrls.push(url);
    return '<li><a href="' + url + '" download="' + esc(name) + '">' + esc(name) + '</a> ' +
      '<span class="note">' + bytes(blob.size) + '</span></li>';
  }

  function resetOutput() {
    for (var i = 0; i < liveUrls.length; i++) URL.revokeObjectURL(liveUrls[i]);
    liveUrls = [];
    outputEl.innerHTML = '';
    summaryEl.textContent = '';
  }

  function build() {
    clearError();
    resetOutput();
    var selection;
    try {
      selection = selectedPages();
    } catch (err) {
      return fail(err.message);
    }

    setBusy(true, 'Building ' + num(selection.length) + ' page' + (selection.length === 1 ? '' : 's') + '…');
    assembleSelection(selection)
      .then(maybeNumber)
      .then(function (data) {
        setBusy(false);
        summaryEl.textContent =
          num(selection.length) + ' page' + (selection.length === 1 ? '' : 's') + ' from ' +
          num(items.length) + ' file' + (items.length === 1 ? '' : 's') + '.';
        outputEl.innerHTML = '<ul class="plain">' + offer('combined.pdf', data) + '</ul>';
      })
      .catch(function (err) {
        setBusy(false);
        fail(err.message || 'Could not build that PDF.');
      });
  }

  function splitEach() {
    clearError();
    resetOutput();
    var selection;
    try {
      selection = selectedPages();
    } catch (err) {
      return fail(err.message);
    }
    if (selection.length > 200) {
      return fail('That is ' + num(selection.length) + ' separate files. Narrow the range to 200 or fewer.');
    }

    setBusy(true, 'Splitting ' + num(selection.length) + ' page' + (selection.length === 1 ? '' : 's') + '…');
    var results = [];
    selection
      .reduce(function (chain, page, index) {
        return chain.then(function () {
          statusEl.textContent = 'Page ' + num(index + 1) + ' of ' + num(selection.length) + '…';
          return assembleSelection([page])
            .then(maybeNumber)
            .then(function (data) {
              results.push(offer('page-' + (index + 1) + '.pdf', data));
            });
        });
      }, Promise.resolve())
      .then(function () {
        setBusy(false);
        summaryEl.textContent = num(results.length) + ' files. Each link saves one page.';
        outputEl.innerHTML = '<ul class="plain">' + results.join('') + '</ul>';
      })
      .catch(function (err) {
        setBusy(false);
        fail(err.message || 'Could not split that PDF.');
      });
  }

  // --------------------------------------------------------------- wiring
  dropzone.addEventListener('click', function () {
    fileInput.click();
  });
  dropzone.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', function () {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (name) {
    dropzone.addEventListener(name, function (event) {
      event.preventDefault();
      dropzone.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (name) {
    dropzone.addEventListener(name, function (event) {
      event.preventDefault();
      dropzone.classList.remove('is-over');
    });
  });
  dropzone.addEventListener('drop', function (event) {
    if (event.dataTransfer && event.dataTransfer.files) addFiles(event.dataTransfer.files);
  });

  buildButton.addEventListener('click', build);
  splitButton.addEventListener('click', splitEach);
})();

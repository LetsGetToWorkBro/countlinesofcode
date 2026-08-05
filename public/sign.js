/* LOC.1999 PDF editor. Vanilla JS, no build step.
 *
 * Loaded on first file open, both from this origin:
 *   /vendor/pdf.min.mjs  — pdf.js, to render pages and report where text is
 *   /pdfsign.js          — pdf-lib plus the content-stream reader, to write
 *
 * Nothing here uploads anything. There is no fetch() to any endpoint.
 *
 * The interesting part is how deleting text works. pdf.js knows what a string
 * says and how wide it is, because it has the fonts. The content-stream reader
 * knows which bytes of the file drew it. Matching the two by position gives
 * both: an accurate box to click on, and the exact operator to remove. Delete
 * the operator and those characters are gone from the file — nothing covered
 * over, nothing flattened to a picture, and every other word on the page is
 * still real selectable text.
 *
 * When the two cannot be matched, that text is marked unremovable and the
 * blackout tool is offered instead. Guessing which operator to delete would
 * damage a document somebody is about to rely on.
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
  var savedEl = $('saved-sigs');

  var pdfjs = null;
  var doc = null;              // pdf.js document
  var libDoc = null;           // pdf-lib document, for the content streams
  var sourceBytes = null;
  var pageIndex = 0;
  var viewport = null;
  var pages = [];              // per page: { items, ops, opOf }
  var objects = [];            // things placed on top: text and signatures
  var removals = {};           // page -> { opIndex: true }
  var flatten = {};            // page -> [rects]  (the blunt fallback)
  var selected = null;
  var liveUrls = [];
  var nextId = 1;

  var VIEW_WIDTH = 660;
  var RASTER_SCALE = 2;
  /* Snap a dragged object onto a nearby line of existing text. Four points is
   * about a third of a line of body text: close enough to catch an intended
   * alignment, far enough not to fight somebody placing something deliberately
   * between two lines. */
  var SNAP_POINTS = 4;
  var STORE_KEY = 'loc1999:signatures';

  // ---------------------------------------------------------------- helpers
  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fail(m) { errorEl.textContent = m; statusEl.textContent = ''; }
  function clearError() { errorEl.textContent = ''; }
  function tool() {
    var picked = document.querySelector('input[name="tool"]:checked');
    return picked ? picked.value : 'text';
  }
  function bytesLabel(n) {
    return n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }
  function pageRemovals(p) { return Object.keys(removals[p] || {}).map(Number); }

  // ------------------------------------------------------------- the engines
  var loading = null;
  function loadEngines() {
    if (pdfjs && window.LOC1999_SIGN) return Promise.resolve();
    if (loading) return loading;
    statusEl.textContent = 'Loading the PDF engines (about 700 KB, once)…';
    loading = Promise.all([
      import('/vendor/pdf.min.mjs').then(function (mod) {
        pdfjs = mod;
        pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
      }),
      new Promise(function (resolve, reject) {
        if (window.LOC1999_SIGN) return resolve();
        var s = document.createElement('script');
        s.src = '/pdfsign.js';
        s.onload = resolve;
        s.onerror = function () { reject(new Error('Could not load the PDF writer.')); };
        document.head.appendChild(s);
      }),
    ]).then(function () { statusEl.textContent = ''; }, function (err) { loading = null; throw err; });
    return loading;
  }

  // ------------------------------------------------------------ opening files
  function open(file) {
    clearError();
    resetOutput();
    loadEngines()
      .then(function () { return file.arrayBuffer(); })
      .then(function (data) {
        sourceBytes = new Uint8Array(data);
        /* standardFontDataUrl and cMapUrl matter more here than in a viewer.
         * Without them pdf.js substitutes fonts and blanks CJK text — which
         * would misplace every box you click on, and would be baked in
         * permanently on any page you flatten. */
        return Promise.all([
          pdfjs.getDocument({
            data: sourceBytes.slice(),
            standardFontDataUrl: '/vendor/standard_fonts/',
            cMapUrl: '/vendor/cmaps/',
            cMapPacked: true,
          }).promise,
          window.LOC1999_SIGN.loadForEditing(sourceBytes),
        ]);
      })
      .then(function (both) {
        doc = both[0];
        libDoc = both[1];
        pageIndex = 0;
        objects = [];
        removals = {};
        flatten = {};
        selected = null;
        pages = new Array(doc.numPages);
        editor.className = '';
        return renderPage();
      })
      .catch(function (err) {
        fail(err && err.name === 'PasswordException'
          ? 'That PDF needs a password to open, so this tool cannot open it either. That is deliberate.'
          : (err && err.message) || 'Could not open that PDF.');
      });
  }

  /* Everything known about one page's text: what it says and where (pdf.js),
   * which operator drew it (the stream reader), and whether the two could be
   * matched at all. Computed once per page, on first view. */
  function analysePage(index) {
    if (pages[index]) return Promise.resolve(pages[index]);
    return doc.getPage(index + 1).then(function (page) {
      return page.getTextContent().then(function (content) {
        var items = [];
        content.items.forEach(function (it) {
          if (!it.str || !it.str.trim()) return; // pdf.js emits blanks; they match nothing
          items.push({
            str: it.str,
            x: it.transform[4],
            y: it.transform[5],
            width: it.width,
            height: it.height || Math.abs(it.transform[3]) || 10,
          });
        });
        var ops = window.LOC1999_SIGN.pageTextOps(libDoc, index);
        var report = window.LOC1999_SIGN.matchOpsToItems(ops, items);
        var opOf = {};
        report.matched.forEach(function (m) { opOf[m.itemIndex] = m.opIndex; });
        pages[index] = { items: items, ops: ops, opOf: opOf, unmatched: report.unmatchedItems.length };
        return pages[index];
      });
    });
  }

  function renderPage() {
    return doc.getPage(pageIndex + 1).then(function (page) {
      var base = page.getViewport({ scale: 1 });
      viewport = page.getViewport({ scale: VIEW_WIDTH / base.width });
      view.width = Math.floor(viewport.width);
      view.height = Math.floor(viewport.height);
      overlay.width = view.width;
      overlay.height = view.height;
      pageLabel.textContent = 'Page ' + (pageIndex + 1) + ' of ' + doc.numPages;
      return page.render({ canvasContext: view.getContext('2d'), viewport: viewport }).promise;
    }).then(function () {
      return analysePage(pageIndex);
    }).then(draw);
  }

  // -------------------------------------------------------------- coordinates
  function toCanvas(p) { return { x: p.x * viewport.scale, y: overlay.height - p.y * viewport.scale }; }
  function toPdf(p) { return window.LOC1999_SIGN.canvasToPdf(p, viewport); }

  function canvasPoint(event) {
    var r = overlay.getBoundingClientRect();
    return {
      x: (event.clientX - r.left) * (overlay.width / r.width),
      y: (event.clientY - r.top) * (overlay.height / r.height),
    };
  }

  /** Bounding box of a placed object, in canvas pixels. */
  function boxOf(obj) {
    var s = viewport.scale;
    var at = toCanvas(obj);
    if (obj.kind === 'text') {
      // Rough but honest: Helvetica averages about half its point size per
      // character, which is close enough to grab and drag.
      var w = obj.value.length * obj.size * 0.5 * s;
      var h = obj.size * s;
      return { x: at.x, y: at.y - h, w: Math.max(w, 8), h: h };
    }
    var width = obj.width * s;
    var height = obj.img ? (obj.img.height / obj.img.width) * width : width * 0.3;
    return { x: at.x, y: at.y, w: width, h: height };
  }

  function objectAt(point) {
    for (var i = objects.length - 1; i >= 0; i--) {
      if (objects[i].page !== pageIndex) continue;
      var b = boxOf(objects[i]);
      if (point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h) return objects[i];
    }
    return null;
  }

  function itemAt(point) {
    var info = pages[pageIndex];
    if (!info) return -1;
    var p = toPdf(point);
    for (var i = 0; i < info.items.length; i++) {
      var it = info.items[i];
      if (p.x >= it.x - 1 && p.x <= it.x + it.width + 1 && p.y >= it.y - 2 && p.y <= it.y + it.height + 2) return i;
    }
    return -1;
  }

  // ------------------------------------------------------------------ drawing
  var snapLine = null;

  function draw() {
    var ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    var s = viewport.scale;
    var info = pages[pageIndex] || { items: [], opOf: {} };

    // Text queued for deletion: struck through and tinted, so it is obvious
    // what will go without pretending it has already gone.
    var pending = removals[pageIndex] || {};
    Object.keys(info.opOf).forEach(function (itemIndex) {
      if (!pending[info.opOf[itemIndex]]) return;
      var it = info.items[itemIndex];
      var at = toCanvas({ x: it.x, y: it.y });
      ctx.fillStyle = 'rgba(204,0,0,0.18)';
      ctx.fillRect(at.x, at.y - it.height * s, it.width * s, it.height * s);
      ctx.strokeStyle = '#cc0000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(at.x, at.y - it.height * s * 0.35);
      ctx.lineTo(at.x + it.width * s, at.y - it.height * s * 0.35);
      ctx.stroke();
    });

    // Blackout rectangles: the blunt fallback that flattens the page.
    (flatten[pageIndex] || []).forEach(function (rect) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(rect.x * s, overlay.height - (rect.y + rect.height) * s, rect.width * s, rect.height * s);
    });

    objects.forEach(function (obj) {
      if (obj.page !== pageIndex) return;
      var at = toCanvas(obj);
      if (obj.kind === 'text') {
        ctx.fillStyle = '#000000';
        ctx.font = (obj.size * s) + 'px Helvetica, Arial, sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(obj.value, at.x, at.y);
      } else if (obj.img) {
        var w = obj.width * s;
        ctx.drawImage(obj.img, at.x, at.y, w, (obj.img.height / obj.img.width) * w);
      }
      if (obj === selected) {
        var b = boxOf(obj);
        ctx.strokeStyle = '#0000ee';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
        ctx.setLineDash([]);
      }
    });

    if (snapLine !== null) {
      ctx.strokeStyle = '#0000ee';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, snapLine);
      ctx.lineTo(overlay.width, snapLine);
      ctx.stroke();
    }

    describe();
  }

  function describe() {
    var removed = 0;
    Object.keys(removals).forEach(function (p) { removed += Object.keys(removals[p]).length; });
    var flattened = Object.keys(flatten).filter(function (p) { return (flatten[p] || []).length; }).length;
    var bits = [];
    if (objects.length) bits.push(objects.length + ' thing' + (objects.length === 1 ? '' : 's') + ' added');
    if (removed) bits.push('<strong>' + removed + ' piece' + (removed === 1 ? '' : 's') + ' of text deleted</strong>');
    if (flattened) bits.push(flattened + ' page' + (flattened === 1 ? '' : 's') + ' to flatten');
    editsEl.innerHTML = bits.length
      ? bits.join(' &middot; ') + (selected ? ' &middot; drag it, nudge with arrow keys, or press Delete' : '')
      : 'Nothing yet. Pick a tool, then click the page.';
  }

  // ------------------------------------------------------------- interactions
  var drag = null;
  var boxFrom = null;

  overlay.addEventListener('pointerdown', function (event) {
    if (!doc) return;
    var point = canvasPoint(event);

    // Anything already placed can be picked up, whatever tool is selected.
    var hit = objectAt(point);
    if (hit) {
      selected = hit;
      var at = toCanvas(hit);
      drag = { obj: hit, dx: point.x - at.x, dy: point.y - at.y };
      overlay.setPointerCapture(event.pointerId);
      syncControls(hit);
      draw();
      return;
    }

    if (tool() === 'blackout') {
      boxFrom = point;
      overlay.setPointerCapture(event.pointerId);
      return;
    }

    selected = null;
    draw();
  });

  overlay.addEventListener('pointermove', function (event) {
    if (!doc) return;
    var point = canvasPoint(event);

    if (drag) {
      var target = { x: point.x - drag.dx, y: point.y - drag.dy };
      var snapped = snap(toPdf(target));
      drag.obj.x = snapped.x;
      drag.obj.y = snapped.y;
      draw();
      return;
    }

    if (boxFrom) {
      draw();
      var ctx = overlay.getContext('2d');
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(Math.min(boxFrom.x, point.x), Math.min(boxFrom.y, point.y),
        Math.abs(point.x - boxFrom.x), Math.abs(point.y - boxFrom.y));
      return;
    }

    // Hovering over deletable text should look deletable.
    if (tool() === 'delete') overlay.style.cursor = itemAt(point) >= 0 ? 'pointer' : 'crosshair';
    else overlay.style.cursor = objectAt(point) ? 'move' : 'crosshair';
  });

  overlay.addEventListener('pointerup', function (event) {
    if (!doc) return;
    var point = canvasPoint(event);

    if (drag) {
      drag = null;
      snapLine = null;
      draw();
      return;
    }

    if (boxFrom) {
      var rect = window.LOC1999_SIGN.canvasRectToPdf(boxFrom, point, viewport);
      boxFrom = null;
      if (rect.width < window.LOC1999_SIGN.MIN_REDACTION_POINTS ||
          rect.height < window.LOC1999_SIGN.MIN_REDACTION_POINTS) {
        draw();
        return fail('That box is too small to be a selection. Drag across what you want covered.');
      }
      clearError();
      flatten[pageIndex] = (flatten[pageIndex] || []).concat([rect]);
      return draw();
    }

    if (tool() === 'delete') return deleteAt(point);
    if (tool() === 'text') return addText(point);
    if (tool() === 'stamp') return addSignature(point);
  });

  /* Double-click existing text to replace it: the old operator is deleted and
   * new text is placed where it sat, at the same size. Two steps, one gesture,
   * and the old characters really are gone rather than hidden underneath. */
  overlay.addEventListener('dblclick', function (event) {
    if (!doc || tool() !== 'delete') return;
    var point = canvasPoint(event);
    var index = itemAt(point);
    var info = pages[pageIndex];
    if (index < 0 || !info) return;
    var it = info.items[index];
    var replacement = window.prompt('Replace this text with:', it.str);
    if (replacement === null) return;
    if (!markForRemoval(index)) return;
    if (replacement) {
      objects.push({
        id: nextId++, kind: 'text', page: pageIndex,
        x: it.x, y: it.y, size: Math.round(it.height * 10) / 10, value: replacement,
      });
    }
    draw();
  });

  function markForRemoval(index) {
    var info = pages[pageIndex];
    var opIndex = info.opOf[index];
    if (opIndex === undefined) {
      fail(
        'That text cannot be removed cleanly — this document draws it in a way the ' +
        'editor cannot tie to a single instruction. Use “black out” for it instead: ' +
        'that flattens the page, but it is certain.',
      );
      return false;
    }
    clearError();
    removals[pageIndex] = removals[pageIndex] || {};
    if (removals[pageIndex][opIndex]) delete removals[pageIndex][opIndex];
    else removals[pageIndex][opIndex] = true;
    return true;
  }

  function deleteAt(point) {
    var index = itemAt(point);
    if (index < 0) return;
    markForRemoval(index);
    draw();
  }

  /** Snap a dragged position onto a nearby line, and remember the guide. */
  function snap(p) {
    var info = pages[pageIndex];
    snapLine = null;
    if (!info || !info.items.length || !$('snap').checked) return p;

    var bestY = null, bestDy = SNAP_POINTS;
    var bestX = null, bestDx = SNAP_POINTS;
    info.items.forEach(function (it) {
      var dy = Math.abs(it.y - p.y);
      if (dy < bestDy) { bestDy = dy; bestY = it.y; }
      var dx = Math.abs(it.x - p.x);
      if (dx < bestDx) { bestDx = dx; bestX = it.x; }
    });

    var out = { x: bestX === null ? p.x : bestX, y: bestY === null ? p.y : bestY };
    if (bestY !== null) snapLine = toCanvas({ x: 0, y: bestY }).y;
    return out;
  }

  /** The size of nearby text, so what you type matches the form it goes on. */
  function sizeNear(p) {
    var info = pages[pageIndex];
    if (!info) return null;
    var best = null, bestDy = 24;
    info.items.forEach(function (it) {
      var dy = Math.abs(it.y - p.y);
      if (dy < bestDy) { bestDy = dy; best = it.height; }
    });
    return best ? Math.round(best * 10) / 10 : null;
  }

  function addText(point) {
    var value = $('text-value').value;
    if (!value) return fail('Type the text first, then click where it goes.');
    clearError();
    var at = snap(toPdf(point));
    var auto = $('text-auto').checked ? sizeNear(at) : null;
    var size = auto || Number($('text-size').value) || 12;
    if (auto) $('text-size').value = auto;
    var obj = { id: nextId++, kind: 'text', page: pageIndex, x: at.x, y: at.y, size: size, value: value };
    objects.push(obj);
    selected = obj;
    snapLine = null;
    draw();
  }

  function addSignature(point) {
    signaturePng().then(function (sig) {
      if (!sig) return fail('Draw, type or pick a saved signature first, then click where it goes.');
      clearError();
      var at = snap(toPdf(point));
      var img = new Image();
      img.onload = function () {
        var width = Number($('sig-width').value) || 160;
        /* Where you click is where the signature should *sit*, not where its
         * top-left corner goes. Signing a line means the ink rests on it, so
         * the stamp is lifted by its own height — otherwise clicking the line
         * hangs your name underneath it and every signature needs dragging. */
        var height = (img.height / img.width) * width;
        var obj = {
          id: nextId++, kind: 'stamp', page: pageIndex, x: at.x, y: at.y + height,
          width: width, png: sig.bytes, img: img,
        };
        objects.push(obj);
        selected = obj;
        snapLine = null;
        draw();
      };
      img.src = sig.url;
    });
  }

  /* Only the panel for the tool in hand. Both at once pushes the document off
   * the screen, and the one you are not using is noise. */
  function syncTool() {
    var picked = tool();
    $('text-options').className = picked === 'text' ? '' : 'hidden';
    $('sig-options').className = picked === 'stamp' ? '' : 'hidden';
    overlay.style.cursor = 'crosshair';
  }

  function syncControls(obj) {
    if (obj.kind === 'text') $('text-size').value = obj.size;
    else $('sig-width').value = obj.width;
  }

  document.addEventListener('keydown', function (event) {
    if (!selected) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      objects = objects.filter(function (o) { return o !== selected; });
      selected = null;
      event.preventDefault();
      return draw();
    }
    // Arrow keys nudge by a point, which is how you line something up exactly.
    var step = event.shiftKey ? 10 : 1;
    var moved = true;
    if (event.key === 'ArrowLeft') selected.x -= step;
    else if (event.key === 'ArrowRight') selected.x += step;
    else if (event.key === 'ArrowUp') selected.y += step;
    else if (event.key === 'ArrowDown') selected.y -= step;
    else moved = false;
    if (moved) {
      event.preventDefault();
      draw();
    }
  });

  // --------------------------------------------------------------- signatures
  var padCtx = sigPad.getContext('2d');
  var drawing = false;
  var padUsed = false;
  var chosen = null; // a saved signature, if one is picked

  padCtx.lineWidth = 2.5;
  padCtx.lineCap = 'round';
  padCtx.lineJoin = 'round';

  function padPoint(event) {
    var r = sigPad.getBoundingClientRect();
    return {
      x: (event.clientX - r.left) * (sigPad.width / r.width),
      y: (event.clientY - r.top) * (sigPad.height / r.height),
    };
  }
  sigPad.addEventListener('pointerdown', function (e) {
    drawing = true; padUsed = true; chosen = null;
    sigPad.setPointerCapture(e.pointerId);
    var p = padPoint(e);
    padCtx.beginPath();
    padCtx.moveTo(p.x, p.y);
    e.preventDefault();
  });
  sigPad.addEventListener('pointermove', function (e) {
    if (!drawing) return;
    var p = padPoint(e);
    padCtx.lineTo(p.x, p.y);
    padCtx.stroke();
    e.preventDefault();
  });
  sigPad.addEventListener('pointerup', function () { drawing = false; });
  $('sig-clear').addEventListener('click', function () {
    padCtx.clearRect(0, 0, sigPad.width, sigPad.height);
    padUsed = false;
    chosen = null;
    renderSaved();
  });

  function currentCanvas() {
    var typed = $('sig-typed').value.trim();
    if (padUsed) return sigPad;
    if (!typed) return null;
    var canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 220;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.font = '86px ' + $('sig-font').value;
    ctx.textBaseline = 'middle';
    ctx.fillText(typed, 10, canvas.height / 2);
    return canvas;
  }

  function signaturePng() {
    if (chosen) {
      return fetch(chosen).then(function (r) { return r.blob(); }).then(function (blob) {
        return blob.arrayBuffer().then(function (buf) {
          return { bytes: new Uint8Array(buf), url: chosen };
        });
      });
    }
    var canvas = currentCanvas();
    if (!canvas) return Promise.resolve(null);
    var trimmed = trim(canvas);
    return new Promise(function (resolve) {
      trimmed.toBlob(function (blob) {
        blob.arrayBuffer().then(function (buf) {
          resolve({ bytes: new Uint8Array(buf), url: URL.createObjectURL(blob) });
        });
      }, 'image/png');
    });
  }

  /** Crop to the ink, so placing a signature does not place a huge empty box. */
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

  /* Saved signatures live in this browser's localStorage and nowhere else.
   * They never touch a server, which is the only reason offering to store a
   * signature image at all is a reasonable thing to do. */
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (e) { return []; }
  }
  function storeSaved(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
  }

  function renderSaved() {
    var list = loadSaved();
    if (!list.length) {
      savedEl.innerHTML = '<p class="note">No saved signatures yet. Draw or type one, save it, ' +
        'and it is one click to stamp on any document after that.</p>';
      return;
    }
    savedEl.innerHTML = '<table><tbody>' + list.map(function (sig, i) {
      return '<tr><td><img class="sig-thumb" src="' + esc(sig.png) + '" alt="saved signature"></td>' +
        '<td><button type="button" data-use="' + i + '">' + (chosen === sig.png ? 'In use' : 'Use this') + '</button> ' +
        '<button type="button" data-drop="' + i + '">Forget</button></td></tr>';
    }).join('') + '</tbody></table>';

    Array.prototype.forEach.call(savedEl.querySelectorAll('[data-use]'), function (btn) {
      btn.addEventListener('click', function () {
        chosen = loadSaved()[Number(btn.getAttribute('data-use'))].png;
        padCtx.clearRect(0, 0, sigPad.width, sigPad.height);
        padUsed = false;
        $('sig-typed').value = '';
        document.querySelector('input[value="stamp"]').checked = true;
        syncTool(); // setting .checked in script does not fire change
        renderSaved();
        statusEl.textContent = 'Signature ready — click the page to stamp it.';
      });
    });
    Array.prototype.forEach.call(savedEl.querySelectorAll('[data-drop]'), function (btn) {
      btn.addEventListener('click', function () {
        var list2 = loadSaved();
        var at = Number(btn.getAttribute('data-drop'));
        if (chosen === list2[at].png) chosen = null;
        list2.splice(at, 1);
        storeSaved(list2);
        renderSaved();
      });
    });
  }

  $('sig-save').addEventListener('click', function () {
    var canvas = currentCanvas();
    if (!canvas) return fail('Draw or type a signature first.');
    clearError();
    var list = loadSaved();
    list.push({ png: trim(canvas).toDataURL('image/png') });
    storeSaved(list.slice(-6));
    renderSaved();
    statusEl.textContent = 'Saved in this browser. It never leaves your device.';
  });

  // -------------------------------------------------------------------- save
  function resetOutput() {
    liveUrls.forEach(URL.revokeObjectURL);
    liveUrls = [];
    outputEl.innerHTML = '';
    summaryEl.textContent = '';
  }

  function rasterise(fromDoc, index) {
    return fromDoc.getPage(index + 1).then(function (page) {
      var vp = page.getViewport({ scale: RASTER_SCALE });
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      var ctx = canvas.getContext('2d');
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        ctx.fillStyle = '#000000';
        (flatten[index] || []).forEach(function (r) {
          ctx.fillRect(r.x * RASTER_SCALE, canvas.height - (r.y + r.height) * RASTER_SCALE,
            r.width * RASTER_SCALE, r.height * RASTER_SCALE);
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

  /* Which document the blackout pages get rendered from.
   *
   * Normally the one on screen. But if a page is both surgically cut and
   * blacked out, rendering the original would paint the deleted text straight
   * back in as pixels — permanently, and invisibly to the person who thought
   * they had deleted it. So in that case the cuts are written first and the
   * result re-opened, and the raster is taken from the document that no longer
   * contains the text. Costs one extra write, only when both tools were used.
   */
  function basisFor(removalList, flatPages) {
    if (!removalList.length || !flatPages.length) {
      return Promise.resolve({ bytes: sourceBytes, doc: doc, removals: removalList });
    }
    return window.LOC1999_SIGN.applyEdits(sourceBytes, [], [], removalList).then(function (cut) {
      return pdfjs.getDocument({
        data: cut.slice(),
        standardFontDataUrl: '/vendor/standard_fonts/',
        cMapUrl: '/vendor/cmaps/',
        cMapPacked: true,
      }).promise.then(function (reopened) {
        // The cuts are already in these bytes, so they must not be applied again.
        return { bytes: cut, doc: reopened, removals: [] };
      });
    });
  }

  function save() {
    clearError();
    resetOutput();
    var removalList = Object.keys(removals)
      .map(function (p) { return { page: Number(p), opIndices: pageRemovals(p) }; })
      .filter(function (r) { return r.opIndices.length; });
    var flatPages = Object.keys(flatten)
      .filter(function (p) { return (flatten[p] || []).length; })
      .map(Number);

    if (!objects.length && !removalList.length && !flatPages.length) {
      return fail('Nothing has been changed yet.');
    }

    $('save').disabled = true;
    statusEl.textContent = flatPages.length ? 'Flattening blacked-out pages…' : 'Writing the PDF…';

    basisFor(removalList, flatPages)
      .then(function (basis) {
        return flatPages
          .reduce(function (chain, index) {
            return chain.then(function (list) {
              return rasterise(basis.doc, index).then(function (r) { return list.concat([r]); });
            });
          }, Promise.resolve([]))
          .then(function (rasters) {
            statusEl.textContent = 'Writing the PDF…';
            var edits = objects.map(function (o) {
              return o.kind === 'text'
                ? { kind: 'text', page: o.page, at: { x: o.x, y: o.y }, value: o.value, size: o.size }
                : { kind: 'stamp', page: o.page, at: { x: o.x, y: o.y }, png: o.png, width: o.width };
            });
            return window.LOC1999_SIGN.applyEdits(basis.bytes, edits, rasters, basis.removals);
          });
      })
      .then(function (out) {
        $('save').disabled = false;
        statusEl.textContent = '';
        var blob = new Blob([out], { type: 'application/pdf' });
        var url = URL.createObjectURL(blob);
        liveUrls.push(url);
        var removed = removalList.reduce(function (n, r) { return n + r.opIndices.length; }, 0);
        summaryEl.textContent =
          [objects.length ? objects.length + ' added' : null,
            removed ? removed + ' deleted from the file itself' : null,
            flatPages.length ? flatPages.length + ' page' + (flatPages.length === 1 ? '' : 's') + ' flattened' : null]
            .filter(Boolean).join(', ') + '. ' + bytesLabel(blob.size) + '.';
        outputEl.innerHTML = '<ul class="plain"><li><a href="' + url + '" download="edited.pdf">edited.pdf</a></li></ul>';
      })
      .catch(function (err) {
        $('save').disabled = false;
        fail((err && err.message) || 'Could not write that PDF.');
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

  $('prev').addEventListener('click', function () {
    if (pageIndex > 0) { pageIndex--; selected = null; renderPage(); }
  });
  $('next').addEventListener('click', function () {
    if (doc && pageIndex < doc.numPages - 1) { pageIndex++; selected = null; renderPage(); }
  });
  $('undo').addEventListener('click', function () {
    if (objects.length) objects.pop();
    selected = null;
    clearError();
    draw();
  });
  $('save').addEventListener('click', save);
  $('sig-width').addEventListener('input', function () {
    $('sig-mm').textContent = Math.round((Number($('sig-width').value) || 0) / 72 * 25.4);
    if (selected && selected.kind === 'stamp') {
      selected.width = Number($('sig-width').value) || selected.width;
      draw();
    }
  });
  $('text-size').addEventListener('input', function () {
    if (selected && selected.kind === 'text') {
      selected.size = Number($('text-size').value) || selected.size;
      draw();
    }
  });

  Array.prototype.forEach.call(document.querySelectorAll('input[name="tool"]'), function (radio) {
    radio.addEventListener('change', syncTool);
  });

  renderSaved();
  syncTool();
})();

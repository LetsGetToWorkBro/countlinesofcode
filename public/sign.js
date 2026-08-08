/* 1999.LOC PDF editor. Vanilla JS, no build step.
 *
 * Loaded on first file open, both from this origin:
 *   /vendor/pdf.min.mjs  — pdf.js, to render pages and report where text is
 *   /pdfsign.js          — pdf-lib plus the content-stream reader, to write
 *
 * Nothing here uploads anything. There is no fetch() to any endpoint.
 *
 * This drives an application, not a form. The markup in sign.html is a menu
 * bar, two toolbars, a thumbnail rail, a page well and a status bar; this
 * file is the program behind them. The rules it works to:
 *
 *   - The tool you hold is a pressed button on a toolbar, not a radio in a
 *     list. You should be able to tell which one it is from across the room.
 *   - Clicking the page with the text tool puts a caret there and you type.
 *     The old flow — fill a box, then click — meant the text existed before
 *     the place did, which is backwards from every editor ever written.
 *   - Anything on the page can be picked up and dropped, including the
 *     signature, which you drag out of its drawer onto the paper.
 *
 * The interesting part is still how deleting text works. pdf.js knows what a
 * string says and how wide it is, because it has the fonts. The content-stream
 * reader knows which bytes of the file drew it. Matching the two by position
 * gives both: an accurate box to click on, and the exact operator to remove.
 * Delete the operator and those characters are gone from the file — nothing
 * covered over, nothing flattened to a picture, and every other word on the
 * page is still real selectable text.
 *
 * When the two cannot be matched, that text is marked unremovable and the
 * blackout tool is offered instead. Guessing which operator to delete would
 * damage a document somebody is about to rely on.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var reader = $('reader');
  var dropzone = $('drop');
  var fileInput = $('file-input');
  var statusEl = $('status');
  var errorEl = $('error');
  var body = $('reader-body');
  var well = $('well');
  var stage = $('stage');
  var rail = $('rail');
  var view = $('view');
  var overlay = $('overlay');
  var summaryEl = $('summary');
  var outputEl = $('output');
  var sigPad = $('sig-pad');
  var savedEl = $('saved-sigs');
  var chip = $('sig-chip');

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
  var turns = {};              // page -> quarter turns the visitor has added
  var selected = null;
  var liveUrls = [];
  var nextId = 1;
  var formFields = [];         // AcroForm fields read from the document
  var formValues = {};         // field name -> value the visitor typed/picked

  var RASTER_SCALE = 2;
  /* Snap a dragged object onto a nearby line of existing text. Four points is
   * about a third of a line of body text: close enough to catch an intended
   * alignment, far enough not to fight somebody placing something deliberately
   * between two lines. */
  var SNAP_POINTS = 4;
  var STORE_KEY = 'loc1999:signatures';
  var ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  var zoomMode = 'fit';        // 'fit', or a number that is the scale itself

  // ---------------------------------------------------------------- helpers
  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fail(m) { errorEl.textContent = m; statusEl.textContent = ''; }
  function clearError() { errorEl.textContent = ''; }
  function bytesLabel(n) {
    return n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  }
  function pageRemovals(p) { return Object.keys(removals[p] || {}).map(Number); }
  function round1(n) { return Math.round(n * 10) / 10; }
  function show(el, on) { el.classList.toggle('hidden', !on); }

  // ------------------------------------------------------------------- tools
  /* The tool in hand. A pressed toolbar button rather than a checked radio:
   * same state, but it is legible at a glance and it leaves the space beside
   * the document free for the document. */
  var currentTool = 'text';
  function tool() { return currentTool; }

  function setTool(name) {
    commitCaret();
    currentTool = name;
    Array.prototype.forEach.call(document.querySelectorAll('.tbtn.tool'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-tool') === name);
      b.setAttribute('aria-pressed', b.getAttribute('data-tool') === name ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.opt-group'), function (g) {
      g.classList.toggle('is-on', g.id === 'opt-' + name);
    });
    // The signature drawer belongs to the signature tool and nothing else.
    $('sig-drawer').classList.toggle('is-on', name === 'stamp');

    /* The form inputs sit over the page and would swallow clicks meant for the
     * other tools, so they are only live in form-fill mode. */
    var filling = name === 'form';
    $('form-layer').className = filling ? 'form-layer' : 'form-layer hidden';
    overlay.style.pointerEvents = filling ? 'none' : 'auto';
    if (filling) placeFormInputs();
    if (viewport) draw();
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
        turns = {};
        selected = null;
        formValues = {};
        zoomMode = 'fit';
        pages = new Array(doc.numPages);
        readForm();
        show(dropzone, false);
        show(body, true);
        $('page-count').textContent = doc.numPages;
        $('page-num').max = doc.numPages;
        enableChrome(true);
        buildRail();
        return renderPage();
      })
      .catch(function (err) {
        fail((err && err.message) || 'That file could not be opened as a PDF.');
      });
  }

  /* The toolbar is dead until there is a document to act on. A row of buttons
   * that do nothing is the thing that made the old page feel broken. */
  function enableChrome(on) {
    ['t-save', 't-undo', 't-rot-l', 't-rot-r', 't-zoom-in', 't-zoom-out',
      't-prev', 't-next', 'page-num'].forEach(function (id) { $(id).disabled = !on; });
    Array.prototype.forEach.call(document.querySelectorAll('.tbtn.tool'), function (b) {
      b.disabled = !on;
    });
    if (!on) return;
    $('t-undo').disabled = true;   // nothing to undo yet
  }

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

  // ---------------------------------------------------------------- rotation
  /* A page already carries a rotation of its own — that is how a sideways
   * scan is stored — and the visitor's turns add to it. What everything else
   * works in is the total: it is what pdf.js is asked to display, what the
   * click coordinates are measured against, and what gets written to the page
   * on save. Keeping the visitor's turns separate from the page's own is what
   * lets "turn left" mean the same thing on an upright page and a sideways one.
   */
  var baseRotations = {};   // page -> the /Rotate the document itself carries

  function totalRotation(index) {
    return (((baseRotations[index] || 0) + (turns[index] || 0) * 90) % 360 + 360) % 360;
  }

  function turn(by) {
    if (!doc || !viewport) return;
    commitCaret();
    // The page's size in points as it is displayed *now*, before the turn.
    // Everything already on the page is anchored in that space, so it has to
    // be carried into the new one or it stays where the old page used to be.
    turnMarks(by, viewport.width / viewport.scale, viewport.height / viewport.scale);
    turns[pageIndex] = ((turns[pageIndex] || 0) + by) % 4;
    renderPage().then(function () { drawThumb(pageIndex); });
  }

  /* Carry everything on this page through a quarter turn.
   *
   * Turning the paper has to take what is written on it along, or signing a
   * contract and then straightening the scan puts your name in the margin.
   * A point (x, y) on a page W by H, turned clockwise, lands at (y, W - x):
   * the old bottom-left corner becomes the new top-left, which is what the
   * sheet does in your hands. Anticlockwise is the same map inverted.
   *
   * Marks stay upright to the reader rather than spinning with the sheet,
   * which is what you want in the case this exists for: a sideways scan set
   * straight, with its signature still readable.
   */
  function turnMarks(by, width, height) {
    var clockwise = by > 0;
    objects.forEach(function (obj) {
      if (obj.page !== pageIndex) return;
      var x = obj.x, y = obj.y;
      obj.x = clockwise ? y : height - y;
      obj.y = clockwise ? width - x : x;
    });
    // A blackout box turns too, and swaps its sides doing it.
    var boxes = flatten[pageIndex];
    if (!boxes || !boxes.length) return;
    flatten[pageIndex] = boxes.map(function (r) {
      return clockwise
        ? { x: r.y, y: width - r.x - r.width, width: r.height, height: r.width }
        : { x: height - r.y - r.height, y: r.x, width: r.height, height: r.width };
    });
  }

  // ------------------------------------------------------------------ render
  /** The scale to render at: fit the well, or whatever zoom was asked for. */
  function scaleFor(baseWidth) {
    if (zoomMode !== 'fit') return zoomMode;
    var room = Math.max(240, well.clientWidth - 30);
    // Never blow a small page up past life size just because there is room.
    return Math.min(room / baseWidth, 1.6);
  }

  function renderPage() {
    if (!doc) return Promise.resolve();
    return doc.getPage(pageIndex + 1).then(function (page) {
      baseRotations[pageIndex] = page.rotate || 0;
      var rotation = totalRotation(pageIndex);
      var base = page.getViewport({ scale: 1, rotation: rotation });
      viewport = page.getViewport({ scale: scaleFor(base.width), rotation: rotation });
      view.width = Math.floor(viewport.width);
      view.height = Math.floor(viewport.height);
      overlay.width = view.width;
      overlay.height = view.height;
      return page.render({ canvasContext: view.getContext('2d'), viewport: viewport }).promise;
    }).then(function () {
      return analysePage(pageIndex);
    }).then(function () {
      draw();
      syncStatus();
      markCurrentThumb();
      if (tool() === 'form') placeFormInputs();
    });
  }

  function goTo(index) {
    if (!doc) return;
    var next = Math.max(0, Math.min(doc.numPages - 1, index));
    if (next === pageIndex) return;
    commitCaret();
    pageIndex = next;
    selected = null;
    renderPage();
  }

  // ------------------------------------------------------------ the page rail
  /* One thumbnail per page, rendered small and once. A reader without a rail
   * makes you page through a contract with two arrows and a guess. */
  function buildRail() {
    rail.innerHTML = '';
    var chain = Promise.resolve();
    for (var i = 0; i < doc.numPages; i++) {
      (function (index) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'thumb';
        button.setAttribute('data-page', index);
        button.title = 'Page ' + (index + 1);
        var canvas = document.createElement('canvas');
        var label = document.createElement('span');
        label.textContent = index + 1;
        button.appendChild(canvas);
        button.appendChild(label);
        button.addEventListener('click', function () { goTo(index); });
        rail.appendChild(button);
        chain = chain.then(function () { return drawThumb(index); });
      })(i);
    }
    markCurrentThumb();
  }

  function drawThumb(index) {
    var button = rail.querySelector('.thumb[data-page="' + index + '"]');
    if (!button || !doc) return Promise.resolve();
    return doc.getPage(index + 1).then(function (page) {
      var rotation = totalRotation(index);
      var base = page.getViewport({ scale: 1, rotation: rotation });
      var vp = page.getViewport({ scale: 78 / base.width, rotation: rotation });
      var canvas = button.querySelector('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    });
  }

  function markCurrentThumb() {
    Array.prototype.forEach.call(rail.querySelectorAll('.thumb'), function (b) {
      var on = Number(b.getAttribute('data-page')) === pageIndex;
      b.classList.toggle('is-current', on);
      if (on && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
    });
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
      var lines = String(obj.value).split('\n');
      var longest = lines.reduce(function (n, l) { return Math.max(n, l.length); }, 0);
      // Rough but honest: Helvetica averages about half its point size per
      // character, which is close enough to grab and drag.
      var w = longest * obj.size * 0.5 * s;
      var h = obj.size * s;
      return { x: at.x, y: at.y - h, w: Math.max(w, 8), h: h * lines.length };
    }
    var width = obj.width * s;
    var height = obj.img ? (obj.img.height / obj.img.width) * width : width * 0.3;
    return { x: at.x, y: at.y, w: width, h: height };
  }

  /* Corner grips on whatever is selected. Kept in canvas pixels because that
   * is where the pointer is; only the result is converted back to points.
   * Ten, not six: a grip you have to hunt for is a grip that does not work,
   * and this is the size a finger needs as much as a mouse. */
  var GRIP = 10;

  function gripsOf(obj) {
    var b = boxOf(obj);
    return [
      { id: 'nw', x: b.x, y: b.y, anchor: { x: b.x + b.w, y: b.y + b.h } },
      { id: 'ne', x: b.x + b.w, y: b.y, anchor: { x: b.x, y: b.y + b.h } },
      { id: 'sw', x: b.x, y: b.y + b.h, anchor: { x: b.x + b.w, y: b.y } },
      { id: 'se', x: b.x + b.w, y: b.y + b.h, anchor: { x: b.x, y: b.y } },
    ];
  }

  function gripAt(point) {
    if (!selected || selected.page !== pageIndex) return null;
    var grips = gripsOf(selected);
    for (var i = 0; i < grips.length; i++) {
      if (Math.abs(point.x - grips[i].x) <= GRIP && Math.abs(point.y - grips[i].y) <= GRIP) return grips[i];
    }
    return null;
  }

  /**
   * Resize to wherever the pointer is, keeping the opposite corner pinned and
   * the shape unchanged. Driven by width alone: dragging a corner of a picture
   * should never squash it, so the height always follows the aspect ratio.
   */
  function resizeTo(state, point) {
    var obj = state.obj;
    var scale = viewport.scale;
    var width = Math.max(GRIP * 2, Math.abs(point.x - state.anchor.x));
    var height = width * state.ratio;
    var left = point.x >= state.anchor.x ? state.anchor.x : state.anchor.x - width;
    var top = point.y >= state.anchor.y ? state.anchor.y : state.anchor.y - height;

    obj.x = left / scale;
    if (obj.kind === 'text') {
      obj.size = Math.max(2, Math.round((height / scale) * 10) / 10);
      // y is the baseline for text, which is the bottom of the box.
      obj.y = (overlay.height - (top + height)) / scale;
      $('text-size').value = obj.size;
    } else {
      obj.width = Math.round((width / scale) * 10) / 10;
      obj.y = (overlay.height - top) / scale; // y is the top for a picture
      $(obj.what === 'picture' ? 'image-width' : 'sig-width').value = obj.width;
    }
  }

  /* What is under the pointer. The box is grown by a few pixels first: a line
   * of 9pt text is four pixels tall on screen, and asking somebody to hit that
   * exactly is why "the drag and drop needs some work". */
  var GRAB_SLOP = 4;
  function objectAt(point) {
    for (var i = objects.length - 1; i >= 0; i--) {
      if (objects[i].page !== pageIndex) continue;
      var b = boxOf(objects[i]);
      if (point.x >= b.x - GRAB_SLOP && point.x <= b.x + b.w + GRAB_SLOP &&
          point.y >= b.y - GRAB_SLOP && point.y <= b.y + b.h + GRAB_SLOP) return objects[i];
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
    if (!viewport) return;
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
        String(obj.value).split('\n').forEach(function (line, i) {
          ctx.fillText(line, at.x, at.y + i * obj.size * 1.2 * s);
        });
      } else if (obj.img) {
        var w = obj.width * s;
        ctx.drawImage(obj.img, at.x, at.y, w, (obj.img.height / obj.img.width) * w);
      }
      if (obj === selected) {
        var b = boxOf(obj);
        ctx.strokeStyle = '#0a246a';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
        ctx.setLineDash([]);
        // Grips last, so they sit on top of the outline and are obvious.
        gripsOf(obj).forEach(function (grip) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(grip.x - 5, grip.y - 5, 10, 10);
          ctx.strokeStyle = '#0a246a';
          ctx.strokeRect(grip.x - 5, grip.y - 5, 10, 10);
        });
      }
    });

    if (snapLine !== null) {
      ctx.strokeStyle = '#0a246a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, snapLine);
      ctx.lineTo(overlay.width, snapLine);
      ctx.stroke();
    }

    syncStatus();
  }

  /* The status bar. Where you are, how big it is, what you have changed —
   * the three things a document window has told you since about 1990. */
  function syncStatus() {
    if (!doc) {
      $('st-page').textContent = 'No document open';
      $('st-size').textContent = '';
      $('st-edits').textContent = 'Nothing changed yet';
      return;
    }
    var turned = (turns[pageIndex] || 0) % 4;
    $('st-page').textContent = 'Page ' + (pageIndex + 1) + ' of ' + doc.numPages +
      (turned ? ' (turned)' : '');
    $('page-num').value = pageIndex + 1;
    var pct = Math.round(viewport ? viewport.scale * 100 : 100);
    $('zoom-label').textContent = pct + '%';
    /* The paper's real size, which is the thing a document window's status bar
     * is for and the thing you want when a page turns out to be A4 and the
     * printer is loaded with Letter. A point is a seventy-second of an inch. */
    if (viewport) {
      var inW = (viewport.width / viewport.scale) / 72;
      var inH = (viewport.height / viewport.scale) / 72;
      $('st-size').textContent = round1(inW) + ' x ' + round1(inH) + ' in';
    }

    var removed = 0;
    Object.keys(removals).forEach(function (p) { removed += Object.keys(removals[p]).length; });
    var flattened = Object.keys(flatten).filter(function (p) { return (flatten[p] || []).length; }).length;
    var turnCount = Object.keys(turns).filter(function (p) { return turns[p] % 4; }).length;
    var bits = [];
    if (objects.length) bits.push(objects.length + ' added');
    if (removed) bits.push(removed + ' deleted from the file');
    if (flattened) bits.push(flattened + ' to flatten');
    if (turnCount) bits.push(turnCount + ' turned');
    $('st-edits').textContent = bits.length
      ? bits.join(' · ') + (selected ? ' · drag it, or arrow keys to nudge' : '')
      : 'Nothing changed yet';
    $('t-undo').disabled = !objects.length;
    $('t-save').disabled = !(objects.length || removed || flattened || turnCount ||
      Object.keys(formValues).length);
  }

  // ------------------------------------------------------------- the caret
  /* Typing on the page.
   *
   * The old flow asked for the words before the place: fill in a text box,
   * then click the page, and the two arrive together. Every editor ever
   * written does the opposite, so this does too — click, and a real text box
   * appears at that spot, at the size the text will be, and you type into it.
   * What you see while typing is what lands.
   *
   * It is a textarea rather than a contenteditable because a textarea cannot
   * be given formatting by a paste, and this only ever produces plain text.
   */
  var caret = null;

  function openCaret(point, seed) {
    commitCaret();
    var at = snap(toPdf(point));
    var auto = $('text-auto').checked ? sizeNear(at) : null;
    var size = auto || Number($('text-size').value) || 12;
    if (auto) $('text-size').value = auto;

    var box = document.createElement('textarea');
    box.className = 'page-caret';
    box.rows = 1;
    box.spellcheck = false;
    box.value = seed || '';
    var px = size * viewport.scale;
    var pos = toCanvas(at);
    var ratio = overlay.getBoundingClientRect().width / overlay.width; // canvas px -> css px
    box.style.fontSize = (px * ratio) + 'px';
    box.style.left = (pos.x * ratio) + 'px';
    /* The click marks the baseline, the way it does for the finished text.
     * A line box sits about four fifths of its size above its own baseline,
     * so the box is lifted by that much and the two line up. */
    box.style.top = ((pos.y - px * 0.8) * ratio) + 'px';
    box.style.height = (px * 1.25 * ratio) + 'px';
    box.style.width = '9em';

    stage.appendChild(box);
    caret = { el: box, at: at, size: size };
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);

    box.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); cancelCaret(); return; }
      // Enter commits, because a single line is what nearly every one of
      // these is. Shift+Enter is the second line, for the ones that are not.
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); commitCaret(); return; }
      if (event.key === 'Enter') {
        box.style.height = ((box.value.split('\n').length + 1) * px * 1.25 * ratio) + 'px';
      }
    });
    box.addEventListener('blur', commitCaret);
  }

  function commitCaret() {
    if (!caret) return;
    var live = caret;
    caret = null;                        // before the DOM work: blur re-enters
    var value = live.el.value.replace(/\s+$/, '');
    live.el.remove();
    if (!value) return;
    var obj = {
      id: nextId++, kind: 'text', page: pageIndex,
      x: live.at.x, y: live.at.y, size: live.size, value: value,
    };
    objects.push(obj);
    selected = obj;
    snapLine = null;
    clearError();
    draw();
  }

  function cancelCaret() {
    if (!caret) return;
    var live = caret;
    caret = null;
    live.el.remove();
    draw();
  }

  // ------------------------------------------------------------- interactions
  var drag = null;
  var resize = null;
  var boxFrom = null;
  var moved = false;

  overlay.addEventListener('pointerdown', function (event) {
    if (!doc) return;
    var point = canvasPoint(event);
    moved = false;

    // A grip is checked first: it sits on the object's own outline, so
    // whichever is tested second can never be reached.
    var grip = gripAt(point);
    if (grip) {
      commitCaret();
      var box = boxOf(selected);
      resize = { obj: selected, anchor: grip.anchor, ratio: box.h / Math.max(1, box.w) };
      overlay.setPointerCapture(event.pointerId);
      return;
    }

    // Anything already placed can be picked up, whatever tool is selected.
    var hit = objectAt(point);
    if (hit) {
      commitCaret();
      selected = hit;
      var at = toCanvas(hit);
      drag = { obj: hit, dx: point.x - at.x, dy: point.y - at.y };
      overlay.setPointerCapture(event.pointerId);
      syncControls(hit);
      draw();
      return;
    }

    if (tool() === 'blackout') {
      commitCaret();
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

    if (resize) { moved = true; resizeTo(resize, point); draw(); return; }

    if (drag) {
      moved = true;
      var target = { x: point.x - drag.dx, y: point.y - drag.dy };
      var snapped = snap(toPdf(target));
      drag.obj.x = snapped.x;
      drag.obj.y = snapped.y;
      draw();
      return;
    }

    if (boxFrom) {
      moved = true;
      draw();
      var ctx = overlay.getContext('2d');
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(Math.min(boxFrom.x, point.x), Math.min(boxFrom.y, point.y),
        Math.abs(point.x - boxFrom.x), Math.abs(point.y - boxFrom.y));
      return;
    }

    // Hovering should say what a click will do.
    var over = gripAt(point);
    if (over) overlay.style.cursor = over.id === 'nw' || over.id === 'se' ? 'nwse-resize' : 'nesw-resize';
    else if (objectAt(point)) overlay.style.cursor = 'move';
    else if (tool() === 'text') overlay.style.cursor = 'text';
    else if (tool() === 'delete') overlay.style.cursor = itemAt(point) >= 0 ? 'pointer' : 'crosshair';
    else overlay.style.cursor = 'crosshair';
  });

  overlay.addEventListener('pointerup', function (event) {
    if (!doc) return;
    var point = canvasPoint(event);

    if (resize) { resize = null; draw(); return; }
    if (drag) { drag = null; snapLine = null; draw(); return; }

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

    if (moved) return;                   // a drag that ended on empty paper
    if (tool() === 'delete') return deleteAt(point);
    if (tool() === 'text') return openCaret(point);
    if (tool() === 'stamp') return placeSignature(point);
    if (tool() === 'image') return addImage(point);
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
    if (!markForRemoval(index)) return;
    draw();
    /* Straight into a caret at the old text's own spot and size, rather than
     * a prompt() box: you are replacing words on a page, so you should be
     * looking at the page while you do it. */
    var wasAuto = $('text-auto').checked;
    $('text-auto').checked = false;
    $('text-size').value = Math.round(it.height * 10) / 10;
    openCaret(toCanvas({ x: it.x, y: it.y }), it.str);
    $('text-auto').checked = wasAuto;
  });

  function markForRemoval(index) {
    var info = pages[pageIndex];
    var opIndex = info.opOf[index];
    if (opIndex === undefined) {
      fail(
        'That text cannot be removed cleanly: this document draws it in a way the ' +
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

  // --------------------------------------------------------- placing a signature
  function placeSignature(point) {
    return signaturePng().then(function (sig) {
      if (!sig) return fail('Draw or type a signature first, then drop it on the page.');
      clearError();
      var at = snap(toPdf(point));
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
          var width = Number($('sig-width').value) || 160;
          /* Where you click is where the signature should *sit*, not where its
           * top-left corner goes. Signing a line means the ink rests on it, so
           * the stamp is lifted by its own height — otherwise clicking the line
           * hangs your name underneath it and every signature needs dragging. */
          var height = (img.height / img.width) * width;
          var obj = {
            id: nextId++, kind: 'stamp', what: 'signature', page: pageIndex,
            x: at.x, y: at.y + height, width: width, bytes: sig.bytes, img: img,
          };
          objects.push(obj);
          selected = obj;
          snapLine = null;
          draw();
          resolve();
        };
        img.src = sig.url;
      });
    });
  }

  /* Dragging the signature out of the drawer and onto the paper.
   *
   * Pointer events rather than HTML5 drag-and-drop on purpose: the native API
   * does not fire on touch at all, so on a phone the drawer's "drag this"
   * would be a lie. This works with a mouse, a finger and a stylus alike, and
   * the ghost that follows the pointer is what makes it obvious that
   * something is being carried.
   */
  var carrying = null;

  chip.addEventListener('pointerdown', function (event) {
    if (chip.classList.contains('is-empty') || !doc) return;
    event.preventDefault();
    chip.setPointerCapture(event.pointerId);
    var ghost = document.createElement('img');
    ghost.className = 'drag-ghost';
    ghost.src = $('sig-chip-img').src;
    ghost.alt = '';
    ghost.width = 150;
    document.body.appendChild(ghost);
    carrying = { ghost: ghost };
    moveGhost(event);
  });

  chip.addEventListener('pointermove', function (event) {
    if (!carrying) return;
    moveGhost(event);
  });

  chip.addEventListener('pointerup', function (event) {
    if (!carrying) return;
    carrying.ghost.remove();
    carrying = null;
    var r = overlay.getBoundingClientRect();
    var inside = event.clientX >= r.left && event.clientX <= r.right &&
                 event.clientY >= r.top && event.clientY <= r.bottom;
    if (!inside) {
      statusEl.textContent = 'Drop it on the page to place it.';
      return;
    }
    placeSignature(canvasPoint(event));
  });

  chip.addEventListener('pointercancel', function () {
    if (!carrying) return;
    carrying.ghost.remove();
    carrying = null;
  });

  function moveGhost(event) {
    carrying.ghost.style.left = (event.clientX - 60) + 'px';
    carrying.ghost.style.top = (event.clientY - 20) + 'px';
  }

  /* Keyboard: there has to be a way to place it that is not a drag. Enter puts
   * it in the middle of the page, where it can then be nudged with the arrows
   * like anything else. */
  chip.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (chip.classList.contains('is-empty') || !doc) return;
    event.preventDefault();
    placeSignature({ x: overlay.width / 2, y: overlay.height / 2 });
  });

  /** The chip shows whatever signature is currently ready to go. */
  function refreshChip() {
    signaturePng().then(function (sig) {
      var img = $('sig-chip-img');
      var hint = $('sig-chip-hint');
      if (!sig) {
        chip.classList.add('is-empty');
        img.hidden = true;
        img.removeAttribute('src');
        hint.textContent = 'Draw or type one first';
        return;
      }
      chip.classList.remove('is-empty');
      img.src = sig.url;
      img.hidden = false;
      hint.textContent = 'Drag me';
    });
  }

  // ------------------------------------------------------------------- forms
  /* Read the fillable fields, if the document has any, and offer the tool.
   * Most PDFs have none, in which case the form button stays hidden and the
   * toolbar is exactly as it was. */
  function readForm() {
    formFields = [];
    try {
      formFields = window.LOC1999_SIGN.readFormFields(libDoc) || [];
    } catch (e) { formFields = []; }

    var has = formFields.length > 0;
    show($('t-form'), has);
    if (has) {
      var names = {};
      formFields.forEach(function (f) { names[f.name] = true; });
      $('form-count').textContent = Object.keys(names).length;
      statusEl.textContent = 'This PDF is a real form. The Form button types straight into its own fields.';
    }
  }

  /** The fields drawn on the page currently shown. */
  function fieldsOnPage() {
    return formFields.filter(function (f) { return f.page === pageIndex; });
  }

  /* One HTML input per field, laid directly over where the field sits on the
   * page. The page is a canvas at a known scale, so a field's PDF rectangle
   * maps straight onto CSS pixels; everything is recomputed on each render
   * because turning the page or resizing the window moves them. */
  function placeFormInputs() {
    var layer = $('form-layer');
    layer.innerHTML = '';
    if (tool() !== 'form' || !viewport) return;
    var rect = overlay.getBoundingClientRect();
    var ratio = rect.width / overlay.width; // canvas px -> css px

    // Radio widgets share a name; group them so one choice clears the rest.
    fieldsOnPage().forEach(function (field) {
      var box = fieldBox(field, ratio);
      var el = inputFor(field);
      if (!el) return;
      el.style.position = 'absolute';
      el.style.left = box.x + 'px';
      el.style.top = box.y + 'px';
      el.style.width = box.w + 'px';
      el.style.height = box.h + 'px';
      if (field.readOnly) { el.disabled = true; el.title = 'This field is locked by the form.'; }
      layer.appendChild(el);
    });
  }

  /** A field's rectangle in CSS pixels over the overlay. */
  function fieldBox(field, ratio) {
    var s = viewport.scale;
    var topPdf = field.rect.y + field.rect.height;
    return {
      x: field.rect.x * s * ratio,
      y: (overlay.height - topPdf * s) * ratio,
      w: field.rect.width * s * ratio,
      h: field.rect.height * s * ratio,
    };
  }

  function currentValue(field) {
    return Object.prototype.hasOwnProperty.call(formValues, field.name)
      ? formValues[field.name]
      : field.value;
  }

  function inputFor(field) {
    if (field.kind === 'text') {
      var input = document.createElement(field.multiline ? 'textarea' : 'input');
      if (!field.multiline) input.type = 'text';
      input.className = 'field-input';
      input.value = currentValue(field);
      input.addEventListener('input', function () { formValues[field.name] = input.value; syncStatus(); });
      return input;
    }
    if (field.kind === 'checkbox') {
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'field-check';
      cb.checked = currentValue(field) === 'on';
      cb.addEventListener('change', function () { formValues[field.name] = cb.checked ? 'on' : 'off'; syncStatus(); });
      return cb;
    }
    if (field.kind === 'radio') {
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'formradio:' + field.name;
      radio.className = 'field-check';
      radio.checked = currentValue(field) === field.radioOption;
      radio.addEventListener('change', function () {
        if (radio.checked) { formValues[field.name] = field.radioOption; syncStatus(); }
      });
      return radio;
    }
    if (field.kind === 'dropdown' || field.kind === 'optionlist') {
      var select = document.createElement('select');
      select.className = 'field-input';
      var blank = document.createElement('option');
      blank.value = ''; blank.textContent = '-';
      select.appendChild(blank);
      (field.options || []).forEach(function (opt) {
        var o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        if (currentValue(field) === opt) o.selected = true;
        select.appendChild(o);
      });
      select.addEventListener('change', function () { formValues[field.name] = select.value; syncStatus(); });
      return select;
    }
    return null; // signatures, buttons: nothing to type
  }

  function collectFormValues() {
    // One value per field name (radios collapse to their group).
    var byName = {};
    formFields.forEach(function (f) { byName[f.name] = f; });
    return Object.keys(formValues).map(function (name) {
      var f = byName[name];
      return { name: name, kind: f ? f.kind : 'text', value: formValues[name] };
    });
  }

  // ------------------------------------------------------------------ pictures
  var picture = null; // { bytes, url, img }

  /* Base64 in chunks: String.fromCharCode.apply throws on a big photo, and a
   * data: URL is the only kind an <img> may load here — img-src is 'self'
   * data:, so a blob: URL is refused and the load event never fires. */
  function bytesToDataUrl(bytes, mime) {
    var parts = [];
    for (var i = 0; i < bytes.length; i += 0x8000) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    }
    return 'data:' + mime + ';base64,' + btoa(parts.join(''));
  }

  function loadPicture(file) {
    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      var format = window.LOC1999_SIGN.imageFormat(bytes);
      var url = bytesToDataUrl(bytes, file.type || 'application/octet-stream');
      // A PDF carries PNG and JPEG as they are. Everything else has to be
      // repainted through a canvas, which is lossless but drops the original
      // compression — a WebP photo can triple in size on the way in.
      if (format) return withImage(bytes, url);
      return repaintAsPng(url);
    });
  }

  function withImage(bytes, url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve({ bytes: bytes, url: url, img: img }); };
      img.onerror = function () { reject(new Error('That file does not look like a picture this browser can open.')); };
      img.src = url;
    });
  }

  function repaintAsPng(url) {
    return withImage(null, url).then(function (loaded) {
      var canvas = document.createElement('canvas');
      canvas.width = loaded.img.naturalWidth;
      canvas.height = loaded.img.naturalHeight;
      canvas.getContext('2d').drawImage(loaded.img, 0, 0);
      var png = canvas.toDataURL('image/png');
      return withImage(dataUrlBytes(png), png);
    });
  }

  function addImage(point) {
    if (!picture) return fail('Choose a picture first, then click where it goes.');
    clearError();
    var at = snap(toPdf(point));
    var obj = {
      id: nextId++, kind: 'stamp', what: 'picture', page: pageIndex,
      // The click marks the top-left for a picture: that is where the cursor is.
      x: at.x, y: at.y, width: Number($('image-width').value) || 200,
      bytes: picture.bytes, img: picture.img,
    };
    objects.push(obj);
    selected = obj;
    snapLine = null;
    draw();
  }

  function syncControls(obj) {
    if (obj.kind === 'text') $('text-size').value = obj.size;
    else $(obj.what === 'picture' ? 'image-width' : 'sig-width').value = obj.width;
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
    var nudged = true;
    if (event.key === 'ArrowLeft') selected.x -= step;
    else if (event.key === 'ArrowRight') selected.x += step;
    else if (event.key === 'ArrowUp') selected.y += step;
    else if (event.key === 'ArrowDown') selected.y -= step;
    else nudged = false;
    if (nudged) {
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
  sigPad.addEventListener('pointerup', function () { drawing = false; refreshChip(); });
  $('sig-clear').addEventListener('click', function () {
    padCtx.clearRect(0, 0, sigPad.width, sigPad.height);
    padUsed = false;
    chosen = null;
    renderSaved();
    refreshChip();
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

  /* Saved signatures are data: URLs, and they are decoded by hand rather than
   * with fetch(). The content security policy on this site is connect-src
   * 'self', which blocks fetching a data: URL — and the right response to that
   * is to not need the network at all, not to widen the policy. */
  function dataUrlBytes(url) {
    var binary = atob(url.slice(url.indexOf(',') + 1));
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  /* Always a data: URL, never a blob:. The preview is drawn by assigning this
   * to an <img>, and img-src on this site is 'self' data: — a blob: URL is
   * refused, the load event never fires, and the signature silently never
   * appears. Same URL feeds both the preview and the bytes that get embedded. */
  function signaturePng() {
    if (chosen) return Promise.resolve({ bytes: dataUrlBytes(chosen), url: chosen });
    var canvas = currentCanvas();
    if (!canvas) return Promise.resolve(null);
    var url = trim(canvas).toDataURL('image/png');
    return Promise.resolve({ bytes: dataUrlBytes(url), url: url });
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
      savedEl.innerHTML = '<span class="opt-hint">Nothing kept yet.</span>';
      return;
    }
    savedEl.innerHTML = list.map(function (sig, i) {
      return '<button type="button" data-use="' + i + '" title="Use this one">' +
        '<img src="' + esc(sig.png) + '" alt="saved signature"></button>' +
        '<button type="button" class="drop-saved" data-drop="' + i + '" title="Forget it">x</button>';
    }).join('');

    Array.prototype.forEach.call(savedEl.querySelectorAll('[data-use]'), function (btn) {
      btn.addEventListener('click', function () {
        chosen = loadSaved()[Number(btn.getAttribute('data-use'))].png;
        padCtx.clearRect(0, 0, sigPad.width, sigPad.height);
        padUsed = false;
        $('sig-typed').value = '';
        setTool('stamp');
        renderSaved();
        refreshChip();
        statusEl.textContent = 'Signature ready. Drag it onto the page.';
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
        refreshChip();
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
    statusEl.textContent = 'Kept in this browser. It never leaves your device.';
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
      // The raster has to be taken at the rotation the visitor was looking at,
      // or a page they turned would be flattened back to how it used to lie.
      var vp = page.getViewport({ scale: RASTER_SCALE, rotation: totalRotation(index) });
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
   * If a page has both surgical deletions and a blackout box, and it is
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
    commitCaret();
    clearError();
    resetOutput();
    var removalList = Object.keys(removals)
      .map(function (p) { return { page: Number(p), opIndices: pageRemovals(p) }; })
      .filter(function (r) { return r.opIndices.length; });
    var flatPages = Object.keys(flatten)
      .filter(function (p) { return (flatten[p] || []).length; })
      .map(Number);
    var formList = collectFormValues();
    var hasForm = formFields.length > 0;
    // Only the pages actually turned, expressed as the rotation to write.
    var rotationList = Object.keys(turns)
      .filter(function (p) { return turns[p] % 4; })
      .map(function (p) { return { page: Number(p), angle: totalRotation(Number(p)) }; });

    if (!objects.length && !removalList.length && !flatPages.length && !formList.length &&
        !rotationList.length) {
      return fail(hasForm
        ? 'Nothing has been changed yet. Fill in a field, sign it, or add something.'
        : 'Nothing has been changed yet.');
    }

    $('t-save').disabled = true;
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
                : { kind: 'stamp', page: o.page, at: { x: o.x, y: o.y }, bytes: o.bytes, width: o.width };
            });
            return window.LOC1999_SIGN.applyEdits(
              basis.bytes, edits, rasters, basis.removals, formList, rotationList,
            );
          });
      })
      .then(function (out) {
        statusEl.textContent = '';
        var blob = new Blob([out], { type: 'application/pdf' });
        var url = URL.createObjectURL(blob);
        liveUrls.push(url);
        var removed = removalList.reduce(function (n, r) { return n + r.opIndices.length; }, 0);
        summaryEl.textContent =
          [formList.length ? formList.length + ' field' + (formList.length === 1 ? '' : 's') + ' filled' : null,
            hasForm ? 'form flattened' : null,
            objects.length ? objects.length + ' added' : null,
            removed ? removed + ' deleted from the file itself' : null,
            rotationList.length ? rotationList.length + ' page' + (rotationList.length === 1 ? '' : 's') + ' turned' : null,
            flatPages.length ? flatPages.length + ' page' + (flatPages.length === 1 ? '' : 's') + ' flattened' : null]
            .filter(Boolean).join(', ') + '. ' + bytesLabel(blob.size) + '.';
        outputEl.innerHTML = '<ul class="plain"><li><a href="' + url + '" download="edited.pdf">edited.pdf</a></li></ul>';
        syncStatus();
      })
      .catch(function (err) {
        syncStatus();
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
  $('t-open').addEventListener('click', function () { fileInput.click(); });

  Array.prototype.forEach.call(document.querySelectorAll('.tbtn.tool'), function (button) {
    button.addEventListener('click', function () { setTool(button.getAttribute('data-tool')); });
  });

  $('t-prev').addEventListener('click', function () { goTo(pageIndex - 1); });
  $('t-next').addEventListener('click', function () { goTo(pageIndex + 1); });
  $('page-num').addEventListener('change', function () {
    goTo((Number($('page-num').value) || 1) - 1);
  });
  $('t-rot-l').addEventListener('click', function () { turn(-1); });
  $('t-rot-r').addEventListener('click', function () { turn(1); });

  function stepZoom(direction) {
    if (!viewport) return;
    var here = viewport.scale;
    var next = null;
    if (direction > 0) {
      for (var i = 0; i < ZOOMS.length; i++) if (ZOOMS[i] > here + 0.01) { next = ZOOMS[i]; break; }
    } else {
      for (var j = ZOOMS.length - 1; j >= 0; j--) if (ZOOMS[j] < here - 0.01) { next = ZOOMS[j]; break; }
    }
    if (next === null) return;
    commitCaret();
    zoomMode = next;
    renderPage();
  }
  $('t-zoom-in').addEventListener('click', function () { stepZoom(1); });
  $('t-zoom-out').addEventListener('click', function () { stepZoom(-1); });

  $('t-undo').addEventListener('click', function () {
    commitCaret();
    if (objects.length) objects.pop();
    selected = null;
    clearError();
    draw();
  });
  $('t-save').addEventListener('click', save);

  $('sig-width').addEventListener('input', function () {
    $('sig-mm').textContent = Math.round((Number($('sig-width').value) || 0) / 72 * 25.4);
    if (selected && selected.kind === 'stamp' && selected.what === 'signature') {
      selected.width = Number($('sig-width').value) || selected.width;
      draw();
    }
  });
  $('sig-typed').addEventListener('input', refreshChip);
  $('sig-font').addEventListener('change', refreshChip);

  $('text-size').addEventListener('input', function () {
    if (selected && selected.kind === 'text') {
      selected.size = Number($('text-size').value) || selected.size;
      draw();
    }
  });
  $('image-width').addEventListener('input', function () {
    $('image-mm').textContent = Math.round((Number($('image-width').value) || 0) / 72 * 25.4);
    if (selected && selected.kind === 'stamp' && selected.what === 'picture') {
      selected.width = Number($('image-width').value) || selected.width;
      draw();
    }
  });
  $('image-file').addEventListener('change', function () {
    var file = $('image-file').files[0];
    if (!file) return;
    clearError();
    statusEl.textContent = 'Reading the picture…';
    loadPicture(file).then(function (loaded) {
      picture = loaded;
      statusEl.textContent = 'Picture ready. Click the page to place it.';
    }).catch(function (err) {
      picture = null;
      fail((err && err.message) || 'That picture could not be read.');
    });
  });

  /* Fitting to the well means the render depends on how wide the window is,
   * so it has to be redone when that changes. Only when fitting: a visitor
   * who chose 150% did not ask for it to move. */
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (!doc || zoomMode !== 'fit') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { renderPage(); }, 150);
  });

  renderSaved();
  refreshChip();
  setTool('text');
  enableChrome(false);
  syncStatus();
})();

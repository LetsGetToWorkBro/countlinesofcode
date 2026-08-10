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

  /* THE DOCUMENT MODEL
   *
   * There used to be two applications: one that marked a page up and one that
   * moved pages around, in separate tabs, each with its own copy of the file
   * open. That is two mental models for one document, and it meant merging a
   * PDF and signing it were things you did in different places.
   *
   * So there is one model now. `sources` holds every file that has been
   * opened, and `order` is the document being built out of them: a flat list
   * of "page 3 of file 2, turned once". Reordering, deleting and inserting are
   * operations on that list and nothing else.
   *
   * Marks are keyed by which page of which file they were put on, never by
   * position. Drag page five to the front and your signature goes with it,
   * because it was never attached to "page five" in the first place.
   */
  var sources = [];            // { name, bytes, doc (pdf.js), libDoc (pdf-lib) }
  var order = [];              // { doc, page, rotation } - the document, in order
  var at = 0;                  // which position in `order` is on screen
  var picked = {};             // positions selected in the rail

  var viewport = null;
  var viewW = 0, viewH = 0;   // the page's size in layout pixels
  var dpr = 1;                // how many real pixels the screen puts in one
  var analysed = {};           // page key -> { items, ops, opOf }
  var objects = [];            // things placed on top: text and signatures
  var removals = {};           // page key -> { opIndex: true }
  var flatten = {};            // page key -> [rects]  (the blunt fallback)
  var baseRotations = {};      // page key -> the /Rotate the file itself carries
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
  /** Read a file into a source, both engines at once. */
  function readSource(file) {
    return file.arrayBuffer().then(function (data) {
      var bytes = new Uint8Array(data);
      /* standardFontDataUrl and cMapUrl matter more here than in a viewer.
       * Without them pdf.js substitutes fonts and blanks CJK text, which would
       * misplace every box you click on and would be baked in permanently on
       * any page you flatten. */
      return Promise.all([
        pdfjs.getDocument({
          data: bytes.slice(),
          standardFontDataUrl: '/vendor/standard_fonts/',
          cMapUrl: '/vendor/cmaps/',
          cMapPacked: true,
        }).promise,
        window.LOC1999_SIGN.loadForEditing(bytes),
      ]).then(function (both) {
        return { name: file.name || 'document.pdf', bytes: bytes, doc: both[0], libDoc: both[1] };
      });
    });
  }

  function open(file) {
    clearError();
    resetOutput();
    loadEngines()
      .then(function () { return readSource(file); })
      .then(function (source) {
        sources = [source];
        order = [];
        for (var i = 0; i < source.doc.numPages; i++) order.push({ doc: 0, page: i, rotation: 0 });
        at = 0;
        picked = {};
        objects = [];
        removals = {};
        flatten = {};
        analysed = {};
        baseRotations = {};
        formValues = {};
        zoomMode = 'fit';
        readForm();
        show(dropzone, false);
        show(body, true);
        enableChrome(true);
        buildRail();
        return renderPage();
      })
      .catch(function (err) {
        fail((err && err.message) || 'That file could not be opened as a PDF.');
      });
  }

  /* Insert another PDF's pages at the end.
   *
   * This is the merge, and it is now a button on the rail rather than a
   * separate tab with its own copy of everything. Pages are copied whole when
   * the file is written, so their fonts, images, links and annotations come
   * with them; nothing is re-rendered. */
  function insert(files) {
    if (!sources.length) return;
    clearError();
    statusEl.textContent = 'Reading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…';
    var list = Array.prototype.slice.call(files);
    list.reduce(function (chain, file) {
      return chain.then(function () {
        return readSource(file).then(function (source) {
          var index = sources.push(source) - 1;
          for (var i = 0; i < source.doc.numPages; i++) {
            order.push({ doc: index, page: i, rotation: 0 });
          }
        });
      });
    }, Promise.resolve())
      .then(function () {
        statusEl.textContent = order.length + ' pages from ' + sources.length + ' files.';
        buildRail();
        return renderPage();
      })
      .catch(function (err) {
        fail((err && err.message) || 'One of those files could not be read as a PDF.');
      });
  }

  /* The toolbar is dead until there is a document to act on. A row of buttons
   * that do nothing is the thing that made the old page feel broken. */
  function enableChrome(on) {
    ['t-save', 't-save-split', 't-undo', 't-rot-l', 't-rot-r', 't-zoom-in', 't-zoom-out',
      't-prev', 't-next', 'page-num', 'p-insert'].forEach(function (id) { $(id).disabled = !on; });
    Array.prototype.forEach.call(document.querySelectorAll('.tbtn.tool'), function (b) {
      b.disabled = !on;
    });
    if (!on) return;
    $('t-undo').disabled = true;   // nothing to undo yet
  }

  // ------------------------------------------------------- the page, addressed
  /** Where a mark lives: which page of which file, never which position. */
  function keyOf(ref) { return ref.doc + ':' + ref.page; }
  function ref() { return order[at] || { doc: 0, page: 0, rotation: 0 }; }
  function key() { return keyOf(ref()); }
  function docOf(ref2) { return sources[ref2.doc]; }

  function analysePage(ref2) {
    var id = keyOf(ref2);
    if (analysed[id]) return Promise.resolve(analysed[id]);
    var source = docOf(ref2);
    return source.doc.getPage(ref2.page + 1).then(function (page) {
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
        var ops = window.LOC1999_SIGN.pageTextOps(source.libDoc, ref2.page);
        var report = window.LOC1999_SIGN.matchOpsToItems(ops, items);
        var opOf = {};
        report.matched.forEach(function (m) { opOf[m.itemIndex] = m.opIndex; });
        analysed[id] = { items: items, ops: ops, opOf: opOf, unmatched: report.unmatchedItems.length };
        return analysed[id];
      });
    });
  }

  // ---------------------------------------------------------------- rotation
  /* A page already carries a rotation of its own, which is how a sideways scan
   * is stored, and the visitor's turns add to it. What everything else works in
   * is the total: it is what pdf.js is asked to display, what the click
   * coordinates are measured against, and what gets written on save. Keeping
   * the two apart is what lets "turn left" mean the same thing on an upright
   * page and a sideways one. */
  function totalRotation(pos) {
    var r = order[pos];
    if (!r) return 0;
    return (((baseRotations[keyOf(r)] || 0) + r.rotation) % 360 + 360) % 360;
  }

  function turn(by) {
    if (!order.length || !viewport) return;
    commitCaret();
    var targets = selection();
    // Only the page on screen has its marks carried, because it is the only
    // one whose display size is known here; the others have none to carry
    // unless they were visited, and a visited page caches its size.
    targets.forEach(function (pos) {
      var current = order[pos];
      var size = pageSize(pos);
      if (size) turnMarks(by, keyOf(current), size.width, size.height);
      current.rotation = ((current.rotation + by * 90) % 360 + 360) % 360;
    });
    renderPage().then(function () {
      return Promise.all(targets.map(drawThumb));
    });
  }

  /** The displayed size of a position in points, if it has ever been rendered. */
  var sizeCache = {};
  function pageSize(pos) {
    var r = order[pos];
    return r ? sizeCache[keyOf(r) + '@' + r.rotation] || null : null;
  }

  /* Carry everything on a page through a quarter turn.
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
  function turnMarks(by, id, width, height) {
    var clockwise = by > 0;
    objects.forEach(function (obj) {
      if (obj.key !== id) return;
      var x = obj.x, y = obj.y;
      obj.x = clockwise ? y : height - y;
      obj.y = clockwise ? width - x : x;
    });
    // A blackout box turns too, and swaps its sides doing it.
    var boxes = flatten[id];
    if (!boxes || !boxes.length) return;
    flatten[id] = boxes.map(function (r) {
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
    if (!order.length) return Promise.resolve();
    var current = ref();
    var source = docOf(current);
    return source.doc.getPage(current.page + 1).then(function (page) {
      baseRotations[keyOf(current)] = page.rotate || 0;
      var rotation = totalRotation(at);
      var base = page.getViewport({ scale: 1, rotation: rotation });
      sizeCache[keyOf(current) + '@' + current.rotation] = { width: base.width, height: base.height };
      viewport = page.getViewport({ scale: scaleFor(base.width), rotation: rotation });
      /* THE PAGE IS DRAWN AT THE SCREEN'S RESOLUTION, NOT THE LAYOUT'S.
       *
       * A canvas has two sizes: how many pixels it holds and how big it is
       * on the page. Setting only the first and letting CSS stretch it is
       * what made a document on a phone unreadable: a 3x display was being
       * handed a 1x rendering and blowing it up. So the backing store is
       * multiplied by devicePixelRatio and the CSS size is pinned to the
       * layout size, which is the difference between 400 and 1200 real
       * pixels of text on the same piece of glass.
       *
       * Everything downstream keeps working in layout pixels: viewW and
       * viewH are the logical size, the overlay's context is scaled once
       * so the drawing code never sees the ratio, and a click is converted
       * against the CSS box. */
      viewW = Math.floor(viewport.width);
      viewH = Math.floor(viewport.height);
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      [view, overlay].forEach(function (canvas) {
        canvas.width = Math.floor(viewW * dpr);
        canvas.height = Math.floor(viewH * dpr);
        canvas.style.width = viewW + 'px';
        canvas.style.height = viewH + 'px';
      });
      var hi = page.getViewport({ scale: viewport.scale * dpr, rotation: rotation });
      return page.render({ canvasContext: view.getContext('2d'), viewport: hi }).promise;
    }).then(function () {
      return analysePage(ref());
    }).then(function () {
      draw();
      markCurrentThumb();
      if (tool() === 'form') placeFormInputs();
    });
  }

  function goTo(pos) {
    if (!order.length) return;
    var next = Math.max(0, Math.min(order.length - 1, pos));
    if (next === at) return;
    commitCaret();
    at = next;
    selected = null;
    picked = {};
    picked[at] = true;
    renderPage();
    syncRail();
  }

  // ------------------------------------------------------------ the page rail
  /* The rail is the document's shape: what order the pages are in, which of
   * them the next command acts on, which go and which stay. It was a whole
   * second tab with its own file open; now it is the left-hand column of the
   * one application, and it is the same list that gets written out. */
  function buildRail() { buildRailFrom({}); }

  function drawThumb(pos) {
    var button = rail.querySelector('.thumb[data-pos="' + pos + '"]');
    var current = order[pos];
    if (!button || !current) return Promise.resolve();
    return docOf(current).doc.getPage(current.page + 1).then(function (page) {
      var rotation = totalRotation(pos);
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
      var on = Number(b.getAttribute('data-pos')) === at;
      b.classList.toggle('is-current', on);
      if (on && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
    });
  }

  /** Which positions a page command acts on: the selection, or the one shown. */
  function selection() {
    var list = Object.keys(picked).map(Number).filter(function (p) { return p < order.length; });
    return list.length ? list.sort(function (a, b) { return a - b; }) : [at];
  }

  function syncRail() {
    Array.prototype.forEach.call(rail.querySelectorAll('.thumb'), function (b) {
      var pos = Number(b.getAttribute('data-pos'));
      b.classList.toggle('is-picked', !!picked[pos]);
      b.classList.toggle('is-current', pos === at);
    });
    var n = order.length;
    $('rail-count').textContent = n + ' page' + (n === 1 ? '' : 's') +
      (sources.length > 1 ? ' from ' + sources.length + ' files' : '');
    var many = selection().length;
    $('p-delete').disabled = !n || many >= n;
    $('p-up').disabled = !n || selection()[0] === 0;
    $('p-down').disabled = !n || selection()[many - 1] === n - 1;
    $('page-count').textContent = n;
    $('page-num').max = n;
    syncSplit();
    syncStatus();
  }

  /* Rebuild the rail after the list itself changed. The thumbnails are already
   * drawn, so they are moved rather than re-rendered: turning a page is cheap
   * but rendering 300 of them again because two swapped places is not. */
  function reflowRail(keepKey) {
    var drawn = {};
    Array.prototype.forEach.call(rail.querySelectorAll('.thumb'), function (b) {
      drawn[b.getAttribute('data-key')] = b.querySelector('canvas');
    });
    buildRailFrom(drawn);
    if (keepKey !== undefined) {
      for (var i = 0; i < order.length; i++) {
        if (keyOf(order[i]) === keepKey) { at = i; break; }
      }
      if (at >= order.length) at = Math.max(0, order.length - 1);
    }
  }

  function buildRailFrom(drawn) {
    rail.innerHTML = '';
    var missing = [];
    order.forEach(function (r, pos) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'thumb';
      button.setAttribute('data-pos', pos);
      button.setAttribute('data-key', keyOf(r) + '@' + r.rotation);
      button.draggable = true;
      button.title = 'Page ' + (pos + 1);
      var already = drawn[keyOf(r) + '@' + r.rotation];
      button.appendChild(already || document.createElement('canvas'));
      if (!already) missing.push(pos);
      var label = document.createElement('span');
      label.textContent = pos + 1;
      button.appendChild(label);
      rail.appendChild(button);
    });
    missing.reduce(function (chain, pos) {
      return chain.then(function () { return drawThumb(pos); });
    }, Promise.resolve());
    syncRail();
  }

  // -------------------------------------------------------------- coordinates
  function toCanvas(p) { return { x: p.x * viewport.scale, y: viewH - p.y * viewport.scale }; }
  function toPdf(p) { return window.LOC1999_SIGN.canvasToPdf(p, viewport); }

  function canvasPoint(event) {
    var r = overlay.getBoundingClientRect();
    return {
      x: (event.clientX - r.left) * (viewW / r.width),
      y: (event.clientY - r.top) * (viewH / r.height),
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
    if (!selected || selected.key !== key()) return null;
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
      obj.y = (viewH - (top + height)) / scale;
      $('text-size').value = obj.size;
    } else {
      obj.width = Math.round((width / scale) * 10) / 10;
      obj.y = (viewH - top) / scale; // y is the top for a picture
      $(obj.what === 'picture' ? 'image-width' : 'sig-width').value = obj.width;
    }
  }

  /* What is under the pointer. The box is grown by a few pixels first: a line
   * of 9pt text is four pixels tall on screen, and asking somebody to hit that
   * exactly is why "the drag and drop needs some work". */
  var GRAB_SLOP = 4;
  function objectAt(point) {
    for (var i = objects.length - 1; i >= 0; i--) {
      if (objects[i].key !== key()) continue;
      var b = boxOf(objects[i]);
      if (point.x >= b.x - GRAB_SLOP && point.x <= b.x + b.w + GRAB_SLOP &&
          point.y >= b.y - GRAB_SLOP && point.y <= b.y + b.h + GRAB_SLOP) return objects[i];
    }
    return null;
  }

  function itemAt(point) {
    var info = analysed[key()];
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
    /* One transform, set each time, so every line below draws in layout
     * pixels and knows nothing about the screen's density. */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    var s = viewport.scale;
    var info = analysed[key()] || { items: [], opOf: {} };

    // Text queued for deletion: struck through and tinted, so it is obvious
    // what will go without pretending it has already gone.
    var pending = removals[key()] || {};
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
    (flatten[key()] || []).forEach(function (rect) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(rect.x * s, viewH - (rect.y + rect.height) * s, rect.width * s, rect.height * s);
    });

    objects.forEach(function (obj) {
      if (obj.key !== key()) return;
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
      ctx.lineTo(viewW, snapLine);
      ctx.stroke();
    }

    syncStatus();
  }

  /* The status bar. Where you are, how big it is, what you have changed —
   * the three things a document window has told you since about 1990. */
  function syncStatus() {
    if (!order.length) {
      $('st-page').textContent = 'No document open';
      $('st-size').textContent = '';
      $('st-edits').textContent = 'Nothing changed yet';
      return;
    }
    var turned = (order[at] && order[at].rotation) ? ' (turned)' : '';
    $('st-page').textContent = 'Page ' + (at + 1) + ' of ' + order.length + turned;
    $('page-num').value = at + 1;
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
    var turnCount = order.filter(function (r) { return r.rotation; }).length;
    var bits = [];
    if (sources.length > 1) bits.push(sources.length + ' files');
    if (objects.length) bits.push(objects.length + ' added');
    if (removed) bits.push(removed + ' deleted from the file');
    if (flattened) bits.push(flattened + ' to flatten');
    if (turnCount) bits.push(turnCount + ' turned');
    $('st-edits').textContent = bits.length
      ? bits.join(' · ') + (selected ? ' · drag it, or arrow keys to nudge' : '')
      : 'Nothing changed yet';
    $('t-undo').disabled = !objects.length;
    /* Saving is offered as soon as there is a document, not only once
     * something has been changed: reordering, merging and splitting are
     * reasons to save that leave none of the counters above above zero. */
    $('t-save').disabled = !order.length;
    $('t-save-split').disabled = !order.length;
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
    var ratio = overlay.getBoundingClientRect().width / viewW; // layout px -> css px
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
    var value = live.el.value.replace(/\s+$/, '');
    if (!value) { caret = null; live.el.remove(); return; }

    /* The editor's font is Helvetica, which is Latin-only (WinAnsi). A glyph it
     * cannot draw used to abort the entire save and lose every edit; it is now
     * skipped at save time, but that would still drop the text silently. So the
     * caret is kept open and the problem named here, at the moment you commit,
     * while the text is still in front of you to fix. */
    var bad = window.LOC1999_SIGN.winAnsiUnsupported(value);
    if (bad.length) {
      var shown = bad.slice(0, 6).map(function (c) { return '"' + c + '"'; }).join(', ');
      fail('The editor’s font can only draw the Latin alphabet, so it cannot place ' + shown +
        (bad.length > 6 ? ' and others' : '') + '. Remove ' +
        (bad.length > 1 ? 'those characters' : 'that character') + ', or type the text in Latin letters.');
      live.el.focus();
      return;   // leave the caret open so nothing typed is lost
    }

    caret = null;                        // before the DOM work: blur re-enters
    live.el.remove();
    var obj = {
      id: nextId++, kind: 'text', key: key(),
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
    if (!order.length) return;
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
    if (!order.length) return;
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
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    if (!order.length) return;
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
      flatten[key()] = (flatten[key()] || []).concat([rect]);
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
    if (!order.length || tool() !== 'delete') return;
    var point = canvasPoint(event);
    var index = itemAt(point);
    var info = analysed[key()];
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
    var info = analysed[key()];
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
    var id = key();
    removals[id] = removals[id] || {};
    if (removals[id][opIndex]) delete removals[id][opIndex];
    else removals[id][opIndex] = true;
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
    var info = analysed[key()];
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
    var info = analysed[key()];
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
            id: nextId++, kind: 'stamp', what: 'signature', key: key(),
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
    if (chip.classList.contains('is-empty') || !order.length) return;
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
    if (chip.classList.contains('is-empty') || !order.length) return;
    event.preventDefault();
    placeSignature({ x: viewW / 2, y: viewH / 2 });
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
      formFields = window.LOC1999_SIGN.readFormFields(sources[0].libDoc) || [];
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
    var current = ref();
    // Fields come from the file that was opened, so they only apply to its
    // own pages: an inserted PDF's pages carry none of them.
    if (current.doc !== 0) return [];
    return formFields.filter(function (f) { return f.page === current.page; });
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
    var ratio = rect.width / viewW; // layout px -> css px

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
      y: (viewH - topPdf * s) * ratio,
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
      id: nextId++, kind: 'stamp', what: 'picture', key: key(),
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

  /* WRITING THE FILE
   *
   * Three passes, because three different things are being done and each has
   * to happen in its own coordinate system.
   *
   *   1. Cut. Per source file: delete the text operators marked for removal
   *      and fill in and flatten any form. Removal indices were computed
   *      against that file's own content streams, so this has to run on that
   *      file, before its pages go anywhere.
   *
   *   2. Assemble. Copy the pages out of the cut files in the order the rail
   *      shows, applying each page's turn. This is the merge, the reorder, the
   *      delete and the rotate, and it is one call: pages are copied whole, so
   *      their fonts, images, links and annotations come with them.
   *
   *   3. Mark. Draw the text, signatures and pictures onto the assembled
   *      document, where a page's position is finally known and its rotation
   *      is already written on it.
   *
   * Doing it in this order is what lets a mark survive a reorder: it is placed
   * against the finished document, and the mark's page is looked up by which
   * page of which file it was put on, not by where that page used to be.
   */
  function rasterise(fromDoc, sourcePage, boxes, rotation) {
    return fromDoc.getPage(sourcePage + 1).then(function (page) {
      // The raster has to be taken at the rotation the visitor was looking at,
      // or a page they turned would be flattened back to how it used to lie.
      var vp = page.getViewport({ scale: RASTER_SCALE, rotation: rotation });
      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      var ctx = canvas.getContext('2d');
      return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
        ctx.fillStyle = '#000000';
        boxes.forEach(function (r) {
          ctx.fillRect(r.x * RASTER_SCALE, canvas.height - (r.y + r.height) * RASTER_SCALE,
            r.width * RASTER_SCALE, r.height * RASTER_SCALE);
        });
        return new Promise(function (resolve) {
          canvas.toBlob(function (blob) {
            blob.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); });
          }, 'image/png');
        });
      });
    });
  }

  /** Pass one, for one source: cut its text and settle its form. */
  function cutSource(index) {
    var source = sources[index];
    var removalList = [];
    Object.keys(removals).forEach(function (id) {
      var parts = id.split(':');
      if (Number(parts[0]) !== index) return;
      var ops = Object.keys(removals[id]).map(Number);
      if (ops.length) removalList.push({ page: Number(parts[1]), opIndices: ops });
    });
    // Only the file that was opened has a form the visitor could fill in.
    var values = index === 0 ? collectFormValues() : [];
    var hasForm = index === 0 && formFields.length > 0;
    if (!removalList.length && !values.length && !hasForm) {
      return Promise.resolve({ bytes: source.bytes, doc: source.doc });
    }
    return window.LOC1999_SIGN.applyEdits(source.bytes, [], [], removalList, values)
      .then(function (cut) {
        // Only reopen for rendering if something on this file has to be
        // flattened; that is the only reason a second pdf.js document is worth
        // the memory, and rendering the *original* would paint deleted text
        // straight back in as pixels.
        var needsRender = Object.keys(flatten).some(function (id) {
          return Number(id.split(':')[0]) === index && (flatten[id] || []).length;
        });
        if (!needsRender) return { bytes: cut, doc: null };
        return pdfjs.getDocument({
          data: cut.slice(),
          standardFontDataUrl: '/vendor/standard_fonts/',
          cMapUrl: '/vendor/cmaps/',
          cMapPacked: true,
        }).promise.then(function (reopened) { return { bytes: cut, doc: reopened }; });
      });
  }

  /** The finished document: all three passes, in bytes. */
  function build() {
    var pagesApi = window.LOC1999_PAGES;
    return sources
      .map(function (unused, i) { return i; })
      .reduce(function (chain, i) {
        return chain.then(function (list) {
          return cutSource(i).then(function (cut) { return list.concat([cut]); });
        });
      }, Promise.resolve([]))
      .then(function (cuts) {
        // Pass three needs a raster per blacked-out page, at its final index.
        var jobs = [];
        order.forEach(function (r, pos) {
          var id = keyOf(r);
          var boxes = flatten[id] || [];
          if (!boxes.length) return;
          var from = cuts[r.doc].doc || sources[r.doc].doc;
          jobs.push(rasterise(from, r.page, boxes, totalRotation(pos)).then(function (png) {
            return { page: pos, png: png };
          }));
        });
        return Promise.all(jobs).then(function (rasters) { return { cuts: cuts, rasters: rasters }; });
      })
      .then(function (state) {
        statusEl.textContent = 'Putting the pages together…';
        return pagesApi.loadSources(state.cuts.map(function (c, i) {
          return { name: sources[i].name, bytes: c.bytes };
        })).then(function (docs) {
          return pagesApi.buildPdf(docs, order);
        }).then(function (assembled) { return { assembled: assembled, rasters: state.rasters }; });
      })
      .then(function (state) {
        statusEl.textContent = 'Writing the PDF…';
        // Where each mark's page ended up. A mark whose page was deleted has
        // nowhere to go, and is dropped rather than landing on a stranger.
        var finalOf = {};
        order.forEach(function (r, pos) { finalOf[keyOf(r)] = pos; });
        var edits = objects
          .filter(function (o) { return finalOf[o.key] !== undefined; })
          .map(function (o) {
            var page = finalOf[o.key];
            return o.kind === 'text'
              ? { kind: 'text', page: page, at: { x: o.x, y: o.y }, value: o.value, size: o.size }
              : { kind: 'stamp', page: page, at: { x: o.x, y: o.y }, bytes: o.bytes, width: o.width };
          });
        /* No rotations list: the assembled pages already carry the right
         * /Rotate, and applyEdits reads it off the page. Passing it again
         * would be two sources of truth for one number. */
        return window.LOC1999_SIGN.applyEdits(state.assembled, edits, state.rasters, [], []);
      });
  }

  function summarise(blob) {
    var removed = 0;
    Object.keys(removals).forEach(function (id) { removed += Object.keys(removals[id]).length; });
    var flattened = Object.keys(flatten).filter(function (id) { return (flatten[id] || []).length; }).length;
    var turned = order.filter(function (r) { return r.rotation; }).length;
    return [
      sources.length > 1 ? sources.length + ' files merged' : null,
      objects.length ? objects.length + ' added' : null,
      removed ? removed + ' deleted from the file itself' : null,
      turned ? turned + ' page' + (turned === 1 ? '' : 's') + ' turned' : null,
      flattened ? flattened + ' page' + (flattened === 1 ? '' : 's') + ' flattened' : null,
      order.length + ' page' + (order.length === 1 ? '' : 's'),
    ].filter(Boolean).join(', ') + '. ' + bytesLabel(blob.size) + '.';
  }

  function offer(name, blob) {
    var url = URL.createObjectURL(blob);
    liveUrls.push(url);
    outputEl.innerHTML = '<ul class="plain"><li><a href="' + url + '" download="' + esc(name) +
      '">' + esc(name) + '</a></li></ul>';
  }

  function save() {
    commitCaret();
    clearError();
    resetOutput();
    if (!order.length) return fail('There are no pages left to save.');

    $('t-save').disabled = true;
    $('t-save-split').disabled = true;
    statusEl.textContent = 'Writing the PDF…';
    build()
      .then(function (out) {
        statusEl.textContent = '';
        var blob = new Blob([out], { type: 'application/pdf' });
        summaryEl.textContent = summarise(blob);
        offer(window.LOC1999_PAGES.outputName(sources.map(function (s2) { return s2.name; }), 'edited'), blob);
        syncStatus();
      })
      .catch(function (err) {
        syncStatus();
        fail((err && err.message) || 'Could not write that PDF.');
      });
  }

  /* Splitting works on the finished document rather than on the sources, so
   * everything that was signed, cut or turned is already in the pages before
   * they are divided up. Doing it the other way round would mean applying
   * every mark once per output file and getting the page numbers wrong. */
  function splitRequest() {
    var mode = $('split-mode').value;
    return { mode: mode, size: Number($('split-size').value) || 0, ranges: $('split-ranges').value };
  }

  function saveSplit() {
    commitCaret();
    clearError();
    resetOutput();
    var plan = window.LOC1999_PAGES.planSplit(order.length, splitRequest());
    if (plan.error) return fail('Cannot split: ' + plan.error + '.');
    if (!plan.groups.length) return fail('That does not select any pages.');

    $('t-save').disabled = true;
    $('t-save-split').disabled = true;
    statusEl.textContent = 'Writing ' + plan.groups.length + ' files…';
    var stem = window.LOC1999_PAGES.outputName(sources.map(function (s2) { return s2.name; }), 'split')
      .replace(/\.pdf$/i, '');

    build()
      .then(function (whole) {
        return window.LOC1999_PAGES.loadSources([{ name: 'edited.pdf', bytes: whole }]);
      })
      .then(function (docs) {
        return plan.groups.reduce(function (chain, group) {
          return chain.then(function (files) {
            var refs = group.pages.map(function (i) { return { doc: 0, page: i, rotation: 0 }; });
            return window.LOC1999_PAGES.buildPdf(docs, refs).then(function (bytes) {
              return files.concat([{ name: stem + '-' + group.label + '.pdf', bytes: bytes }]);
            });
          });
        }, Promise.resolve([]));
      })
      .then(function (files) {
        statusEl.textContent = '';
        syncStatus();
        if (files.length === 1) {
          var one = new Blob([files[0].bytes], { type: 'application/pdf' });
          summaryEl.textContent = '1 file. ' + bytesLabel(one.size) + '.';
          return offer(files[0].name, one);
        }
        /* A browser blocks a burst of downloads, so more than one file comes
         * back as an archive. The writer is borrowed from the ZIP tool rather
         * than duplicated. */
        return loadZip().then(function (zip) {
          // The archive writer's entries are {name, data}, not {name, bytes}.
          return zip(files.map(function (f) {
            return { name: f.name, data: f.bytes };
          })).then(function (bytes) {
            var blob = new Blob([bytes], { type: 'application/zip' });
            summaryEl.textContent = files.length + ' files, delivered as one ZIP. ' + bytesLabel(blob.size) + '.';
            offer(stem + '.zip', blob);
          });
        });
      })
      .catch(function (err) {
        syncStatus();
        fail((err && err.message) || 'Could not split that PDF.');
      });
  }

  function loadZip() {
    if (window.LOC1999_ZIP) return Promise.resolve(window.LOC1999_ZIP.zip);
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = '/zipkit.js';
      el.onload = function () {
        if (window.LOC1999_ZIP) resolve(window.LOC1999_ZIP.zip);
        else reject(new Error('the archive engine did not load'));
      };
      el.onerror = function () { reject(new Error('the archive engine did not load')); };
      document.head.appendChild(el);
    });
  }

  // ---------------------------------------------------------- the rail's own
  /* Click selects, shift-click extends, ctrl or cmd adds. Same three gestures
   * as every file list of the era, and the reason the rail can replace a whole
   * tab: acting on several pages at once needs no extra furniture. */
  var anchorPos = 0;
  rail.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.thumb') : null;
    if (!button) return;
    var pos = Number(button.getAttribute('data-pos'));
    if (event.shiftKey) {
      picked = {};
      var lo = Math.min(anchorPos, pos), hi = Math.max(anchorPos, pos);
      for (var i = lo; i <= hi; i++) picked[i] = true;
    } else if (event.ctrlKey || event.metaKey) {
      if (picked[pos]) delete picked[pos]; else picked[pos] = true;
      anchorPos = pos;
    } else {
      picked = {};
      picked[pos] = true;
      anchorPos = pos;
    }
    if (pos !== at) { commitCaret(); at = pos; selected = null; renderPage(); }
    syncRail();
  });

  /* Dragging a thumbnail moves the page. Native drag-and-drop here rather than
   * pointer events, the opposite choice from the signature chip: this list has
   * a keyboard equivalent right beside it in Up and Down, so a phone loses
   * nothing, and the native API gives the drop indicator for free. */
  var dragFrom = null;
  rail.addEventListener('dragstart', function (event) {
    var button = event.target.closest ? event.target.closest('.thumb') : null;
    if (!button) return;
    dragFrom = Number(button.getAttribute('data-pos'));
    button.classList.add('is-dragging');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  rail.addEventListener('dragover', function (event) {
    if (dragFrom === null) return;
    event.preventDefault();
    var button = event.target.closest ? event.target.closest('.thumb') : null;
    Array.prototype.forEach.call(rail.querySelectorAll('.thumb'), function (b) {
      b.classList.toggle('is-drop', b === button);
    });
  });
  rail.addEventListener('drop', function (event) {
    if (dragFrom === null) return;
    event.preventDefault();
    var button = event.target.closest ? event.target.closest('.thumb') : null;
    if (button) movePages([dragFrom], Number(button.getAttribute('data-pos')));
    endDrag();
  });
  rail.addEventListener('dragend', endDrag);
  function endDrag() {
    dragFrom = null;
    Array.prototype.forEach.call(rail.querySelectorAll('.thumb'), function (b) {
      b.classList.remove('is-dragging', 'is-drop');
    });
  }

  /** Move pages to a position, keeping the one on screen on screen. */
  function movePages(from, to) {
    commitCaret();
    var here = keyOf(ref());
    var moving = from.map(function (i) { return order[i]; });
    var rest = order.filter(function (r) { return moving.indexOf(r) < 0; });
    var target = rest.indexOf(order[to]);
    if (target < 0) target = rest.length;
    else if (to > from[0]) target += 1;
    order = rest.slice(0, target).concat(moving, rest.slice(target));
    picked = {};
    moving.forEach(function (r) { picked[order.indexOf(r)] = true; });
    reflowRail(here);
    renderPage();
  }

  /* The thumbnails fold away.
   *
   * On a phone the rail is a filmstrip across the top, and between it, two
   * toolbars, the options strip and the save strip there was nothing left
   * for the document: a three page PDF showed as a sliver you could not
   * read. The pages are how you get around a long document and useless
   * while you are reading one, so they collapse, and the button says which
   * state it is in. */
  $('p-fold').addEventListener('click', function () {
    var folded = reader.classList.toggle('is-folded');
    $('p-fold').setAttribute('aria-expanded', folded ? 'false' : 'true');
    $('p-fold').textContent = folded ? 'Pages...' : 'Pages';
    if (zoomMode === 'fit') renderPage();
  });

  $('p-insert').addEventListener('click', function () { $('insert-input').click(); });
  $('insert-input').addEventListener('change', function () {
    if ($('insert-input').files.length) insert($('insert-input').files);
    $('insert-input').value = '';
  });

  $('p-delete').addEventListener('click', function () {
    var going = selection();
    if (going.length >= order.length) return fail('That would delete every page.');
    commitCaret();
    clearError();
    /* The marks on a deleted page are left where they are rather than thrown
     * away: put the page back with Insert and they are still on it, and the
     * writer skips any mark whose page is no longer in the document. */
    order = window.LOC1999_PAGES.removePages(order, going);
    at = Math.min(at, order.length - 1);
    picked = {};
    picked[at] = true;
    reflowRail();
    renderPage();
  });

  $('p-up').addEventListener('click', function () {
    var list = selection();
    if (list[0] === 0) return;
    movePages(list, list[0] - 1);
  });
  $('p-down').addEventListener('click', function () {
    var list = selection();
    if (list[list.length - 1] >= order.length - 1) return;
    movePages(list, Math.min(order.length - 1, list[list.length - 1] + 1));
  });

  // The split controls only show the box the chosen mode needs.
  function syncSplit() {
    var mode = $('split-mode').value;
    show($('split-size'), mode === 'every');
    show($('split-ranges'), mode === 'ranges');
    if (!order.length) { $('split-note').textContent = ''; return; }
    var plan = window.LOC1999_PAGES.planSplit(order.length, splitRequest());
    $('split-note').textContent = plan.error
      ? plan.error
      : plan.groups.length + ' file' + (plan.groups.length === 1 ? '' : 's') +
        (plan.groups.length > 1 ? ', delivered as one ZIP' : '');
  }
  $('split-mode').addEventListener('change', syncSplit);
  $('split-size').addEventListener('input', syncSplit);
  $('split-ranges').addEventListener('input', syncSplit);
  $('t-save-split').addEventListener('click', saveSplit);

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

  $('t-prev').addEventListener('click', function () { goTo(at - 1); });
  $('t-next').addEventListener('click', function () { goTo(at + 1); });
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
    if (!order.length || zoomMode !== 'fit') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { renderPage(); }, 150);
  });

  renderSaved();
  refreshChip();
  syncSplit();
  setTool('text');
  enableChrome(false);
  syncStatus();
})();

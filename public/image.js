/* 1999.LOC image tools. Vanilla JS, no build step.
 *
 * Resize, compress and convert an image, all in the tab. Nothing is uploaded:
 * there is no fetch() to any endpoint. The one thing loaded on demand is the
 * HEIC decoder (libheif), and only when someone actually opens a HEIC — every
 * other format the browser decodes itself.
 *
 * Re-encoding through a canvas is also what strips EXIF: the pixels are copied,
 * the metadata is not. That is stated on the page as a feature, because for a
 * photo you are about to share it is one.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var dropzone = $('drop');
  var fileInput = $('file-input');
  var statusEl = $('status');
  var errorEl = $('error');
  var toolEl = $('tool');
  var originalEl = $('original');
  var resultEl = $('result');
  var outputEl = $('output');
  var previewEl = $('preview');

  var source = null;     // { canvas, width, height, name, bytes, kind }
  var liveUrls = [];

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fail(m) { errorEl.textContent = m; statusEl.textContent = ''; }
  function clearError() { errorEl.textContent = ''; }
  function bytesLabel(n) {
    return n < 1024 ? n + ' B'
      : n < 1048576 ? (n / 1024).toFixed(1) + ' KB'
        : (n / 1048576).toFixed(2) + ' MB';
  }
  function baseName(name) {
    return (name || 'image').replace(/\.[^.]+$/, '');
  }
  function format() {
    var picked = document.querySelector('input[name="fmt"]:checked');
    return picked ? picked.value : 'image/jpeg';
  }
  function extFor(mime) {
    return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  }

  // ------------------------------------------------------------ decoding input
  /**
   * The first bytes tell the format apart without trusting the file name.
   * A HEIC/AVIF file is ISO base-media ("ftyp" at offset 4); those are the ones
   * a browser may refuse, so they route to libheif.
   */
  function sniff(bytes) {
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      var brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
      return { iso: true, brand: brand };
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return { kind: 'PNG' };
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return { kind: 'JPEG' };
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return { kind: 'GIF' };
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return { kind: 'BMP' };
    if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return { kind: 'WebP' };
    }
    return { kind: 'image' };
  }

  var libheifReady = null;
  function loadLibheif() {
    if (libheifReady) return libheifReady;
    statusEl.textContent = 'Loading the HEIC decoder (about 1.4 MB, once)…';
    libheifReady = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/vendor/libheif/libheif-bundle.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load the HEIC decoder.')); };
      document.head.appendChild(s);
    }).then(function () {
      // The bundle exposes a factory (window.libheif); calling it builds the
      // Emscripten module and returns a promise for it once the wasm is ready.
      var factory = window.libheif;
      if (typeof factory !== 'function') throw new Error('The HEIC decoder did not load.');
      var built = factory();
      return built && typeof built.then === 'function' ? built : Promise.resolve(built);
    });
    return libheifReady;
  }

  /** Decode a HEIC/AVIF to an ImageData via libheif. */
  function decodeHeif(bytes) {
    return loadLibheif().then(function (lib) {
      var decoder = new lib.HeifDecoder();
      var images = decoder.decode(bytes);
      if (!images || !images.length) throw new Error('That HEIC file has no image in it.');
      var image = images[0];
      var w = image.get_width();
      var h = image.get_height();
      // Free the wasm-side handles once the pixels are copied out; a burst of
      // HEICs otherwise accumulates every decoded frame in wasm memory.
      var freeAll = function () {
        images.forEach(function (i) { try { if (i.free) i.free(); } catch (e) { /* already freed */ } });
      };
      return new Promise(function (resolve, reject) {
        var data = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
        image.display(data, function (out) {
          freeAll();
          if (!out) return reject(new Error('The HEIC image could not be decoded.'));
          resolve(out);
        });
      });
    });
  }

  function canvasFromImageData(imageData) {
    var canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(
      imageData instanceof ImageData ? imageData : new ImageData(imageData.data, imageData.width, imageData.height),
      0, 0,
    );
    return canvas;
  }

  function canvasFromBitmap(bitmap) {
    var canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    // The bitmap's pixels now live in the canvas; holding the bitmap open too
    // keeps a second full-size copy of every photo in memory.
    if (bitmap.close) bitmap.close();
    return canvas;
  }

  function decode(bytes, file) {
    var kind = sniff(bytes);
    // Try the browser first — it is fastest and handles PNG/JPEG/WebP/GIF/BMP,
    // and newer ones even decode HEIC/AVIF. Fall back to libheif only when the
    // browser refuses an ISO-base-media file.
    return createImageBitmap(new Blob([bytes], { type: file.type || '' }))
      .then(function (bitmap) {
        return { canvas: canvasFromBitmap(bitmap), kind: kind.kind || (kind.iso ? kind.brand.toUpperCase() : 'image') };
      })
      .catch(function (err) {
        if (kind.iso) {
          return decodeHeif(bytes).then(function (imageData) {
            return { canvas: canvasFromImageData(imageData), kind: 'HEIC' };
          });
        }
        throw err;
      });
  }

  // -------------------------------------------------------------------- open
  var openSeq = 0;
  function open(file) {
    clearError();
    resetOutput();
    // Two quick opens race their decodes: HEIC via wasm is much slower than a
    // JPEG via the browser, so the first file could finish last and replace
    // the second. Every open takes a ticket, and a decode that comes back to
    // find a newer ticket drops its result.
    var ticket = ++openSeq;
    statusEl.textContent = 'Reading the image…';
    file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      return decode(bytes, file).then(function (decoded) {
        if (ticket !== openSeq) return;
        source = {
          canvas: decoded.canvas,
          width: decoded.canvas.width,
          height: decoded.canvas.height,
          name: file.name,
          bytes: bytes,
          kind: decoded.kind,
        };
        statusEl.textContent = '';
        toolEl.className = '';
        var longest = Math.max(source.width, source.height);
        $('longest').value = longest;
        $('longest').max = Math.max(20000, longest);
        originalEl.innerHTML = '<strong>Original:</strong> ' + source.width + ' &times; ' + source.height +
          ', ' + esc(source.kind) + ', ' + bytesLabel(bytes.length);
        syncQuality();
        // Show the picture straight away, not just a line of stats about it, so
        // there is something to look at before tuning. Convert replaces it with
        // the result.
        showSourcePreview();
        $('convert').focus();
      });
    }).catch(function (err) {
      if (ticket !== openSeq) return;
      source = null;
      fail((err && err.message) || 'Could not open that image.');
    });
  }

  /* A downscaled preview of the opened image, kept small so a phone photo does
     not become a multi-megabyte data URL just to be looked at. */
  function showSourcePreview() {
    if (!source) return;
    var max = 512;
    var scale = Math.min(1, max / Math.max(source.width, source.height));
    var pw = Math.max(1, Math.round(source.width * scale));
    var ph = Math.max(1, Math.round(source.height * scale));
    var c = document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    var cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(source.canvas, 0, 0, pw, ph);
    previewEl.innerHTML = '<img class="pic-preview" src="' + c.toDataURL('image/png') + '" alt="the image you opened">';
  }

  // ----------------------------------------------------------------- convert
  function targetSize() {
    if ($('keep-size').checked) return { w: source.width, h: source.height };
    // The field documents a minimum of 16; typed input has to honour it or a
    // "1" collapses the picture to a single pixel column.
    var typed = Number($('longest').value) || Math.max(source.width, source.height);
    var longest = Math.max(16, typed);
    var current = Math.max(source.width, source.height);
    // Never upscale: asking for bigger than the original just keeps the original.
    var scale = Math.min(1, longest / current);
    return {
      w: Math.max(1, Math.round(source.width * scale)),
      h: Math.max(1, Math.round(source.height * scale)),
    };
  }

  function convert() {
    if (!source) return;
    clearError();
    resetOutput();
    var size = targetSize();
    var mime = format();
    var quality = (Number($('quality').value) || 82) / 100;

    var canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    var ctx = canvas.getContext('2d');
    // A white backing for JPEG, which has no transparency: without it a
    // transparent PNG would come out with black where it was see-through.
    if (mime === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size.w, size.h);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source.canvas, 0, 0, size.w, size.h);

    statusEl.textContent = 'Encoding…';
    // Disabled while encoding: toBlob is async, and a second click would revoke
    // the first run's blob URL out from under its own download link.
    $('convert').disabled = true;
    canvas.toBlob(function (blob) {
      if (!blob) { statusEl.textContent = ''; $('convert').disabled = false; return fail('This browser could not encode that format. Try JPEG or PNG.'); }
      // The download link uses a blob: URL (fine for a download). The preview is
      // an <img>, and img-src is 'self' data: — a blob: there is refused — so the
      // preview gets a data: URL instead. Same picture, two URL kinds for two jobs.
      var url = URL.createObjectURL(blob);
      liveUrls.push(url);
      var reader = new FileReader();
      reader.onload = function () {
        statusEl.textContent = '';
        var name = baseName(source.name) + '.' + extFor(mime);
        var delta = blob.size - source.bytes.length;
        var change = delta <= 0
          ? bytesLabel(-delta) + ' smaller'
          : bytesLabel(delta) + ' larger, so the original was already smaller';
        resultEl.innerHTML = '<strong>Result:</strong> ' + size.w + ' &times; ' + size.h + ', ' +
          extFor(mime).toUpperCase() + ', ' + bytesLabel(blob.size) + ' (' + change + ').';
        outputEl.innerHTML = '<ul class="plain"><li><a href="' + url + '" download="' + esc(name) + '">' +
          esc(name) + '</a></li></ul>';
        previewEl.innerHTML = '<img class="pic-preview" src="' + reader.result + '" alt="the converted image">';
        $('convert').disabled = false;
      };
      reader.readAsDataURL(blob);
    }, mime, quality);
  }

  function resetOutput() {
    liveUrls.forEach(URL.revokeObjectURL);
    liveUrls = [];
    outputEl.innerHTML = '';
    previewEl.innerHTML = '';
    resultEl.textContent = '';
  }

  function syncQuality() {
    var lossy = format() !== 'image/png';
    $('quality-row').className = lossy ? '' : 'hidden';
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
  // Paste a screenshot straight in: the most common way to have an image in hand
  // is on the clipboard, and saving it to disk first just to reopen it is friction.
  document.addEventListener('paste', function (e) {
    var file = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
    if (file && /^image\//.test(file.type)) { e.preventDefault(); open(file); }
  });

  $('convert').addEventListener('click', convert);
  $('keep-size').addEventListener('change', function () {
    $('longest').disabled = $('keep-size').checked;
  });
  $('longest').disabled = true;
  $('quality').addEventListener('input', function () {
    $('quality-val').textContent = $('quality').value;
  });
  Array.prototype.forEach.call(document.querySelectorAll('input[name="fmt"]'), function (r) {
    r.addEventListener('change', syncQuality);
  });
})();

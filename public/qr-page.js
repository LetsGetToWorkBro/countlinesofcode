/* 1999.LOC QR page. Vanilla JS, no build step.
 *
 * Loads /qrkit.js on first use: the in-house encoder and reader, where the
 * tests can reach them. The page is the label printer around them. Make turns
 * text into a code and prints it onto a tape; Read turns an image or a camera
 * frame back into text. Nothing is uploaded; there is no endpoint to upload to,
 * and no service draws or reads the code for you.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var kit = null; // window.LOC1999_QR
  var ec = 'M';
  var mode = 'make';
  var lastQr = null; // the QrResult last printed, for saving
  var lastText = '';
  var camStream = null;
  var camTimer = 0;

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fail(m) { $('error').textContent = m; }
  function clearError() { $('error').textContent = ''; }

  var loading = null;
  function ready() {
    if (kit) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/qrkit.js';
      s.onload = function () { kit = window.LOC1999_QR; kit ? resolve() : reject(new Error('the engine did not load')); };
      s.onerror = function () { reject(new Error('could not load the QR engine')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  // -------------------------------------------------------------- mode toggle
  function setMode(next) {
    mode = next;
    var make = next === 'make';
    $('pt-mode-make').classList.toggle('is-on', make);
    $('pt-mode-read').classList.toggle('is-on', !make);
    $('pt-mode-make').setAttribute('aria-pressed', String(make));
    $('pt-mode-read').setAttribute('aria-pressed', String(!make));
    document.querySelector('[data-panel="make"]').classList.toggle('hidden', !make);
    document.querySelector('[data-panel="read"]').classList.toggle('hidden', make);
    $('pt-make-scr').classList.toggle('hidden', !make);
    $('pt-read-scr').classList.toggle('hidden', make);
    clearError();
    if (make) stopCamera();
  }

  // -------------------------------------------------------------- make a code
  function selectEc(next) {
    ec = next;
    var btns = document.querySelectorAll('.pt-ecbtn');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-ec') === next;
      btns[i].classList.toggle('is-on', on);
      btns[i].setAttribute('aria-checked', String(on));
    }
    if (lastQr && $('pt-text').value.trim()) makeCode();
  }

  function makeCode() {
    clearError();
    var text = $('pt-text').value;
    if (!text) { fail('Type something to turn into a code.'); return; }
    ready().then(function () {
      var qr;
      try { qr = kit.encodeQr(text, ec); }
      catch (err) { fail((err && err.message) || String(err)); return; }
      lastQr = qr;
      lastText = text;
      // Draw it into the tape at a comfortable on-screen size.
      $('pt-qr').innerHTML = kit.qrSvg(qr, { scale: 8, margin: 4 });
      $('pt-caption').textContent = text;
      $('pt-meta').textContent = 'version ' + qr.version + ', level ' + qr.ec + ', ' + qr.size + ' by ' + qr.size + ' modules';
      $('pt-tape').classList.remove('hidden');
      $('pt-saverow').classList.remove('hidden');
    }).catch(function (err) { fail((err && err.message) || String(err)); });
  }

  // Rasterise the modules straight onto a canvas: no SVG-into-image detour, so
  // the PNG is exact and nothing is loaded across the network to make it.
  function rasterCanvas(qr, scale, margin) {
    var dim = (qr.size + margin * 2) * scale;
    var cv = document.createElement('canvas');
    cv.width = dim; cv.height = dim;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#000000';
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
      }
    }
    return cv;
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function saveSvg() {
    if (!lastQr) return;
    var svg = kit.qrSvg(lastQr, { scale: 10, margin: 4 });
    download(new Blob([svg], { type: 'image/svg+xml' }), 'qr.svg');
  }
  function savePng() {
    if (!lastQr) return;
    rasterCanvas(lastQr, 10, 4).toBlob(function (blob) {
      if (blob) download(blob, 'qr.png');
      else fail('This browser would not render the PNG.');
    }, 'image/png');
  }

  // -------------------------------------------------------------- read a code
  function showResult(text) {
    $('pt-decoded').textContent = text;
    $('pt-read-scr').classList.remove('pt-empty');
    $('pt-result-text').textContent = text;
    $('pt-result').classList.remove('hidden');
    var link = $('pt-openlink');
    if (/^https?:\/\/[^\s]+$/i.test(text)) {
      link.href = text;
      link.classList.remove('hidden');
    } else {
      link.removeAttribute('href');
      link.classList.add('hidden');
    }
  }
  function noResult() {
    $('pt-decoded').textContent = 'No code found. Try a clearer or straighter image.';
    $('pt-result').classList.add('hidden');
  }

  // Draw any image-ish source onto a canvas, capped in size so a huge photo
  // does not make the reader crawl, and hand back its pixels.
  function pixelsOf(source, sw, sh) {
    var max = 1024;
    var w = sw, h = sh;
    if (Math.max(w, h) > max) { var k = max / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  function decodeImageBitmap(bmp) {
    var img = pixelsOf(bmp, bmp.width, bmp.height);
    var text = kit.decodeQr(img.data, img.width, img.height);
    if (bmp.close) bmp.close();
    return text;
  }

  function readFile(file) {
    if (!file || !/^image\//.test(file.type)) { fail('That is not an image.'); return; }
    clearError();
    // Show what is being read.
    var url = URL.createObjectURL(file);
    var prev = $('pt-preview');
    prev.src = url; prev.classList.remove('hidden');
    prev.onload = function () { setTimeout(function () { URL.revokeObjectURL(url); }, 100); };
    ready().then(function () {
      return createImageBitmap(file);
    }).then(function (bmp) {
      var text = decodeImageBitmap(bmp);
      if (text) showResult(text); else noResult();
    }).catch(function () {
      // Fall back to an <img> for browsers without createImageBitmap.
      var im = new Image();
      im.onload = function () {
        ready().then(function () {
          var img = pixelsOf(im, im.naturalWidth, im.naturalHeight);
          var text = kit.decodeQr(img.data, img.width, img.height);
          if (text) showResult(text); else noResult();
        });
      };
      im.onerror = function () { fail('Could not read that image.'); };
      im.src = URL.createObjectURL(file);
    });
  }

  // -------------------------------------------------------------- the camera
  function startCamera() {
    clearError();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fail('This browser does not offer a camera to this page. Open an image instead.');
      return;
    }
    ready().then(function () {
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    }).then(function (stream) {
      camStream = stream;
      var v = $('pt-video');
      v.srcObject = stream;
      $('pt-cam-wrap').classList.remove('hidden');
      $('pt-preview').classList.add('hidden');
      return v.play();
    }).then(function () {
      $('pt-decoded').textContent = 'Scanning...';
      scanLoop();
    }).catch(function (err) {
      var name = err && err.name;
      if (name === 'NotAllowedError') fail('The camera was not allowed. You can open an image instead.');
      else if (name === 'NotFoundError') fail('No camera was found. Open an image instead.');
      else fail('The camera could not be started. Open an image instead.');
      stopCamera();
    });
  }

  function scanLoop() {
    if (!camStream) return;
    var v = $('pt-video');
    if (v.readyState >= 2 && v.videoWidth) {
      try {
        var img = pixelsOf(v, v.videoWidth, v.videoHeight);
        var text = kit.decodeQr(img.data, img.width, img.height);
        if (text) { stopCamera(); showResult(text); return; }
      } catch (e) { /* a frame that will not draw yet; try the next one */ }
    }
    // Poll a few times a second: often enough to feel live, easy on the phone.
    camTimer = setTimeout(function () { requestAnimationFrame(scanLoop); }, 180);
  }

  function stopCamera() {
    if (camTimer) { clearTimeout(camTimer); camTimer = 0; }
    if (camStream) {
      camStream.getTracks().forEach(function (t) { t.stop(); });
      camStream = null;
    }
    var v = $('pt-video');
    if (v) v.srcObject = null;
    $('pt-cam-wrap').classList.add('hidden');
  }

  // -------------------------------------------------------------- wiring
  $('pt-mode-make').addEventListener('click', function () { setMode('make'); });
  $('pt-mode-read').addEventListener('click', function () { setMode('read'); });

  var ecBtns = document.querySelectorAll('.pt-ecbtn');
  for (var i = 0; i < ecBtns.length; i++) {
    (function (btn) { btn.addEventListener('click', function () { selectEc(btn.getAttribute('data-ec')); }); })(ecBtns[i]);
  }

  $('pt-make').addEventListener('click', makeCode);
  $('pt-text').addEventListener('keydown', function (e) {
    // Enter prints; Shift+Enter is a newline, because a label can have lines.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); makeCode(); }
  });
  $('pt-svg').addEventListener('click', saveSvg);
  $('pt-png').addEventListener('click', savePng);

  $('pt-open').addEventListener('click', function () { $('pt-file').click(); });
  $('pt-file').addEventListener('change', function () {
    var f = $('pt-file').files && $('pt-file').files[0];
    if (f) readFile(f);
    $('pt-file').value = '';
  });
  $('pt-cam').addEventListener('click', startCamera);
  $('pt-cam-stop').addEventListener('click', function () {
    stopCamera();
    $('pt-decoded').textContent = 'Stopped.';
  });

  $('pt-copy').addEventListener('click', function () {
    var text = $('pt-result-text').textContent || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        var b = $('pt-copy'); var was = b.textContent; b.textContent = 'Copied';
        setTimeout(function () { b.textContent = was; }, 1200);
      }, function () { fail('The browser would not let the page copy.'); });
    }
  });

  // Drop an image onto the read pane.
  var drop = $('pt-drop');
  ['dragenter', 'dragover'].forEach(function (n) {
    drop.addEventListener(n, function (e) {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') !== -1) {
        e.preventDefault(); drop.classList.add('is-over');
      }
    });
  });
  ['dragleave', 'drop'].forEach(function (n) {
    drop.addEventListener(n, function () { drop.classList.remove('is-over'); });
  });
  drop.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) { e.preventDefault(); setMode('read'); readFile(f); }
  });

  // Paste an image while reading.
  document.addEventListener('paste', function (e) {
    if (mode !== 'read') return;
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var j = 0; j < items.length; j++) {
      if (items[j].type && items[j].type.indexOf('image') === 0) {
        var f = items[j].getAsFile();
        if (f) { e.preventDefault(); readFile(f); return; }
      }
    }
  });

  // Stop the camera if the tab is hidden or the window is left.
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopCamera(); });
  window.addEventListener('pagehide', stopCamera);
})();

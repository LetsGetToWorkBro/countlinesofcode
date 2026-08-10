/* 1999.LOC payment terminal. Vanilla JS, no build step.
 *
 * Loads /paykit.js (the address checks and the URI) and /qrkit.js (the code)
 * on first use, where the tests can reach them. The page is the terminal
 * around them: set a coin, an address and an amount, press Charge, and it
 * builds the standard payment link and draws the QR a customer scans. Nothing
 * is uploaded; the coins go from the payer straight to the address, and this
 * page never sees them.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var pay = null;   // window.LOC1999_PAY
  var qrkit = null; // window.LOC1999_QR
  var coin = 'btc';
  var lastUri = '';
  var lastQr = null;

  function fail(m) { $('error').textContent = m; }
  function clearError() { $('error').textContent = ''; }

  function loadScript(src, name) {
    return new Promise(function (resolve, reject) {
      if (window[name]) { resolve(window[name]); return; }
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { window[name] ? resolve(window[name]) : reject(new Error('the engine did not load')); };
      s.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  var loading = null;
  function ready() {
    if (pay && qrkit) return Promise.resolve();
    if (loading) return loading;
    loading = Promise.all([
      loadScript('/paykit.js', 'LOC1999_PAY'),
      loadScript('/qrkit.js', 'LOC1999_QR'),
    ]).then(function (mods) { pay = mods[0]; qrkit = mods[1]; });
    return loading;
  }

  // ------------------------------------------------------------- coin
  function setCoin(next) {
    coin = next;
    var btc = next === 'btc';
    $('pay-coin-btc').classList.toggle('is-on', btc);
    $('pay-coin-xmr').classList.toggle('is-on', !btc);
    $('pay-coin-btc').setAttribute('aria-pressed', String(btc));
    $('pay-coin-xmr').setAttribute('aria-pressed', String(!btc));
    $('pay-ticker').textContent = btc ? 'BTC' : 'XMR';
    clearError();
    recheckAddress();
  }

  // ------------------------------------------------------------- amount keypad
  function sanitizeAmount(v) {
    // Keep digits and a single dot; drop anything else a paste might carry.
    v = v.replace(/[^0-9.]/g, '');
    var dot = v.indexOf('.');
    if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
    return v;
  }
  function keypad(k) {
    var el = $('pay-amount');
    var v = el.value;
    if (k === 'back') v = v.slice(0, -1);
    else if (k === '.') { if (v.indexOf('.') === -1) v = (v || '0') + '.'; }
    else v = v + k;
    el.value = sanitizeAmount(v);
    clearError();
  }

  // ------------------------------------------------------------- address check
  function recheckAddress() {
    var a = $('pay-address').value.trim();
    var mark = $('pay-addr-mark');
    if (!a) { mark.textContent = ''; mark.className = 'pos-mark'; return; }
    ready().then(function () {
      var r = pay.checkAddress(coin, a);
      if (r.valid) { mark.textContent = '✓ ' + r.kind; mark.className = 'pos-mark is-ok'; }
      else { mark.textContent = '✗ ' + r.problem; mark.className = 'pos-mark is-bad'; }
    }).catch(function () { /* the engine failing to load is reported on Charge */ });
  }

  // ------------------------------------------------------------- charge
  function charge() {
    clearError();
    ready().then(function () {
      var addr = $('pay-address').value.trim();
      var ac = pay.checkAddress(coin, addr);
      if (!ac.valid) { fail(ac.problem || 'That address is not valid.'); return; }
      var am = pay.parseAmount(coin, $('pay-amount').value);
      if (!am.ok) { fail(am.problem); return; }

      var label = $('pay-label').value.trim();
      var uri = pay.buildUri(coin, addr, { amount: am.value, label: label });
      lastUri = uri;

      var qr;
      try { qr = qrkit.encodeQr(uri, 'M'); }
      catch (err) { fail((err && err.message) || String(err)); return; }
      lastQr = qr;

      $('pay-qr').innerHTML = qrkit.qrSvg(qr, { scale: 7, margin: 4 });
      $('pay-uri').textContent = uri;
      $('pay-ticket-head').textContent = am.value
        ? 'Scan to pay ' + am.value + ' ' + pay.COINS[coin].ticker
        : 'Scan to pay ' + pay.COINS[coin].name;
      $('pay-ticket').classList.remove('hidden');
    }).catch(function (err) { fail((err && err.message) || String(err)); });
  }

  // ------------------------------------------------------------- saving
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

  // ------------------------------------------------------------- wiring
  $('pay-coin-btc').addEventListener('click', function () { setCoin('btc'); });
  $('pay-coin-xmr').addEventListener('click', function () { setCoin('xmr'); });

  var keys = document.querySelectorAll('.pos-key');
  for (var i = 0; i < keys.length; i++) {
    (function (btn) { btn.addEventListener('click', function () { keypad(btn.getAttribute('data-key')); }); })(keys[i]);
  }

  $('pay-amount').addEventListener('input', function () {
    var el = $('pay-amount');
    var clean = sanitizeAmount(el.value);
    if (clean !== el.value) el.value = clean;
    clearError();
  });
  $('pay-address').addEventListener('input', recheckAddress);
  // Loading the engines when the address is first touched keeps the check
  // instant once someone starts typing.
  $('pay-address').addEventListener('focus', function () { ready(); }, { once: true });

  $('pay-charge').addEventListener('click', charge);
  $('pay-clear').addEventListener('click', function () {
    $('pay-amount').value = '';
    $('pay-label').value = '';
    $('pay-ticket').classList.add('hidden');
    lastUri = ''; lastQr = null;
    clearError();
  });

  // Enter anywhere in the terminal charges.
  document.querySelector('.pos-machine').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); charge(); }
  });

  $('pay-copy').addEventListener('click', function () {
    if (!lastUri) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(lastUri).then(function () {
        var b = $('pay-copy'); var was = b.textContent; b.textContent = 'Copied';
        setTimeout(function () { b.textContent = was; }, 1200);
      }, function () { fail('The browser would not let the page copy.'); });
    }
  });
  $('pay-svg').addEventListener('click', function () {
    if (!lastQr) return;
    download(new Blob([qrkit.qrSvg(lastQr, { scale: 10, margin: 4 })], { type: 'image/svg+xml' }), 'payment-qr.svg');
  });
  $('pay-png').addEventListener('click', function () {
    if (!lastQr) return;
    rasterCanvas(lastQr, 10, 4).toBlob(function (blob) {
      if (blob) download(blob, 'payment-qr.png');
      else fail('This browser would not render the PNG.');
    }, 'image/png');
  });
})();

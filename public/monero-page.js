/* 1999.LOC Monero page. Vanilla JS, no build step.
 *
 * Loads /monero.js on first use: the derivation, the address encoding and the
 * seed phrase, built from src/client/monero.ts.
 *
 * The one rule this file enforces that the engine cannot: the generator stays
 * disabled until every self-check has passed in this browser. A build that is
 * broken, tampered with, or running somewhere its dependencies misbehave will
 * refuse to make a wallet rather than make a bad one, and a bad one is
 * indistinguishable from a good one until the money is gone.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var xmr = null;
  var checksPassed = false;
  var liveUrls = [];

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fail(m) { $('error').textContent = m; $('status').textContent = ''; }
  function clearError() { $('error').textContent = ''; }

  function ready() {
    if (xmr) return Promise.resolve();
    $('status').textContent = 'Loading…';
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = '/monero.js';
      el.onload = function () {
        xmr = window.LOC1999_XMR;
        xmr ? resolve() : reject(new Error('the engine did not load'));
      };
      el.onerror = function () { reject(new Error('could not load the engine')); };
      document.head.appendChild(el);
    }).then(function () { $('status').textContent = ''; });
  }

  // ---------------------------------------------------------------- proof

  function runChecks() {
    var checks = xmr.selfTest();
    checksPassed = xmr.allChecksPass(checks);
    var passed = checks.filter(function (c) { return c.ok; }).length;

    $('proof-checks').innerHTML =
      '<p class="' + (checksPassed ? 'status' : 'error') + '"><strong>' +
        passed + ' of ' + checks.length + ' checks passed' +
        (checksPassed ? '.' : '. The generator is switched off.') +
      '</strong></p>' +
      '<div class="key-list">' + checks.map(function (c) {
        return '<div class="key-row">' +
          '<span class="key-kind">' + (c.ok ? 'ok' : 'FAILED') + '</span>' +
          '<span class="key-name">' + esc(c.name) + '<br>' +
            '<span class="note">' + esc(c.proves) + '</span></span>' +
          '<span class="key-print">' + esc(c.detail) + '</span>' +
          '</div>';
      }).join('') + '</div>' +
      (checksPassed
        ? '<p class="note">These prove the parts that can be checked against something other than this code. They cannot prove the step from a private key to a public one, because there is no published secret to test that against. That is the gap the official wallet closes, and why restoring there before you fund anything is not a formality.</p>'
        : '<p class="error">Something here is wrong. Do not use this page. Please report it.</p>');

    $('generate').disabled = !checksPassed;
  }

  // ------------------------------------------------------------ checking

  function showParsed(target, parsed, extra) {
    if (!parsed.valid) {
      target.innerHTML = '<p class="error"><strong>Not a valid address.</strong> ' + esc(parsed.problem) + '</p>';
      return;
    }
    target.innerHTML =
      '<p><strong>Valid ' + esc(parsed.network) + ' ' + esc(parsed.kind) + ' address.</strong> ' +
      'The checksum matches, so it has not been corrupted in transit.</p>' +
      '<table>' +
      '<tr><th scope="row">Network</th><td>' + esc(parsed.network) + '</td></tr>' +
      '<tr><th scope="row">Kind</th><td>' + esc(parsed.kind) + '</td></tr>' +
      '<tr><th scope="row">Public spend key</th><td><code class="xmr">' + esc(parsed.spendPublic) + '</code></td></tr>' +
      '<tr><th scope="row">Public view key</th><td><code class="xmr">' + esc(parsed.viewPublic) + '</code></td></tr>' +
      (parsed.paymentId
        ? '<tr><th scope="row">Payment id</th><td><code>' + esc(parsed.paymentId) + '</code></td></tr>'
        : '') +
      '</table>' + (extra || '');
  }

  function check() {
    clearError();
    ready().then(function () {
      showParsed($('check-result'), xmr.parseAddress($('check-text').value));
    }).catch(function (err) { fail(err.message); });
  }

  // ---------------------------------------------------------- generating

  /* Browser randomness, with whatever the visitor typed folded in. The mixing
     itself lives in the engine, where the tests can reach it: an earlier
     version of this function did the folding here and got it wrong, in a way
     that produced a perfectly plausible-looking key. */
  function makeSeed(extra) {
    var browser = new Uint8Array(32);
    crypto.getRandomValues(browser);
    return xmr.mixEntropy(browser, new TextEncoder().encode(extra || ''));
  }

  function generate() {
    clearError();
    if (!checksPassed) { fail('The checks above have not passed, so nothing will be generated.'); return; }

    var wallet;
    try {
      wallet = xmr.walletFromSeed(makeSeed($('extra').value.trim()), $('network').value);
    } catch (err) {
      fail(err.message);
      return;
    }

    var words = wallet.mnemonic;
    $('wallet-out').innerHTML =
      '<p><strong>Address</strong></p>' +
      '<p><code class="xmr">' + esc(wallet.address) + '</code></p>' +
      '<p><strong>Seed phrase</strong>, the 25 words that restore everything. ' +
        'Write these down. They are the wallet.</p>' +
      '<ol class="seed-words">' + words.map(function (w) {
        return '<li>' + esc(w) + '</li>';
      }).join('') + '</ol>' +
      '<p><strong>Keys</strong>, for tools that want them directly.</p>' +
      '<table>' +
      '<tr><th scope="row">Private spend key</th><td><code class="xmr">' + esc(wallet.spendSecret) + '</code></td></tr>' +
      '<tr><th scope="row">Private view key</th><td><code class="xmr">' + esc(wallet.viewSecret) + '</code></td></tr>' +
      '<tr><th scope="row">Public spend key</th><td><code class="xmr">' + esc(wallet.spendPublic) + '</code></td></tr>' +
      '<tr><th scope="row">Public view key</th><td><code class="xmr">' + esc(wallet.viewPublic) + '</code></td></tr>' +
      '</table>' +
      '<div class="notice-box">' +
      '<p><strong>Before you send anything to this address.</strong></p>' +
      '<p class="note">Restore those 25 words in the official wallet and confirm it shows the same address. ' +
      '<code>monero-wallet-cli --restore-deterministic-wallet</code>. If the address it shows differs, ' +
      'this page is wrong, and finding that out now costs you nothing.</p>' +
      '</div>' +
      '<hr>' +
      watchOnlyHtml(wallet.address, wallet.viewSecret,
        'Watching this wallet later, without exposing it');

    $('wallet').classList.remove('hidden');
    $('generate-note').textContent = 'Made. Nothing about it is stored anywhere.';
    $('wallet').scrollIntoView({ block: 'start' });
  }


  // ---------------------------------------------------------- watch only

  /* The instructions for loading an address and its view key into the official
     wallet. Shared by the Watch tab and the freshly generated wallet, so there
     is one place that decides what is printed and one place to get it wrong. */
  function watchOnlyHtml(address, viewSecret, heading) {
    var exported = xmr.watchOnlyExport(address, viewSecret, Date.now());
    return '<h4>' + esc(heading) + '</h4>' +
      '<p class="note">Run this, and answer the two prompts with the values below. ' +
      'Nothing here contacts the network; the official wallet does that part.</p>' +
      '<pre>' + esc(exported.steps[0]) + '</pre>' +
      '<table>' +
      '<tr><th scope="row">Standard address</th><td><code class="xmr">' + esc(address) + '</code></td></tr>' +
      '<tr><th scope="row">Private view key</th><td><code class="xmr">' + esc(viewSecret) + '</code></td></tr>' +
      '<tr><th scope="row">Restore from height</th><td><code>' + exported.height.toLocaleString() + '</code></td></tr>' +
      '</table>' +
      '<p class="note">That height is worked out from today\'s date and is deliberately about a week early. ' +
      'Scanning from too early only costs time; from too late, the wallet never sees payments that already ' +
      'arrived and shows a balance of zero without saying why. If you know when the wallet was made, use that.</p>' +
      '<p class="note">In the GUI instead: <em>Restore wallet from keys</em>, paste the address and the view key, ' +
      'and leave the spend key blank.</p>' +
      '<p><button type="button" class="small watch-json" data-json="' + esc(exported.json) +
      '" data-name="' + esc(exported.filename) + '">Save the JSON for --generate-from-json</button></p>' +
      '<p class="note">The JSON is the scriptable route. It contains the address, the view key and the height, ' +
      'and no spend key: it cannot move anything.</p>';
  }

  function watch() {
    clearError();
    ready().then(function () {
      var address = $('watch-address').value.trim();
      var view = $('watch-view').value.trim().toLowerCase();

      var allowed = xmr.canWatch(xmr.parseAddress(address));
      if (!allowed.ok) {
        $('watch-result').innerHTML = '<p class="error">' + esc(allowed.problem) + '</p>';
        return;
      }
      if (!/^[0-9a-f]{64}$/.test(view)) {
        $('watch-result').innerHTML = '<p class="error">A private view key is 64 hexadecimal characters. ' +
          'That is ' + view.length + '.</p>';
        return;
      }
      $('watch-result').innerHTML = watchOnlyHtml(address, view, 'Load it as watch-only');
    }).catch(function (err) { fail(err.message); });
  }

  // ------------------------------------------------------------ restoring

  function restore() {
    clearError();
    ready().then(function () {
      var result = xmr.walletFromMnemonic($('restore-text').value, $('restore-network').value);
      if (result.problem) {
        $('restore-result').innerHTML = '<p class="error">' + esc(result.problem) + '</p>';
        return;
      }
      $('restore-result').innerHTML =
        '<p><strong>Those words open this wallet.</strong></p>' +
        '<p><code class="xmr">' + esc(result.address) + '</code></p>' +
        '<table>' +
        '<tr><th scope="row">Private spend key</th><td><code class="xmr">' + esc(result.spendSecret) + '</code></td></tr>' +
        '<tr><th scope="row">Private view key</th><td><code class="xmr">' + esc(result.viewSecret) + '</code></td></tr>' +
        '</table>' +
        '<p class="note">If you are checking a phrase you wrote down, the address above is the one to compare against your paper. If they differ, the words were copied wrongly.</p>';
    }).catch(function (err) { fail(err.message); });
  }

  // -------------------------------------------------------------- wiring

  var TABS = ['check', 'make', 'restore', 'watch'];
  TABS.forEach(function (name) {
    $('tab-' + name).addEventListener('click', function () {
      clearError();
      TABS.forEach(function (other) {
        $('mode-' + other).classList.toggle('hidden', other !== name);
        $('tab-' + other).classList.toggle('is-active', other === name);
      });
    });
  });

  $('check').addEventListener('click', check);
  $('check-ours').addEventListener('click', function () {
    ready().then(function () {
      $('check-text').value = xmr.KNOWN_ADDRESS;
      check();
    }).catch(function (err) { fail(err.message); });
  });
  $('generate').addEventListener('click', generate);
  $('restore').addEventListener('click', restore);
  $('watch').addEventListener('click', watch);
  $('print').addEventListener('click', function () { window.print(); });
  $('verify-jump').addEventListener('click', function () {
    $('tab-restore').click();
    $('restore-text').focus();
  });

  // The checks run on load, not on first use: somebody should be able to see
  // whether this page works before deciding to trust it with anything.
  ready().then(runChecks).catch(function (err) {
    fail(err.message);
    $('proof-checks').innerHTML = '<p class="error">The engine did not load, so nothing has been verified.</p>';
  });

  document.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.watch-json') : null;
    if (!button) return;
    download(button.dataset.json, button.dataset.name + '.json');
  });

  /* Writes text out as a file. The watch-only JSON holds a view key, so it goes
     through a blob like everything else here and never near a URL. */
  function download(text, name) {
    var link = document.createElement('a');
    link.href = objectUrl(new Blob([text], { type: 'application/json' }));
    link.download = name;
    link.click();
  }

  function objectUrl(blob) {
    var url = URL.createObjectURL(blob);
    liveUrls.push(url);
    return url;
  }

  window.addEventListener('pagehide', function () {
    liveUrls.forEach(URL.revokeObjectURL);
    liveUrls = [];
  });
})();

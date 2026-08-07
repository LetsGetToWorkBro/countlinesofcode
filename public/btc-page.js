/* 1999.LOC Bitcoin wallet page. Vanilla JS, no build step.
 *
 * Loaded on demand from this origin:
 *   /btcwallet.js    keys, derivation, signing, scanning (scure/noble, bundled)
 *
 * The wallet lives in memory only: no wallet file, no browser storage, gone on
 * reload; the seed words are the only way back in. The keys never leave the
 * tab. Only explorer lookups and a finished transaction cross the network, and
 * they go through this site's /api/btc proxy so the explorer never sees the
 * visitor's IP.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  if (!$('btc-setup')) return;

  var kit = null;          // window.LOC1999_BTC
  var loadingKit = null;
  var wallet = null;       // { kind, account, zpub } from the kit
  var seedWords = null;    // shown under Secrets for a full wallet
  var view = null;         // last scan result
  var plan = null;         // built-but-unsent transaction awaiting confirm
  var scanning = false;

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setupFail(m) { $('btc-setup-error').textContent = m; }
  function setupStatus(m) { $('btc-setup-status').textContent = m; }
  function syncLine(m) { $('btc-sync-line').textContent = m; }

  function loadKit() {
    if (kit) return Promise.resolve();
    if (loadingKit) return loadingKit;
    loadingKit = new Promise(function (resolve, reject) {
      if (window.LOC1999_BTC) return resolve();
      var el = document.createElement('script');
      el.src = '/btcwallet.js';
      el.onload = resolve;
      el.onerror = function () { reject(new Error('could not load the wallet engine')); };
      document.head.appendChild(el);
    }).then(function () {
      kit = window.LOC1999_BTC;
      if (!kit) throw new Error('the wallet engine did not load');
    }, function (err) { loadingKit = null; throw err; });
    return loadingKit;
  }

  // ------------------------------------------------------ explorer picking

  function fillServers() {
    var select = $('btc-server');
    kit.btcServers().forEach(function (server) {
      var opt = document.createElement('option');
      opt.value = server.id;
      opt.textContent = server.label;
      select.appendChild(opt);
    });
    var custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'An Esplora server of your own...';
    select.appendChild(custom);
    syncServerSummary();
  }

  var PRIVACY_NOTES = {
    direct: 'Fastest. This site\u2019s server, and Cloudflare behind it, can read your addresses out of the request log.',
    padded: 'Each batch is mixed with real decoy addresses and shuffled, so the log holds a set your wallet is somewhere inside. Two to three times the requests, and public explorers rate-limit; your own server above is better still.',
  };

  function privacyMode() {
    var select = $('btc-privacy');
    return select && select.value === 'padded' ? 'padded' : 'direct';
  }

  function syncPrivacyNote() {
    $('btc-privacy-note').textContent = PRIVACY_NOTES[privacyMode()];
  }

  function serverChoice() {
    var select = $('btc-server');
    return { id: select.value || 'mempool', custom: $('btc-custom').value };
  }

  function syncServerSummary() {
    var choice = serverChoice();
    if (choice.id === 'custom') {
      $('btc-server-summary').textContent = choice.custom ? choice.custom : 'your own server';
      return;
    }
    var known = kit.btcServers().filter(function (s) { return s.id === choice.id; })[0];
    $('btc-server-summary').textContent = known ? known.label : choice.id;
  }

  /** GET a path as JSON through the proxy, failing over between the curated
   *  servers once, and saying so, the way the Monero tab swaps nodes. */
  function getJson(path) {
    return requestRaw('GET', path, null).then(function (r) { return JSON.parse(r); });
  }

  function requestRaw(method, path, body) {
    var choice = serverChoice();
    var order = [choice.id];
    if (choice.id !== 'custom') {
      kit.btcServers().forEach(function (s) { if (s.id !== choice.id) order.push(s.id); });
    }
    var attempt = 0;
    function tryNext(lastErr) {
      if (attempt >= order.length) return Promise.reject(lastErr || new Error('no explorer answered'));
      var id = order[attempt++];
      var base = kit.btcProxyBase(id === 'custom' ? choice : { id: id });
      if (!base.ok) return Promise.reject(new Error(base.problem));
      return fetch(base.base + '/' + path, {
        method: method,
        headers: body === null ? {} : { 'content-type': 'text/plain' },
        body: body === null ? undefined : body,
      }).then(function (r) {
        return r.text().then(function (text) {
          if (!r.ok) {
            // A 4xx is an answer (bad tx, unknown address shape): surface it.
            // A 5xx or a 429 means this server is struggling or rationing:
            // try the next one.
            if (r.status >= 500 || r.status === 429) throw new Error('HTTP ' + r.status);
            var message = text;
            try { message = JSON.parse(text).error.message || text; } catch (e) { /* plain text */ }
            if (/^\s*</.test(message)) message = 'HTTP ' + r.status; // an HTML error page is not a sentence
            var err = new Error(message || ('HTTP ' + r.status));
            err.final = true;
            throw err;
          }
          if (attempt > 1) {
            $('btc-server-swap').textContent = 'The chosen explorer did not answer; using ' + id + ' instead.';
          }
          return text;
        });
      }).catch(function (err) {
        if (err && err.final) throw err;
        return tryNext(err);
      });
    }
    return tryNext(null);
  }

  // -------------------------------------------------------------- opening

  function openWallet(opened, words, freshlyMade) {
    wallet = opened;
    seedWords = words || null;
    view = null;
    plan = null;
    $('btc-setup').classList.add('hidden');
    $('btc-wallet').classList.remove('hidden');
    $('btc-watch-banner').classList.toggle('hidden', wallet.kind !== 'watch');
    $('btw-send').classList.toggle('hidden', wallet.kind === 'watch');
    // Secrets stays for a watch wallet: it holds the zpub, the honest "no
    // words on this machine" answer, and the close button.
    showSection('overview');
    if (freshlyMade) {
      view = kit.emptyView(wallet);
      renderView();
    } else {
      refresh();
    }
  }

  $('btc-create').addEventListener('click', function () {
    setupFail('');
    loadKit().then(function () {
      var words = kit.newMnemonic();
      // A brand-new wallet is empty by construction: no scan, no network,
      // no explorer learning forty addresses that can only be blank.
      openWallet(kit.openFromMnemonic(words), words, true);
      // The words are the wallet; show them immediately, once, and insist.
      showSection('secrets');
      revealSeed();
      syncLine('Write the 12 words down now. Then fund the wallet from Receive.');
    }).catch(function (err) { setupFail(kit ? kit.prettyBtcError(err) : String(err.message || err)); });
  });

  $('btc-restore').addEventListener('click', function () {
    setupFail('');
    loadKit().then(function () {
      var checked = kit.checkMnemonic($('btc-seed-in').value);
      if (!checked.ok) { setupFail(checked.problem); return; }
      openWallet(kit.openFromMnemonic(checked.words), checked.words);
      $('btc-seed-in').value = '';
    }).catch(function (err) { setupFail(kit ? kit.prettyBtcError(err) : String(err.message || err)); });
  });

  $('btc-watch').addEventListener('click', function () {
    setupFail('');
    loadKit().then(function () {
      var opened = kit.openWatch($('btc-zpub-in').value);
      if (!opened.ok) { setupFail(opened.problem); return; }
      openWallet(opened.wallet, null);
    }).catch(function (err) { setupFail(kit ? kit.prettyBtcError(err) : String(err.message || err)); });
  });

  // -------------------------------------------------------------- scanning

  function refresh() {
    if (!wallet || scanning) return;
    scanning = true;
    syncLine('Scanning the wallet’s addresses...');
    kit.scanWallet(getJson, wallet, { privacy: privacyMode() }).then(function (result) {
      view = result;
      scanning = false;
      renderView();
    }, function (err) {
      scanning = false;
      syncLine(kit.prettyBtcError(err));
    });
  }

  function renderView() {
    if (!view) return;
    $('btc-balance').textContent = kit.formatBtc(view.balance);
    $('btc-pending-line').textContent = view.pending !== 0n
      ? '(' + kit.formatBtc(view.pending) + ' of that still unconfirmed)' : '';
    $('btc-coins-line').textContent = view.utxos.length
      ? String(view.utxos.length) + ' coin' + (view.utxos.length === 1 ? '' : 's') + ' across ' + view.usedAddresses + ' used address' + (view.usedAddresses === 1 ? '' : 'es') + '.'
      : 'Nothing received yet. Fund it from the Receive tab.';
    $('btc-address').textContent = view.receiveAddress;
    renderHistory();
    syncLine('Up to date. Balance ' + kit.formatBtc(view.balance) + ' BTC.');
  }

  function renderHistory() {
    var box = $('btc-history');
    if (!view.history.length) {
      $('btc-history-note').textContent = 'No transactions yet.';
      box.innerHTML = '';
      return;
    }
    $('btc-history-note').textContent = '';
    var html = '';
    view.history.forEach(function (entry) {
      var sign = entry.net >= 0n ? '+' : '';
      var when = entry.time ? new Date(entry.time * 1000).toISOString().slice(0, 10) : 'pending';
      html += '<p class="note"><strong>' + sign + esc(kit.formatBtc(entry.net)) + ' BTC</strong> ' +
        (entry.confirmed ? '' : '(unconfirmed) ') + esc(when) +
        ' <code>' + esc(entry.txid.slice(0, 10)) + '...</code></p>';
    });
    box.innerHTML = html;
  }

  $('btc-refresh').addEventListener('click', refresh);

  // ---------------------------------------------------------------- send

  function sendFail(m) { $('btc-send-error').textContent = m; }

  $('btc-send-max').addEventListener('click', function () {
    $('btc-send-amount').value = 'max';
  });

  $('btc-review').addEventListener('click', function () {
    sendFail('');
    $('btc-confirm').classList.add('hidden');
    if (!wallet || !view) return;
    var amountText = String($('btc-send-amount').value).trim().toLowerCase();
    var amount;
    if (amountText === 'max' || amountText === 'all') {
      amount = null;
    } else {
      var parsed = kit.parseBtc(amountText);
      if (!parsed.ok) { sendFail(parsed.problem); return; }
      amount = parsed.sats;
    }
    syncLine('Asking the explorer for fee rates...');
    getJson('fee-estimates').then(function (estimates) {
      var rate = kit.pickFeeRate(estimates, parseInt($('btc-fee').value, 10) || 6);
      var built = kit.buildSend({
        wallet: wallet,
        utxos: view.utxos,
        to: String($('btc-send-address').value).trim(),
        amount: amount,
        feeRate: rate,
      });
      syncLine('Up to date. Balance ' + kit.formatBtc(view.balance) + ' BTC.');
      if (!built.ok) { sendFail(built.problem); return; }
      plan = built;
      $('btc-confirm-detail').textContent =
        kit.formatBtc(built.amount) + ' BTC to ' + String($('btc-send-address').value).trim() +
        ', network fee ' + kit.formatBtc(built.fee) + ' BTC (' + rate + ' sat/vB)' +
        (built.change > 0n ? ', change ' + kit.formatBtc(built.change) + ' BTC back to this wallet.' : '.');
      $('btc-confirm').classList.remove('hidden');
    }, function (err) { syncLine(''); sendFail(kit.prettyBtcError(err)); });
  });

  $('btc-send-cancel').addEventListener('click', function () {
    plan = null;
    $('btc-confirm').classList.add('hidden');
  });

  $('btc-send-now').addEventListener('click', function () {
    if (!plan) return;
    var sending = plan;
    plan = null;
    $('btc-confirm').classList.add('hidden');
    syncLine('Broadcasting...');
    requestRaw('POST', 'tx', sending.hex).then(function (txid) {
      $('btc-send-result').innerHTML =
        '<p class="status">Sent. Transaction <code>' + esc(txid.trim() || sending.txid) + '</code></p>';
      $('btc-send-amount').value = '';
      $('btc-send-address').value = '';
      refresh();
    }, function (err) {
      syncLine('');
      sendFail(kit.prettyBtcError(err));
    });
  });

  // -------------------------------------------------------------- secrets

  function revealSeed() {
    if (!seedWords) {
      $('btc-seed-out').innerHTML = '<p class="note">This wallet was opened watch-only; there are no words on this machine.</p>';
      return;
    }
    $('btc-seed-out').innerHTML = '<p><code class="xmr">' + esc(seedWords) + '</code></p>' +
      '<p class="note">These 12 words are the whole wallet. Paper, not a screenshot.</p>';
  }

  $('btc-reveal-seed').addEventListener('click', revealSeed);

  $('btc-show-zpub').addEventListener('click', function () {
    if (!wallet) return;
    $('btc-zpub-out').innerHTML = '<p class="note">Watch-only key: paste this into the Watch tab (or any wallet) to see balance and history without being able to spend.</p>' +
      '<p><code class="xmr">' + esc(wallet.zpub) + '</code></p>';
  });

  $('btc-close').addEventListener('click', function () {
    wallet = null;
    seedWords = null;
    view = null;
    plan = null;
    $('btc-seed-out').innerHTML = '';
    $('btc-zpub-out').innerHTML = '';
    $('btc-send-result').innerHTML = '';
    $('btc-wallet').classList.add('hidden');
    $('btc-setup').classList.remove('hidden');
    syncLine('');
  });

  // ----------------------------------------------------------------- copy

  $('btc-addr-copy').addEventListener('click', function () {
    var text = $('btc-address').textContent;
    if (!text) return;
    var button = $('btc-addr-copy');
    var done = function () {
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy'; }, 1500);
    };
    var fallen = function () {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.className = 'offscreen';
      document.body.appendChild(area);
      area.select();
      var copied = false;
      try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
      document.body.removeChild(area);
      if (copied) return done();
      $('btc-addr-note').textContent = 'copying is blocked here; select the address and copy it by hand';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallen);
    } else {
      fallen();
    }
  });

  // ---------------------------------------------------- tabs and sections

  var MODES = ['create', 'restore', 'watch'];
  MODES.forEach(function (name) {
    $('btab-' + name).addEventListener('click', function () {
      MODES.forEach(function (other) {
        $('btab-' + other).classList.toggle('is-active', other === name);
        $('bmode-' + other).classList.toggle('hidden', other !== name);
      });
      setupFail('');
    });
  });

  var SECTIONS = ['overview', 'receive', 'send', 'history', 'secrets'];
  function showSection(which) {
    SECTIONS.forEach(function (name) {
      $('btw-' + name).classList.toggle('is-active', name === which);
      $('bsec-' + name).classList.toggle('hidden', name !== which);
    });
  }
  SECTIONS.forEach(function (name) {
    $('btw-' + name).addEventListener('click', function () { showSection(name); });
  });

  $('btc-privacy').addEventListener('change', syncPrivacyNote);

  $('btc-server').addEventListener('change', function () {
    $('btc-custom-row').classList.toggle('hidden', $('btc-server').value !== 'custom');
    syncServerSummary();
    $('btc-server-swap').textContent = '';
  });
  $('btc-custom').addEventListener('input', function () {
    syncServerSummary();
    var checked = kit ? kit.btcProxyBase({ id: 'custom', custom: $('btc-custom').value }) : { ok: true };
    $('btc-server-note').textContent = checked.ok || !$('btc-custom').value ? '' : checked.problem;
  });

  // The engine is 150 KB, so it loads when the Bitcoin tab is first shown
  // rather than costing every visitor to the Monero tab.
  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    loadKit().then(function () { fillServers(); syncPrivacyNote(); }, function () {
      setupFail('The wallet engine did not load. Reload the page.');
    });
  }
  var tabsRoot = document.querySelector('[data-tabs]');
  if (tabsRoot) {
    tabsRoot.addEventListener('tab:shown', function (event) {
      if (event.detail && event.detail.tab === 'btc') boot();
    });
    var panel = tabsRoot.querySelector('[data-panel="btc"]');
    if (panel && !panel.classList.contains('hidden')) boot();
  } else {
    boot();
  }
})();

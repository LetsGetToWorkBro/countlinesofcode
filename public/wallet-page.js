/* 1999.LOC Monero wallet page. Vanilla JS, no build step.
 *
 * Loaded on demand, both from this origin:
 *   /xmrlib.js                             the Monero wallet (monero-ts), bundled
 *   /walletkit.js                          the page's own amount/node/error logic
 *   /vendor/monero-ts/monero.worker.js     the wallet cryptography, in a Worker
 *
 * The wallet lives in memory only. There is no wallet file, here or in browser
 * storage: closing or reloading the tab discards it, and the seed phrase is the
 * only way back in. The keys never leave the tab; only ordinary node RPC (fetch
 * blocks, broadcast a transaction) crosses the network, and that goes through
 * this site's /api/xmr proxy so the node never sees the visitor.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var xmr = null;    // window.LOC1999_XMRLIB, the monero-ts module
  var kit = null;    // window.LOC1999_WALLET, our helpers
  var loading = null;

  var wallet = null;         // the live MoneroWalletFull
  var walletNetwork = 'mainnet';
  var watchOnly = false;
  var pendingTxs = null;     // built-but-unsent transactions awaiting confirm
  var subaddressCount = 0;

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ------------------------------------------------------------- loading

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(el);
    });
  }

  function loadEngines() {
    if (xmr && kit) return Promise.resolve();
    if (loading) return loading;
    setSetupStatus('Loading the wallet (a few megabytes, once)...');
    loading = Promise.all([
      window.LOC1999_WALLET ? null : loadScript('/walletkit.js'),
      window.LOC1999_XMRLIB ? null : loadScript('/xmrlib.js'),
    ]).then(function () {
      kit = window.LOC1999_WALLET;
      xmr = window.LOC1999_XMRLIB;
      if (!kit || !xmr) throw new Error('the wallet did not load');
      // The cryptography runs in the vendored worker, served from this origin.
      xmr.LibraryUtils.setWorkerDistPath('/vendor/monero-ts/monero.worker.js');
      setSetupStatus('');
    }, function (err) { loading = null; setSetupStatus(''); throw err; });
    return loading;
  }

  // -------------------------------------------------------- node picking

  function fillNodes() {
    var select = $('node');
    kit.nodes().forEach(function (node) {
      var opt = document.createElement('option');
      opt.value = 'n:' + node.id;
      opt.textContent = node.label + (node.network !== 'mainnet' ? ' [' + node.network + ']' : '');
      select.appendChild(opt);
    });
    var custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'A node of your own...';
    select.appendChild(custom);
    syncNodeSummary();
  }

  function nodeIsCustom() { return $('node').value === 'custom'; }

  /* The collapsed picker's one-line summary: which node the wallet will use. */
  function syncNodeSummary() {
    var el = $('node-summary');
    if (!el) return;
    if (nodeIsCustom()) {
      var v = $('custom-node').value.trim();
      el.textContent = v || 'your own node (enter it below)';
    } else {
      var sel = $('node');
      var opt = sel.options[sel.selectedIndex];
      el.textContent = opt ? opt.textContent : 'choosing...';
    }
  }

  /* The chosen node's network, so the wallet is created on the matching chain.
     A custom node is assumed mainnet, which is what almost every one is. */
  function chosenNetwork() {
    if (nodeIsCustom()) return 'mainnet';
    var id = $('node').value.slice(2);
    var node = kit.nodes().find(function (n) { return n.id === id; });
    return node ? node.network : 'mainnet';
  }

  /* The proxy URI to hand the wallet, or null with a message shown. */
  function chosenServer() {
    var choice;
    if (nodeIsCustom()) {
      choice = { mode: 'c', key: $('custom-node').value.trim() };
    } else {
      choice = { mode: 'n', key: $('node').value.slice(2) };
    }
    var built = kit.proxyUri(choice, window.location.origin);
    if (!built.ok) {
      $('node-note').textContent = built.problem || 'That node cannot be used.';
      return null;
    }
    $('node-note').textContent = '';
    return { uri: built.uri };
  }

  // ------------------------------------------------- node preflight/failover

  /* Ask a node for its version through the proxy, with a hard timeout. It is
     the same endpoint the wallet needs, so a node that fails this would fail
     the wallet a minute later, more confusingly. */
  function probeNode(uri) {
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 8000) : null;
    var done = function (pass) { if (timer) clearTimeout(timer); return pass; };
    return fetch(uri + '/json_rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_version' }),
      signal: ctl ? ctl.signal : undefined,
    }).then(function (r) {
      done();
      if (!r.ok) throw new Error('node unreachable');
      return r.json();
    }, function (err) { done(); throw err; }).then(function (j) {
      if (!j || !j.result) throw new Error('node unreachable');
    });
  }

  function labelFor(id) {
    var n = kit.nodes().find(function (x) { return x.id === id; });
    return n ? n.label : id;
  }

  /* Make sure the chosen node answers before a wallet is built against it. A
     curated node that fails is swapped for the next curated one that works,
     with a note saying so. A custom node that fails is an error, because
     silently abandoning a node somebody chose on purpose would be worse. */
  function ensureReachableNode() {
    if ($('node-swap')) $('node-swap').textContent = '';
    var origin = window.location.origin;
    if (nodeIsCustom()) {
      var built = kit.proxyUri({ mode: 'c', key: $('custom-node').value.trim() }, origin);
      if (!built.ok) return Promise.reject(new Error(built.problem || 'That node cannot be used.'));
      return probeNode(built.uri).catch(function () { throw new Error('node_unreachable'); });
    }
    var chosen = $('node').value.slice(2);
    var ids = kit.nodes().map(function (n) { return n.id; });
    var order = [chosen].concat(ids.filter(function (id) { return id !== chosen; }));
    function attempt(i) {
      if (i >= order.length) throw new Error('node_unreachable');
      var id = order[i];
      var built = kit.proxyUri({ mode: 'n', key: id }, origin);
      if (!built.ok) return attempt(i + 1);
      return probeNode(built.uri).then(function () {
        if (id !== chosen) {
          $('node').value = 'n:' + id;
          syncNodeSummary();
          if ($('node-swap')) $('node-swap').textContent = labelFor(chosen) + ' was not answering, so this wallet is on ' + labelFor(id) + ' instead.';
        }
      }, function () { return attempt(i + 1); });
    }
    return Promise.resolve().then(function () { return attempt(0); });
  }

  /* Whether an error smells like the node, as opposed to bad input. Only
     node-shaped failures are worth retrying somewhere else. */
  function isNodeError(err) {
    var m = String((err && err.message) || err || '');
    return /connect|connection|daemon|network|fetch|timeout|unreachable|node_|502|503|522|rpc/i.test(m);
  }

  /* Advance the picker to the next curated node not yet tried. Returns its id,
     or null when the list is exhausted (or a custom node is chosen, which is
     never abandoned silently). */
  function advanceNode(tried) {
    if (nodeIsCustom()) return null;
    var ids = kit.nodes().map(function (n) { return n.id; });
    for (var i = 0; i < ids.length; i++) {
      if (tried.indexOf(ids[i]) === -1) {
        $('node').value = 'n:' + ids[i];
        syncNodeSummary();
        return ids[i];
      }
    }
    return null;
  }

  /* Open a wallet with failover: the preflight can pass and the node still
     fail seconds later, so the open itself retries on the next curated node
     when the failure is node-shaped. buildConfig() is called fresh per
     attempt, so it picks up the advanced node. */
  function openWithFailover(buildConfig) {
    var tried = [];
    function attempt() {
      return xmr.createWalletFull(buildConfig()).catch(function (err) {
        if (nodeIsCustom() || !isNodeError(err)) throw err;
        var failed = $('node').value.slice(2);
        tried.push(failed);
        var next = advanceNode(tried);
        if (!next) throw err;
        if ($('node-swap')) $('node-swap').textContent = labelFor(failed) + ' failed while opening, so this wallet is on ' + labelFor(next) + ' instead.';
        setSetupStatus('Trying ' + labelFor(next) + '\u2026');
        return attempt();
      });
    }
    return attempt();
  }

  function networkTypeFor(name) {
    if (name === 'stagenet') return xmr.MoneroNetworkType.STAGENET;
    if (name === 'testnet') return xmr.MoneroNetworkType.TESTNET;
    return xmr.MoneroNetworkType.MAINNET;
  }

  // ----------------------------------------------------------- messaging

  function setSetupStatus(m) { $('setup-status').textContent = m; }
  function setSetupError(m) { $('setup-error').textContent = m; }
  function clearSetup() { setSetupError(''); setSetupStatus(''); }

  // --------------------------------------------------------- opening a wallet

  function withEngines(run) {
    clearSetup();
    setBusy(true);
    return loadEngines()
      .then(run)
      .catch(function (err) { setSetupError(kit ? kit.prettyError(err) : (err && err.message) || String(err)); })
      .then(function () { setBusy(false); });
  }

  function setBusy(on) {
    ['create', 'restore', 'restore-keys'].forEach(function (id) { if ($(id)) $(id).disabled = on; });
  }

  function baseConfig() {
    var server = chosenServer();
    if (!server) throw new Error('Choose a node first.');
    walletNetwork = chosenNetwork();
    return {
      networkType: networkTypeFor(walletNetwork),
      server: server,
      // Run the wallet in the worker so scanning never freezes the page.
      proxyToWorker: true,
      password: '',
    };
  }

  function createNew() {
    return withEngines(function () {
      setSetupStatus('Checking the node...');
      return ensureReachableNode().then(function () {
        setSetupStatus('Creating a new wallet...');
        return openWithFailover(baseConfig).then(afterOpen);
      });
    });
  }

  function restoreSeed() {
    return withEngines(function () {
      var seed = $('seed-in').value.trim().replace(/\s+/g, ' ');
      if (!seed) { setSetupError('Enter the seed phrase.'); return; }
      setSetupStatus('Checking the node...');
      return ensureReachableNode().then(function () {
      setSetupStatus('Restoring...');
      var height = kit.restoreHeightForDate($('restore-date').value);
      return openWithFailover(function () {
        var config = baseConfig();
        config.seed = seed;
        if (height !== null) config.restoreHeight = height;
        return config;
      }).then(afterOpen);
      });
    });
  }

  function restoreKeys() {
    return withEngines(function () {
      var address = $('keys-address').value.trim();
      var view = $('keys-view').value.trim();
      var spend = $('keys-spend').value.trim();
      if (!address || !view) { setSetupError('The address and the view key are both needed.'); return; }
      setSetupStatus('Checking the node...');
      return ensureReachableNode().then(function () {
      setSetupStatus('Opening...');
      var height = kit.restoreHeightForDate($('keys-date').value);
      return openWithFailover(function () {
        var config = baseConfig();
        config.primaryAddress = address;
        config.privateViewKey = view;
        if (spend) config.privateSpendKey = spend;
        if (height !== null) config.restoreHeight = height;
        return config;
      }).then(afterOpen);
      });
    });
  }

  // ------------------------------------------------------ the live wallet

  function afterOpen(w) {
    wallet = w;
    return Promise.resolve()
      .then(function () { return wallet.getPrivateSpendKey().catch(function () { return ''; }); })
      .then(function (spendKey) {
        // A watch-only wallet reports an all-zero spend key.
        watchOnly = !spendKey || /^0+$/.test(spendKey);
        $('watch-banner').classList.toggle('hidden', !watchOnly);
        $('send-section').classList.toggle('hidden', watchOnly);
        // A watch-only wallet cannot send, so its client does not offer the tab.
        if ($('wtab-send')) $('wtab-send').classList.toggle('hidden', watchOnly);
        $('setup').classList.add('hidden');
        $('wallet').classList.remove('hidden');
        return showPrimaryAddress();
      })
      .then(function () { return attachListener(); })
      .then(function () {
        // The wallet is open and usable for receiving from here. Syncing needs
        // the node, and a node that is slow or unreachable must not read as the
        // wallet having failed to open: degrade to a message on the sync line
        // and let startSyncing's own timer keep retrying.
        return startSync();
      })
      .catch(function (err) { setSetupError(kit.prettyError(err)); });
  }

  var syncTried = [];

  function startSync() {
    return Promise.resolve()
      .then(function () { return wallet.startSyncing(10000); })
      .then(function () { syncTried = []; return refreshEverything(); })
      .catch(function (err) { return syncFailover(err); });
  }

  /* An open wallet whose node stops answering is re-pointed at the next
     curated node — monero-ts can switch daemons on a live wallet — rather than
     told to go reopen itself. A custom node is never abandoned, and when every
     listed node has been tried the message says exactly that. */
  function syncFailover(err) {
    if (nodeIsCustom() || !isNodeError(err)) {
      $('sync-line').textContent = kit.prettyError(err);
      $('height-line').textContent = 'The wallet is open and can receive, but cannot see the chain until it reaches a node.';
      return;
    }
    var failed = $('node').value.slice(2);
    if (syncTried.indexOf(failed) === -1) syncTried.push(failed);
    var next = advanceNode(syncTried);
    if (!next) {
      $('sync-line').textContent = 'None of the listed nodes are answering right now. They will be retried automatically; you can also set your own under Node.';
      syncTried = [];
      return;
    }
    $('sync-line').textContent = labelFor(failed) + ' stopped answering; switching to ' + labelFor(next) + '\u2026';
    var built = kit.proxyUri({ mode: 'n', key: next }, window.location.origin);
    return Promise.resolve()
      .then(function () { return wallet.setDaemonConnection(built.uri); })
      .then(function () { return startSync(); })
      .catch(function (e2) { return syncFailover(e2); });
  }

  function attachListener() {
    var listener = new xmr.MoneroWalletListener();
    listener.onSyncProgress = function (height, startHeight, endHeight, percentDone) {
      var pct = Math.floor((percentDone || 0) * 100);
      $('sync-line').textContent = pct >= 100 ? 'Synced.' : 'Syncing the chain: ' + pct + '%';
      $('height-line').textContent = 'Scanned to block ' + height + ' of ' + endHeight + '.';
    };
    listener.onBalancesChanged = function () { refreshBalance(); refreshHistory(); };
    listener.onNewBlock = function () { /* height line is driven by sync progress */ };
    return wallet.addListener(listener);
  }

  function refreshEverything() {
    return Promise.all([refreshBalance(), refreshHistory()]).then(function () {});
  }

  function refreshBalance() {
    return Promise.all([wallet.getBalance(), wallet.getUnlockedBalance()]).then(function (b) {
      $('balance').textContent = kit.formatXmr(BigInt(b[0]));
      $('unlocked').textContent = kit.formatXmr(BigInt(b[1]));
    }).catch(function () {});
  }

  function showPrimaryAddress() {
    return wallet.getPrimaryAddress().then(function (addr) {
      $('primary-address').textContent = addr;
    });
  }

  function newSubaddress() {
    if (!wallet) return;
    $('new-subaddress').disabled = true;
    wallet.createSubaddress(0).then(function (sub) {
      subaddressCount++;
      var address = sub.getAddress();
      var row = document.createElement('p');
      row.innerHTML = '<code class="xmr">' + esc(address) + '</code>';
      $('subaddresses').appendChild(row);
      $('subaddress-note').textContent = subaddressCount + (subaddressCount === 1 ? ' subaddress made' : ' subaddresses made');
    }).catch(function (err) {
      $('subaddress-note').textContent = kit.prettyError(err);
    }).then(function () { $('new-subaddress').disabled = false; });
  }

  // -------------------------------------------------------------- history

  function refreshHistory() {
    if (!wallet) return Promise.resolve();
    return wallet.getTxs().then(function (txs) {
      if (!txs.length) { $('history-note').textContent = 'No transactions yet.'; $('history').innerHTML = ''; return; }
      $('history-note').textContent = txs.length + (txs.length === 1 ? ' transaction' : ' transactions') + ':';
      // Newest first.
      var rows = txs.slice().sort(function (a, b) { return (b.getHeight() || 1e12) - (a.getHeight() || 1e12); }).map(function (tx) {
        var incoming = tx.getIncomingTransfers && tx.getIncomingTransfers();
        var isIn = incoming && incoming.length;
        var amount = isIn
          ? incoming.reduce(function (sum, t) { return sum + BigInt(t.getAmount()); }, 0n)
          : (tx.getOutgoingTransfer && tx.getOutgoingTransfer() ? BigInt(tx.getOutgoingTransfer().getAmount()) : 0n);
        var confirms = tx.getNumConfirmations ? (tx.getNumConfirmations() || 0) : 0;
        var state = tx.isConfirmed && tx.isConfirmed()
          ? (confirms + (confirms === 1 ? ' confirmation' : ' confirmations'))
          : (tx.inTxPool && tx.inTxPool() ? 'in the mempool' : 'pending');
        return '<p class="note">' + (isIn ? 'received ' : 'sent ') +
          '<strong>' + esc(kit.formatXmr(amount)) + ' XMR</strong>, ' + esc(state) + '</p>';
      }).join('');
      $('history').innerHTML = rows;
    }).catch(function () {});
  }

  // ----------------------------------------------------------------- send

  var maxMode = false;

  function review() {
    if (!wallet || watchOnly) return;
    $('send-error').textContent = '';
    $('send-result').innerHTML = '';
    var address = $('send-address').value.trim();
    var amountText = $('send-amount').value.trim();

    $('review').disabled = true;
    Promise.all([wallet.getUnlockedBalance()]).then(function (b) {
      var unlocked = BigInt(b[0]);
      if (!maxMode) {
        var check = kit.checkSend(address, amountText, unlocked, walletNetwork);
        if (!check.ok) { $('send-error').textContent = check.problem; $('review').disabled = false; return; }
      } else if (!address) {
        $('send-error').textContent = 'Enter a destination address.'; $('review').disabled = false; return;
      }
      var build = maxMode
        ? wallet.sweepUnlocked({ address: address, accountIndex: 0, relay: false })
        : wallet.createTxs({ address: address, amount: kit.parseXmr(amountText).atomic, accountIndex: 0, relay: false });
      return Promise.resolve(build).then(function (result) {
        var txs = Array.isArray(result) ? result : [result];
        pendingTxs = txs;
        var fee = txs.reduce(function (s, t) { return s + BigInt(t.getFee()); }, 0n);
        var sent = txs.reduce(function (s, t) {
          var out = t.getOutgoingTransfer && t.getOutgoingTransfer();
          return s + (out ? BigInt(out.getAmount()) : 0n);
        }, 0n);
        $('confirm-detail').innerHTML =
          'Sending <strong>' + esc(kit.formatXmr(sent)) + ' XMR</strong> to<br><code class="xmr">' + esc(address) + '</code><br>' +
          'Network fee <strong>' + esc(kit.formatXmr(fee)) + ' XMR</strong>. Total leaving the wallet <strong>' +
          esc(kit.formatXmr(sent + fee)) + ' XMR</strong>.';
        $('confirm').classList.remove('hidden');
      });
    }).catch(function (err) {
      $('send-error').textContent = kit.prettyError(err);
    }).then(function () { $('review').disabled = false; });
  }

  function sendNow() {
    if (!pendingTxs) return;
    $('send-now').disabled = true;
    $('confirm-detail').innerHTML += '<br>Broadcasting...';
    var hashes = pendingTxs.map(function (t) { return t.getHash ? t.getHash() : null; });
    wallet.relayTxs(pendingTxs).then(function () {
      $('confirm').classList.add('hidden');
      $('send-result').innerHTML = '<p class="note">Sent. ' +
        (hashes[0] ? 'Transaction <code class="xmr">' + esc(hashes[0]) + '</code>.' : '') +
        ' It will show as pending until the network confirms it.</p>';
      $('send-address').value = '';
      $('send-amount').value = '';
      pendingTxs = null;
      maxMode = false;
      refreshEverything();
    }).catch(function (err) {
      $('send-error').textContent = kit.prettyError(err);
      $('confirm').classList.add('hidden');
    }).then(function () { $('send-now').disabled = false; });
  }

  function cancelSend() {
    pendingTxs = null;
    maxMode = false;
    $('confirm').classList.add('hidden');
  }

  // ---------------------------------------------------------- secrets, close

  function revealSeed() {
    if (!wallet) return;
    wallet.getSeed().then(function (seed) {
      $('seed-out').innerHTML =
        '<p class="note">Write these 25 words on paper, in order. This is the only copy.</p>' +
        '<p><code class="xmr">' + esc(seed) + '</code></p>';
    }).catch(function (err) {
      if (watchOnly) $('seed-out').innerHTML = '<p class="note">A watch-only wallet has no seed phrase.</p>';
      else $('seed-out').innerHTML = '<p class="note">' + esc(kit.prettyError(err)) + '</p>';
    });
  }

  function closeWallet() {
    var w = wallet;
    wallet = null;
    pendingTxs = null;
    if (w) { try { w.close(); } catch (e) { /* nothing left to do */ } }
    $('wallet').classList.add('hidden');
    $('setup').classList.remove('hidden');
    ['seed-out', 'subaddresses', 'history', 'send-result'].forEach(function (id) { $(id).innerHTML = ''; });
    $('balance').textContent = '0';
    $('unlocked').textContent = '0';
    subaddressCount = 0;
    clearSetup();
  }

  // ---------------------------------------------------------------- wiring

  function showMode(which) {
    ['create', 'restore', 'keys'].forEach(function (name) {
      $('mode-' + name).classList.toggle('hidden', name !== which);
      $('tab-' + name).classList.toggle('is-active', name === which);
    });
    clearSetup();
  }

  $('node').addEventListener('change', function () {
    $('custom-node-row').classList.toggle('hidden', !nodeIsCustom());
  });

  $('tab-create').addEventListener('click', function () { showMode('create'); });
  $('tab-restore').addEventListener('click', function () { showMode('restore'); });
  $('tab-keys').addEventListener('click', function () { showMode('keys'); });

  $('create').addEventListener('click', createNew);
  $('restore').addEventListener('click', restoreSeed);
  $('restore-keys').addEventListener('click', restoreKeys);

  $('new-subaddress').addEventListener('click', newSubaddress);
  $('send-max').addEventListener('click', function () {
    maxMode = true;
    $('send-amount').value = '';
    $('send-amount').placeholder = 'everything';
    review();
  });
  $('review').addEventListener('click', function () { maxMode = false; $('send-amount').placeholder = '0.00'; review(); });
  $('send-now').addEventListener('click', sendNow);
  $('send-cancel').addEventListener('click', cancelSend);
  $('reveal-seed').addEventListener('click', revealSeed);
  $('close-wallet').addEventListener('click', closeWallet);

  // The wallet is memory-only; make that literal by closing it on the way out
  // so its keys do not sit in a detached worker after the page is gone.
  window.addEventListener('pagehide', function () {
    if (wallet) { try { wallet.close(); } catch (e) { /* going away anyway */ } }
  });

  // The open wallet is a little client: Overview / Receive / Send / History /
  // Secrets are its tabs. Plain show-hide, same pattern as the setup modes.
  /* A tick beside the To field the moment an address is complete.
     checkSend still has the last word when the payment is built; this only
     moves the discovery of a mistyped address to where it is cheapest, which
     is before the amount has even been typed. The tick means the checksum
     passed, not that the address is the one you were given: clipboard
     malware substitutes addresses that checksum perfectly. */
  function markAddress(fieldId, markerId, check) {
    var field = $(fieldId);
    var marker = $(markerId);
    if (!field || !marker) return;
    var update = function () {
      var verdict = check(field.value);
      marker.className = 'addr-check' + (verdict.state === 'empty' ? '' : ' is-' + verdict.state);
      marker.textContent = verdict.state === 'empty' ? ''
        : (verdict.state === 'ok' ? '\u2713 ' : '\u26A0 ') + verdict.note;
    };
    field.addEventListener('input', update);
    field.addEventListener('change', update);
  }

  var WSECTIONS = ['overview', 'receive', 'send', 'history', 'secrets'];
  function showSection(which) {
    WSECTIONS.forEach(function (name) {
      var tab = $('wtab-' + name);
      var section = $('wsec-' + name);
      if (!tab || !section) return;
      section.classList.toggle('hidden', name !== which);
      tab.classList.toggle('is-active', name === which);
    });
  }
  WSECTIONS.forEach(function (name) {
    var tab = $('wtab-' + name);
    if (tab) tab.addEventListener('click', function () { showSection(name); });
  });

  // Populate the node list as soon as the helpers are available. The heavy
  // wallet library waits until a wallet is actually opened.
  loadScript('/walletkit.js').then(function () {
    kit = window.LOC1999_WALLET;
    fillNodes();
    markAddress('send-address', 'send-addr-check', function (value) {
      return kit.checkAddress(value, walletNetwork);
    });
  }).catch(function () {
    $('setup-error').textContent = 'The wallet helpers did not load. Reload the page.';
  });
})();

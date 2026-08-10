/* 1999.LOC swap-to-Monero page. Vanilla JS, no build step.
 *
 * Talks only to this origin's /api/swap/* (so connect-src 'self' is
 * untouched); the Worker relays to the exchange services. The page holds the
 * one thing that matters, the order id, in this tab's session storage so a
 * refresh does not lose a swap that is mid-flight; closing the tab forgets
 * it, which is the same promise the disposable inbox makes.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  if (!$('get-quotes')) return;

  // Ticker and address hint per coin id. The server owns the real coin table
  // (src/lib/swapkit.ts) and validates against it; this is only what the page
  // needs to label a field and place a placeholder.
  var COINS = {
    xmr:     { ticker: 'XMR',  name: 'Monero',           hint: '4... or 8..., a mainnet Monero address' },
    btc:     { ticker: 'BTC',  name: 'Bitcoin',          hint: 'bc1..., or a 1... or 3... address' },
    usdttrc: { ticker: 'USDT', name: 'USDT (Tron)',      hint: 'T..., a Tron address' },
    usdteth: { ticker: 'USDT', name: 'USDT (Ethereum)',  hint: '0x..., an Ethereum address' },
    eth:     { ticker: 'ETH',  name: 'Ethereum',         hint: '0x..., an Ethereum address' },
    usdc:    { ticker: 'USDC', name: 'USDC (Ethereum)',  hint: '0x..., an Ethereum address' },
    usdcsol: { ticker: 'USDC', name: 'USDC (Solana)',    hint: 'a Solana address' },
  };
  var PROVIDER_LABELS = {
    exolix: 'Exolix', godex: 'Godex', changenow: 'ChangeNOW', trocador: 'Trocador',
  };
  var PROVIDER_SITES = {
    exolix: 'https://exolix.com/transaction/',
    godex: 'https://godex.io/exchange/waiting/',
    changenow: 'https://changenow.io/exchange/txs/',
    trocador: 'https://trocador.app/en/checkout/',
  };

  var quotes = [];      // last quote list, in server order
  var chosen = null;    // provider id picked in the list
  var order = null;     // the live order, mirrored to sessionStorage
  var pollTimer = null;

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function api(path, opts) {
    return fetch('/api/swap/' + path, opts).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error((body && body.error) || 'Request failed.');
        return body;
      });
    });
  }

  /* Six decimals is plenty for XMR or BTC and far too many for USDT; trim
     the trailing zeros rather than printing "731.422302000000". */
  function trim(n) {
    return String(Number(n).toFixed(8)).replace(/\.?0+$/, '');
  }

  function fail(m) { $('swap-error').textContent = m; }
  function note(m) { $('swap-status').textContent = m; }
  function clearMessages() { fail(''); note(''); }

  // --------------------------------------------------------------- quotes

  function fromId() { return $('from-coin').value; }
  function toId() { return $('to-coin').value; }
  function coinOf(id) { return COINS[id] || { ticker: id.toUpperCase(), name: id, hint: 'an address' }; }

  /* Every swap has Monero on one side. Rather than police the two pickers
     with an error, the other one follows: choose Monero to send and the
     destination stops being Monero, and the same the other way round. */
  function syncPair(changed) {
    var from = fromId();
    var to = toId();
    if (from === to || (from !== 'xmr' && to !== 'xmr')) {
      if (changed === 'to') {
        $('from-coin').value = to === 'xmr' ? 'btc' : 'xmr';
      } else {
        $('to-coin').value = from === 'xmr' ? 'btc' : 'xmr';
      }
    }
    var target = coinOf(toId());
    var source = coinOf(fromId());
    $('amount-unit').textContent = source.ticker;
    $('dest-coin-name').textContent = target.name;
    $('xmr-address').placeholder = target.hint;
    $('refund').placeholder = source.hint + ' (the coin you are sending)';
    // A pair change invalidates whatever was quoted for the old one.
    quotes = [];
    chosen = null;
    $('recv-amount').textContent = 'take a quote';
    $('quotes-block').classList.add('hidden');
    clearMessages();
  }

  function amountTyped() {
    // Money parsing has one rule: never guess small. "1,5" is a European
    // decimal and becomes 1.5; "1,000" or "1,234.56" is grouped thousands,
    // and parseFloat would silently read those as 1 and 1.234. Any string
    // with more than one separator, or a comma alongside a dot, is refused
    // so the person retypes it rather than swaps a thousandth of it.
    var raw = String($('amount').value).trim();
    var commas = (raw.match(/,/g) || []).length;
    var dots = (raw.match(/\./g) || []).length;
    if (commas + dots > 1) return null;
    var cleaned = raw.replace(',', '.');
    if (!/^\d*\.?\d*$/.test(cleaned)) return null;
    var n = parseFloat(cleaned);
    return isFinite(n) && n > 0 ? n : null;
  }

  function getQuotes() {
    clearMessages();
    var amt = amountTyped();
    if (amt === null) { fail('Enter the amount you are sending, as a number.'); return; }
    note('Asking for quotes...');
    $('quotes-block').classList.add('hidden');
    api('quote?from=' + encodeURIComponent(fromId()) + '&to=' + encodeURIComponent(toId()) +
        '&amount=' + encodeURIComponent(amt))
      .then(function (data) {
        quotes = data.quotes || [];
        note('');
        renderQuotes(amt);
      })
      .catch(function (err) { note(''); fail(err.message); });
  }

  function renderQuotes(amt) {
    var live = quotes.filter(function (q) { return q.ok; });
    var best = null;
    live.forEach(function (q) { if (!best || q.toAmount > best.toAmount) best = q; });
    chosen = best ? best.provider : null;

    // The board: quotes as the amber dealing table the face was drawn for,
    // one desk per row, the amount right-aligned where a terminal puts it.
    // The radio rides in the first cell, so picking a desk is clicking its row.
    var rows = '';
    quotes.forEach(function (q) {
      var label = PROVIDER_LABELS[q.provider] || q.provider;
      if (q.ok) {
        rows += '<tr><td><label><input type="radio" name="quote" value="' + esc(q.provider) + '"' +
          (q.provider === chosen ? ' checked' : '') + '> ' + esc(label) +
          (q === best && live.length > 1 ? ' <span class="note">(best)</span>' : '') +
          '</label></td><td class="n">' + esc(trim(q.toAmount)) + ' ' + esc(coinOf(toId()).ticker) +
          '</td></tr>';
      } else {
        var why = q.reason || 'no quote';
        if (q.minAmount) why += ' (minimum ' + trim(q.minAmount) + ' ' + coinOf(fromId()).ticker + ')';
        rows += '<tr><td>' + esc(label) + '</td><td class="n">' + esc(why) + '</td></tr>';
      }
    });
    var html = '<table><tr><th scope="col">Desk</th><th scope="col">You receive</th></tr>' + rows + '</table>';
    if (!live.length) {
      html += '<p class="note">No provider quoted this. Check the amount against the minimums above and try again.</p>';
    }
    $('quotes').innerHTML = html;
    $('start-swap').disabled = !live.length;
    $('quotes-block').classList.remove('hidden');
    showEstimate();
  }

  /* Put the picked desk's number back in the Receive box, so the two halves of
   * the ticket read as one trade rather than a form and a table that happen to
   * be about the same thing. */
  function showEstimate() {
    var picked = quotes.filter(function (q) { return q.ok && q.provider === chosen; })[0];
    $('recv-amount').textContent = picked
      ? trim(picked.toAmount) + ' ' + coinOf(toId()).ticker
      : 'no quote';
  }

  $('quotes').addEventListener('change', function (event) {
    if (event.target && event.target.name === 'quote') {
      chosen = event.target.value;
      showEstimate();
    }
  });

  /* Paste, because the thing every visitor does here is paste an address they
   * copied from a wallet, and on a phone the long-press menu is a nuisance. */
  $('paste-dest').addEventListener('click', function () {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      note('This browser will not hand a page the clipboard; paste with the keyboard.');
      return;
    }
    navigator.clipboard.readText().then(function (text) {
      $('xmr-address').value = String(text || '').trim();
      $('xmr-address').focus();
    }, function () {
      note('The browser refused the clipboard; paste with the keyboard.');
    });
  });

  $('from-coin').addEventListener('change', function () { syncPair('from'); });
  $('to-coin').addEventListener('change', function () { syncPair('to'); });
  $('flip').addEventListener('click', function () {
    var from = fromId();
    $('from-coin').value = toId();
    $('to-coin').value = from;
    syncPair('from');
  });

  $('get-quotes').addEventListener('click', getQuotes);
  $('amount').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') getQuotes();
  });

  // ---------------------------------------------------------------- order

  /* Every swap started in this tab, newest first.
   *
   * A list rather than the single order this used to hold, because a swap runs
   * for twenty minutes and people start a second one while the first is still
   * settling, and because the deposit address of the one you started ten
   * minutes ago is not something to lose by clicking Get quotes again.
   *
   * Still sessionStorage, deliberately. localStorage would survive the tab and
   * make this far more forgiving, and it would also leave a list of every coin
   * you have ever swapped sitting on the disk of the machine, which is not a
   * trade this page gets to make on somebody's behalf. Closing the tab forgets,
   * which is the promise the page already prints, and it is why it also says to
   * keep the order id somewhere of your own.
   */
  var STORE_KEY = 'loc1999-swap-orders';
  var OLD_KEY = 'loc1999-swap-order';
  var swaps = [];

  function remember() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(swaps)); } catch (e) { /* private browsing */ }
  }
  function recall() {
    var list = [];
    try { list = JSON.parse(sessionStorage.getItem(STORE_KEY)) || []; } catch (e) { list = []; }
    if (!list.length) {
      // A swap started before this page kept a list is still a live swap.
      try {
        var one = JSON.parse(sessionStorage.getItem(OLD_KEY));
        if (one && one.o) list = [one];
        sessionStorage.removeItem(OLD_KEY);
      } catch (e) { /* ignore */ }
    }
    return list.filter(function (s) { return s && s.o && s.o.id; });
  }

  function entryFor(o) {
    for (var i = 0; i < swaps.length; i++) {
      if (swaps[i].o.id === o.id && swaps[i].o.provider === o.provider) return swaps[i];
    }
    return null;
  }

  /* Local time, hours and minutes. No date: this list cannot outlive the tab,
     so the day is always today, and a date is one more thing to leak. */
  function clockOf(ms) {
    var d = new Date(ms);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  var STAGE_WORDS = {
    waiting: 'Waiting', confirming: 'Confirming', exchanging: 'Exchanging',
    sending: 'Sending', done: 'Done', refunded: 'Refunded',
    expired: 'Expired', failed: 'Failed',
  };
  /* Three states worth telling apart at a glance: still going, finished well,
     finished badly. */
  function stageClass(stage) {
    if (stage === 'done') return 'is-done';
    if (stage === 'refunded' || stage === 'expired' || stage === 'failed') return 'is-bad';
    return 'is-live';
  }

  function renderSwapList() {
    if (!swaps.length) { $('swaps-block').classList.add('hidden'); return; }
    var open = order && order.o;
    var rows = swaps.map(function (s, i) {
      var stage = s.stage || 'waiting';
      var here = open && s.o.id === open.id && s.o.provider === open.provider;
      return '<button type="button" class="tick-swap' + (here ? ' is-open' : '') + '" data-swap="' + i + '">' +
        '<span class="tick-stage ' + stageClass(stage) + '">' + esc(STAGE_WORDS[stage] || stage) + '</span>' +
        '<span class="tick-swap-pair">' + esc(coinOf(s.from).ticker) + ' &#8594; ' + esc(coinOf(s.to).ticker) + '</span>' +
        '<span class="tick-swap-amt">' + esc(trim(s.o.payinAmount)) + ' ' + esc(coinOf(s.from).ticker) + '</span>' +
        '<span class="tick-swap-meta">' + esc(PROVIDER_LABELS[s.o.provider] || s.o.provider) +
        ' &middot; ' + esc(clockOf(s.at)) + '</span>' +
        '</button>';
    }).join('');
    $('swap-list').innerHTML = rows;
    $('swaps-block').classList.remove('hidden');
  }

  $('swap-list').addEventListener('click', function (event) {
    var row = event.target.closest ? event.target.closest('[data-swap]') : null;
    if (!row) return;
    var picked = swaps[Number(row.getAttribute('data-swap'))];
    if (!picked) return;
    order = picked;
    renderOrder();
    checkStatus();
    $('order-block').scrollIntoView({ block: 'nearest' });
  });

  function startSwap() {
    clearMessages();
    var amt = amountTyped();
    var address = String($('xmr-address').value).trim();
    if (amt === null) { fail('Enter the amount first.'); return; }
    if (!address) { fail('Enter the ' + coinOf(toId()).name + ' address the swap should pay.'); return; }
    if (!chosen) { fail('Pick a quote first.'); return; }
    var button = $('start-swap');
    button.disabled = true;
    note('Creating the swap at ' + (PROVIDER_LABELS[chosen] || chosen) + '...');
    api('create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: chosen,
        from: fromId(),
        to: toId(),
        amount: amt,
        address: address,
        refund: String($('refund').value).trim(),
      }),
    })
      .then(function (data) {
        note('');
        order = { o: data, from: fromId(), to: toId(), at: Date.now(), stage: 'waiting' };
        swaps.unshift(order);
        remember();
        renderOrder();
        renderSwapList();
        checkStatus();
      })
      .catch(function (err) { note(''); fail(err.message); })
      .then(function () { button.disabled = false; });
  }

  /* The deposit address, in groups of four.
   *
   * A swap address is sixty to ninety-five characters of base58 and the only
   * thing standing between the money and somebody else's wallet, and the one
   * check anybody actually performs is reading the first few and last few
   * against what their wallet shows. An unbroken run of characters makes that
   * hard and makes losing your place easy; in fours, with every other group
   * dimmed, the eye keeps its position and a transposed pair stops hiding. */
  function groupAddress(el, address) {
    el.textContent = '';
    var text = String(address || '');
    for (var i = 0; i < text.length; i += 4) {
      var span = document.createElement('span');
      span.className = (i / 4) % 2 ? 'tick-g tick-g-alt' : 'tick-g';
      span.textContent = text.slice(i, i + 4);
      el.appendChild(span);
    }
  }

  /* The code the phone scans. qrkit is this site's own encoder and is fetched
   * only when there is an address to draw, because most visits never create an
   * order. A failure here costs the picture and nothing else: the address is
   * already on the page in text, which is what the payment actually needs. */
  var qrkit = null;
  function drawQr(address) {
    var box = $('pay-qr');
    if (!box) return;
    function paint() {
      try {
        box.innerHTML = qrkit.qrSvg(qrkit.encodeQr(address, 'M'), { scale: 5, margin: 2 });
      } catch (e) { box.textContent = ''; }
    }
    if (qrkit) return paint();
    if (window.LOC1999_QR) { qrkit = window.LOC1999_QR; return paint(); }
    var s = document.createElement('script');
    s.src = '/qrkit.js';
    s.onload = function () { qrkit = window.LOC1999_QR; if (qrkit) paint(); };
    s.onerror = function () { box.textContent = ''; };
    document.head.appendChild(s);
  }

  function renderOrder() {
    if (!order) return;
    var o = order.o;
    var sent = coinOf(order.from).ticker;
    var got = coinOf(order.to).ticker;
    $('quotes-block').classList.add('hidden');
    $('pay-line').innerHTML = 'Send exactly <strong>' + esc(o.payinAmount) + ' ' + esc(sent) + '</strong>';
    groupAddress($('pay-address'), o.payinAddress);
    drawQr(o.payinAddress);
    /* The details, as a list of facts rather than a paragraph: the id is the
     * only handle on the swap, and a paragraph is where an id goes to hide. */
    var track = (PROVIDER_SITES[o.provider] || '') + o.id;
    $('order-meta').innerHTML =
      '<span class="tick-fact"><span class="tick-fact-k">Order</span>' +
      '<code class="tick-fact-v">' + esc(o.id) + '</code></span>' +
      '<span class="tick-fact"><span class="tick-fact-k">Started</span>' +
      '<span class="tick-fact-v">' + esc(clockOf(order.at || Date.now())) + '</span></span>' +
      '<span class="tick-fact"><span class="tick-fact-k">Pair</span>' +
      '<span class="tick-fact-v">' + esc(sent) + ' &#8594; ' + esc(got) + '</span></span>' +
      '<span class="tick-fact"><span class="tick-fact-k">Desk</span>' +
      '<span class="tick-fact-v">' + esc(PROVIDER_LABELS[o.provider] || o.provider) + '</span></span>' +
      '<span class="tick-fact"><span class="tick-fact-k">You get</span>' +
      '<span class="tick-fact-v">about ' + esc(trim(o.toAmount)) + ' ' + esc(got) +
      ' to <code>' + esc(shorten(o.payoutAddress)) + '</code></span></span>' +
      '<span class="tick-fact"><span class="tick-fact-k">Track</span>' +
      '<span class="tick-fact-v"><a href="' + esc(track) + '" rel="noreferrer">' + esc(track) + '</a></span></span>';
    setStage(order.stage || 'waiting');
    $('order-block').classList.remove('hidden');
    startPolling();
  }

  function shorten(addr) {
    var a = String(addr || '');
    return a.length > 20 ? a.slice(0, 10) + '...' + a.slice(-6) : a;
  }

  function setStage(stage) {
    var pill = $('order-stage');
    pill.textContent = STAGE_WORDS[stage] || stage;
    pill.className = 'tick-stage ' + stageClass(stage);
  }

  function checkStatus() {
    if (!order) return;
    var o = order.o;
    var asked = order;
    api('status?provider=' + encodeURIComponent(o.provider) + '&id=' + encodeURIComponent(o.id))
      .then(function (s) {
        var line = s.line || s.stage;
        /* Record it against the swap that was asked about, not against
         * whatever is on screen now: the answer can land after somebody has
         * clicked a different row in the list. */
        var entry = entryFor(asked.o) || asked;
        entry.stage = s.stage;
        entry.line = line;
        remember();
        renderSwapList();
        if (order === asked || (order && order.o.id === asked.o.id)) {
          $('order-status').textContent = line + (s.txId ? ' Transaction: ' + s.txId : '');
          setStage(s.stage);
        }
        if (s.stage === 'done' || s.stage === 'refunded' || s.stage === 'expired' || s.stage === 'failed') {
          stopPolling();
        }
      })
      .catch(function (err) { $('order-status').textContent = 'Could not check: ' + err.message; });
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(checkStatus, 30000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  $('start-swap').addEventListener('click', startSwap);
  $('check-status').addEventListener('click', checkStatus);

  /* "I have sent it" is the same call as Check now. It exists because after
   * paying, the question in somebody's head is "did that work", and answering
   * it with a button that says what they just did beats one that says Check. */
  $('sent-it').addEventListener('click', function () {
    $('order-status').textContent = 'Looking for your deposit...';
    checkStatus();
  });

  /* Start another one. The swap you were looking at is not cancelled and not
     forgotten: it goes on running at the exchange, and it stays in the list so
     you can come back to its address. This only clears the screen. */
  $('new-swap').addEventListener('click', function () {
    stopPolling();
    order = null;
    $('order-block').classList.add('hidden');
    $('order-status').textContent = '';
    // The old code is a picture of a dead address; it does not outlive the view.
    $('pay-qr').textContent = '';
    $('pay-address').textContent = '';
    renderSwapList();
    clearMessages();
  });

  // ----------------------------------------------------------------- copy

  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'offscreen';
    document.body.appendChild(area);
    area.select();
    var copied = false;
    try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
    document.body.removeChild(area);
    return copied;
  }

  function selectPayAddress() {
    try {
      var range = document.createRange();
      range.selectNodeContents($('pay-address'));
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (e) { return false; }
  }

  $('copy-pay').addEventListener('click', function () {
    if (!order) return;
    var text = order.o.payinAddress;
    var button = $('copy-pay');
    var done = function () {
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy address'; }, 1500);
    };
    var fallen = function () {
      if (fallbackCopy(text)) return done();
      $('copy-note').textContent = selectPayAddress()
        ? 'copying is blocked here; the address is selected, copy it by hand'
        : 'copying is blocked here; select the address and copy it by hand';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallen);
    } else {
      fallen();
    }
  });

  $('pay-address').addEventListener('click', function () { if (order) selectPayAddress(); });

  // ---------------------------------------------------------------- boot

  syncPair('from');

  // A refresh mid-swap lands here: the swaps come back, the newest one opens,
  // and polling resumes on it.
  swaps = recall();
  if (swaps.length) {
    renderSwapList();
    order = swaps[0];
    renderOrder();
    checkStatus();
  }
})();

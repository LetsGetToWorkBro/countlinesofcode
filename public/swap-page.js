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

  var COIN_LABELS = { btc: 'BTC', usdc: 'USDC', usdcsol: 'USDC' };
  var PROVIDER_LABELS = { exolix: 'Exolix', changenow: 'ChangeNOW' };
  var PROVIDER_SITES = {
    exolix: 'https://exolix.com/transaction/',
    changenow: 'https://changenow.io/exchange/txs/',
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

  function fail(m) { $('swap-error').textContent = m; }
  function note(m) { $('swap-status').textContent = m; }
  function clearMessages() { fail(''); note(''); }

  // --------------------------------------------------------------- quotes

  function coin() { return $('from-coin').value; }

  function amountTyped() {
    var n = parseFloat(String($('amount').value).replace(',', '.'));
    return isFinite(n) && n > 0 ? n : null;
  }

  function getQuotes() {
    clearMessages();
    var amt = amountTyped();
    if (amt === null) { fail('Enter the amount you are sending, as a number.'); return; }
    note('Asking for quotes...');
    $('quotes-block').classList.add('hidden');
    api('quote?from=' + encodeURIComponent(coin()) + '&amount=' + encodeURIComponent(amt))
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

    var html = '';
    quotes.forEach(function (q) {
      var label = PROVIDER_LABELS[q.provider] || q.provider;
      if (q.ok) {
        html += '<p><label><input type="radio" name="quote" value="' + esc(q.provider) + '"' +
          (q.provider === chosen ? ' checked' : '') + '> ' +
          '<strong>' + esc(label) + '</strong>: about ' + esc(q.toAmount.toFixed(6)) + ' XMR' +
          (q === best && live.length > 1 ? ' <span class="note">(best)</span>' : '') +
          '</label></p>';
      } else {
        var why = q.reason || 'no quote';
        if (q.minAmount) why += ' (minimum ' + q.minAmount + ' ' + (COIN_LABELS[coin()] || '') + ')';
        html += '<p class="note">' + esc(label) + ': ' + esc(why) + '</p>';
      }
    });
    if (!live.length) {
      html += '<p class="note">No provider quoted this. Check the amount against the minimums above and try again.</p>';
    }
    $('quotes').innerHTML = html;
    $('start-swap').disabled = !live.length;
    $('quotes-block').classList.remove('hidden');
  }

  $('quotes').addEventListener('change', function (event) {
    if (event.target && event.target.name === 'quote') chosen = event.target.value;
  });

  $('get-quotes').addEventListener('click', getQuotes);
  $('amount').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') getQuotes();
  });

  // ---------------------------------------------------------------- order

  var STORE_KEY = 'loc1999-swap-order';
  function remember() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(order)); } catch (e) { /* private browsing */ } }
  function forget() { try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ } }
  function recall() {
    try { return JSON.parse(sessionStorage.getItem(STORE_KEY)); } catch (e) { return null; }
  }

  function startSwap() {
    clearMessages();
    var amt = amountTyped();
    var address = String($('xmr-address').value).trim();
    if (amt === null) { fail('Enter the amount first.'); return; }
    if (!address) { fail('Enter the Monero address the swap should pay.'); return; }
    if (!chosen) { fail('Pick a quote first.'); return; }
    var button = $('start-swap');
    button.disabled = true;
    note('Creating the swap at ' + (PROVIDER_LABELS[chosen] || chosen) + '...');
    api('create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: chosen,
        from: coin(),
        amount: amt,
        address: address,
        refund: String($('refund').value).trim(),
      }),
    })
      .then(function (data) {
        note('');
        order = { o: data, coin: coin() };
        remember();
        renderOrder();
        checkStatus();
      })
      .catch(function (err) { note(''); fail(err.message); })
      .then(function () { button.disabled = false; });
  }

  function renderOrder() {
    if (!order) return;
    var o = order.o;
    var coinLabel = COIN_LABELS[order.coin] || order.coin;
    $('quotes-block').classList.add('hidden');
    $('pay-line').innerHTML = 'Send exactly <strong>' + esc(o.payinAmount) + ' ' + esc(coinLabel) +
      '</strong> to this address, in one payment:';
    $('pay-address').textContent = o.payinAddress;
    $('order-meta').innerHTML =
      'Order <code>' + esc(o.id) + '</code> at ' + esc(PROVIDER_LABELS[o.provider] || o.provider) +
      ' &middot; about ' + esc(o.toAmount) + ' XMR to <code>' + esc(shorten(o.payoutAddress)) + '</code>' +
      ' &middot; <a href="' + esc((PROVIDER_SITES[o.provider] || '#') + o.id) + '" rel="noreferrer">view it on their site</a>.' +
      ' Keep the order id; it is the only handle on this swap.';
    $('order-block').classList.remove('hidden');
    startPolling();
  }

  function shorten(addr) {
    var a = String(addr || '');
    return a.length > 20 ? a.slice(0, 10) + '...' + a.slice(-6) : a;
  }

  function checkStatus() {
    if (!order) return;
    var o = order.o;
    api('status?provider=' + encodeURIComponent(o.provider) + '&id=' + encodeURIComponent(o.id))
      .then(function (s) {
        var line = s.line || s.stage;
        $('order-status').textContent = line + (s.txId ? ' Transaction: ' + s.txId : '');
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

  $('new-swap').addEventListener('click', function () {
    stopPolling();
    order = null;
    forget();
    $('order-block').classList.add('hidden');
    $('order-status').textContent = '';
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

  // A refresh mid-swap lands here: the order comes back and polling resumes.
  var kept = recall();
  if (kept && kept.o && kept.o.id) {
    order = kept;
    renderOrder();
    checkStatus();
  }
})();

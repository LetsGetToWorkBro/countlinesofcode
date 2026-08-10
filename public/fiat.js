/* 1999.LOC fiat estimates. Vanilla JS, no build step.
 *
 * Prints "about USD 72" beside an amount, for the pages that already talk to
 * the network: the swap desk and the two wallets that sync. It is deliberately
 * absent from the address checker and the paper wallet, which make no requests
 * at all and are the ones people run with the wifi off.
 *
 * What leaves the browser: a GET to /api/price on this origin, which returns
 * the same table of five numbers to everybody and is cached at the edge. No
 * address, no balance, no amount is ever sent; the multiplication happens
 * here. An upstream price service cannot see a visitor, an amount, or even a
 * visitor count, because it hears from the Worker once a minute regardless.
 *
 * Anybody who would still rather the page made one fewer request can turn it
 * off, and the choice sticks. Off means the fetch never happens at all.
 */
(function () {
  'use strict';

  var KEY = 'loc1999:fiat';
  var table = null;      // the last table fetched, this page load
  var inflight = null;   // one request per page load, shared by every caller
  var listeners = [];

  function on() {
    try { return localStorage.getItem(KEY) !== 'off'; } catch (e) { return true; }
  }
  function setOn(want) {
    try { localStorage.setItem(KEY, want ? 'on' : 'off'); } catch (e) { /* private mode */ }
    if (!want) { table = null; inflight = null; }
    announce();
  }

  function announce() {
    listeners.forEach(function (fn) {
      try { fn(on() ? table : null); } catch (e) { /* a bad listener is not our problem */ }
    });
  }

  /* Resolves with the table, or with null when it is switched off or nothing
     answered. It never rejects: a missing price is a missing line on a page,
     never an error somebody has to read. */
  function load() {
    if (!on()) return Promise.resolve(null);
    if (table) return Promise.resolve(table);
    if (inflight) return inflight;
    inflight = fetch('/api/price')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        table = body && body.usd ? body : null;
        announce();
        return table;
      })
      .catch(function () { return null; })
      .then(function (value) { inflight = null; return value; });
    return inflight;
  }

  function priceOf(ticker) {
    if (!table || !table.usd) return null;
    var p = table.usd[String(ticker || '').toLowerCase()];
    return typeof p === 'number' && isFinite(p) && p > 0 ? p : null;
  }

  /* The dollar value of an amount, or null when it cannot be said. Null and
     not zero: a dash is honest about not knowing, "USD 0.00" is not. */
  function usd(amount, ticker) {
    var n = typeof amount === 'string' ? Number(amount) : amount;
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return null;
    var price = priceOf(ticker);
    return price === null ? null : n * price;
  }

  function format(amount, ticker) {
    var value = usd(amount, ticker);
    if (value === null) return null;
    return value > 0 && value < 1 ? 'USD ' + value.toFixed(4) : 'USD ' + value.toFixed(2);
  }

  /* Write the estimate into an element, or empty it when there is none. The
     one call a page needs for "put the dollars here". */
  function paint(el, amount, ticker, prefix) {
    if (!el) return;
    var text = format(amount, ticker);
    el.textContent = text ? (prefix === undefined ? 'about ' : prefix) + text : '';
  }

  /* Wire a checkbox to the setting, if the page has one. */
  function mountToggle(box, onChange) {
    if (!box) return;
    box.checked = on();
    box.addEventListener('change', function () {
      setOn(box.checked);
      if (box.checked) load().then(function () { if (onChange) onChange(); });
      else if (onChange) onChange();
    });
  }

  /* The balances on the wallet page, both tabs. Kept here rather than in each
     tab's own file so the two say the same thing in the same words, and so a
     page that grows a third coin only has to add the element. */
  var BALANCES = [
    { amount: 'balance', into: 'xmr-usd', ticker: 'xmr' },
    { amount: 'btc-balance', into: 'btc-usd', ticker: 'btc' },
  ];
  function paintBalances() {
    BALANCES.forEach(function (b) {
      var into = document.getElementById(b.into);
      var from = document.getElementById(b.amount);
      if (!into || !from) return;
      paint(into, Number(String(from.textContent).replace(/,/g, '')), b.ticker, 'about ');
    });
  }

  /* Pages that only want the standard behaviour get it for nothing: every
     checkbox marked .fiat-toggle drives the setting and they stay in step,
     which is what a tabbed page needs, and the balances repaint themselves. */
  function autowire() {
    var boxes = [].slice.call(document.querySelectorAll('input.fiat-toggle'));
    boxes.forEach(function (box) {
      mountToggle(box, function () {
        boxes.forEach(function (other) { other.checked = on(); });
        paintBalances();
      });
    });
    if (document.getElementById('xmr-usd') || document.getElementById('btc-usd')) {
      listeners.push(paintBalances);
      load().then(paintBalances);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autowire);
  } else {
    autowire();
  }

  /* Where the last table came from, for the line that gives the number a
     source. Null when there is no table to credit. */
  function sourceInfo() {
    return table ? { source: table.source, at: table.at } : null;
  }

  /* Call me when the table arrives or the setting changes. */
  function onChange(fn) {
    listeners.push(fn);
  }

  /* Plain references, no inline bodies: the bundle guard reads this object
     literal to check that every member a page calls actually exists, and it
     stops at the first closing brace, so a function written out here would
     hide everything below it. */
  window.LOC1999_FIAT = {
    enabled: on,
    setEnabled: setOn,
    load: load,
    usd: usd,
    format: format,
    paint: paint,
    paintBalances: paintBalances,
    mountToggle: mountToggle,
    source: sourceInfo,
    onChange: onChange,
  };
})();

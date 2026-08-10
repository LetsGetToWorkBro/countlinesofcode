/* 1999.LOC temporary inbox. Vanilla JS, no build step.
 *
 * Talks only to this origin's /api/mail/* (so connect-src 'self' is untouched).
 * The server hands out a random address, stores mail sent to it for an hour,
 * and returns each message reduced to plain text plus the email checker's
 * verdict on it. Nothing here renders a message as live HTML: bodies are shown
 * as escaped text, so opening one cannot load a tracker or run a script.
 *
 * Addresses work like a wallet's: you can hold several at once. "New address"
 * adds one and keeps the old ones, every held address reads into the one inbox,
 * and each message is tagged with which address it arrived at. The server is
 * stateless about this: every address is independent, so holding many is just
 * the client polling each and merging, with no back end to change.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var MAX_ADDRESSES = 8;

  var addresses = [];     // every address this tab holds, oldest first
  var active = null;      // the one shown at the top and copied by default
  var pollTimer = null;
  var expandedIds = {};   // id -> true while a message is open
  var readIds = {};       // id -> true once a message has ever been opened
  var msgCache = {};      // id -> the fetched message, so re-renders are free
  var msgInbox = {};      // id -> which held address received it
  var firstLoad = true;

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function api(path, opts) {
    return fetch('/api/mail/' + path, opts).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error((body && body.error) || 'Request failed.');
        return body;
      });
    });
  }

  function fail(m) { $('mail-error').textContent = m; }
  function clearError() { $('mail-error').textContent = ''; }
  function setNote(m) { var n = $('address-note'); if (n) n.textContent = m || ''; }

  // ------------------------------------------------------------- addresses

  // The addresses survive a refresh: a visitor pastes one into a signup, and an
  // accidental reload must not strand the verification code at an address they
  // can no longer read. sessionStorage has exactly the right lifetime: it rides
  // out refreshes and navigation within the tab, and dies when the tab closes,
  // which is the ephemerality the page promises.
  var STORE_KEY = 'loc1999-mail-addresses';
  var LEGACY_KEY = 'loc1999-mail-address';

  function persist() {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ addresses: addresses, active: active })); }
    catch (e) { /* private browsing */ }
  }
  function recall() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.addresses && o.addresses.length) {
          var list = o.addresses.filter(function (a) { return typeof a === 'string' && a.indexOf('@') > 0; });
          if (list.length) return { addresses: list.slice(0, MAX_ADDRESSES), active: o.active };
        }
      }
      // One address kept under the old single-value key: carry it forward.
      var legacy = sessionStorage.getItem(LEGACY_KEY);
      if (legacy && legacy.indexOf('@') > 0) return { addresses: [legacy], active: legacy };
    } catch (e) { /* private browsing or bad JSON */ }
    return null;
  }

  /** Short label for an address: the random part before the @, which is what
   *  tells two held addresses apart in a tagged message row. */
  function alias(addr) { return String(addr || '').split('@')[0]; }

  function newAddress(opts) {
    var initial = opts && opts.initial;
    clearError();
    if (addresses.length >= MAX_ADDRESSES) {
      setNote('You are holding the most this will (' + MAX_ADDRESSES + '). Delete one before adding another.');
      return Promise.resolve();
    }
    if (initial) { $('address').textContent = 'setting up...'; }
    return api('new').then(function (data) {
      addresses.push(data.address);
      active = data.address;
      persist();
      renderAddresses();
      $('inbox-status').textContent = 'Waiting for mail...';
      if (!initial) {
        // A user asked for this one, so it is almost certainly what they are
        // about to paste: copy it, and reassure them the others still work.
        copyText(active);
        var kept = addresses.length - 1;
        setNote(kept
          ? 'New address ready and copied. Your other ' + kept + ' still receive.'
          : 'New address ready and copied.');
      }
      ensurePolling();
      poll();
    }).catch(function (err) {
      if (initial) $('address').textContent = 'unavailable';
      fail(readableSetupError(err));
    });
  }

  /** Resume the tab's held addresses if it has any, else mint the first. */
  function beginInbox() {
    var saved = recall();
    if (saved && saved.addresses.length) {
      addresses = saved.addresses;
      active = (saved.active && addresses.indexOf(saved.active) >= 0)
        ? saved.active
        : addresses[addresses.length - 1];
      persist();
      renderAddresses();
      $('inbox-status').textContent = 'Waiting for mail...';
      ensurePolling();
      poll();
      return;
    }
    newAddress({ initial: true });
  }

  function readableSetupError(err) {
    var m = (err && err.message) || String(err);
    if (/not configured/i.test(m)) {
      return 'The temporary inbox is not switched on for this site yet. It needs its mail routing configured before it can receive anything.';
    }
    return m;
  }

  // ------------------------------------------------------- address display

  function renderAddresses() {
    $('address').textContent = active || 'open this tab to get one';

    var list = $('ol-addr-list');
    if (list) {
      list.innerHTML = addresses.map(function (a) {
        var current = a === active;
        return '<li class="ol-addr-item' + (current ? ' is-active' : '') + '" data-addr="' + esc(a) + '">' +
          '<span class="ol-addr-text" role="button" tabindex="0" aria-label="Use and copy ' + esc(a) + '">' + esc(a) + '</span>' +
          '<button type="button" class="ol-clip ol-addr-copy" data-addr="' + esc(a) + '" aria-label="Copy ' + esc(a) + '" title="Copy">' +
          '<svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true"><rect x="1" y="1" width="9" height="11" fill="#fff" stroke="#4a4a4a" stroke-width="1.1"/><rect x="4.5" y="3.5" width="9" height="11" fill="#fff" stroke="#4a4a4a" stroke-width="1.1"/></svg>' +
          '</button></li>';
      }).join('');
    }

    var burnAll = $('burn-all');
    if (burnAll) burnAll.classList.toggle('hidden', addresses.length < 2);
    var lead = document.querySelector('.ol-addr-lead');
    if (lead) lead.classList.toggle('hidden', addresses.length < 2);
  }

  function setActive(addr) {
    if (addresses.indexOf(addr) < 0) return;
    active = addr;
    persist();
    renderAddresses();
    copyText(addr);
    selectAddress();
    setNote('Copied. This is the address shown above now.');
  }

  // ------------------------------------------------------------- polling

  function ensurePolling() {
    if (!pollTimer) pollTimer = setInterval(poll, 4000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // Poll every held address at once and merge, so the inbox is the union of
  // them all. An address that fails this round contributes nothing rather than
  // wiping what the others returned; only if every one fails on the very first
  // load is that surfaced, because that is the "not configured" case.
  function poll() {
    if (!addresses.length) return;
    var held = addresses.slice();
    Promise.all(held.map(function (a) {
      return api('inbox?address=' + encodeURIComponent(a))
        .then(function (data) { return { addr: a, messages: data.messages || [] }; })
        .catch(function (err) { return { addr: a, messages: null, err: err }; });
    })).then(function (results) {
      var merged = [];
      var firstErr = null;
      var failures = 0;
      results.forEach(function (r) {
        if (r.messages === null) { failures++; if (!firstErr) firstErr = r.err; return; }
        r.messages.forEach(function (m) { m.inbox = r.addr; merged.push(m); });
      });
      if (failures === held.length) {
        if (firstLoad) fail(readableSetupError(firstErr));
        else $('inbox-status').textContent = 'Could not check just now; it will try again in a few seconds.';
        return;
      }
      merged.sort(function (x, y) { return y.receivedAt - x.receivedAt; });
      msgInbox = {};
      merged.forEach(function (m) { msgInbox[m.id] = m.inbox; });
      renderInbox(merged);
    });
  }

  // The inbox is a little mail client: every message is a row that opens and
  // closes in place, so several can be open at once and none of them needs a
  // separate screen. Bodies are fetched on first open and cached; the 4-second
  // poll re-renders the list from state, so open messages stay open.
  function renderInbox(messages) {
    firstLoad = false;
    if (!messages.length) {
      $('inbox-status').textContent = 'Waiting for mail. Anything sent to the address' +
        (addresses.length > 1 ? 'es' : '') + ' above shows up here within a few seconds.';
      $('inbox').innerHTML = '';
      return;
    }
    var many = addresses.length > 1;
    $('inbox-status').textContent = messages.length + (messages.length === 1 ? ' message' : ' messages') +
      (many ? ' across ' + addresses.length + ' addresses' : '') + '. Auto-refreshing.';
    $('inbox').innerHTML = messages.map(function (m) {
      var open = !!expandedIds[m.id];
      var unread = !readIds[m.id];
      var toTag = many ? '<span class="mail-to" title="arrived at ' + esc(m.inbox) + '">to ' + esc(alias(m.inbox)) + '</span>' : '';
      return '<div class="mail-msg' + (open ? ' open' : '') + (unread ? ' unread' : '') + '" data-id="' + esc(m.id) + '">' +
        '<div class="mail-head" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<span class="mail-toggle">' + (open ? '[−]' : '[+]') + '</span>' +
          '<span class="mail-from">' + esc(shortSender(m.sender)) + '</span>' +
          '<span class="mail-when">' + esc(ago(m.receivedAt)) + '</span>' +
          '<span class="mail-subj">' + esc(m.subject || '(no subject)') + '</span>' +
          '<span class="mail-badges">' + toTag + verdictBadge(m.verdict, m.trackerCount) + '</span>' +
        '</div>' +
        '<div class="mail-open-area' + (open ? '' : ' hidden') + '"></div>' +
      '</div>';
    }).join('');
    messages.forEach(function (m) { if (expandedIds[m.id]) fillBody(m.id); });
  }

  function bodySlot(id) {
    var msg = $('inbox').querySelector('.mail-msg[data-id="' + id + '"]');
    return msg ? msg.querySelector('.mail-open-area') : null;
  }

  function fillBody(id) {
    var slot = bodySlot(id);
    if (!slot) return;
    if (msgCache[id]) { slot.innerHTML = messageHtml(msgCache[id]); return; }
    slot.innerHTML = '<p class="note">Opening…</p>';
    var addr = msgInbox[id] || active;
    api('message?address=' + encodeURIComponent(addr) + '&id=' + encodeURIComponent(id)).then(function (m) {
      msgCache[id] = m;
      var s = bodySlot(id);
      if (s) s.innerHTML = messageHtml(m);
    }).catch(function (err) {
      var s = bodySlot(id);
      if (s) s.innerHTML = '<p class="error">' + esc((err && err.message) || 'Could not open that message.') + '</p>';
    });
  }

  function toggleMessage(id) {
    var open = !expandedIds[id];
    if (open) { expandedIds[id] = true; readIds[id] = true; }
    else delete expandedIds[id];
    var msg = $('inbox').querySelector('.mail-msg[data-id="' + id + '"]');
    if (!msg) return;
    msg.classList.toggle('open', open);
    msg.classList.remove('unread');
    var head = msg.querySelector('.mail-head');
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    msg.querySelector('.mail-toggle').textContent = open ? '[−]' : '[+]';
    msg.querySelector('.mail-open-area').classList.toggle('hidden', !open);
    if (open) fillBody(id);
  }

  function verdictBadge(verdict, trackerCount) {
    var parts = [];
    if (verdict) {
      var bad = /fail|forg|spoof|mismatch|caution|suspicious/i.test(verdict);
      parts.push('<span class="' + (bad ? 'pw-terrible' : 'pw-strong') + '">' + esc(shortVerdict(verdict)) + '</span>');
    }
    if (trackerCount > 0) parts.push('<span class="pw-weak">' + trackerCount + ' tracker' + (trackerCount === 1 ? '' : 's') + '</span>');
    return parts.join(' ') || '<span class="note">ok</span>';
  }

  function shortVerdict(v) {
    return String(v).length > 28 ? String(v).slice(0, 27) + '…' : v;
  }
  function shortSender(s) {
    s = String(s || 'unknown');
    return s.length > 40 ? s.slice(0, 39) + '…' : s;
  }

  // ----------------------------------------------------- one open message

  function messageHtml(m) {
    var a = m.analysis || {};
    var html = '<table>' +
      '<tr><th scope="row">From</th><td><code>' + esc(m.sender || 'unknown') + '</code></td></tr>' +
      (a.sender && a.sender.replyTo ? '<tr><th scope="row">Replies go to</th><td><code>' + esc(a.sender.replyTo) + '</code></td></tr>' : '') +
      '<tr><th scope="row">Subject</th><td>' + esc(m.subject || '(no subject)') + '</td></tr>' +
      '<tr><th scope="row">Received</th><td>' + esc(ago(m.receivedAt)) + ', deletes ' + esc(deletesIn(m.expiresAt)) + '</td></tr>' +
      '</table>';

    if (a.verdict) {
      var bad = /fail|forg|spoof|mismatch|caution|suspicious/i.test(a.verdict);
      html += '<p class="' + (bad ? 'error' : 'note') + '"><strong>Sender check:</strong> ' + esc(a.verdict) + '</p>';
    }
    if (a.trackers && a.trackers.length) {
      html += '<p class="note"><strong>' + a.trackers.length + ' tracker' + (a.trackers.length === 1 ? '' : 's') +
        ' found</strong> (not loaded): ' +
        a.trackers.slice(0, 6).map(function (t) { return esc(t.host); }).join(', ') + '</p>';
    }

    html += '<p class="note">The message, as text (images, links and trackers are shown but never loaded):</p>' +
      '<pre class="mail-body">' + esc(m.bodyText || '(no readable text in this message)') + '</pre>';
    return html;
  }

  // ------------------------------------------------------------- time

  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'just now';
    if (s < 90) return 'a minute ago';
    if (s < 3600) return Math.round(s / 60) + ' minutes ago';
    return Math.round(s / 3600) + ' hour' + (s < 7200 ? '' : 's') + ' ago';
  }
  function deletesIn(ms) {
    var s = Math.max(0, Math.round((ms - Date.now()) / 1000));
    if (s < 90) return 'in under a minute';
    if (s < 3600) return 'in ' + Math.round(s / 60) + ' minutes';
    return 'in about an hour';
  }

  // ------------------------------------------------------------- copying

  // Copy with a real fallback chain, because the async clipboard API is the
  // least reliable part of the modern web on a phone: try it, then the
  // textarea + execCommand trick, and only if both fail select the address so
  // a long-press copy is one step.
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

  function selectAddress() {
    try {
      var range = document.createRange();
      range.selectNodeContents($('address'));
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (e) { return false; }
  }

  /** Copy a string, trying every path, and land feedback in the note line. */
  function copyText(text, done) {
    if (!text) return;
    var ok = function () { if (done) done(); };
    var fell = function () {
      if (fallbackCopy(text)) return ok();
      setNote(selectAddress()
        ? 'copying is blocked here; the address is selected, copy it by hand'
        : 'copying is blocked here; select the address and copy it by hand');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, fell);
    } else {
      fell();
    }
  }

  // ------------------------------------------------------------- wiring

  $('copy').addEventListener('click', function () {
    if (!active) return;
    var button = $('copy');
    var label = button.querySelector('span') || button;
    var was = label.textContent;
    copyText(active, function () {
      label.textContent = 'Copied';
      setTimeout(function () { label.textContent = was; }, 1500);
    });
  });

  var addrCopy = $('address-copy');
  if (addrCopy) addrCopy.addEventListener('click', function () { if (active) { copyText(active); selectAddress(); setNote('Copied.'); } });

  // Tapping the headline address copies it and selects it, so the long-press
  // path on a phone is one gesture and the tap did something on a desktop.
  $('address').addEventListener('click', function () {
    if (!active) return;
    copyText(active);
    selectAddress();
    setNote('Copied.');
  });
  $('address').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (active) { copyText(active); selectAddress(); setNote('Copied.'); }
  });

  // The address list: click a row (or its copy button) to make that address the
  // active one and copy it.
  var addrList = $('ol-addr-list');
  if (addrList) {
    addrList.addEventListener('click', function (event) {
      var t = event.target;
      var copyBtn = t.closest ? t.closest('.ol-addr-copy') : null;
      if (copyBtn) { copyText(copyBtn.getAttribute('data-addr')); setNote('Copied.'); return; }
      var item = t.closest ? t.closest('.ol-addr-item') : null;
      if (item) setActive(item.getAttribute('data-addr'));
    });
    addrList.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var text = event.target.closest ? event.target.closest('.ol-addr-text') : null;
      if (!text) return;
      event.preventDefault();
      var item = text.closest('.ol-addr-item');
      if (item) setActive(item.getAttribute('data-addr'));
    });
  }

  $('new').addEventListener('click', function () { newAddress(); });

  // The poll runs itself every few seconds, but a button that checks right now
  // is the difference between trusting the page and watching it.
  $('refresh').addEventListener('click', function () {
    if (!addresses.length) return;
    clearError();
    $('inbox-status').textContent = 'Checking...';
    poll();
  });

  $('burn').addEventListener('click', function () {
    if (!active) return;
    var gone = active;
    api('burn?address=' + encodeURIComponent(gone), { method: 'POST' }).catch(function () {});
    addresses = addresses.filter(function (a) { return a !== gone; });
    // Forget the state that belonged only to the burned address.
    Object.keys(msgInbox).forEach(function (id) {
      if (msgInbox[id] === gone) { delete msgCache[id]; delete expandedIds[id]; delete readIds[id]; }
    });
    if (!addresses.length) { active = null; $('inbox').innerHTML = ''; newAddress({ initial: true }); return; }
    active = addresses[addresses.length - 1];
    persist();
    renderAddresses();
    setNote('Deleted. ' + addresses.length + ' address' + (addresses.length === 1 ? '' : 'es') + ' left.');
    poll();
  });

  var burnAll = $('burn-all');
  if (burnAll) burnAll.addEventListener('click', function () {
    if (addresses.length < 2) return;
    addresses.forEach(function (a) { api('burn?address=' + encodeURIComponent(a), { method: 'POST' }).catch(function () {}); });
    addresses = [];
    active = null;
    expandedIds = {}; readIds = {}; msgCache = {}; msgInbox = {};
    $('inbox').innerHTML = '';
    newAddress({ initial: true });
  });

  // One listener for the whole inbox: rows are re-rendered every poll, and a
  // listener per row would be re-attached forty times a minute.
  $('inbox').addEventListener('click', function (event) {
    var head = event.target.closest ? event.target.closest('.mail-head') : null;
    if (!head || !$('inbox').contains(head)) return;
    toggleMessage(head.parentNode.getAttribute('data-id'));
  });
  $('inbox').addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var head = event.target.closest ? event.target.closest('.mail-head') : null;
    if (!head) return;
    event.preventDefault();
    toggleMessage(head.parentNode.getAttribute('data-id'));
  });

  window.addEventListener('pagehide', stopPolling);

  // On the merged /email.html this inbox lives beside the message checker. Most
  // visitors come for the checker, so if there is a tab driver do not mint an
  // address or poll until the inbox is opened. With the folder-rail navigation
  // (no data-tabs) the inbox is the default view, so it begins at load.
  var started = false;
  function activate() {
    if (!started) { started = true; beginInbox(); return; }
    if (addresses.length && !pollTimer) ensurePolling();   // resume where we left off
  }
  var tabs = document.querySelector('[data-tabs]');
  if (tabs) {
    tabs.addEventListener('tab:shown', function (e) { if (e.detail && e.detail.tab === 'inbox') activate(); });
    tabs.addEventListener('tab:hidden', function (e) { if (e.detail && e.detail.tab === 'inbox') stopPolling(); });
    var panel = tabs.querySelector('[data-panel="inbox"]');
    if (panel && !panel.classList.contains('hidden')) activate();
  } else {
    beginInbox();   // folder-rail page: the inbox is the default view
  }
})();

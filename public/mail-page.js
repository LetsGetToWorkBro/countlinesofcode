/* 1999.LOC temporary inbox. Vanilla JS, no build step.
 *
 * Talks only to this origin's /api/mail/* (so connect-src 'self' is untouched).
 * The server hands out a random address, stores mail sent to it for an hour,
 * and returns each message reduced to plain text plus the email checker's
 * verdict on it. Nothing here renders a message as live HTML: bodies are shown
 * as escaped text, so opening one cannot load a tracker or run a script.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var address = null;
  var pollTimer = null;
  var expandedIds = {}; // id -> true while a message is open
  var readIds = {};     // id -> true once a message has ever been opened
  var msgCache = {};    // id -> the fetched message, so re-renders are free
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

  // ------------------------------------------------------------- addresses

  // The address survives a refresh: a visitor pastes it into a signup, and an
  // accidental reload must not strand the verification code at an address they
  // can no longer read. sessionStorage has exactly the right lifetime — it
  // rides out refreshes and navigation within the tab, and dies when the tab
  // closes, which is the ephemerality the page promises. Only "New address",
  // "burn" or closing the tab hands out a different one.
  var STORE_KEY = 'loc1999-mail-address';
  function remember(value) { try { sessionStorage.setItem(STORE_KEY, value); } catch (e) { /* private browsing */ } }
  function recall() { try { return sessionStorage.getItem(STORE_KEY) || null; } catch (e) { return null; } }

  function newAddress() {
    clearError();
    stopPolling();
    $('address').textContent = 'setting up...';
    $('inbox').innerHTML = '';
    expandedIds = {};
    readIds = {};
    msgCache = {};
    firstLoad = true;
    return api('new').then(function (data) {
      address = data.address;
      remember(address);
      $('address').textContent = address;
      $('inbox-status').textContent = 'Waiting for mail...';
      startPolling();
    }).catch(function (err) {
      $('address').textContent = 'unavailable';
      fail(readableSetupError(err));
    });
  }

  /** Resume the tab's existing address if it has one, else mint. */
  function beginInbox() {
    var saved = recall();
    if (saved && saved.indexOf('@') > 0) {
      address = saved;
      $('address').textContent = saved;
      $('inbox-status').textContent = 'Waiting for mail...';
      startPolling();
      return;
    }
    newAddress();
  }

  function readableSetupError(err) {
    var m = (err && err.message) || String(err);
    if (/not configured/i.test(m)) {
      return 'The temporary inbox is not switched on for this site yet. It needs its mail routing configured before it can receive anything.';
    }
    return m;
  }

  // ------------------------------------------------------------- polling

  function startPolling() {
    poll();
    pollTimer = setInterval(poll, 4000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function poll() {
    if (!address) return;
    api('inbox?address=' + encodeURIComponent(address)).then(function (data) {
      renderInbox(data.messages || []);
    }).catch(function (err) {
      // A transient poll error should not wipe the inbox; just note it quietly.
      if (firstLoad) fail(readableSetupError(err));
      else $('inbox-status').textContent = 'Could not check just now; it will try again in a few seconds.';
    });
  }

  // The inbox is a little mail client: every message is a row that opens and
  // closes in place, so several can be open at once and none of them needs a
  // separate screen. Bodies are fetched on first open and cached; the 4-second
  // poll re-renders the list from state, so open messages stay open.
  function renderInbox(messages) {
    firstLoad = false;
    if (!messages.length) {
      $('inbox-status').textContent = 'Waiting for mail. Anything sent to the address above shows up here within a few seconds.';
      $('inbox').innerHTML = '';
      return;
    }
    $('inbox-status').textContent = messages.length + (messages.length === 1 ? ' message' : ' messages') + '. Auto-refreshing.';
    $('inbox').innerHTML = messages.map(function (m) {
      var open = !!expandedIds[m.id];
      var unread = !readIds[m.id];
      return '<div class="mail-msg' + (open ? ' open' : '') + (unread ? ' unread' : '') + '" data-id="' + esc(m.id) + '">' +
        '<div class="mail-head" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">' +
          '<span class="mail-toggle">' + (open ? '[\u2212]' : '[+]') + '</span>' +
          '<span class="mail-from">' + esc(shortSender(m.sender)) + '</span>' +
          '<span class="mail-when">' + esc(ago(m.receivedAt)) + '</span>' +
          '<span class="mail-subj">' + esc(m.subject || '(no subject)') + '</span>' +
          '<span class="mail-badges">' + verdictBadge(m.verdict, m.trackerCount) + '</span>' +
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
    slot.innerHTML = '<p class="note">Opening\u2026</p>';
    api('message?address=' + encodeURIComponent(address) + '&id=' + encodeURIComponent(id)).then(function (m) {
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
    msg.querySelector('.mail-toggle').textContent = open ? '[\u2212]' : '[+]';
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
    return String(v).length > 28 ? String(v).slice(0, 27) + '\u2026' : v;
  }
  function shortSender(s) {
    s = String(s || 'unknown');
    return s.length > 40 ? s.slice(0, 39) + '\u2026' : s;
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

  // ------------------------------------------------------------- wiring

  // Copy with a real fallback chain, because the async clipboard API is the
  // least reliable part of the modern web on a phone: try it, then the
  // textarea + execCommand trick, and only if both fail select the address so
  // a long-press copy is one step. Feedback lands on the button itself, which
  // is where the visitor is already looking.
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

  $('copy').addEventListener('click', function () {
    if (!address) return;
    var button = $('copy');
    var done = function () {
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy'; }, 1500);
    };
    var fallen = function () {
      if (fallbackCopy(address)) return done();
      $('address-note').textContent = selectAddress()
        ? 'copying is blocked here; the address is selected, copy it by hand'
        : 'copying is blocked here; select the address and copy it by hand';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(address).then(done, fallen);
    } else {
      fallen();
    }
  });

  // Tapping the address selects it whole, so the long-press-copy path on a
  // phone is one gesture instead of a fiddly drag across fourteen characters.
  $('address').addEventListener('click', function () { if (address) selectAddress(); });

  $('new').addEventListener('click', newAddress);

  // The poll runs itself every few seconds, but a button that checks right now
  // is the difference between trusting the page and watching it.
  $('refresh').addEventListener('click', function () {
    if (!address) return;
    clearError();
    $('inbox-status').textContent = 'Checking...';
    poll();
  });

  $('burn').addEventListener('click', function () {
    if (!address) return;
    var gone = address;
    api('burn?address=' + encodeURIComponent(gone), { method: 'POST' }).catch(function () {});
    newAddress();
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

  // On the merged /email.html this inbox lives in a tab beside the message
  // checker. Most visitors come for the checker, so don't mint an address or
  // poll the server until someone actually opens the inbox. tabs.js fires
  // 'tab:shown'/'tab:hidden' as the panel appears and disappears.
  var started = false;
  function activate() {
    if (!started) { started = true; beginInbox(); return; }
    if (address && !pollTimer) startPolling();   // resume where we left off
  }
  var tabs = document.querySelector('[data-tabs]');
  if (tabs) {
    tabs.addEventListener('tab:shown', function (e) { if (e.detail && e.detail.tab === 'inbox') activate(); });
    tabs.addEventListener('tab:hidden', function (e) { if (e.detail && e.detail.tab === 'inbox') stopPolling(); });
    // Belt and suspenders: if the panel is already visible by the time this
    // runs (script order changed), start it without waiting for the event.
    var panel = tabs.querySelector('[data-panel="inbox"]');
    if (panel && !panel.classList.contains('hidden')) activate();
  } else {
    beginInbox();   // standalone page with no tabs: behave as before
  }
})();

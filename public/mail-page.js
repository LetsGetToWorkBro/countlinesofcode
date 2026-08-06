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
  var seen = {};        // id -> true, to mark arrivals
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
    $('message-view').classList.add('hidden');
    seen = {};
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
    });
  }

  function renderInbox(messages) {
    firstLoad = false;
    if (!messages.length) {
      $('inbox-status').textContent = 'Waiting for mail. Anything sent to the address above shows up here within a few seconds.';
      $('inbox').innerHTML = '';
      return;
    }
    $('inbox-status').textContent = messages.length + (messages.length === 1 ? ' message' : ' messages') + '. Auto-refreshing.';
    var rows = messages.map(function (m) {
      var fresh = !seen[m.id];
      seen[m.id] = true;
      var badge = verdictBadge(m.verdict, m.trackerCount);
      return '<tr class="mail-row" data-id="' + esc(m.id) + '">' +
        '<td>' + (fresh ? '<strong>new</strong> ' : '') + esc(shortSender(m.sender)) + '</td>' +
        '<td>' + esc(m.subject || '(no subject)') + '</td>' +
        '<td class="note">' + esc(ago(m.receivedAt)) + '</td>' +
        '<td>' + badge + '</td></tr>';
    }).join('');
    $('inbox').innerHTML =
      '<table class="mail-table"><thead><tr><th>From</th><th>Subject</th><th>When</th><th>Checks</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
    Array.prototype.forEach.call($('inbox').querySelectorAll('.mail-row'), function (row) {
      row.addEventListener('click', function () { openMessage(row.getAttribute('data-id')); });
    });
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

  // ------------------------------------------------------------- one message

  function openMessage(id) {
    clearError();
    api('message?address=' + encodeURIComponent(address) + '&id=' + encodeURIComponent(id)).then(function (m) {
      renderMessage(m);
      $('message-view').classList.remove('hidden');
      $('message-view').scrollIntoView({ block: 'start' });
    }).catch(function (err) { fail((err && err.message) || 'Could not open that message.'); });
  }

  function renderMessage(m) {
    var a = m.analysis || {};
    var html = '<table>' +
      '<tr><th scope="row">From</th><td><code>' + esc(m.sender || 'unknown') + '</code></td></tr>' +
      (a.sender && a.sender.replyTo ? '<tr><th scope="row">Replies go to</th><td><code>' + esc(a.sender.replyTo) + '</code></td></tr>' : '') +
      '<tr><th scope="row">Subject</th><td>' + esc(m.subject || '(no subject)') + '</td></tr>' +
      '<tr><th scope="row">Received</th><td>' + esc(ago(m.receivedAt)) + ', deletes ' + esc(deletesIn(m.expiresAt)) + '</td></tr>' +
      '</table>';

    // The checker's verdict on this message, inline.
    if (a.verdict) {
      var bad = /fail|forg|spoof|mismatch|caution|suspicious/i.test(a.verdict);
      html += '<p class="' + (bad ? 'error' : 'note') + '"><strong>Sender check:</strong> ' + esc(a.verdict) + '</p>';
    }
    if (a.trackers && a.trackers.length) {
      html += '<p class="note"><strong>' + a.trackers.length + ' tracker' + (a.trackers.length === 1 ? '' : 's') +
        ' found</strong> (not loaded): ' +
        a.trackers.slice(0, 6).map(function (t) { return esc(t.host); }).join(', ') + '</p>';
    }

    // The body, as plain text. Escaped and shown in a pre so nothing executes
    // and no remote content is ever fetched.
    html += '<p class="note">The message, as text (images, links and trackers are shown but never loaded):</p>' +
      '<pre class="mail-body">' + esc(m.bodyText || '(no readable text in this message)') + '</pre>';

    $('message').innerHTML = html;
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

  $('copy').addEventListener('click', function () {
    if (!address) return;
    var done = function () { $('address-note').textContent = 'copied'; setTimeout(function () { $('address-note').textContent = ''; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(address).then(done, function () { $('address-note').textContent = 'press Ctrl+C to copy'; });
    } else {
      $('address-note').textContent = 'select the address and press Ctrl+C';
    }
  });

  $('new').addEventListener('click', newAddress);

  $('burn').addEventListener('click', function () {
    if (!address) return;
    var gone = address;
    api('burn?address=' + encodeURIComponent(gone), { method: 'POST' }).catch(function () {});
    newAddress();
  });

  $('back').addEventListener('click', function () {
    $('message-view').classList.add('hidden');
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

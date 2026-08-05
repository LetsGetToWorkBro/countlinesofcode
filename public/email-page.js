/* 1999.LOC email checker. Vanilla JS, no build step.
 *
 * Loads /email.js on first use: header parsing, the authentication verdicts and
 * the tracker finder, built from src/client/email.ts.
 *
 * One rule runs through the whole file: nothing in the message is ever loaded.
 * Tracker URLs are printed as text and never as an href a click could follow,
 * because fetching one is exactly the event the sender is waiting for.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var mail = null;

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fail(m) { $('error').textContent = m; $('status').textContent = ''; }
  function clearError() { $('error').textContent = ''; }

  function ready() {
    if (mail) return Promise.resolve();
    $('status').textContent = 'Loading…';
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = '/email.js';
      el.onload = function () {
        mail = window.LOC1999_EMAIL;
        mail ? resolve() : reject(new Error('the engine did not load'));
      };
      el.onerror = function () { reject(new Error('could not load the engine')); };
      document.head.appendChild(el);
    }).then(function () { $('status').textContent = ''; });
  }

  /* A long URL, shortened for display but never turned into a link. The full
     text stays in the title so it can be read without being followed. */
  function urlText(url) {
    var shown = url.length > 90 ? url.slice(0, 87) + '…' : url;
    return '<code class="xmr" title="' + esc(url) + '">' + esc(shown) + '</code>';
  }

  function sectionSender(message) {
    var checks = mail.authChecks(message);
    var sender = mail.senderCheck(message);
    var verdict = mail.authVerdict(checks, sender);
    var bad = checks.some(function (c) { return c.result === 'fail'; });

    var html = '<h3>Who sent it</h3>' +
      '<p class="' + (bad ? 'error' : 'note') + '"><strong>' + esc(verdict) + '</strong></p>';

    html += '<table>' +
      '<tr><th scope="row">Shown as</th><td>' + (sender.displayName ? esc(sender.displayName) : '<span class="note">no display name</span>') + '</td></tr>' +
      '<tr><th scope="row">Actually from</th><td><code>' + esc(sender.from || 'not stated') + '</code></td></tr>' +
      (sender.replyTo ? '<tr><th scope="row">Replies go to</th><td><code>' + esc(sender.replyTo) + '</code></td></tr>' : '') +
      (sender.returnPath ? '<tr><th scope="row">Bounces go to</th><td><code>' + esc(sender.returnPath) + '</code></td></tr>' : '') +
      '</table>';

    if (checks.length) {
      html += '<table><thead><tr><th>Check</th><th>Result</th><th>Domain</th></tr></thead><tbody>' +
        checks.map(function (c) {
          return '<tr><th scope="row">' + esc(c.method.toUpperCase()) + '</th>' +
            '<td><strong>' + esc(c.result) + '</strong><br><span class="note">' + esc(c.meaning) + '</span></td>' +
            '<td><code>' + esc(c.domain || '') + '</code></td></tr>';
        }).join('') + '</tbody></table>';
    }

    if (sender.concerns.length) {
      html += '<div class="notice-box"><p><strong>Worth a second look.</strong></p><ul class="plain">' +
        sender.concerns.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') +
        '</ul></div>';
    } else if (checks.length) {
      html += '<p class="note">Nothing about the sender contradicts itself: the name, the address, the replies and the bounces all line up.</p>';
    }

    return html;
  }

  function sectionTrackers(message) {
    var trackers = mail.findTrackers(message.body || '');
    var hosts = mail.trackerHosts(trackers);

    var html = '<hr><h3>Who is watching you read it</h3>' +
      '<p class="' + (trackers.length ? 'note' : 'status') + '"><strong>' +
        esc(mail.trackerVerdict(trackers)) + '</strong></p>';

    if (!message.body) {
      html += '<p class="note">There is no message body here, only headers, so there was nothing to look through. Paste the whole message or drop the <code>.eml</code> file to check this half.</p>';
      return html;
    }

    if (trackers.length) {
      html += '<p class="note">None of these has been loaded, and none of them is a link. Loading one is the thing that tells the sender you opened the message.</p>';
      html += '<div class="key-list">' + trackers.map(function (t) {
        return '<div class="key-row">' +
          '<span class="key-kind">' + esc(t.kind) + '</span>' +
          '<span class="key-name">' + urlText(t.url) +
            (t.destination ? '<br><span class="note">Really goes to: ' + esc(t.destination) + '</span>' : '') +
            (t.label ? '<br><span class="note">Link text: “' + esc(t.label) + '”</span>' : '') +
            '<br><span class="note">' + esc(t.why) + '</span></span>' +
          '</div>';
      }).join('') + '</div>';

      html += '<p class="note"><strong>Hosts this message would contact:</strong> ' +
        hosts.map(function (h) { return '<code>' + esc(h) + '</code>'; }).join(', ') + '</p>';
    }

    return html;
  }

  function sectionPath(message) {
    var path = mail.hops(message);
    if (!path.length) return '';
    return '<hr><h3>The path it took</h3>' +
      '<p class="note">Oldest first. Everything below the first server you actually trust can be invented by the sender, so read this from the bottom up.</p>' +
      '<table><thead><tr><th>From</th><th>To</th><th>When</th></tr></thead><tbody>' +
      path.map(function (h) {
        return '<tr><td><code>' + esc(h.from || '?') + '</code></td>' +
          '<td><code>' + esc(h.by || '?') + '</code></td>' +
          '<td class="note">' + esc(h.when || '') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function run(text) {
    clearError();
    if (!String(text || '').trim()) { fail('Paste a message, or open one above.'); return; }

    ready().then(function () {
      var message = mail.parseMessage(text);
      if (!message.headers.length) {
        fail('There are no headers in that. Copy the whole message source, not the text you can read in your mail client.');
        $('results').innerHTML = '';
        return;
      }
      var subject = mail.header(message, 'Subject');
      $('results').innerHTML =
        '<hr>' +
        (subject ? '<h3>' + esc(subject) + '</h3>' : '') +
        sectionSender(message) +
        sectionTrackers(message) +
        sectionPath(message);
    }).catch(function (err) { fail(err.message); });
  }

  // ---------------------------------------------------------------- wiring

  var zone = $('drop');
  var input = $('file-input');
  zone.addEventListener('click', function () { input.click(); });
  zone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('is-over'); });
  zone.addEventListener('dragleave', function () { zone.classList.remove('is-over'); });
  zone.addEventListener('drop', function (e) {
    e.preventDefault();
    zone.classList.remove('is-over');
    openFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });
  input.addEventListener('change', function () { openFile(input.files[0]); input.value = ''; });

  function openFile(file) {
    if (!file) return;
    clearError();
    file.text().then(function (text) {
      $('source').value = text;
      run(text);
    }).catch(function (err) { fail(err.message); });
  }

  $('check').addEventListener('click', function () { run($('source').value); });

  $('sample').addEventListener('click', function () {
    // A message with every trick in it at once, so the page can be judged
    // without anyone having to find a real phish to feed it.
    var sample = [
      'Return-Path: <bounce@sendy-mailer.example>',
      'Received: from unknown (HELO localhost) (198.51.100.44)',
      '\tby mx.recipient.example with SMTP; Tue, 4 Aug 2026 03:11:09 +0000',
      'Authentication-Results: mx.recipient.example;',
      '\tspf=fail smtp.mailfrom=sendy-mailer.example;',
      '\tdkim=none; dmarc=fail header.from=paypal.com',
      'From: "PayPal Service <service@paypal.com>" <no-reply@sendy-mailer.example>',
      'Reply-To: account-recovery@secure-verify.example',
      'To: you@recipient.example',
      'Subject: Your account has been limited',
      'Content-Type: text/html',
      '',
      '<html><body>',
      '<p>We noticed unusual activity. Confirm your details to restore access.</p>',
      '<a href="https://sendy-mailer.example/c?url=https%3A%2F%2Fpaypa1-secure.example%2Flogin">Restore my account</a>',
      '<img src="https://open.sendy-mailer.example/o?rid=8f2b91cc44de71a0" width="1" height="1">',
      '<img src="https://cdn.list-manage.com/banner.png" width="600" height="120">',
      '</body></html>',
    ].join('\n');
    $('source').value = sample;
    run(sample);
  });
})();

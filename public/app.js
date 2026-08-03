/* LOC.1999 front-end. Vanilla JS, no build step, no dependencies.
 * Progress arrives over Server-Sent Events; if the browser lacks EventSource
 * we fall back to a plain POST and just show a spinner-free "working" line.
 */
(function () {
  'use strict';

  var form = document.getElementById('count-form');
  var repoInput = document.getElementById('repo-input');
  var refInput = document.getElementById('ref-input');
  var optLockfiles = document.getElementById('opt-lockfiles');
  var optVendored = document.getElementById('opt-vendored');
  var optFresh = document.getElementById('opt-fresh');
  var submitButton = document.getElementById('submit-button');
  var cancelWrap = document.getElementById('cancel-wrap');
  var cancelButton = document.getElementById('cancel-button');
  var statusEl = document.getElementById('status');
  var errorEl = document.getElementById('error');
  var resultsEl = document.getElementById('results');
  var authBlock = document.getElementById('auth-block');
  var quickpick = document.getElementById('quickpick');
  var standingsEl = document.getElementById('standings');
  var challengeInput = document.getElementById('challenge-input');

  var source = null;
  var browserAbort = null;

  /* Above this much countable text we ask before downloading, instead of just
   * doing it. Measured: ~12 MB of text takes about 10s in a browser, which is
   * fine when it is visible and interruptible. Beyond ~25 MB the download and
   * the wait stop being something to spend on someone's behalf. */
  var AUTO_BROWSER_MAX_BYTES = 25 * 1024 * 1024;

  // ---------------------------------------------------------------- helpers
  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function num(value) {
    return Number(value).toLocaleString('en-US');
  }

  function pct(part, whole) {
    if (!whole) return '0.0%';
    return ((part / whole) * 100).toFixed(1) + '%';
  }

  function bytes(value) {
    if (value < 1024) return value + ' B';
    if (value < 1048576) return (value / 1024).toFixed(1) + ' KB';
    return (value / 1048576).toFixed(1) + ' MB';
  }

  function setBusy(busy) {
    submitButton.disabled = busy;
    submitButton.textContent = busy ? 'Counting…' : 'Count Lines';
    cancelWrap.className = busy ? '' : 'hidden';
  }

  function fail(message, hint) {
    errorEl.textContent = hint ? message + ' ' + hint : message;
    statusEl.textContent = '';
  }

  /* Client-side sanity check. The Worker validates again; this only saves a
   * round trip for obvious typos. */
  function parseInputLocally(raw) {
    var value = String(raw || '').trim();
    if (!value) return { error: 'Enter a repository.' };
    if (/\s/.test(value)) return { error: 'That input has spaces in it.' };
    if (/^https?:\/\//i.test(value) && !/^https?:\/\/(www\.)?github\.com\//i.test(value)) {
      return { error: 'Only github.com repositories are supported.' };
    }
    return { value: value };
  }

  // ------------------------------------------------------------- rendering
  /* The challenge selected when this count started, so the result can say what
   * it was entered in without asking the server again. */
  var submittedTo = null;

  function renderResults(result) {
    var t = result.totals;
    var shortSha = result.sha.slice(0, 10);
    var html = '';

    html += '<h2>' + esc(result.full_name) + ' <span class="badge ' +
      (result.cached ? 'cached' : 'fresh') + '">' +
      (result.cached ? 'cached' : 'fresh') + '</span></h2>';

    if (result.warnings && result.warnings.length) {
      html += '<ul class="warnings">';
      for (var w = 0; w < result.warnings.length; w++) {
        html += '<li>' + esc(result.warnings[w]) + '</li>';
      }
      html += '</ul>';
    }

    html += '<table><caption>Totals</caption><tbody>' +
      row('Total lines', '<span class="big">' + num(t.lines) + '</span>', '100.0%') +
      row('Code', num(t.code), pct(t.code, t.lines)) +
      row('Comments', num(t.comment), pct(t.comment, t.lines)) +
      row('Blank', num(t.blank), pct(t.blank, t.lines)) +
      row('Files counted', num(t.files), bytes(t.bytes)) +
      '</tbody></table>';

    html += '<h3>By language</h3><table><thead><tr>' +
      '<th>Language</th><th class="n">Files</th><th class="n">Code</th>' +
      '<th class="n">Comment</th><th class="n">Blank</th><th class="n">Lines</th>' +
      '<th class="n">Share</th></tr></thead><tbody>';
    if (!result.by_language.length) {
      html += '<tr><td colspan="7">Nothing counted.</td></tr>';
    }
    for (var i = 0; i < result.by_language.length; i++) {
      var lang = result.by_language[i];
      html += '<tr><td>' + esc(lang.language) + '</td>' +
        '<td class="n">' + num(lang.files) + '</td>' +
        '<td class="n">' + num(lang.code) + '</td>' +
        '<td class="n">' + num(lang.comment) + '</td>' +
        '<td class="n">' + num(lang.blank) + '</td>' +
        '<td class="n">' + num(lang.lines) + '</td>' +
        '<td class="n">' + pct(lang.lines, t.lines) + '</td></tr>';
    }
    html += '</tbody></table>';

    if (result.languages_without_comment_rules.length) {
      html += '<p class="note">Comment detection is not available for: ' +
        esc(result.languages_without_comment_rules.join(', ')) +
        '. For those files every non-blank line is counted as code. ' +
        '<a href="/how.html">How we count</a>.</p>';
    } else {
      html += '<p class="note">Comment rules applied to every language in this result. ' +
        '<a href="/how.html">How we count</a>.</p>';
    }

    if (result.biggest_files && result.biggest_files.length) {
      html += '<h3>Biggest files</h3><table><thead><tr><th>File</th><th>Language</th>' +
        '<th class="n">Lines</th></tr></thead><tbody>';
      for (var b = 0; b < result.biggest_files.length; b++) {
        var file = result.biggest_files[b];
        var blobUrl = 'https://github.com/' + encodeURIComponent(result.owner) + '/' +
          encodeURIComponent(result.repo) + '/blob/' + encodeURIComponent(result.sha) + '/' + file.path;
        html += '<tr><td><a href="' + esc(blobUrl) + '">' + esc(file.path) + '</a></td>' +
          '<td>' + esc(file.language) + '</td>' +
          '<td class="n">' + num(file.lines) + '</td></tr>';
      }
      html += '</tbody></table>';
    }

    var commitUrl = 'https://github.com/' + encodeURIComponent(result.owner) + '/' +
      encodeURIComponent(result.repo) + '/commit/' + encodeURIComponent(result.sha);
    html += '<h3>Repository</h3><table><tbody>' +
      row2('Repository', '<a href="' + esc(result.repo_meta.html_url) + '">' + esc(result.full_name) + '</a>' +
        (result.repo_meta.private ? ' (private)' : '')) +
      row2('Ref', esc(result.ref) + (result.ref === result.default_branch ? ' (default branch)' : '')) +
      row2('Commit', '<a href="' + esc(commitUrl) + '"><code>' + esc(shortSha) + '</code></a>') +
      row2('Stars', num(result.repo_meta.stars)) +
      row2('Repo size', num(result.repo_meta.size_kb) + ' KB (git)') +
      row2('Counted in', (result.duration_ms / 1000).toFixed(2) + 's (' + esc(result.strategy) +
        ' strategy, ' + num(result.github_requests) + ' GitHub requests)') +
      row2('Counter version', esc(result.counter_version)) +
      '</tbody></table>';

    html += '<h3>Skipped</h3><table><tbody>' +
      row2('Vendored / build output', num(result.skipped.vendored)) +
      row2('Generated (incl. lockfiles)', num(result.skipped.generated)) +
      row2('Binary', num(result.skipped.binary)) +
      row2('Too large', num(result.skipped.too_large)) +
      row2('Other', num(result.skipped.other)) +
      '</tbody></table>';

    // Whether this count reached the leaderboards, said plainly at the moment
    // it is answerable. Everything that decides it is already in the result, so
    // none of this costs another request.
    if (result.strategy === 'browser') {
      html += '<p class="note">Counted locally, so there is no shareable link for this one: ' +
        'the server never saw these numbers. That also keeps it off ' +
        '<a href="/board">the standings</a> &mdash; nothing is ranked that the ' +
        'server did not count itself.</p>';
    } else {
      var permalink = '/r/' + result.owner + '/' + result.repo + '/' + result.sha;
      html += '<p class="note">Permalink: <a href="' + esc(permalink) + '">' +
        esc('/r/' + result.owner + '/' + result.repo + '/' + shortSha) + '</a> &middot; ' +
        '<a href="/api/count/' + esc(result.owner) + '/' + esc(result.repo) + '?ref=' +
        esc(result.sha) + '">JSON</a></p>';
      if (result.repo_meta.private) {
        html += '<p class="note">Private, so it stays off <a href="/board">the standings</a> ' +
          'and out of any challenge. Counting a repository is not publishing it.</p>';
      } else if (result.repo_meta.fork) {
        html += '<p class="note">A fork, so it is listed but not ranked on ' +
          '<a href="/board">the standings</a>, and cannot enter a challenge &mdash; ' +
          'submitting somebody else\'s solution is not entering.</p>';
      } else if (submittedTo) {
        html += '<p class="note">Entered in <a href="/golf/' + esc(submittedTo.id) + '">' +
          esc(submittedTo.title) + '</a> at <strong>' + num(result.totals.code) +
          '</strong> lines of code. Push a shorter one and count it again to replace it.</p>';
      } else {
        html += '<p class="note">Now on <a href="/board">the standings</a>. ' +
          'To enter a <a href="/golf">golf challenge</a>, pick one above and count again.</p>';
      }
    }

    resultsEl.innerHTML = html;

    if (result.strategy !== 'browser' && window.history && window.history.replaceState) {
      window.history.replaceState({}, '', '/r/' + result.owner + '/' + result.repo + '/' + result.sha);
    }
    document.title = 'LOC.1999 - ' + result.full_name + ' - ' + num(t.code) + ' lines of code';
  }

  function row(label, value, extra) {
    return '<tr><th scope="row">' + label + '</th><td class="n">' + value +
      '</td><td class="n">' + extra + '</td></tr>';
  }

  function row2(label, value) {
    return '<tr><th scope="row">' + label + '</th><td>' + value + '</td></tr>';
  }

  // -------------------------------------------------------------- counting
  function buildQuery(input, ref) {
    var params = new URLSearchParams();
    params.set('input', input);
    if (ref) params.set('ref', ref);
    if (optLockfiles.checked) params.set('lockfiles', '1');
    if (optVendored.checked) params.set('vendored', '1');
    if (optFresh.checked) params.set('fresh', '1');
    var challenge = challengeInput && challengeInput.value;
    if (challenge) params.set('challenge', challenge);
    return params.toString();
  }

  function stop() {
    if (source) {
      source.close();
      source = null;
    }
    if (browserAbort) {
      browserAbort.abort();
      browserAbort = null;
    }
    setBusy(false);
    statusEl.textContent = 'Stopped.';
  }

  /* Whether to switch to browser counting without asking. The numbers are the
   * same either way; what differs is that this spends the visitor's bandwidth
   * and CPU, so it is only done when that cost is small and they are not on a
   * connection that says otherwise. */
  function shouldAutoCount(details) {
    if (typeof window.DecompressionStream !== 'function') return false;
    var conn = navigator.connection || {};
    if (conn.saveData) return false;
    if (/2g/.test(conn.effectiveType || '')) return false;
    var bytes = details && details.bytes;
    if (typeof bytes !== 'number') return true;
    return bytes <= AUTO_BROWSER_MAX_BYTES;
  }

  function startCount(input, ref) {
    errorEl.textContent = '';
    resultsEl.innerHTML = '';
    statusEl.textContent = 'Starting…';
    setBusy(true);
    submittedTo = challengeFor(challengeInput && challengeInput.value);

    var query = buildQuery(input, ref);

    if (typeof window.EventSource !== 'function') {
      postFallback(input, ref);
      return;
    }

    source = new EventSource('/api/stream?' + query);

    source.addEventListener('progress', function (event) {
      var data = JSON.parse(event.data);
      statusEl.textContent = data.message;
    });

    source.addEventListener('result', function (event) {
      var result = JSON.parse(event.data);
      statusEl.textContent = 'Counted in ' + (result.duration_ms / 1000).toFixed(2) + 's' +
        (result.cached ? ' (from cache)' : '') + '.';
      renderResults(result);
      stopQuietly();
    });

    source.addEventListener('failure', function (event) {
      var err = JSON.parse(event.data).error;

      // Too big for the server is not a failure the visitor needs to act on:
      // the browser can do it. Switch straight over, saying so as it happens,
      // rather than showing red text and asking them to click again.
      if (err.code === 'too_large' && shouldAutoCount(err.details)) {
        stopQuietly();
        runBrowserCount(input, ref, err.details);
        return;
      }

      fail(err.message, err.code === 'too_large' ? '' : err.hint);
      if (err.code === 'too_large') offerBrowserCount(input, ref, err.details);
      stopQuietly();
    });

    source.onerror = function () {
      // Either the stream ended normally (we already closed it) or the
      // connection dropped. Only report the latter.
      if (source) {
        // A dropped stream is also what a repository too big for the server's
        // CPU budget looks like: Cloudflare kills the isolate and no handler
        // here gets to explain. The browser has no such budget, so offer it
        // rather than leaving a dead end.
        fail('The connection to the counter dropped.');
        stopQuietly();
        offerBrowserCount(input, ref, null, 'The server did not finish this one.');
      }
    };
  }

  function stopQuietly() {
    if (source) {
      source.close();
      source = null;
    }
    setBusy(false);
  }

  function postFallback(input, ref) {
    statusEl.textContent = 'Counting (no progress stream in this browser)…';
    fetch('/api/count', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: input,
        ref: ref || undefined,
        includeLockfiles: optLockfiles.checked,
        includeVendored: optVendored.checked,
        fresh: optFresh.checked,
        challenge: (challengeInput && challengeInput.value) || undefined
      })
    })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (payload) {
        setBusy(false);
        if (!payload.ok) {
          fail(payload.body.error ? payload.body.error.message : 'Count failed.',
            payload.body.error ? payload.body.error.hint : undefined);
          return;
        }
        statusEl.textContent = 'Counted in ' + (payload.body.duration_ms / 1000).toFixed(2) + 's.';
        renderResults(payload.body);
      })
      .catch(function () {
        setBusy(false);
        fail('Could not reach the counter.');
      });
  }

  // ------------------------------------------------- big repos, in the browser
  // The server refuses repositories bigger than its CPU budget. The browser has
  // no such budget, so we offer to do the work here instead: the Worker streams
  // the archive through untouched, and bigcount.js — built from the very same
  // counting modules — does the gunzip, tar parsing and classification locally.

  var bigScriptLoading = null;

  function loadBigCounter() {
    if (window.LOC1999_BIG) return Promise.resolve();
    if (bigScriptLoading) return bigScriptLoading;
    bigScriptLoading = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = '/bigcount.js';
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Could not load the browser counter.')); };
      document.head.appendChild(script);
    });
    return bigScriptLoading;
  }

  function offerBrowserCount(input, ref, details, lead) {
    if (typeof window.DecompressionStream !== 'function') {
      errorEl.textContent += ' This browser cannot decompress the archive, so counting it here is not possible either.';
      return;
    }
    var size = details && typeof details.bytes === 'number'
      ? ' That means downloading roughly ' + Math.round(details.bytes / 1048576) + ' MB to this device'
      : ' That means downloading the repository archive to this device';
    resultsEl.innerHTML =
      '<p>' + (lead || 'This repository is bigger than the server will process.') + ' ' +
      'Your browser has no such limit &mdash; it can do the counting locally, ' +
      'using exactly the same code.' + size + ', so it is your call.</p>' +
      '<p><button type="button" id="big-count">Count it in my browser</button></p>' +
      '<p class="note">Nothing is uploaded. The result is not cached, not shareable, ' +
      'and not ranked on <a href="/board">the standings</a>.</p>';
    document.getElementById('big-count').addEventListener('click', function () {
      runBrowserCount(input, ref, details);
    });
  }

  function runBrowserCount(input, ref, details) {
    errorEl.textContent = '';
    resultsEl.innerHTML = '';
    var approx = details && typeof details.bytes === 'number'
      ? ' (about ' + Math.round(details.bytes / 1048576) + ' MB)'
      : '';
    statusEl.textContent = 'Too big for the server — counting it here instead' + approx + '…';
    setBusy(true);
    browserAbort = typeof AbortController === 'function' ? new AbortController() : null;

    var params = new URLSearchParams();
    params.set('input', input);
    if (ref) params.set('ref', ref);

    loadBigCounter()
      .then(function () {
        statusEl.textContent = 'Resolving repository…';
        return fetch('/api/resolve?' + params.toString());
      })
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw new Error(body.error ? body.error.message : 'Could not resolve that repository.');
          return body;
        });
      })
      .then(function (resolved) {
        statusEl.textContent = 'Downloading archive' + approx + '… (press Stop to cancel)';
        var url = '/api/archive/' + encodeURIComponent(resolved.owner) + '/' +
          encodeURIComponent(resolved.repo) + '/' + encodeURIComponent(resolved.sha);
        return window.LOC1999_BIG.countArchive(url, resolved, {
          includeLockfiles: optLockfiles.checked,
          includeVendored: optVendored.checked,
          signal: browserAbort ? browserAbort.signal : undefined,
          onProgress: function (files) {
            statusEl.textContent = 'Counting files ' + files.toLocaleString() + '… (in your browser)';
          }
        });
      })
      .then(function (result) {
        browserAbort = null;
        statusEl.textContent = 'Counted in ' + (result.duration_ms / 1000).toFixed(2) + 's, in your browser.';
        renderResults(result);
        setBusy(false);
      })
      .catch(function (error) {
        browserAbort = null;
        setBusy(false);
        if (error && error.name === 'AbortError') {
          statusEl.textContent = 'Stopped.';
          return;
        }
        fail(error.message || 'Counting in the browser failed.');
      });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var parsed = parseInputLocally(repoInput.value);
    if (parsed.error) {
      fail(parsed.error);
      return;
    }
    startCount(parsed.value, refInput.value.trim());
  });

  cancelButton.addEventListener('click', stop);

  // ------------------------------------------------------------------ auth
  function renderAuth(me) {
    var flag = document.getElementById('auth-flag');
    // The marker follows reality: it only says NEW once sign-in actually works,
    // so enabling it later needs no edit here.
    if (flag) flag.textContent = me.oauth_available || me.authenticated ? 'NEW' : 'SOON';

    if (me.authenticated) {
      authBlock.innerHTML = 'Connected as <strong>' + esc(me.login) + '</strong>. ' +
        'Private repositories you can access are countable, and you use your own ' +
        'GitHub rate limit. <a href="#" id="logout-link">Disconnect</a>.';
      var link = document.getElementById('logout-link');
      link.addEventListener('click', function (event) {
        event.preventDefault();
        fetch('/api/auth/logout', { method: 'POST' }).then(function () {
          window.location.reload();
        });
      });
      loadMyRepos();
      return;
    }
    if (me.oauth_available) {
      var grants = me.scopes === null
        ? 'this is a GitHub App: you pick which repositories it may read'
        : 'requests <code>' + esc(me.scopes) + '</code>';
      authBlock.innerHTML = '<a href="/api/auth/login">Connect GitHub</a> to use your own rate limit' +
        (me.private_repos ? ' and count private repositories' : '') + '. It ' + grants +
        '. Your token is kept server-side and never sent to the browser &mdash; ' +
        '<a href="/security.html">what that means, and how to check it</a>.';
    } else {
      authBlock.innerHTML = 'Coming soon. It will let you count <strong>private</strong> ' +
        'repositories and use your own GitHub rate limit. Public repositories work now, ' +
        'with no account. What it will ask for, and how to check it: ' +
        '<a href="/security.html">connecting GitHub</a>.';
    }
  }

  function loadMyRepos() {
    fetch('/api/auth/repos')
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        if (!data || !data.repos.length) return;
        var html = '<h3>Your repositories</h3><ul class="plain">';
        for (var i = 0; i < data.repos.length; i++) {
          var repo = data.repos[i];
          html += '<li><a href="#" class="pick" data-repo="' + esc(repo.full_name) + '">' +
            esc(repo.full_name) + '</a>' + (repo.private ? ' <em>(private)</em>' : '') + '</li>';
        }
        html += '</ul>';
        quickpick.innerHTML = html;
        var picks = quickpick.querySelectorAll('.pick');
        for (var p = 0; p < picks.length; p++) {
          picks[p].addEventListener('click', function (event) {
            event.preventDefault();
            repoInput.value = this.getAttribute('data-repo');
            refInput.value = '';
            window.scrollTo(0, 0);
            repoInput.focus();
          });
        }
      })
      .catch(function () { /* quick-pick is a nicety, never a blocker */ });
  }

  fetch('/api/auth/me')
    .then(function (response) { return response.json(); })
    .then(renderAuth)
    .catch(function () {
      authBlock.textContent = 'Could not check sign-in status.';
    });

  // ------------------------------------------------------------------ golf
  // The challenge list and its standings come from the server in one request,
  // which also fills the dropdown above — so the challenges are defined in
  // exactly one place, and the homepage stays a static asset.

  var challenges = [];

  function fillChallengePicker() {
    if (!challengeInput) return;
    for (var i = 0; i < challenges.length; i++) {
      var option = document.createElement('option');
      option.value = challenges[i].id;
      option.textContent = challenges[i].title;
      challengeInput.appendChild(option);
    }
    // Arriving from a challenge page preselects it, so the link does the work.
    var wanted = new URLSearchParams(window.location.search).get('challenge');
    if (wanted) challengeInput.value = wanted;
  }

  function challengeFor(id) {
    if (!id) return null;
    for (var i = 0; i < challenges.length; i++) {
      if (challenges[i].id === id) return challenges[i];
    }
    return null;
  }

  function renderGolf() {
    if (!standingsEl || !challenges.length) return;
    var rows = '';
    for (var i = 0; i < challenges.length; i++) {
      var c = challenges[i];
      var leader = c.rows && c.rows[0];
      rows += '<tr><td><a href="/golf/' + esc(c.id) + '">' + esc(c.title) + '</a><br>' +
        '<span class="note">' + esc(c.brief) + '</span></td>' +
        '<td class="n">' + (leader ? '<strong>' + num(leader.code) + '</strong>' : '&mdash;') + '</td>' +
        '<td class="n">' + num(c.entries) + '</td></tr>';
    }
    standingsEl.innerHTML =
      '<h2>Code Golf</h2>' +
      '<p class="note">One task. Fewest lines wins. Pick one above before counting ' +
      'and your repository joins that board.</p>' +
      '<table><thead><tr><th>Challenge</th><th class="n">Best</th>' +
      '<th class="n">Entries</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="note"><a href="/golf">The rules</a> &middot; ' +
      '<a href="/board">the standings</a> rank everything counted here on things ' +
      'that should not matter.</p><hr>';
  }

  fetch('/api/golf')
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (data) {
      if (!data || !data.challenges) return;
      challenges = data.challenges;
      fillChallengePicker();
      renderGolf();
    })
    .catch(function () { /* A leaderboard is not worth an error message. */ });

  // --------------------------------------------------------------- startup
  var query = new URLSearchParams(window.location.search);
  var oauthError = query.get('error');
  if (oauthError) {
    fail(oauthError);
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, '', '/');
    }
  }
  var prefill = query.get('repo');
  if (prefill) {
    repoInput.value = prefill;
    var prefillRef = query.get('ref');
    if (prefillRef) refInput.value = prefillRef;
    startCount(prefill, prefillRef || '');
  } else {
    repoInput.focus();
  }
})();

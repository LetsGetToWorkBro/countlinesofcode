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

  var source = null;

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

    var permalink = '/r/' + result.owner + '/' + result.repo + '/' + result.sha;
    html += '<p class="note">Permalink: <a href="' + esc(permalink) + '">' +
      esc('/r/' + result.owner + '/' + result.repo + '/' + shortSha) + '</a> &middot; ' +
      '<a href="/api/count/' + esc(result.owner) + '/' + esc(result.repo) + '?ref=' +
      esc(result.sha) + '">JSON</a></p>';

    resultsEl.innerHTML = html;

    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, '', permalink);
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
    return params.toString();
  }

  function stop() {
    if (source) {
      source.close();
      source = null;
    }
    setBusy(false);
    statusEl.textContent = 'Stopped.';
  }

  function startCount(input, ref) {
    errorEl.textContent = '';
    resultsEl.innerHTML = '';
    statusEl.textContent = 'Starting…';
    setBusy(true);

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
      var payload = JSON.parse(event.data);
      fail(payload.error.message, payload.error.hint);
      stopQuietly();
    });

    source.onerror = function () {
      // Either the stream ended normally (we already closed it) or the
      // connection dropped. Only report the latter.
      if (source) {
        fail('The connection to the counter dropped. Try again.');
        stopQuietly();
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
        fresh: optFresh.checked
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
      authBlock.innerHTML = '<a href="/api/auth/login">Connect GitHub</a> for private repositories, ' +
        'a much higher rate limit, and a quick-pick list of your repositories. ' +
        'Your token is stored server-side and never sent to the browser.';
    } else {
      authBlock.textContent = 'GitHub sign-in is not configured on this deployment. ' +
        'Public repositories still work.';
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

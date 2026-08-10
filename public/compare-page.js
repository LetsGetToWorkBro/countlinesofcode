/* 1999.LOC compare page. Vanilla JS, no build step.
 *
 * Loads /diffkit.js on first compare — the Myers diff, where the tests can
 * reach it. The page draws the two panes and the coloured rows; the kit
 * decides which lines and which characters differ. Nothing is uploaded; there
 * is no endpoint to upload to.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var kit = null;   // window.LOC1999_DIFF

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fail(m) { $('error').textContent = m; }
  function clearError() { $('error').textContent = ''; }

  var loading = null;
  function ready() {
    if (kit) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/diffkit.js';
      s.onload = function () { kit = window.LOC1999_DIFF; kit ? resolve() : reject(new Error('the engine did not load')); };
      s.onerror = function () { reject(new Error('could not load the compare engine')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  /* The two options rewrite each side before the diff, without touching the
   * text the boxes hold or the text the rows show — the comparison changes,
   * the display does not. */
  function normalise(text) {
    var out = text;
    if ($('wm-case').checked) out = out.toLowerCase();
    if ($('wm-ws').checked) {
      out = out.split('\n').map(function (line) {
        return line.replace(/[ \t]+/g, ' ').replace(/^ | $/g, '');
      }).join('\n');
    }
    return out;
  }

  function compare() {
    clearError();
    ready().then(function () {
      var leftRaw = $('wm-left').value;
      var rightRaw = $('wm-right').value;
      if (!leftRaw && !rightRaw) { fail('Put some text in both sides, or open two files.'); return; }

      // The rows are computed against the normalised text so the options take
      // effect, but each row is shown as the original line it came from.
      var leftNorm = normalise(leftRaw);
      var rightNorm = normalise(rightRaw);
      var leftLines = kit.splitLines(leftRaw);
      var rightLines = kit.splitLines(rightRaw);

      var rows = kit.diffRows(leftNorm, rightNorm);
      var stats = kit.diffStats(rows);
      renderVerdict(stats);
      renderRows(rows, leftLines, rightLines);
    }).catch(function (err) { fail((err && err.message) || String(err)); });
  }

  function renderVerdict(stats) {
    var v = $('wm-verdict');
    v.classList.remove('hidden');
    if (stats.identical) {
      v.className = 'is-same';
      v.textContent = 'The two are identical.';
      return;
    }
    v.className = 'is-diff';
    var parts = [];
    if (stats.changed) parts.push(stats.changed + ' line' + (stats.changed === 1 ? '' : 's') + ' changed');
    if (stats.inserted) parts.push(stats.inserted + ' added on the right');
    if (stats.deleted) parts.push(stats.deleted + ' only on the left');
    v.textContent = 'They differ: ' + parts.join(', ') + '.';
  }

  function spanHtml(spans) {
    return spans.map(function (s) {
      return s.changed ? '<span class="wm-span-change">' + esc(s.value) + '</span>' : esc(s.value);
    }).join('');
  }

  function renderRows(rows, leftLines, rightLines) {
    var out = ['<table class="wm-diff"><colgroup>' +
      '<col class="wm-gutter"><col><col style="width:1px"><col class="wm-gutter"><col></colgroup><tbody>'];
    rows.forEach(function (row) {
      var leftText;
      var rightText;
      if (row.kind === 'change') {
        // The character diff runs on the ORIGINAL lines, not the normalised
        // ones, so the highlighted spans line up with what is shown.
        var lo = row.leftNo ? leftLines[row.leftNo - 1] : '';
        var ro = row.rightNo ? rightLines[row.rightNo - 1] : '';
        var spans = kit.charSpans(lo, ro);
        leftText = spanHtml(spans.left);
        rightText = spanHtml(spans.right);
      } else {
        leftText = row.left === null ? '' : esc(row.leftNo ? leftLines[row.leftNo - 1] : row.left);
        rightText = row.right === null ? '' : esc(row.rightNo ? rightLines[row.rightNo - 1] : row.right);
      }
      out.push('<tr class="wm-' + row.kind + '">' +
        '<td class="wm-no">' + (row.leftNo || '') + '</td>' +
        '<td class="wm-text wm-text-left">' + leftText + '</td>' +
        '<td class="wm-mid"></td>' +
        '<td class="wm-no">' + (row.rightNo || '') + '</td>' +
        '<td class="wm-text wm-text-right">' + rightText + '</td>' +
        '</tr>');
    });
    out.push('</tbody></table>');
    $('wm-result').innerHTML = out.join('');
  }

  // ------------------------------------------------------------- files
  function openInto(input, textarea) {
    var file = input.files && input.files[0];
    if (!file) return;
    clearError();
    file.text().then(function (text) {
      textarea.value = text;
      compare();
    }, function () { fail('Could not read that file as text.'); });
    input.value = '';
  }

  // A file dropped on a textarea fills it and compares; a text drop just lands
  // as text the browser already handles.
  function wireDrop(textarea) {
    ['dragenter', 'dragover'].forEach(function (n) {
      textarea.addEventListener(n, function (e) {
        if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') !== -1) {
          e.preventDefault(); textarea.classList.add('is-over');
        }
      });
    });
    ['dragleave', 'drop'].forEach(function (n) {
      textarea.addEventListener(n, function () { textarea.classList.remove('is-over'); });
    });
    textarea.addEventListener('drop', function (e) {
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      e.preventDefault();
      file.text().then(function (text) { textarea.value = text; compare(); },
        function () { fail('Could not read that file as text.'); });
    });
  }

  // ------------------------------------------------------------- wiring
  $('wm-run').addEventListener('click', compare);
  $('wm-ws').addEventListener('change', function () { if ($('wm-result').innerHTML) compare(); });
  $('wm-case').addEventListener('change', function () { if ($('wm-result').innerHTML) compare(); });

  $('wm-swap').addEventListener('click', function () {
    var l = $('wm-left').value;
    $('wm-left').value = $('wm-right').value;
    $('wm-right').value = l;
    if ($('wm-result').innerHTML) compare();
  });
  $('wm-clear').addEventListener('click', function () {
    $('wm-left').value = '';
    $('wm-right').value = '';
    $('wm-result').innerHTML = '';
    $('wm-verdict').classList.add('hidden');
    clearError();
  });

  $('wm-open-left').addEventListener('click', function () { $('wm-file-left').click(); });
  $('wm-open-right').addEventListener('click', function () { $('wm-file-right').click(); });
  $('wm-file-left').addEventListener('change', function () { openInto($('wm-file-left'), $('wm-left')); });
  $('wm-file-right').addEventListener('change', function () { openInto($('wm-file-right'), $('wm-right')); });

  wireDrop($('wm-left'));
  wireDrop($('wm-right'));
})();

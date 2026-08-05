/* 1999.LOC spreadsheet page. Vanilla JS, no build step.
 *
 * Loads /sheetkit.js on first file open — an .xlsx is a ZIP of XML and the
 * browser's own deflate does the compression, so there is no engine to fetch
 * beyond a few kilobytes of our own code. Nothing is uploaded.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var dropzone = $('drop');
  var fileInput = $('file-input');
  var statusEl = $('status');
  var errorEl = $('error');

  var engine = null;
  var book = null;      // { sheets: [{name, rows}] }
  var active = 0;
  var sourceName = 'sheet';
  var liveUrls = [];

  var PREVIEW_ROWS = 25;
  var PREVIEW_COLS = 12;

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fail(m) { errorEl.textContent = m; statusEl.textContent = ''; }
  function clearError() { errorEl.textContent = ''; }
  function bytesLabel(n) {
    return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
  }

  var loading = null;
  function loadEngine() {
    if (window.LOC1999_SHEET) { engine = window.LOC1999_SHEET; return Promise.resolve(); }
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/sheetkit.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load the spreadsheet engine.')); };
      document.head.appendChild(s);
    }).then(function () { engine = window.LOC1999_SHEET; });
    return loading;
  }

  function resetOutput() {
    liveUrls.forEach(URL.revokeObjectURL);
    liveUrls = [];
    $('output').innerHTML = '';
  }

  function open(file) {
    clearError();
    resetOutput();
    $('workbook').className = 'hidden';
    sourceName = (file.name || 'sheet').replace(/\.[^.]+$/, '');
    statusEl.textContent = 'Reading…';
    loadEngine()
      .then(function () { return file.arrayBuffer(); })
      .then(function (buf) {
        var bytes = new Uint8Array(buf);
        var isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
        if (isZip) return engine.readXlsx(bytes);
        // Anything else is treated as text: CSV, TSV, semicolon-separated.
        var text = new TextDecoder().decode(bytes);
        return { sheets: [{ name: file.name || 'Sheet1', rows: engine.parseCsv(text) }] };
      })
      .then(function (read) {
        book = read;
        active = 0;
        statusEl.textContent = '';
        $('workbook').className = '';
        renderPicker();
        renderSheet();
      })
      .catch(function (err) {
        book = null;
        fail((err && err.message) || 'Could not read that file.');
      });
  }

  function renderPicker() {
    if (book.sheets.length < 2) { $('sheet-pick').innerHTML = ''; return; }
    $('sheet-pick').innerHTML = '<strong>Sheet:</strong> ' + book.sheets.map(function (s, i) {
      return '<button type="button" class="sheet-tab' + (i === active ? ' is-active' : '') +
        '" data-sheet="' + i + '">' + esc(s.name) + '</button>';
    }).join(' ');
    Array.prototype.forEach.call($('sheet-pick').querySelectorAll('[data-sheet]'), function (btn) {
      btn.addEventListener('click', function () {
        active = Number(btn.getAttribute('data-sheet'));
        resetOutput();
        renderPicker();
        renderSheet();
      });
    });
  }

  function renderSheet() {
    var sheet = book.sheets[active];
    var rows = sheet.rows;
    var widest = rows.reduce(function (n, r) { return Math.max(n, r.length); }, 0);
    $('counts').innerHTML = '<strong>' + esc(sheet.name) + ':</strong> ' +
      rows.length.toLocaleString() + ' row' + (rows.length === 1 ? '' : 's') + ', ' +
      widest + ' column' + (widest === 1 ? '' : 's') + '.' +
      (rows.length > PREVIEW_ROWS ? ' Showing the first ' + PREVIEW_ROWS + '.' : '');

    var shown = rows.slice(0, PREVIEW_ROWS);
    $('preview').innerHTML = '<table>' + shown.map(function (row, r) {
      var cells = [];
      for (var c = 0; c < Math.min(widest, PREVIEW_COLS); c++) {
        var value = row[c] === undefined ? '' : row[c];
        cells.push(r === 0 ? '<th>' + esc(value) + '</th>' : '<td>' + esc(value) + '</td>');
      }
      if (widest > PREVIEW_COLS) cells.push(r === 0 ? '<th>&hellip;</th>' : '<td>&hellip;</td>');
      return '<tr>' + cells.join('') + '</tr>';
    }).join('') + '</table>';
  }

  function save() {
    if (!book) return;
    var choice = $('delimiter').value;
    resetOutput();
    var work;
    if (choice === 'xlsx') {
      work = engine.writeXlsx(book).then(function (out) {
        return { data: out, name: sourceName + '.xlsx',
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
      });
    } else {
      var delimiter = choice === 'csv-;' ? ';' : choice === 'csv-\\t' ? '\t' : ',';
      var text = engine.writeCsv(book.sheets[active].rows, delimiter);
      // A byte-order mark makes Excel open UTF-8 CSV correctly instead of
      // mangling every accented character.
      var data = new TextEncoder().encode('﻿' + text);
      work = Promise.resolve({
        data: data,
        name: sourceName + (delimiter === '\t' ? '.tsv' : '.csv'),
        type: 'text/csv;charset=utf-8',
      });
    }

    work.then(function (out) {
      var blob = new Blob([out.data], { type: out.type });
      var url = URL.createObjectURL(blob);
      liveUrls.push(url);
      $('output').innerHTML = '<ul class="plain"><li><a href="' + url + '" download="' + esc(out.name) + '">' +
        esc(out.name) + '</a> <span class="note">' + bytesLabel(blob.size) + '</span></li></ul>';
    }).catch(function (err) { fail((err && err.message) || 'Could not write that file.'); });
  }

  // ------------------------------------------------------------------ wiring
  dropzone.addEventListener('click', function () { fileInput.click(); });
  dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files[0]) open(fileInput.files[0]);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach(function (n) {
    dropzone.addEventListener(n, function (e) { e.preventDefault(); dropzone.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (n) {
    dropzone.addEventListener(n, function (e) { e.preventDefault(); dropzone.classList.remove('is-over'); });
  });
  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files[0]) open(e.dataTransfer.files[0]);
  });
  $('save').addEventListener('click', save);
})();

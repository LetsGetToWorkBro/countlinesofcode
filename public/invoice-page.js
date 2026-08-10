/* 1999.LOC invoice page. Vanilla JS, no build step.
 *
 * The form and the running totals are here; the PDF and the arithmetic it
 * trusts are in /invoicekit.js, loaded on the first Save so the heavy pdf-lib
 * bundle is not paid for until it is used. The totals shown on screen use the
 * same cent-rounding the PDF does, so what you see is what prints. Nothing is
 * uploaded, and nothing is kept between visits.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var kit = null; // window.LOC1999_INVOICE
  var template = 'classic';

  function val(id) { return ($(id) && $(id).value != null) ? $(id).value : ''; }
  function fail(m) { $('error').textContent = m; }
  function clearError() { $('error').textContent = ''; }

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function money(n) {
    var v = Math.abs(round2(n)).toFixed(2).split('.');
    var grouped = v[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + (val('inv-currency') || '$') + grouped + '.' + v[1];
  }

  // -------------------------------------------------------------- rows
  var items = $('inv-items');

  function addRow(desc, qty, rate) {
    var tr = document.createElement('tr');
    tr.className = 'qb-row';
    tr.innerHTML =
      '<td class="qb-c-desc"><input class="qb-desc" type="text" autocomplete="off" placeholder="What it was for"></td>' +
      '<td class="qb-c-qty"><input class="qb-qty" type="text" inputmode="decimal" autocomplete="off" value="1"></td>' +
      '<td class="qb-c-rate"><input class="qb-rate" type="text" inputmode="decimal" autocomplete="off" value="0"></td>' +
      '<td class="qb-c-amt"><span class="qb-amt">0.00</span></td>' +
      '<td class="qb-c-del"><button type="button" class="qb-del" aria-label="Remove this line">×</button></td>';
    items.appendChild(tr);
    if (desc != null) tr.querySelector('.qb-desc').value = desc;
    if (qty != null) tr.querySelector('.qb-qty').value = String(qty);
    if (rate != null) tr.querySelector('.qb-rate').value = String(rate);
    tr.querySelector('.qb-del').addEventListener('click', function () {
      tr.remove();
      if (!items.querySelector('.qb-row')) addRow();
      recompute();
    });
    return tr;
  }

  function recompute() {
    var subtotal = 0;
    var rows = items.querySelectorAll('.qb-row');
    for (var i = 0; i < rows.length; i++) {
      var q = parseFloat(rows[i].querySelector('.qb-qty').value) || 0;
      var r = parseFloat(rows[i].querySelector('.qb-rate').value) || 0;
      var amt = round2(q * r);
      rows[i].querySelector('.qb-amt').textContent = money(amt);
      subtotal += amt;
    }
    subtotal = round2(subtotal);
    var taxRate = parseFloat(val('inv-tax')) || 0;
    var tax = round2((subtotal * taxRate) / 100);
    $('inv-subtotal').textContent = money(subtotal);
    $('inv-tax-amt').textContent = money(tax);
    $('inv-total').textContent = money(round2(subtotal + tax));
  }

  // -------------------------------------------------------------- template
  function setTemplate(t) {
    template = t;
    var btns = document.querySelectorAll('.qb-tpl');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-tpl') === t;
      btns[i].classList.toggle('is-on', on);
      btns[i].setAttribute('aria-checked', String(on));
    }
  }

  // -------------------------------------------------------------- the PDF
  var loading = null;
  function ready() {
    if (kit) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/invoicekit.js';
      s.onload = function () { kit = window.LOC1999_INVOICE; kit ? resolve() : reject(new Error('the engine did not load')); };
      s.onerror = function () { reject(new Error('could not load the invoice engine')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function gather() {
    var rows = items.querySelectorAll('.qb-row');
    var list = [];
    for (var i = 0; i < rows.length; i++) {
      list.push({
        description: rows[i].querySelector('.qb-desc').value,
        quantity: parseFloat(rows[i].querySelector('.qb-qty').value) || 0,
        rate: parseFloat(rows[i].querySelector('.qb-rate').value) || 0,
      });
    }
    return {
      business: { name: val('inv-biz-name'), address: val('inv-biz-addr'), email: val('inv-biz-email') },
      client: { name: val('inv-cli-name'), address: val('inv-cli-addr'), email: val('inv-cli-email') },
      number: val('inv-number'),
      date: val('inv-date'),
      due: val('inv-due'),
      items: list,
      taxRate: parseFloat(val('inv-tax')) || 0,
      currency: val('inv-currency') || '$',
      notes: val('inv-notes'),
      template: template,
    };
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function make() {
    clearError();
    var inv = gather();
    if (!inv.items.some(function (it) { return it.description || it.quantity || it.rate; })) {
      fail('Add at least one line before saving.');
      return;
    }
    var btn = $('inv-make');
    var was = btn.textContent;
    btn.textContent = 'Working...';
    btn.disabled = true;
    ready().then(function () {
      return kit.renderInvoicePdf(inv);
    }).then(function (bytes) {
      var safe = (inv.number || 'invoice').replace(/[^\w.-]+/g, '_') || 'invoice';
      download(new Blob([bytes], { type: 'application/pdf' }), safe + '.pdf');
    }).catch(function (err) {
      fail((err && err.message) || String(err));
    }).then(function () { btn.textContent = was; btn.disabled = false; });
  }

  // -------------------------------------------------------------- wiring
  $('inv-add').addEventListener('click', function () { addRow(); recompute(); });
  $('inv-make').addEventListener('click', make);
  items.addEventListener('input', recompute);
  $('inv-tax').addEventListener('input', recompute);
  $('inv-currency').addEventListener('input', recompute);

  var tplBtns = document.querySelectorAll('.qb-tpl');
  for (var i = 0; i < tplBtns.length; i++) {
    (function (btn) { btn.addEventListener('click', function () { setTemplate(btn.getAttribute('data-tpl')); }); })(tplBtns[i]);
  }

  // "Clear the form" (a toolbar button the File menu also points at) resets it.
  $('inv-clear').addEventListener('click', function () {
    var inputs = document.querySelectorAll('.qb-sheet input, .qb-sheet textarea');
    for (var j = 0; j < inputs.length; j++) {
      if (inputs[j].id === 'inv-currency') inputs[j].value = '$';
      else if (inputs[j].id === 'inv-number') inputs[j].value = 'INV-001';
      else if (inputs[j].id === 'inv-tax') inputs[j].value = '0';
      else inputs[j].value = '';
    }
    items.innerHTML = '';
    addRow(); addRow(); addRow();
    prefillDate();
    recompute();
    clearError();
  });

  function prefillDate() {
    var d = new Date();
    var iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (!val('inv-date')) $('inv-date').value = iso;
  }

  // Start with a few empty lines and today's date.
  addRow(); addRow(); addRow();
  prefillDate();
  recompute();
})();

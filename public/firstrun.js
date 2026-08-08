/* 1999.LOC first-run dialog.
 *
 * Every tool used to explain itself down the page: what it is, the warning
 * that matters, the honest notes, the privacy proof, a footer. On a phone
 * that is a screenful of application followed by four screenfuls of reading,
 * and the reading is between you and the Back button.
 *
 * So the prose moved inside. Each page keeps it in a hidden #first-run
 * block of <section data-step="Title"> elements; this builds a modal out of
 * them with Back and Next, shows it once, and remembers that it did. After
 * that it is behind Help, where a program's explanation of itself belongs.
 *
 * The prose is still in the page's markup, which is what matters for anyone
 * reading the source or indexing it. It is display:none rather than absent.
 *
 * Progressive enhancement, like everything else here: with scripting off the
 * block is revealed by CSS instead and reads as it always did, one section
 * after another, below the tool.
 */
(function () {
  'use strict';

  var source = document.getElementById('first-run');
  if (!source) return;

  var app = document.body.getAttribute('data-app') || 'app';
  var KEY = 'loc1999:seen:' + app;

  var steps = [].slice.call(source.querySelectorAll('[data-step]'));
  if (!steps.length) return;

  /* Taking the sections out of the page and into the dialog, rather than
   * copying them, keeps one copy of every id: the privacy proof panel is a
   * live control with an id, and two of it would leave the wrong one wired. */
  var at = 0;
  var back, next, title, count, body, dialog, sheet;

  function build() {
    dialog = document.createElement('div');
    dialog.className = 'fr-back hidden';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'fr-title');

    sheet = document.createElement('div');
    sheet.className = 'fr-box';

    var bar = document.createElement('p');
    bar.className = 'fr-title';
    title = document.createElement('span');
    title.id = 'fr-title';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'fr-x';
    close.textContent = 'x';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', dismiss);
    bar.appendChild(title);
    bar.appendChild(close);

    body = document.createElement('div');
    body.className = 'fr-body';
    steps.forEach(function (step) { body.appendChild(step); });

    var foot = document.createElement('p');
    foot.className = 'fr-foot';
    count = document.createElement('span');
    count.className = 'fr-count';
    back = document.createElement('button');
    back.type = 'button';
    back.textContent = '< Back';
    back.addEventListener('click', function () { go(at - 1); });
    next = document.createElement('button');
    next.type = 'button';
    next.className = 'fr-next';
    next.addEventListener('click', function () {
      if (at === steps.length - 1) dismiss(); else go(at + 1);
    });
    foot.appendChild(count);
    foot.appendChild(back);
    foot.appendChild(next);

    sheet.appendChild(bar);
    sheet.appendChild(body);
    sheet.appendChild(foot);
    dialog.appendChild(sheet);
    document.body.appendChild(dialog);

    // Clicking the dark behind it closes; clicking the dialog does not.
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dismiss();
    });
    document.addEventListener('keydown', function (event) {
      if (dialog.classList.contains('hidden')) return;
      if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
      if (event.key === 'ArrowRight' && at < steps.length - 1) go(at + 1);
      if (event.key === 'ArrowLeft' && at > 0) go(at - 1);
    });
  }

  function go(index) {
    at = Math.max(0, Math.min(steps.length - 1, index));
    steps.forEach(function (step, i) { step.classList.toggle('hidden', i !== at); });
    title.textContent = steps[at].getAttribute('data-step');
    count.textContent = (at + 1) + ' of ' + steps.length;
    back.disabled = at === 0;
    next.textContent = at === steps.length - 1 ? 'Close' : 'Next >';
    body.scrollTop = 0;
  }

  function open() {
    dialog.classList.remove('hidden');
    go(0);
    next.focus();
  }

  function dismiss() {
    dialog.classList.add('hidden');
    try { localStorage.setItem(KEY, '1'); } catch (e) { /* private mode */ }
  }

  function seen() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }

  build();
  source.remove();          // its sections live in the dialog now

  /* Anything marked data-help opens it again: the Help title in each app's
   * menu bar, which until now was a word that did nothing. */
  [].slice.call(document.querySelectorAll('[data-help]')).forEach(function (el) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.addEventListener('click', open);
    el.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    });
  });

  if (!seen()) open();
})();

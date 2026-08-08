/* 1999.LOC warnings that pop rather than sit in the way.
 *
 * A wallet in a browser tab needs to say some frightening and true things
 * about itself, and they were said in the middle of the wallet: a folded
 * notice box between the tabs you press and the buttons you press, in
 * every panel, forever. The first time you read it that is honest. The
 * second time it is furniture, and by the tenth it is the thing you scroll
 * past to reach the wallet, which means the one reader who needed it has
 * learned to skip it too.
 *
 * So a warning is a dialog now. It opens by itself the first time you look
 * at the wallet it belongs to, once, and after that it is behind the ! in
 * that wallet's toolbar. Same words, same file, same place in the markup
 * for anyone reading the source; out of the road of the program.
 *
 * Markup:
 *
 *   <div class="warn-source" data-warn="xmr" data-warn-panel="wallet"
 *        data-warn-title="Before you put a coin in it">
 *     <p>...</p>
 *   </div>
 *
 * data-warn        the storage key, so each warning is dismissed on its own
 * data-warn-panel  the [data-panel] whose first showing opens it (optional:
 *                  without it the warning only ever opens on request)
 * data-warn-title  the dialog's title bar
 *
 * Anything marked data-warn-open="<key>" opens that one again.
 *
 * It borrows the first-run dialog's .fr-* furniture rather than growing a
 * second set of dialog styles, because it is the same object: a thing the
 * program has to say, said once, with a way back to it.
 *
 * Progressive enhancement, like the rest: with scripting off no dialog is
 * built, and the CSS leaves the blocks where they are to be read down the
 * page as they always were.
 */
(function () {
  'use strict';

  var sources = [].slice.call(document.querySelectorAll('[data-warn]'));
  if (!sources.length) return;

  var built = {};          // key -> { open, dialog }

  function seen(key) {
    try { return localStorage.getItem('loc1999:warned:' + key) === '1'; }
    catch (e) { return false; }
  }
  function remember(key) {
    try { localStorage.setItem('loc1999:warned:' + key, '1'); }
    catch (e) { /* private mode: it will ask again, which is the safe way to fail */ }
  }

  function build(source) {
    var key = source.getAttribute('data-warn');

    var dialog = document.createElement('div');
    dialog.className = 'fr-back hidden';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');

    var sheet = document.createElement('div');
    sheet.className = 'fr-box';

    var bar = document.createElement('p');
    bar.className = 'fr-title';
    var title = document.createElement('span');
    title.textContent = source.getAttribute('data-warn-title') || 'Please read this';
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'fr-x';
    x.textContent = 'x';
    x.setAttribute('aria-label', 'Close');
    bar.appendChild(title);
    bar.appendChild(x);

    var body = document.createElement('div');
    body.className = 'fr-body';
    /* Moved, not copied. Two of any id in here would leave the wrong one
       wired, and these blocks carry links the page counts. */
    while (source.firstChild) body.appendChild(source.firstChild);

    var foot = document.createElement('p');
    foot.className = 'fr-foot';
    var note = document.createElement('span');
    note.className = 'fr-count';
    note.textContent = 'Shown once. The ! in the toolbar brings it back.';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'fr-next';
    ok.textContent = 'I have read this';
    foot.appendChild(note);
    foot.appendChild(ok);

    sheet.appendChild(bar);
    sheet.appendChild(body);
    sheet.appendChild(foot);
    dialog.appendChild(sheet);
    document.body.appendChild(dialog);

    function close() {
      dialog.classList.add('hidden');
      remember(key);
    }
    function open() {
      dialog.classList.remove('hidden');
      body.scrollTop = 0;
      ok.focus();
    }

    x.addEventListener('click', close);
    ok.addEventListener('click', close);
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) close();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !dialog.classList.contains('hidden')) {
        event.preventDefault();
        close();
      }
    });

    source.remove();
    built[key] = { open: open, panel: source.getAttribute('data-warn-panel') };
  }

  sources.forEach(build);

  /* The ! in a toolbar, and anything else that asks for one by name. */
  [].slice.call(document.querySelectorAll('[data-warn-open]')).forEach(function (el) {
    el.addEventListener('click', function () {
      var entry = built[el.getAttribute('data-warn-open')];
      if (entry) entry.open();
    });
  });

  /* One dialog at a time.
   *
   * tabs.js fires tab:shown for the panel it opens on load, and on a first
   * visit firstrun.js is about to put its own dialog up over the same
   * screen. Two modals stacked is not a warning, it is a pile. So an
   * automatic warning waits for the screen to be clear and then takes its
   * turn: the program introduces itself, and when you close that, the
   * wallet you landed in tells you what it is. A warning asked for by name
   * never waits, because you asked for it. */
  var pending = null;
  function drain() {
    if (!pending) return;
    if (document.querySelector('.fr-back:not(.hidden)')) {
      setTimeout(drain, 250);
      return;
    }
    var entry = pending;
    pending = null;
    entry.open();
  }

  /* First look at a wallet opens that wallet's warning. Arriving at #btc is
     the same as switching to it. */
  var root = document.querySelector('[data-tabs]');
  if (!root) return;
  root.addEventListener('tab:shown', function (event) {
    var name = event.detail && event.detail.tab;
    Object.keys(built).forEach(function (key) {
      if (built[key].panel !== name || seen(key)) return;
      /* Marked read as soon as it is queued rather than when it closes: a
         reader who switches tabs twice before the first dialog gets its
         turn should not end up with a queue of them. */
      remember(key);
      pending = built[key];
    });
    drain();
  });
})();

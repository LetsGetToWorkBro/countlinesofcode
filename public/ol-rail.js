/* 1999.LOC mail client: the folder rail is the navigation.
 *
 * There used to be a row of tabs above the client reading "Disposable inbox"
 * and "Check a message", sitting above a folder pane that did nothing. Two
 * navigations, one of them decorative, for one program.
 *
 * So the tabs went and the rail took the job, which is what a folder pane is
 * for and what makes it worth drawing at all. An entry with data-view shows
 * the panel with the matching data-view-panel; the four folders without one
 * are marked is-inert and say so when you point at them, rather than
 * pretending to be places you can go.
 *
 * Progressive enhancement, like everything else here: with scripting off both
 * panels are simply open, one after the other, and every control in them
 * still works.
 */
(function () {
  'use strict';

  var rail = document.getElementById('ol-rail');
  if (!rail) return;

  var entries = [].slice.call(rail.querySelectorAll('[data-view]'));
  var panels = [].slice.call(document.querySelectorAll('[data-view-panel]'));
  if (!entries.length || !panels.length) return;

  rail.querySelectorAll('.is-inert').forEach(function (el) {
    el.title = 'This folder is here because a mail client has one. Nothing is in it.';
  });

  function show(name) {
    entries.forEach(function (el) {
      el.classList.toggle('is-current', el.getAttribute('data-view') === name);
    });
    panels.forEach(function (el) {
      el.classList.toggle('hidden', el.getAttribute('data-view-panel') !== name);
    });
    /* The address bar belongs to the inbox and nothing else: it is the
     * account you are looking at, and a checker has no account. */
    var addr = document.querySelector('.ol-addr');
    if (addr) addr.classList.toggle('hidden', name !== 'inbox');
  }

  entries.forEach(function (el) {
    el.addEventListener('click', function () { show(el.getAttribute('data-view')); });
    el.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      show(el.getAttribute('data-view'));
    });
  });

  show('inbox');
})();

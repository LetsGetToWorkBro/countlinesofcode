/* 1999.LOC desktop window manager. The smallest one ever shipped.
 *
 * Progressive enhancement only: without this file every window is simply
 * open and the taskbar carries plain anchors, so nothing needs JavaScript.
 * With it, things boot the way a desktop should: windows minimised to the
 * taskbar, restored when their button is pressed, minimised again from the
 * button or the _ in their title bar. A #hash in the URL (or following a
 * link to one) opens the window that holds the target.
 *
 * Runs on the landing desktop (.desktop), where windows boot minimised, and
 * on every tool page's patch of desk (.desk-shell), where the app you came
 * for boots open but can be minimised to the taskbar and restored.
 */
(function () {
  'use strict';

  var desk = document.querySelector('.desktop, .desk-shell');
  if (!desk) return;
  desk.classList.add('desk-js');

  /* The window a #hash refers to: the window itself, or the one holding the
   * element or tab panel the hash names. Tool pages deep-link to tabs
   * (#inbox, #pgp), and those must open the app, not leave it minimised. */
  function windowFor(hash) {
    if (!hash) return null;
    var id = hash.replace(/^#/, '');
    if (!/^[\w-]+$/.test(id)) return null;
    var el = document.getElementById(id) ||
             document.querySelector('[data-panel="' + id + '"]');
    return el ? el.closest('.app-window') : null;
  }

  function buttonFor(win) {
    return document.querySelector('.taskbar .task-btn[href="#' + win.id + '"]');
  }

  function setOpen(win, open) {
    win.classList.toggle('is-open', open);
    var button = buttonFor(win);
    if (button) button.classList.toggle('is-open', open);
  }

  function toggleFrom(hash, scroll) {
    var win = windowFor(hash);
    if (!win) return false;
    var opening = !win.classList.contains('is-open');
    setOpen(win, opening);
    if (opening && scroll) win.scrollIntoView({ block: 'nearest' });
    return true;
  }

  // Taskbar buttons toggle their window; Start opens the tools window.
  Array.prototype.forEach.call(document.querySelectorAll('.taskbar .task-btn, .taskbar .start'), function (el) {
    el.addEventListener('click', function (event) {
      var hash = el.getAttribute('href');
      if (!windowFor(hash)) return;   // a real link (Start on tool pages): let it navigate
      event.preventDefault();
      if (el.classList.contains('start')) {
        var win = windowFor(hash);
        setOpen(win, true);
        win.scrollIntoView({ block: 'nearest' });
      } else {
        toggleFrom(hash, true);
      }
    });
  });

  // The _ in a window's title bar minimises it.
  Array.prototype.forEach.call(document.querySelectorAll('.win-min'), function (el) {
    el.addEventListener('click', function (event) {
      event.preventDefault();
      var win = el.closest('.app-window');
      if (win) setOpen(win, false);
    });
  });

  /* The landing desktop boots minimised, except a window the URL asks for.
   * A tool page boots its app open: the visitor clicked its icon to get
   * here, and a tool drawing inside a display:none window would measure a
   * zero-size layout. setOpen still runs so every taskbar button matches
   * what is actually open. */
  var isShell = desk.classList.contains('desk-shell');
  var wanted = windowFor(location.hash);
  Array.prototype.forEach.call(desk.querySelectorAll('.app-window'), function (win) {
    setOpen(win, isShell || win === wanted);
  });

  // Following an in-page anchor later (e.g. a link elsewhere) opens it too.
  window.addEventListener('hashchange', function () {
    var win = windowFor(location.hash);
    if (win) { setOpen(win, true); win.scrollIntoView({ block: 'nearest' }); }
  });
})();

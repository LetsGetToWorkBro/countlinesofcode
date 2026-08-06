/* 1999.LOC desktop window manager. The smallest one ever shipped.
 *
 * Progressive enhancement only: without this file the landing page shows its
 * three windows open and the taskbar buttons are plain anchors, so nothing
 * needs JavaScript. With it, the desktop boots the way a desktop should —
 * windows minimised to the taskbar, restored when their button is pressed,
 * minimised again from the button or the _ in their title bar. A #hash in the
 * URL (or following a link to one) opens that window.
 */
(function () {
  'use strict';

  var desktop = document.querySelector('.desktop');
  if (!desktop) return;
  desktop.classList.add('desk-js');

  function windowFor(hash) {
    if (!hash) return null;
    var id = hash.replace(/^#/, '');
    var el = document.getElementById(id);
    return el && el.classList.contains('app-window') ? el : null;
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

  // Boot minimised, except a window the URL asks for.
  var wanted = windowFor(location.hash);
  if (wanted) setOpen(wanted, true);

  // Following an in-page anchor later (e.g. a link elsewhere) opens it too.
  window.addEventListener('hashchange', function () {
    var win = windowFor(location.hash);
    if (win) { setOpen(win, true); win.scrollIntoView({ block: 'nearest' }); }
  });
})();

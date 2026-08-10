/* 1999.LOC generic function toolbar. Vanilla JS, no build step.
 *
 * A row of buttons at the top of an app that each stand for a function the app
 * already has, for the visitors who want the button rather than the menu. A
 * toolbar button carries data-acts="id"; pressing it presses the control with
 * that id, and it mirrors that control's state, so a button whose control is
 * hidden or disabled (a "Start" with nothing to start yet) greys out on its
 * own, the same way the menu items do. It reads and writes nothing but public
 * DOM and calls into no engine, so it cannot change what an app does; it only
 * surfaces what is already there.
 */
(function () {
  'use strict';

  var buttons = [].slice.call(document.querySelectorAll('[data-acts]'));
  if (!buttons.length) return;

  function target(b) { return document.getElementById(b.getAttribute('data-acts')); }
  // A control is not usable if it is missing, disabled, or inside something
  // hidden (offsetParent goes null under display:none).
  function unusable(t) { return !t || t.disabled || t.offsetParent === null; }

  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      var t = target(b);
      if (t && !unusable(t)) t.click();
    });
  });

  var pending = 0;
  function sync() {
    pending = 0;
    buttons.forEach(function (b) {
      var u = unusable(target(b));
      // Only write when it changes, or the observer below would see our own
      // edit and reschedule forever.
      if (b.disabled !== u) b.disabled = u;
    });
  }
  function schedule() { if (!pending) pending = requestAnimationFrame(sync); }

  sync();

  // The app shows and hides blocks as it runs; re-sync when it does.
  var scope = document.getElementById('app') || document.body;
  if (window.MutationObserver) {
    new MutationObserver(schedule).observe(scope, {
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'disabled'],
      childList: true,
      subtree: true,
    });
  }
  document.addEventListener('click', schedule, true);
  window.addEventListener('load', sync);
})();

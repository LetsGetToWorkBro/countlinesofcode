/* 1999.LOC lightweight tabs. Vanilla JS, no build step, CSP-safe (external
 * file, no inline handlers).
 *
 * Markup it drives:
 *
 *   <div data-tabs>
 *     <p role="tablist">
 *       <button class="sheet-tab" data-tab="check">Check a message</button>
 *       <button class="sheet-tab" data-tab="inbox">Throwaway inbox</button>
 *     </p>
 *     <div data-panel="check">...</div>
 *     <div data-panel="inbox" class="hidden">...</div>
 *   </div>
 *
 * The panel whose name matches location.hash (e.g. #inbox) opens on load;
 * otherwise the first one. Switching tab updates the hash, so /email.html#inbox
 * deep-links straight to a tab and the browser Back button moves between them.
 *
 * Each switch fires two CustomEvents on the [data-tabs] container:
 *   'tab:shown'  detail:{tab}   — the panel now visible
 *   'tab:hidden' detail:{tab}   — the panel just hidden (not fired on first show)
 * A page script uses these to start work only when its tab is opened (the
 * throwaway inbox does not poll until you look at it) and to stop when you leave.
 * This script loads AFTER the page scripts so their listeners exist before the
 * initial 'tab:shown' fires.
 */
(function () {
  'use strict';

  function setup(root) {
    var panels = Array.prototype.slice.call(root.querySelectorAll('[data-panel]'));
    var names = panels.map(function (p) { return p.getAttribute('data-panel'); });

    /* A tab control does not have to live in the tab strip.
     *
     * These used to be gathered from inside the container only, which meant
     * a panel could be reached from one place and one place alone. A menu
     * item that opens a panel had to be a proxy that clicked the strip's
     * button instead, and it went dead the moment that button was not on
     * screen. Anything anywhere naming a panel of this root is a control
     * for it now, which is how a File menu has always worked: the same
     * command, reachable twice. */
    var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-tab]'))
      .filter(function (b) {
        return names.indexOf(b.getAttribute('data-tab')) !== -1 &&
               (root.contains(b) || !b.closest('[data-tabs]'));
      });
    if (!buttons.length) return;
    var current = null;

    function show(name, updateHash) {
      /* Fall back to the first PANEL, not the first control.
       *
       * It used to be buttons[0], which was the same thing while every
       * control lived in the tab strip in panel order. Now that a menu item
       * can be one, buttons[0] is whichever appears first in the document,
       * and the menu bar sits above the strip: the page booted on the paper
       * wallet because its File item was the first [data-tab] in the file.
       * The panels are the running order; the controls are just ways in. */
      if (names.indexOf(name) === -1) name = names[0];
      if (name === current) return;
      var prev = current;
      current = name;

      buttons.forEach(function (b) {
        var on = b.getAttribute('data-tab') === name;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      panels.forEach(function (p) {
        p.classList.toggle('hidden', p.getAttribute('data-panel') !== name);
      });

      if (updateHash) {
        try { history.replaceState(null, '', '#' + name); }
        catch (e) { location.hash = name; }
      }

      if (prev !== null) root.dispatchEvent(new CustomEvent('tab:hidden', { detail: { tab: prev } }));
      root.dispatchEvent(new CustomEvent('tab:shown', { detail: { tab: name } }));
    }

    buttons.forEach(function (b) {
      b.addEventListener('click', function () { show(b.getAttribute('data-tab'), true); });
    });

    // Follow the Back/Forward buttons when they only change the fragment.
    window.addEventListener('hashchange', function () {
      show((location.hash || '').replace(/^#/, ''), false);
    });

    show((location.hash || '').replace(/^#/, '') || names[0], false);
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tabs]'), setup);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

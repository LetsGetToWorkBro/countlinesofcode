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
    var buttons = Array.prototype.slice.call(root.querySelectorAll('[data-tab]'));
    var panels = Array.prototype.slice.call(root.querySelectorAll('[data-panel]'));
    if (!buttons.length) return;
    var current = null;

    function names() {
      return buttons.map(function (b) { return b.getAttribute('data-tab'); });
    }

    function show(name, updateHash) {
      if (names().indexOf(name) === -1) name = buttons[0].getAttribute('data-tab');
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

    show((location.hash || '').replace(/^#/, '') || buttons[0].getAttribute('data-tab'), false);
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tabs]'), setup);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

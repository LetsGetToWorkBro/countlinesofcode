/* 1999.LOC menu bars that actually open.
 *
 * Every app here grew a menu bar reading File / Edit / View / Help, and none
 * of them opened anything. The note in the stylesheet called it "a label
 * rather than a promise", which was a nice way of saying the first thing
 * anybody taps does nothing. Worse on a phone: the titles were spans with a
 * hover style, and a span with a hover style on iOS takes one tap to hover
 * and a second to activate, so even the one that did work needed two taps
 * and read as broken.
 *
 * So they open now. A title is a <button>, which a touchscreen treats as a
 * thing to press; a menu is a list of <button>s; and each item names an
 * existing control:
 *
 *   data-cmd="t-open"     click the element with that id
 *   data-pick=".tbtn[..]" click the first element matching that selector
 *
 * Nothing here reimplements a command. The menu is a second way to reach the
 * button on the toolbar, which is what a menu bar has always been, and it
 * means an item cannot drift away from what it claims to do. An item whose
 * control is disabled is disabled with it, worked out each time the menu
 * opens rather than guessed at.
 *
 * Progressive enhancement: with scripting off the titles are buttons that do
 * nothing and the drops stay closed, which is no worse than the spans were.
 */
(function () {
  'use strict';

  var menus = [].slice.call(document.querySelectorAll('.menu'));
  if (!menus.length) return;

  function target(item) {
    var id = item.getAttribute('data-cmd');
    if (id) return document.getElementById(id);
    var pick = item.getAttribute('data-pick');
    return pick ? document.querySelector(pick) : null;
  }

  /* Reaching a menu item means whatever its control is. A button or a link,
   * or a div dressed as one, is pressed. A checkbox or radio is toggled,
   * which is a press too. A field you fill in is brought into view and given
   * the cursor instead, because "Quality..." should land you in the quality
   * box: clicking at a text box or a select does nothing, which is most of
   * why the menus read as dead. Help has no control and firstrun listens for
   * it directly, so a missing one is simply left alone. */
  function activate(control) {
    if (!control) return;
    var tag = control.tagName;
    var type = (control.type || '').toLowerCase();
    var isField = (tag === 'INPUT' && type !== 'checkbox' && type !== 'radio' &&
                   type !== 'button' && type !== 'submit' && type !== 'reset' && type !== 'file') ||
                  tag === 'SELECT' || tag === 'TEXTAREA';
    if (isField) {
      if (control.scrollIntoView) control.scrollIntoView({ block: 'nearest' });
      if (control.focus) control.focus();
    } else {
      control.click();
    }
  }

  function closeAll(except) {
    menus.forEach(function (menu) {
      if (menu === except) return;
      menu.classList.remove('is-open');
      var title = menu.querySelector('.menu-title');
      if (title) title.setAttribute('aria-expanded', 'false');
    });
  }

  function open(menu) {
    closeAll(menu);
    /* Work out what is available at the moment it is asked for. A menu built
     * once at load would offer Save on a window with no document in it. */
    [].slice.call(menu.querySelectorAll('[data-cmd], [data-pick]')).forEach(function (item) {
      var control = target(item);
      item.disabled = !control || control.disabled ||
        (control.offsetParent === null && control.tagName !== 'INPUT');
    });
    menu.classList.add('is-open');
    menu.querySelector('.menu-title').setAttribute('aria-expanded', 'true');
  }

  menus.forEach(function (menu) {
    var title = menu.querySelector('.menu-title');
    if (!title) return;
    title.setAttribute('aria-expanded', 'false');
    title.setAttribute('aria-haspopup', 'true');

    title.addEventListener('click', function (event) {
      event.stopPropagation();
      if (menu.classList.contains('is-open')) closeAll();
      else open(menu);
    });

    menu.addEventListener('click', function (event) {
      var item = event.target.closest ? event.target.closest('[data-cmd], [data-pick], [data-help]') : null;
      if (!item || item.classList.contains('menu-title')) return;
      closeAll();
      activate(target(item));
    });
  });

  document.addEventListener('click', function () { closeAll(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeAll();
  });

  /* Left and right walk the bar, the way a menu bar has always done. */
  var titles = menus.map(function (m) { return m.querySelector('.menu-title'); }).filter(Boolean);
  titles.forEach(function (title, i) {
    title.addEventListener('keydown', function (event) {
      var step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      var to = titles[(i + step + titles.length) % titles.length];
      to.focus();
      if (menus[i].classList.contains('is-open')) open(to.parentNode);
    });
  });
})();

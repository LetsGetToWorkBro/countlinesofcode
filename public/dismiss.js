/* 1999.LOC: a warning you have read is a warning you can put away.
 *
 * The yellow boxes are the ones that matter, which is exactly why they are
 * yellow and exactly why they must not be permanent furniture. A person who
 * has read "this inbox is not private" and gone on using it anyway has made
 * a decision; leaving the box there for every visit afterwards costs them a
 * chunk of a phone screen and teaches them to stop reading yellow boxes,
 * which is the opposite of what it is for.
 *
 * So each one gets an x. Dismissing is remembered per box per app, and the
 * whole text is still in Help, which is where it also lives for anyone who
 * closed it and wants it back.
 *
 * Keyed by the box's own summary text rather than by position, so adding a
 * warning above an existing one does not silently un-dismiss it or, worse,
 * dismiss the new one on its behalf.
 */
(function () {
  'use strict';

  var app = document.body.getAttribute('data-app') || 'app';
  var boxes = [].slice.call(document.querySelectorAll('.notice-box'));
  if (!boxes.length) return;

  function keyFor(box) {
    var summary = box.querySelector('summary');
    var text = (summary ? summary.textContent : box.textContent) || '';
    // A short, stable digest of the wording: enough to tell two boxes apart,
    // short enough to be a sane storage key.
    var hash = 0;
    for (var i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return 'loc1999:read:' + app + ':' + (hash >>> 0).toString(36);
  }

  function remember(key) {
    try { localStorage.setItem(key, '1'); } catch (e) { /* private mode */ }
  }
  function alreadyRead(key) {
    try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
  }

  boxes.forEach(function (box) {
    // A box inside the first-run dialog is the explanation itself; it has a
    // Close button of its own and must not grow a second one.
    if (box.closest('#first-run')) return;

    var key = keyFor(box);
    if (alreadyRead(key)) { box.classList.add('hidden'); return; }

    /* A .notice-box with no summary is not a warning: it is an output
     * region the tool fills in, like the key-profile panel on the
     * encryption page. Nothing to dismiss and nothing to remember. */
    var summary = box.querySelector('summary');
    if (!summary) return;
    var shut = document.createElement('button');
    shut.type = 'button';
    shut.className = 'notice-x';
    shut.textContent = 'x';
    shut.title = 'I have read this. It stays in Help.';
    shut.setAttribute('aria-label', 'Dismiss this warning');
    shut.addEventListener('click', function (event) {
      // The summary is a toggle; dismissing must not also open the box on
      // the way out.
      event.preventDefault();
      event.stopPropagation();
      box.classList.add('hidden');
      remember(key);
    });
    summary.appendChild(shut);
  });
})();

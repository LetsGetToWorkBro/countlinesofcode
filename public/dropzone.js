/* 1999.LOC drop-zone state. Vanilla JS, no build step.
 *
 * The empty screen of a file tool is one big drop target, which is what you
 * want when there is nothing open yet. Once a file is in, that same target is
 * just an "open another" and should get out of the way, so this slims it the
 * moment a file is chosen or dropped. It only adds a class; the app's own
 * open logic is untouched.
 */
(function () {
  'use strict';
  var dz = document.getElementById('drop');
  if (!dz) return;

  function slim() { dz.classList.add('dz-loaded'); }

  // A file chosen through the hidden <input>, wherever it sits.
  var input = dz.querySelector('input[type="file"]') || document.getElementById('file-input');
  if (input) {
    input.addEventListener('change', function () {
      if (input.files && input.files.length) slim();
    });
  }
  // Or one dropped straight on the zone. Capture, so it fires whatever the
  // app's own handler does with the event.
  dz.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) slim();
  }, true);
})();

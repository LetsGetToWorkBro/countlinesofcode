/* 1999.LOC drop-zone state. Vanilla JS, no build step.
 *
 * The empty screen of a file tool is one big drop target, which is what you
 * want when there is nothing open yet. Once a file is in, that same target is
 * just an "open another" and should get out of the way, so this slims it the
 * moment a file is chosen or dropped. It only adds a class; the app's own
 * open logic is untouched.
 *
 * Both listeners run in the capture phase, and that is load-bearing. An app
 * reads the file in its own change handler and then clears the input so the
 * same file can be picked twice, and a bubble-phase listener registered after
 * the app's would see an input with no files left on it. Capture fires before
 * the app's handler, while the file is still there to see.
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
    }, true);
  }
  // Or one dropped straight on the zone.
  dz.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) slim();
  }, true);
})();

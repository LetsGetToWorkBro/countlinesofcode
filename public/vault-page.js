/* 1999.LOC — showing a Monero file to a Labyrinth Vault. Vanilla JS, no build step.
 *
 * A file goes in and codes come out. That is the whole program, and everything
 * interesting about it is what it refuses to do.
 *
 * It never uploads. There is no endpoint on this site that would take one of
 * these, the page's Content-Security-Policy is `script-src 'self'`, and the
 * file is read with a FileReader into a Uint8Array that stays in the tab. The
 * device on the other end has no radio at all, which is the point of it.
 *
 * It never claims a signature comes back. A wallet2 file is the *sending*
 * wallet's account of its own transaction, so a vault will not sign one; it
 * opens the file, shows what it claims, and stops. The panel says so above the
 * fold and this script never draws anything that suggests otherwise.
 *
 * It never animates a file the vault would only name back at you. `offerFile`
 * in /vaultwire.js decides, using the same table the vault uses, so a signed
 * transaction set or a multisig container is refused here rather than after
 * somebody has fetched a phone out of a drawer.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var panel = document.querySelector('[data-panel="vault"]');
  if (!panel) return;

  var wire = null;   // window.LOC1999_VAULTWIRE
  var qr = null;     // window.LOC1999_QR
  var frames = [];
  var at = 0;
  var timer = 0;
  var cadence = 220;
  var paused = false;

  /* The cadence a person can change, and the reason there are only three
   * steps. 220ms is what the vault's companion uses and what an old camera
   * reads reliably; slower helps a bad camera in bad light, faster shortens
   * a long file for a good one. A slider would invite somebody to set it to
   * 40ms and conclude the vault is broken. */
  var STEPS = [400, 300, 220, 160, 120];

  function fail(message) {
    $('vw-error').textContent = message || '';
    if (message) $('vw-status').textContent = '';
  }
  function say(message) {
    $('vw-status').textContent = message || '';
    if (message) $('vw-error').textContent = '';
  }

  var loading = null;
  function ready() {
    if (wire && qr) return Promise.resolve();
    if (loading) return loading;
    loading = Promise.all([load('/vaultwire.js'), load('/qrkit.js')]).then(function () {
      wire = window.LOC1999_VAULTWIRE;
      qr = window.LOC1999_QR;
      if (!wire || !qr) throw new Error('the encoders did not load');
    });
    return loading;
  }

  function load(src) {
    return new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = src;
      tag.onload = function () { resolve(); };
      tag.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(tag);
    });
  }

  function bytesOf(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(new Error('that file could not be read')); };
      reader.readAsArrayBuffer(file);
    });
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = 0; }
  }

  function draw() {
    if (!frames.length) return;
    var text = frames[at % frames.length];
    /* Error correction M, the same level the vault's companion draws at. A
     * higher level would shrink the payload per code and lengthen the
     * animation; a lower one reads worse on a phone camera pointed at a
     * monitor, which is the exact situation this is for. */
    $('vw-code').innerHTML = qr.qrSvg(qr.encodeQr(text, 'M'), { scale: 6, margin: 4 });
    $('vw-count').textContent = 'Frame ' + ((at % frames.length) + 1) + ' of ' + frames.length
      + ' · pass ' + (Math.floor(at / frames.length) + 1);
  }

  function play() {
    stop();
    if (paused || frames.length <= 1) { draw(); return; }
    timer = setInterval(function () { at += 1; draw(); }, cadence);
    draw();
  }

  function reset() {
    stop();
    frames = [];
    at = 0;
    paused = false;
    $('vw-pause').textContent = 'Pause';
    $('vw-play').classList.add('hidden');
    $('vw-code').innerHTML = '';
  }

  function chose(file) {
    if (!file) return;
    reset();
    say('Reading ' + file.name + '…');
    ready()
      .then(function () { return bytesOf(file); })
      .then(function (bytes) {
        var offer = wire.offerFile(bytes);
        if (!offer.ok) {
          fail(offer.problem);
          return;
        }
        frames = wire.framesFor(bytes);
        if (!frames) {
          /* Unreachable unless the two functions ever disagree, and stated
             rather than assumed, because "cannot happen" is how a blank
             screen with no message gets shipped. */
          fail('That file was accepted and then produced no codes, which is a fault in this page.');
          return;
        }
        cadence = wire.FRAME_MS;
        say(offer.what + ' · ' + offer.frames + ' frame' + (offer.frames === 1 ? '' : 's')
          + ' · about ' + offer.seconds + 's a pass. Point the vault at this.');
        $('vw-cadence').textContent = cadence + ' ms a frame';
        $('vw-play').classList.remove('hidden');
        play();
      })
      .catch(function (error) {
        fail(error && error.message ? error.message : 'That file could not be read.');
      });
  }

  $('vw-file').addEventListener('change', function (event) {
    chose(event.target.files && event.target.files[0]);
    /* Cleared so that choosing the same file twice fires again. Somebody who
       re-exports a transaction under the same name would otherwise pick it
       and watch the old codes. */
    event.target.value = '';
  });

  $('vw-pause').addEventListener('click', function () {
    paused = !paused;
    $('vw-pause').textContent = paused ? 'Play' : 'Pause';
    play();
  });

  function shift(by) {
    var index = STEPS.indexOf(cadence);
    if (index === -1) index = STEPS.indexOf(220);
    index = Math.max(0, Math.min(STEPS.length - 1, index + by));
    cadence = STEPS[index];
    $('vw-cadence').textContent = cadence + ' ms a frame';
    play();
  }
  $('vw-slower').addEventListener('click', function () { shift(-1); });
  $('vw-faster').addEventListener('click', function () { shift(1); });

  /* Stop drawing when the tab is not the one on screen.
   *
   * Not a performance nicety: a code left running behind another panel is a
   * code somebody could still scan by accident, and a timer redrawing a QR
   * every 220ms in a hidden div is work nobody asked for. tabs.js fires these
   * on the container. */
  var root = panel.closest('[data-tabs]');
  if (root) {
    root.addEventListener('tab:hidden', function (event) {
      if (event.detail && event.detail.tab === 'vault') reset();
    });
  }
})();

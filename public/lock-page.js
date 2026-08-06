/* 1999.LOC password lock. Vanilla JS, no build step.
 *
 * Loaded on first use, both from this origin:
 *   /vendor/openpgp/openpgp.min.mjs — the cryptography
 *   /pgpkit.js                      — naming, the strength meter, passphrases
 *
 * Nothing here uploads anything. Neither the file nor the password leaves the
 * tab, and there is no endpoint for them to go to.
 *
 * The output is OpenPGP's symmetric mode — the same thing `gpg --symmetric`
 * writes — rather than a container of our own. That is the important decision
 * on this page: a bespoke format would work perfectly and would tie whoever you
 * send the file to to this page existing. The standard does not.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var pgp = null;   // the OpenPGP.js module
  var kit = null;   // window.LOC1999_PGP
  var toLock = null;
  var toUnlock = null;
  // One live URL per pane, tracked apart. A single shared list was a
  // regression: minting the lock pane's download revoked the unlock pane's
  // still-live link (and the reverse), so whichever result you produced second
  // silently broke the first pane's download button. Each pane only ever
  // replaces its own previous URL.
  var lockUrl = null;
  var unlockUrl = null;

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function lockObjectUrl(blob) {
    if (lockUrl) URL.revokeObjectURL(lockUrl);
    lockUrl = URL.createObjectURL(blob);
    return lockUrl;
  }

  function unlockObjectUrl(blob) {
    if (unlockUrl) URL.revokeObjectURL(unlockUrl);
    unlockUrl = URL.createObjectURL(blob);
    return unlockUrl;
  }

  function loadEngines() {
    if (pgp && kit) return Promise.resolve();
    return Promise.all([
      pgp ? null : import('/vendor/openpgp/openpgp.min.mjs'),
      kit ? null : new Promise(function (resolve, reject) {
        var el = document.createElement('script');
        el.src = '/pgpkit.js';
        el.onload = function () {
          kit = window.LOC1999_PGP;
          kit ? resolve() : reject(new Error('the helpers did not load'));
        };
        el.onerror = function () { reject(new Error('could not load the helpers')); };
        document.head.appendChild(el);
      }),
    ]).then(function (results) {
      if (results[0]) pgp = results[0];
    });
  }

  function formatBytes(n) {
    if (n < 1024) return Math.round(n) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ------------------------------------------------------------- the meter

  function updateMeter() {
    if (!kit) return;
    var value = $('password').value;
    var result = kit.strength(value);
    $('meter').innerHTML = value
      ? '<strong class="pw-' + result.verdict + '">' + esc(result.verdict) + '</strong>, about ' +
        result.bits + ' bits. ' + esc(result.note)
      : '';

    var confirm = $('confirm').value;
    $('match').textContent = !confirm ? '' : confirm === value ? 'matches' : 'these do not match';
    $('match').className = 'note' + (confirm && confirm !== value ? ' error-inline' : '');
    updateLockButton();
  }

  function updateLockButton() {
    var value = $('password').value;
    $('lock').disabled = !toLock || !value || value !== $('confirm').value;
  }

  function updateWordsNote() {
    if (!kit) return;
    var words = Number($('words').value);
    $('words-note').textContent = kit.passphraseBits(words) + ' bits of real randomness';
  }

  // -------------------------------------------------------------- locking

  function lock() {
    var password = $('password').value;
    if (!toLock || !password) return;

    $('lock-error').textContent = '';
    $('lock-output').innerHTML = '';
    $('lock-progress').textContent = 'Locking…';
    $('lock').disabled = true;

    var armored = $('armored').checked;
    toLock.arrayBuffer()
      .then(function (buffer) {
        return pgp.createMessage({ binary: new Uint8Array(buffer), filename: toLock.name });
      })
      .then(function (message) {
        // `passwords` is symmetric mode: no keys involved, the password itself
        // is stretched into the key that protects the session key.
        return pgp.encrypt({ message: message, passwords: [password], format: armored ? 'armored' : 'binary' });
      })
      .then(function (result) {
        var blob = armored
          ? new Blob([result], { type: 'application/pgp-encrypted' })
          : new Blob([result], { type: 'application/octet-stream' });
        var name = kit.lockedName(toLock.name, armored);
        $('lock-progress').textContent = '';
        $('lock-output').innerHTML =
          '<p><a id="lock-download" download="' + esc(name) + '" href="' + lockObjectUrl(blob) + '">Download ' +
          esc(name) + '</a> <span class="note">' + esc(formatBytes(blob.size)) + '</span></p>' +
          '<p class="note">Anyone can open it with <code>gpg -d ' + esc(name) +
          '</code>, or by dropping it into the unlock tab here.</p>';
      })
      .catch(function (err) {
        $('lock-progress').textContent = '';
        $('lock-error').textContent = (err && err.message) || String(err);
      })
      .then(function () { updateLockButton(); });
  }

  // ------------------------------------------------------------ unlocking

  function unlock() {
    var password = $('unpassword').value;
    if (!toUnlock) { $('unlock-error').textContent = 'Choose a locked file first.'; return; }

    $('unlock-error').textContent = '';
    $('unlock-output').innerHTML = '';
    $('unlock-progress').textContent = 'Unlocking…';
    $('unlock').disabled = true;

    toUnlock.arrayBuffer()
      .then(function (buffer) {
        var raw = new Uint8Array(buffer);
        // Armored output is text and binary output is not; the reader has to be
        // told which, so sniff it rather than trusting the extension.
        var head = new TextDecoder().decode(raw.subarray(0, 40));
        return head.indexOf('-----BEGIN PGP') >= 0
          ? pgp.readMessage({ armoredMessage: new TextDecoder().decode(raw) })
          : pgp.readMessage({ binaryMessage: raw });
      })
      .then(function (message) {
        return pgp.decrypt({ message: message, passwords: [password], format: 'binary' });
      })
      .then(function (result) {
        var name = kit.unlockedName(toUnlock.name, result.filename);
        var blob = new Blob([result.data], { type: 'application/octet-stream' });
        $('unlock-progress').textContent = '';
        $('unlock-output').innerHTML =
          '<p><a id="unlock-download" download="' + esc(name) + '" href="' + unlockObjectUrl(blob) + '">Download ' +
          esc(name) + '</a> <span class="note">' + esc(formatBytes(blob.size)) + '</span></p>';
      })
      .catch(function (err) {
        $('unlock-progress').textContent = '';
        $('unlock-error').textContent = readableError(err);
      })
      .then(function () { $('unlock').disabled = false; });
  }

  /* OpenPGP's messages are accurate and unhelpful. A wrong password is by far
     the most likely thing to have happened, and it is worth saying plainly. */
  function readableError(err) {
    var message = (err && err.message) || String(err);
    if (/incorrect key|session key decryption failed|passphrase|password/i.test(message)) {
      return 'That password does not open this file. There is no way to recover it: if it is lost, so is the file.';
    }
    if (/misformed|armor|packet|Unknown|Malformed/i.test(message)) {
      return 'That file is not something this can open. It should be a .gpg, .pgp or .asc written by this page or by GPG.';
    }
    return message;
  }

  // ---------------------------------------------------------------- wiring

  function wireDrop(zone, input, onFile) {
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
    });
    zone.addEventListener('dragover', function (event) { event.preventDefault(); zone.classList.add('is-over'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('is-over'); });
    zone.addEventListener('drop', function (event) {
      event.preventDefault();
      zone.classList.remove('is-over');
      var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) onFile(file);
    });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) onFile(input.files[0]);
    });
  }

  wireDrop($('drop'), $('file-input'), function (file) {
    toLock = file;
    loadEngines().then(function () {
      $('chosen').textContent = file.name + ', ' + formatBytes(file.size);
      updateMeter();
      updateWordsNote();
    }).catch(function (err) { $('lock-error').textContent = err.message; });
  });

  wireDrop($('undrop'), $('unfile-input'), function (file) {
    toUnlock = file;
    loadEngines().then(function () {
      $('unchosen').textContent = file.name + ', ' + formatBytes(file.size);
      return file.slice(0, 64).arrayBuffer();
    }).then(function (head) {
      if (head && !kit.looksEncrypted(new Uint8Array(head), file.name)) {
        $('unlock-error').textContent = 'That does not look like an encrypted file. Locked files here end in .gpg or .asc.';
      } else {
        $('unlock-error').textContent = '';
      }
    }).catch(function (err) { $('unlock-error').textContent = err.message; });
  });

  $('tab-lock').addEventListener('click', function () { switchMode(true); });
  $('tab-unlock').addEventListener('click', function () { switchMode(false); });

  function switchMode(locking) {
    $('mode-lock').classList.toggle('hidden', !locking);
    $('mode-unlock').classList.toggle('hidden', locking);
    $('tab-lock').classList.toggle('is-active', locking);
    $('tab-unlock').classList.toggle('is-active', !locking);
    // Loading early means the meter works before a file is chosen.
    loadEngines().then(updateWordsNote).catch(function () {});
  }

  ['password', 'confirm'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      loadEngines().then(updateMeter).catch(function () {});
    });
  });

  $('show').addEventListener('click', function () { toggleReveal($('password'), $('confirm'), $('show')); });
  $('unshow').addEventListener('click', function () { toggleReveal($('unpassword'), null, $('unshow')); });

  function toggleReveal(field, second, button) {
    var showing = field.type === 'text';
    field.type = showing ? 'password' : 'text';
    if (second) second.type = field.type;
    button.textContent = showing ? 'show' : 'hide';
  }

  $('suggest').addEventListener('click', function () {
    loadEngines().then(function () {
      var phrase = kit.makePassphrase(Number($('words').value));
      $('password').value = phrase;
      $('confirm').value = phrase;
      // Shown, because a passphrase nobody can read is a passphrase nobody
      // writes down, and this one has to be written down.
      $('password').type = 'text';
      $('confirm').type = 'text';
      $('show').textContent = 'hide';
      updateMeter();
    }).catch(function (err) { $('lock-error').textContent = err.message; });
  });

  $('words').addEventListener('change', function () {
    loadEngines().then(updateWordsNote).catch(function () {});
  });

  $('lock').addEventListener('click', lock);
  $('unlock').addEventListener('click', unlock);
  $('unpassword').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); unlock(); }
  });

  window.addEventListener('pagehide', function () {
    if (lockUrl) URL.revokeObjectURL(lockUrl);
    if (unlockUrl) URL.revokeObjectURL(unlockUrl);
    lockUrl = null;
    unlockUrl = null;
  });

  updateLockButton();
})();

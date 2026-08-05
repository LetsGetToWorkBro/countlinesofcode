/* 1999.LOC PGP page. Vanilla JS, no build step.
 *
 * Loaded on first use, both from this origin:
 *   /vendor/openpgp/openpgp.min.mjs — the cryptography
 *   /pgpkit.js                      — the keyring, armor sniffing, formatting
 *
 * Nothing here uploads anything. Private keys are generated in this tab, kept
 * in this browser's local storage, and never sent anywhere — there is no
 * keyserver and no endpoint.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var pgp = null;   // OpenPGP.js
  var kit = null;   // window.LOC1999_PGP
  var keys = [];    // StoredKey[]
  var liveUrls = [];

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fail(m) { $('error').textContent = m; $('status').textContent = ''; }
  function clearError() { $('error').textContent = ''; }
  function setStatus(m) { $('status').textContent = m; }

  function objectUrl(blob) {
    var url = URL.createObjectURL(blob);
    liveUrls.push(url);
    return url;
  }

  function ready() {
    if (pgp && kit) return Promise.resolve();
    setStatus('Loading the cryptography…');
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
      keys = kit.savedKeys();
      setStatus('');
    });
  }

  // ------------------------------------------------------------- keyring

  /* Everything a key says about itself, read from the key rather than from
     whatever the person who pasted it claimed. */
  function describeKey(key) {
    var users = key.getUserIDs();
    return {
      name: users.length ? users[0] : '(no name on this key)',
      fingerprint: key.getFingerprint(),
      created: key.getCreationTime(),
      algorithm: key.getAlgorithmInfo().algorithm,
    };
  }

  function renderKeyring() {
    if (!keys.length) {
      $('keyring').innerHTML = '<p class="note">No keys yet. Make one below, or import someone else\'s.</p>';
      fillPickers();
      return;
    }
    $('keyring').innerHTML = '<div class="key-list">' + keys.map(function (k, i) {
      return '<div class="key-row' + (k.kind === 'private' ? ' is-private' : '') + '">' +
        '<span class="key-kind">' + (k.kind === 'private' ? 'yours' : 'public') + '</span>' +
        '<span class="key-name">' + esc(k.name) + '</span>' +
        '<span class="key-print">' + esc(kit.formatFingerprint(k.fingerprint)) + '</span>' +
        '<span class="key-acts">' +
          '<button type="button" class="small key-copy" data-index="' + i + '">copy</button>' +
          '<button type="button" class="small key-save" data-index="' + i + '">save</button>' +
          (hasBothHalves(k.fingerprint)
            ? '<button type="button" class="small key-pair" data-index="' + i + '">save the pair</button>'
            : '') +
          '<button type="button" class="small key-drop" data-index="' + i + '">forget</button>' +
        '</span>' +
        '</div>';
    }).join('') + '</div>';
    $('keyring-actions').classList.toggle('hidden', keys.length === 0);
    fillPickers();
  }

  function hasBothHalves(fingerprint) {
    var kinds = keys.filter(function (k) { return k.fingerprint === fingerprint; })
      .map(function (k) { return k.kind; });
    return kinds.indexOf('public') !== -1 && kinds.indexOf('private') !== -1;
  }

  function halfOf(fingerprint, kind) {
    return keys.find(function (k) { return k.fingerprint === fingerprint && k.kind === kind; });
  }

  /* Downloads text as a file. Used for every kind of export here, so there is
     one place that decides the MIME type and one place that revokes. */
  function download(text, name) {
    var link = document.createElement('a');
    link.href = objectUrl(new Blob([text], { type: 'text/plain' }));
    link.download = name;
    link.click();
  }

  /* The dropdowns: public keys are who you can write to, private keys are who
     you can be. */
  function fillPickers() {
    var publics = keys.filter(function (k) { return k.kind === 'public'; });
    var privates = keys.filter(function (k) { return k.kind === 'private'; });
    // A private key carries its public half, so it can also be a recipient —
    // encrypting something to yourself is a normal thing to want.
    var recipients = publics.concat(privates);

    fill($('enc-to'), recipients, 'no keys yet, import one');
    fill($('enc-as'), privates, 'you have no private key');
    fill($('dec-key'), privates, 'you have no private key');
    fill($('sign-key'), privates, 'you have no private key');
  }

  function fill(select, list, empty) {
    var previous = select.value;
    select.innerHTML = list.length
      ? list.map(function (k) {
          return '<option value="' + esc(k.kind + ':' + k.fingerprint) + '">' + esc(k.name) + ' · ' +
            esc(kit.shortId(k.fingerprint)) + '</option>';
        }).join('')
      : '<option value="">' + esc(empty) + '</option>';
    if (previous) select.value = previous;
    select.disabled = list.length === 0;
  }

  function keyByValue(value) {
    var parts = String(value || '').split(':');
    return keys.find(function (k) { return k.kind === parts[0] && k.fingerprint === parts[1]; });
  }

  /* A private key, unlocked if it needs to be. A key with no passphrase
     decrypts trivially; one with the wrong passphrase says so plainly. */
  function privateKeyFrom(stored, passphrase) {
    return pgp.readPrivateKey({ armoredKey: stored.armored }).then(function (key) {
      if (key.isDecrypted()) return key;
      return pgp.decryptKey({ privateKey: key, passphrase: passphrase || '' }).catch(function () {
        throw new Error('That passphrase does not unlock "' + stored.name + '".');
      });
    });
  }

  function publicKeyFrom(stored) {
    return pgp.readKey({ armoredKey: stored.armored });
  }

  // ---------------------------------------------------------- generating

  /* What the chosen format actually produces, printed before anything is made
     rather than after. The sentences come from pgpkit, and test/pgpcrypto
     generates real keys with these options and checks they are true. */
  function showProfile() {
    if (!kit) return;
    var profile = kit.profileFor($('key-profile').value);
    $('profile-detail').innerHTML =
      '<p><strong>' + esc(profile.label) + '</strong></p>' +
      '<ul class="plain">' +
        '<li><strong>The key:</strong> ' + esc(profile.algorithms) + '.</li>' +
        '<li><strong>At rest:</strong> ' + esc(profile.protection) + '.</li>' +
        '<li><strong>Messages to it:</strong> ' + esc(profile.message) + '.</li>' +
        '<li><strong>Who can open it:</strong> ' + esc(profile.opens) + '</li>' +
      '</ul>' +
      (profile.id === 'modern'
        ? '<p class="note">Pick this when the only person who has to open it is you, or someone you know keeps their software current. The format is from 2024 and a good deal of what is installed out there predates it.</p>'
        : '<p class="note">The safe default. Same curve and the same mathematics as the modern option; what differs is how the packets are written and how your passphrase is stretched.</p>');
  }

  function updateMeter() {
    if (!kit) return;
    var value = $('key-pass').value;
    if (!value) {
      $('key-meter').innerHTML = '<span class="pw-warn">No passphrase: the key will be made and downloaded, but not kept here.</span>';
      return;
    }
    var result = kit.strength(value);
    $('key-meter').innerHTML = '<strong class="pw-' + esc(result.verdict) + '">' + esc(result.verdict) +
      '</strong>, about ' + result.bits + ' bits. ' + esc(result.note);
  }

  function generate() {
    clearError();
    var name = $('key-name').value.trim();
    var email = $('key-email').value.trim();
    if (!name && !email) { fail('Put a name or an email on the key, so it can be told apart from others.'); return; }

    var rsa = $('key-type').value === 'rsa4096';
    var passphrase = $('key-pass').value;
    $('generate').disabled = true;
    $('generate-note').textContent = rsa
      ? 'Making an RSA 4096 key. This takes several seconds and the tab will sit still while it does.'
      : 'Making a key…';

    ready()
      .then(function () {
        var options = kit.keyOptions(kit.profileFor($('key-profile').value), {
          name: name, email: email,
          kind: rsa ? 'rsa4096' : 'curve25519',
          passphrase: passphrase,
          expiryYears: Number($('key-expiry').value),
        });
        // A moment for the browser to paint the note before the tab locks up.
        return new Promise(function (r) { setTimeout(r, 30); }).then(function () { return pgp.generateKey(options); });
      })
      .then(function (result) {
        return pgp.readKey({ armoredKey: result.publicKey }).then(function (key) {
          var about = describeKey(key);
          var kept = kit.mayStorePrivate(passphrase);

          // The public half is always worth keeping: it is not a secret, and
          // without it you cannot encrypt to yourself.
          keys = kit.rememberKey({
            armored: result.publicKey, kind: 'public', name: about.name,
            fingerprint: about.fingerprint, added: Date.now(),
          });
          if (kept) {
            keys = kit.rememberKey({
              armored: result.privateKey, kind: 'private', name: about.name,
              fingerprint: about.fingerprint, added: Date.now(),
            });
          }

          // Downloaded either way. When it is not being kept, this file is the
          // only copy that will ever exist, so it goes out without being asked
          // for rather than waiting for a click that might not come.
          if (!kept) download(kit.keyPairArmor(result.publicKey, result.privateKey), kit.backupName(about.name, 'pair'));

          $('generate-note').innerHTML = 'Made <strong>' + esc(about.name) + '</strong>, ' +
            esc(kit.formatFingerprint(about.fingerprint)) + '. ' +
            (kept
              ? 'Kept in this browser, locked with your passphrase. Save the pair somewhere else too; a browser is not a backup.'
              : '<strong>Downloaded, and not kept here</strong>, because it has no passphrase. That file is the only copy.');
          $('key-name').value = '';
          $('key-email').value = '';
          $('key-pass').value = '';
          $('key-suggested').textContent = '';
          updateMeter();
          renderKeyring();
        });
      })
      .catch(function (err) {
        $('generate-note').textContent = '';
        fail((err && err.message) || String(err));
      })
      .then(function () { $('generate').disabled = false; });
  }

  /* One armored block. Resolves to what was imported, or rejects with a reason
     naming that block rather than the whole file. */
  function importBlock(text) {
    var kind = kit.armorKind(text);
    if (kind !== 'public-key' && kind !== 'private-key') {
      return Promise.reject(new Error('That is not a PGP key. A key starts with "-----BEGIN PGP PUBLIC KEY BLOCK-----".'));
    }
    var isPrivate = kind === 'private-key';
    return (isPrivate ? pgp.readPrivateKey({ armoredKey: text }) : pgp.readKey({ armoredKey: text }))
      .then(function (key) {
        var about = describeKey(key);

        // An unprotected private key must not go into local storage in the
        // clear — that is the one thing the generator refuses to do, and the
        // rule has to hold however a key arrives. Rather than turn the key
        // away, put a passphrase on it here.
        if (isPrivate && key.isDecrypted()) {
          var chosen = $('import-pass').value;
          if (!kit.mayStorePrivate(chosen)) {
            throw new Error('"' + about.name + '" has no passphrase on it, so storing it as it stands would leave the key readable by anything running on this page. Put a passphrase in the box above and import it again: it will be locked with that before it is kept.');
          }
          return pgp.encryptKey({ privateKey: key, passphrase: chosen }).then(function (locked) {
            return { key: locked, about: about, armored: locked.armor(), locked: true };
          });
        }
        return { key: key, about: about, armored: text, locked: false };
      })
      .then(function (result) {
        var key = result.key;
        var about = result.about;
        keys = kit.rememberKey({
          armored: result.armored, kind: isPrivate ? 'private' : 'public', name: about.name,
          fingerprint: about.fingerprint, added: Date.now(),
        });
        // A private key carries its public half; store that too so it can
        // be handed out without exporting the secret.
        if (isPrivate) {
          keys = kit.rememberKey({
            armored: key.toPublic().armor(), kind: 'public', name: about.name,
            fingerprint: about.fingerprint, added: Date.now(),
          });
        }
        return { name: about.name, fingerprint: about.fingerprint, locked: result.locked };
      });
  }

  /* Import everything in a piece of text. A file from `gpg --export` routinely
     holds several keys, and a key-pair backup holds two; taking only the first
     would drop the rest while reporting success. */
  function importText(text, label) {
    var blocks = kit.splitArmored(text);
    if (!blocks.length) {
      // No armor at all: let importBlock produce the "that is not a key"
      // message against the whole thing, which is what someone pasting
      // nonsense needs to read.
      blocks = [text];
    }

    var done = [];
    var failures = [];
    return blocks.reduce(function (chain, block) {
      return chain.then(function () {
        return importBlock(block).then(
          function (about) { done.push(about); },
          function (err) { failures.push(err.message); },
        );
      });
    }, Promise.resolve()).then(function () {
      if (!done.length) throw new Error(failures[0] || 'Nothing in that could be read as a key.');

      var names = done.map(function (a) {
        return '<strong>' + esc(a.name) + '</strong> ' + esc(kit.shortId(a.fingerprint));
      }).join(', ');
      var relocked = done.filter(function (a) { return a.locked; }).length;
      $('import-note').innerHTML =
        'Imported ' + done.length + (done.length === 1 ? ' key' : ' keys') +
        (label ? ' from ' + esc(label) : '') + ': ' + names +
        '. Check those fingerprints with their owners through some other channel before you trust them.' +
        (relocked ? ' <strong>' + relocked + ' had no passphrase and was locked with the one you gave</strong> before being stored.' : '') +
        (failures.length ? ' ' + failures.length + ' block in that file could not be read: ' + esc(failures[0]) : '');
      $('import-pass').value = '';
      renderKeyring();
    });
  }

  function importKey() {
    clearError();
    var text = $('import-text').value.trim();
    if (!text) { fail('Paste a key first, or open a file above.'); return; }

    ready()
      .then(function () { return importText(text, ''); })
      .then(function () { $('import-text').value = ''; })
      .catch(function (err) {
        $('import-note').textContent = '';
        fail((err && err.message) || String(err));
      });
  }

  function importFiles(files) {
    clearError();
    if (!files || !files.length) return;
    var list = Array.prototype.slice.call(files);

    ready()
      .then(function () {
        return list.reduce(function (chain, file) {
          return chain.then(function () {
            return file.text().then(function (text) { return importText(text, file.name); });
          });
        }, Promise.resolve());
      })
      .catch(function (err) {
        $('import-note').textContent = '';
        fail((err && err.message) || String(err));
      });
  }

  // ----------------------------------------------------------- encrypting

  function encrypt() {
    clearError();
    $('enc-output').innerHTML = '';
    var to = keyByValue($('enc-to').value);
    if (!to) { fail('Choose who this is for. Import their public key first if it is not listed.'); return; }

    var file = $('enc-file').files && $('enc-file').files[0];
    var text = $('enc-text').value;
    if (!file && !text.trim()) { fail('Type a message, or choose a file.'); return; }

    $('enc-note').textContent = 'Encrypting…';
    ready()
      .then(function () {
        var work = [publicKeyFrom(to)];
        if ($('enc-sign').checked) {
          var as = keyByValue($('enc-as').value);
          if (!as) throw new Error('To sign it you need a private key. Make one on the Keys tab.');
          work.push(privateKeyFrom(as, prompt('Passphrase for "' + as.name + '" (leave blank if it has none)') || ''));
        }
        return Promise.all(work);
      })
      .then(function (loaded) {
        var options = { encryptionKeys: loaded[0], format: 'armored' };
        if (loaded[1]) options.signingKeys = loaded[1];
        if (file) {
          return file.arrayBuffer().then(function (buffer) {
            options.message = null;
            return pgp.createMessage({ binary: new Uint8Array(buffer), filename: file.name }).then(function (m) {
              options.message = m;
              return pgp.encrypt(options);
            });
          });
        }
        return pgp.createMessage({ text: text }).then(function (m) {
          options.message = m;
          return pgp.encrypt(options);
        });
      })
      .then(function (armored) {
        $('enc-note').textContent = '';
        var name = (file ? file.name : 'message.txt') + '.asc';
        $('enc-output').innerHTML =
          '<p class="note">Only ' + esc(to.name) + ' can read this. Paste it, or download it.</p>' +
          '<p><textarea id="enc-result" rows="9" readonly spellcheck="false">' + esc(armored) + '</textarea></p>' +
          '<p><button type="button" id="enc-copy" class="small">Copy</button> ' +
          '<a download="' + esc(name) + '" href="' + objectUrl(new Blob([armored], { type: 'text/plain' })) +
          '">Download ' + esc(name) + '</a></p>';
      })
      .catch(function (err) {
        $('enc-note').textContent = '';
        fail((err && err.message) || String(err));
      });
  }

  // ----------------------------------------------------------- decrypting

  function decrypt() {
    clearError();
    $('dec-output').innerHTML = '';
    var stored = keyByValue($('dec-key').value);
    if (!stored) { fail('You need a private key to decrypt. Make one, or import yours, on the Keys tab.'); return; }

    var file = $('dec-file').files && $('dec-file').files[0];
    var text = $('dec-text').value.trim();
    if (!file && !text) { fail('Paste the message, or choose the file.'); return; }

    ready()
      .then(function () { return privateKeyFrom(stored, $('dec-pass').value); })
      .then(function (key) {
        var readMessage = file
          ? file.arrayBuffer().then(function (buffer) {
              var raw = new Uint8Array(buffer);
              var head = new TextDecoder().decode(raw.subarray(0, 40));
              return head.indexOf('-----BEGIN PGP') >= 0
                ? pgp.readMessage({ armoredMessage: new TextDecoder().decode(raw) })
                : pgp.readMessage({ binaryMessage: raw });
            })
          : pgp.readMessage({ armoredMessage: text });

        return readMessage.then(function (message) {
          // Every public key is offered as a possible signer, so a signature on
          // the message is checked rather than ignored.
          return Promise.all(keys.filter(function (k) { return k.kind === 'public'; }).map(publicKeyFrom))
            .then(function (verifiers) {
              return pgp.decrypt({
                message: message,
                decryptionKeys: key,
                verificationKeys: verifiers.length ? verifiers : undefined,
                format: file ? 'binary' : 'utf8',
              });
            });
        });
      })
      .then(function (result) {
        return signatureNote(result).then(function (note) {
          if (file) {
            var name = kit.unlockedName(file.name, result.filename);
            $('dec-output').innerHTML = note +
              '<p><a download="' + esc(name) + '" href="' +
              objectUrl(new Blob([result.data], { type: 'application/octet-stream' })) +
              '">Download ' + esc(name) + '</a></p>';
          } else {
            $('dec-output').innerHTML = note +
              '<p><textarea rows="9" readonly spellcheck="false">' + esc(result.data) + '</textarea></p>';
          }
        });
      })
      .catch(function (err) { fail(readableError(err)); });
  }

  /* Whether the message was signed, and by whom. An unsigned message is not a
     failure — it is just a message nobody vouched for, and saying so is more
     useful than silence. */
  function signatureNote(result) {
    var signatures = result.signatures || [];
    if (!signatures.length) {
      return Promise.resolve('<p class="note sig-none">Decrypted. It carries no signature, so this proves ' +
        'nothing about who sent it.</p>');
    }
    return signatures[0].verified
      .then(function () {
        var id = signatures[0].keyID.toHex().toUpperCase();
        var who = keys.find(function (k) { return k.fingerprint.toUpperCase().endsWith(id); });
        return '<p class="note sig-good">Decrypted, and the signature checks out. Signed by ' +
          esc(who ? who.name : id) + '.</p>';
      })
      .catch(function () {
        return '<p class="note sig-bad">Decrypted, but the signature does <strong>not</strong> check out. ' +
          'Either it was altered, or it was signed by a key you do not have.</p>';
      });
  }

  // -------------------------------------------------------- sign / verify

  function sign() {
    clearError();
    $('sign-output').innerHTML = '';
    var stored = keyByValue($('sign-key').value);
    if (!stored) { fail('You need a private key to sign. Make one on the Keys tab.'); return; }
    var text = $('sign-text').value;
    if (!text.trim()) { fail('Type something to sign.'); return; }

    ready()
      .then(function () { return privateKeyFrom(stored, $('sign-pass').value); })
      .then(function (key) {
        return pgp.createCleartextMessage({ text: text }).then(function (message) {
          return pgp.sign({ message: message, signingKeys: key });
        });
      })
      .then(function (signed) {
        $('sign-output').innerHTML =
          '<p class="note">The message stays readable. Anyone with your public key can check it came from you.</p>' +
          '<p><textarea id="sign-result" rows="10" readonly spellcheck="false">' + esc(signed) + '</textarea></p>' +
          '<p><button type="button" id="sign-copy" class="small">Copy</button></p>';
      })
      .catch(function (err) { fail(readableError(err)); });
  }

  function verify() {
    clearError();
    $('verify-output').innerHTML = '';
    var text = $('verify-text').value.trim();
    if (!text) { fail('Paste a signed message.'); return; }

    ready()
      .then(function () {
        if (kit.armorKind(text) !== 'signed-message') {
          throw new Error('That is not a clearsigned message. It should start with "-----BEGIN PGP SIGNED MESSAGE-----".');
        }
        return Promise.all(keys.filter(function (k) { return k.kind === 'public'; }).map(publicKeyFrom));
      })
      .then(function (verifiers) {
        if (!verifiers.length) throw new Error('Import the signer\'s public key first: without it there is nothing to check against.');
        return pgp.readCleartextMessage({ cleartextMessage: text }).then(function (message) {
          return pgp.verify({ message: message, verificationKeys: verifiers });
        });
      })
      .then(function (result) {
        var signature = result.signatures[0];
        if (!signature) throw new Error('There is no signature in that message.');
        return signature.verified
          .then(function () {
            var id = signature.keyID.toHex().toUpperCase();
            var who = keys.find(function (k) { return k.fingerprint.toUpperCase().endsWith(id); });
            $('verify-output').innerHTML =
              '<p class="note sig-good"><strong>Good signature</strong> from ' + esc(who ? who.name : id) +
              '. The text below is exactly what they signed.</p>' +
              '<p><textarea rows="8" readonly spellcheck="false">' + esc(result.data) + '</textarea></p>' +
              '<p class="note">This proves the message matches that key. Whether the key belongs to the person ' +
              'you think it does is a separate question, and the only answer is checking the fingerprint with them.</p>';
          })
          .catch(function () {
            $('verify-output').innerHTML =
              '<p class="note sig-bad"><strong>Bad signature.</strong> Either the message was changed after it was ' +
              'signed, or it was signed by a key you have not imported. Do not act on it.</p>';
          });
      })
      .catch(function (err) { fail(readableError(err)); });
  }

  function readableError(err) {
    var message = (err && err.message) || String(err);
    if (/session key decryption failed|incorrect key/i.test(message)) {
      return 'None of your private keys can open that message. It was probably encrypted to someone else.';
    }
    if (/Misformed armored text|Unknown|Malformed/i.test(message)) {
      return 'That does not parse as PGP. Copy the whole block, including the BEGIN and END lines.';
    }
    return message;
  }

  // ---------------------------------------------------------------- wiring

  var TABS = ['keys', 'encrypt', 'decrypt', 'sign', 'verify'];
  TABS.forEach(function (name) {
    $('tab-' + name).addEventListener('click', function () {
      clearError();
      TABS.forEach(function (other) {
        $('mode-' + other).classList.toggle('hidden', other !== name);
        $('tab-' + other).classList.toggle('is-active', other === name);
      });
      ready().then(renderKeyring).catch(function (err) { fail(err.message); });
    });
  });

  $('keyring').addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('button') : null;
    if (!button) return;
    var key = keys[Number(button.dataset.index)];
    if (!key) return;

    if (button.classList.contains('key-copy')) {
      // Putting a private key on the clipboard means every other page on this
      // machine that reads it gets the key. Worth one deliberate click.
      if (key.kind === 'private' &&
          !confirm('Copy the PRIVATE key "' + key.name + '" to the clipboard?\n\nAnything that reads your clipboard can then take it. Saving it to a file is usually what you want.')) {
        return;
      }
      copy(key.armored, button);
    } else if (button.classList.contains('key-save')) {
      download(key.armored, kit.backupName(key.name, key.kind));
    } else if (button.classList.contains('key-pair')) {
      var pub = halfOf(key.fingerprint, 'public');
      var priv = halfOf(key.fingerprint, 'private');
      download(kit.keyPairArmor(pub.armored, priv.armored), kit.backupName(key.name, 'pair'));
    } else if (button.classList.contains('key-drop')) {
      // A private key is the one thing here that cannot be recovered.
      var warning = key.kind === 'private'
        ? 'Forget the private key "' + key.name + '"? Anything encrypted to it becomes unreadable unless you have it saved elsewhere.'
        : 'Forget the public key "' + key.name + '"?';
      if (!confirm(warning)) return;
      keys = kit.forgetKey(key.fingerprint, key.kind);
      renderKeyring();
    }
  });

  document.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('#enc-copy, #sign-copy') : null;
    if (!button) return;
    var area = button.id === 'enc-copy' ? $('enc-result') : $('sign-result');
    if (area) copy(area.value, button);
  });

  function copy(text, button) {
    var original = button.textContent;
    var done = function () {
      button.textContent = 'copied';
      setTimeout(function () { button.textContent = original; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'offscreen';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* nothing else to try */ }
    document.body.removeChild(area);
  }

  $('backup-all').addEventListener('click', function () {
    // Public halves first, then private, so the file reads the same way a
    // single pair does and nobody scrolling it is surprised.
    var ordered = keys.filter(function (k) { return k.kind === 'public'; })
      .concat(keys.filter(function (k) { return k.kind === 'private'; }));
    download(ordered.map(function (k) { return k.armored.trim(); }).join('\n\n') + '\n',
      kit.backupName('1999loc', 'keyring'));
  });

  $('forget-all').addEventListener('click', function () {
    var privates = keys.filter(function (k) { return k.kind === 'private'; }).length;
    var warning = privates
      ? 'Forget every key, including ' + privates + ' private ' + (privates === 1 ? 'key' : 'keys') +
        '?\n\nAnything encrypted to ' + (privates === 1 ? 'it' : 'them') + ' becomes unreadable unless you have a backup.'
      : 'Forget every key in this browser?';
    if (!confirm(warning)) return;
    kit.forgetAllKeys();
    keys = [];
    renderKeyring();
  });

  // Opening a key file. Same drop-or-click pattern as every other tool here.
  (function () {
    var zone = $('import-drop');
    var input = $('import-file');
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('is-over'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('is-over'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('is-over');
      importFiles(e.dataTransfer && e.dataTransfer.files);
    });
    input.addEventListener('change', function () { importFiles(input.files); input.value = ''; });
  })();

  $('key-pass').addEventListener('input', updateMeter);
  $('key-profile').addEventListener('change', showProfile);
  $('key-suggest').addEventListener('click', function () {
    ready().then(function () {
      var phrase = kit.makePassphrase(8);
      $('key-pass').value = phrase;
      $('key-suggested').innerHTML = '<code>' + esc(phrase) + '</code> ' +
        kit.passphraseBits(8) + ' bits of real randomness. Write it down before you leave this page.';
      updateMeter();
    }).catch(function (err) { fail(err.message); });
  });

  $('generate').addEventListener('click', generate);
  $('import').addEventListener('click', importKey);
  $('encrypt').addEventListener('click', encrypt);
  $('decrypt').addEventListener('click', decrypt);
  $('sign').addEventListener('click', sign);
  $('verify').addEventListener('click', verify);

  ready().then(function () {
    renderKeyring();
    showProfile();
    updateMeter();
  }).catch(function (err) { fail(err.message); });
})();

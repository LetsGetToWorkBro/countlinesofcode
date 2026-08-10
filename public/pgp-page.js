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

  /* ------------------------------------------------------------- the list

     Keychain's arrangement: a list of records with column headings, one of
     them selected, a detail pane over it describing that one, and the
     actions in a status bar underneath. What was here before put four
     buttons on every row, which is fine with two keys and a wall with ten,
     and left nowhere to say anything about a key beyond its fingerprint.

     A key is identified by fingerprint AND kind, because the public and
     private halves of one key share a fingerprint and are two rows. */
  var selected = null;
  var detailToken = 0;

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];

  function longDate(value) {
    var d = value instanceof Date ? value : new Date(Number(value) || 0);
    if (!value || isNaN(d.getTime())) return 'unknown';
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }
  function shortDate(value) {
    var d = new Date(Number(value) || 0);
    if (!value || isNaN(d.getTime())) return '';
    return d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear();
  }

  function isSelected(key) {
    return !!selected && key.fingerprint === selected.fingerprint && key.kind === selected.kind;
  }
  function currentKey() {
    return selected ? keys.find(isSelected) : undefined;
  }

  /* Drawn rather than fetched, like every other picture on this site. Brass
     for a key that is yours, grey for one that is somebody else's, which is
     the distinction Keychain drew too. */
  function keyGlyph(kind) {
    var ink = kind === 'private' ? '#a8761a' : '#6b6760';
    return '<svg class="kc-detail-icon" width="40" height="40" viewBox="0 0 40 40" ' +
      'aria-hidden="true" focusable="false">' +
      '<circle cx="20" cy="11" r="7" fill="none" stroke="' + ink + '" stroke-width="4"/>' +
      '<path d="M20 18 L20 35" stroke="' + ink + '" stroke-width="4" stroke-linecap="round"/>' +
      '<path d="M20 26 L28 26" stroke="' + ink + '" stroke-width="4" stroke-linecap="round"/>' +
      '<path d="M20 31 L26 31" stroke="' + ink + '" stroke-width="3" stroke-linecap="round"/>' +
      '</svg>';
  }

  /* What OpenPGP.js calls these and what a person calls them are not the
     same thing. "eddsaLegacy on ed25519Legacy" is accurate and is also not a
     sentence anybody should have to read off a detail pane. */
  var ALGOS = {
    eddsaLegacy: 'EdDSA', ed25519Legacy: 'Curve25519',
    ed25519: 'Ed25519', x25519: 'X25519', curve25519: 'Curve25519',
    ecdh: 'ECDH', ecdsa: 'ECDSA', eddsa: 'EdDSA',
    rsaEncryptSign: 'RSA', rsaSign: 'RSA', rsaEncrypt: 'RSA',
    dsa: 'DSA', elgamal: 'ElGamal',
    nistP256: 'NIST P-256', nistP384: 'NIST P-384', nistP521: 'NIST P-521',
  };

  function plainAlgorithm(info) {
    var name = ALGOS[info.algorithm] || info.algorithm || 'unknown';
    var body = info.bits
      ? name + ' ' + info.bits
      : (info.curve ? name + ' on ' + (ALGOS[info.curve] || info.curve) : name);
    // The page makes a point of the two packet encodings, so a key says
    // which one it is in rather than leaving "Legacy" hanging off a word.
    var legacy = /Legacy$/.test(info.algorithm || '') || /Legacy$/.test(info.curve || '');
    return body + (legacy ? ', in the compatible encoding' : '');
  }

  /* The order the list is drawn in. Storage order puts a key's two halves
     wherever they happened to arrive; a keychain window shows them together,
     with the half that is yours first. */
  function ordered() {
    return keys.map(function (key, index) { return { key: key, index: index }; })
      .sort(function (a, b) {
        var byName = a.key.name.toLowerCase() < b.key.name.toLowerCase() ? -1
          : (a.key.name.toLowerCase() > b.key.name.toLowerCase() ? 1 : 0);
        if (byName) return byName;
        if (a.key.fingerprint !== b.key.fingerprint) return a.key.fingerprint < b.key.fingerprint ? -1 : 1;
        if (a.key.kind !== b.key.kind) return a.key.kind === 'private' ? -1 : 1;
        return 0;
      });
  }

  function fact(label, value, cls) {
    return '<dt>' + esc(label) + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</dd>';
  }

  function renderKeyring() {
    // A key that was forgotten cannot stay selected, and an empty list with
    // an enabled Forget button is a trap.
    if (selected && !currentKey()) selected = null;
    if (!selected && keys.length) {
      var first = ordered()[0].key;
      selected = { fingerprint: first.fingerprint, kind: first.kind };
    }

    $('keyring').innerHTML = keys.length ? listMarkup() :
      '<p class="kc-empty">No keys yet. Make one, or import somebody else\'s.</p>';
    $('keyring-actions').classList.toggle('hidden', keys.length === 0);
    $('key-count').textContent = keys.length
      ? keys.length + (keys.length === 1 ? ' key' : ' keys')
      : 'no keys';
    renderDetail();
    fillPickers();
  }

  function listMarkup() {
    return '<table class="kc-list"><thead><tr>' +
      '<th scope="col">Name</th>' +
      '<th scope="col">Kind</th>' +
      '<th scope="col" class="kc-col-print">Key ID</th>' +
      '<th scope="col" class="kc-col-added">Added</th>' +
      '</tr></thead><tbody>' +
      ordered().map(function (entry) {
        var k = entry.key;
        return '<tr class="kc-row' + (isSelected(k) ? ' is-selected' : '') + '" data-index="' + entry.index +
            '" tabindex="0" aria-selected="' + (isSelected(k) ? 'true' : 'false') + '">' +
          '<td class="kc-name' + (k.kind === 'private' ? ' kc-mine' : '') + '">' + esc(k.name) + '</td>' +
          '<td>' + (k.kind === 'private' ? 'private key' : 'public key') + '</td>' +
          '<td class="kc-print kc-col-print">' + esc(kit.shortId(k.fingerprint)) + '</td>' +
          '<td class="kc-col-added">' + esc(shortDate(k.added)) + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  function renderDetail() {
    var key = currentKey();
    var box = $('key-detail');
    detailToken += 1;

    if (!key) {
      box.innerHTML = '<span class="kc-detail-empty">' +
        (keys.length ? 'Pick a key from the list to read it.' : 'Nothing to show until there is a key.') +
        '</span>';
      setActions(null, false);
      return;
    }

    var pair = hasBothHalves(key.fingerprint);
    box.innerHTML =
      keyGlyph(key.kind) +
      '<span class="kc-detail-body">' +
        '<span class="kc-detail-name">' + esc(key.name) + '</span>' +
        '<dl class="kc-facts">' +
          fact('Kind', key.kind === 'private'
            ? 'private key, yours' + (pair ? ', with its public half' : '')
            : 'public key, somebody else&#39;s') +
          fact('Fingerprint', esc(kit.formatFingerprint(key.fingerprint)), 'kc-mono') +
          fact('Added', esc(longDate(key.added))) +
        '</dl>' +
      '</span>';
    setActions(key, pair);
    describeLater(key, detailToken);
  }

  /* What the key itself says, as opposed to what was recorded when it was
     stored. Read from the packets, and appended when it arrives, because a
     detail pane that waits for a parse is a detail pane that flickers. */
  function describeLater(key, token) {
    if (!pgp) return;
    pgp.readKey({ armoredKey: key.armored }).then(function (parsed) {
      return parsed.getExpirationTime()
        .catch(function () { return null; })
        .then(function (until) { return { parsed: parsed, until: until }; });
    }).then(function (read) {
      // Somebody clicked another row while that was parsing.
      if (token !== detailToken) return;
      var facts = $('key-detail').querySelector('.kc-facts');
      if (!facts) return;

      var until = read.until;
      var expiry = until === Infinity || until === null ? 'never'
        : (until instanceof Date ? longDate(until) : 'unknown');

      facts.insertAdjacentHTML('beforeend',
        fact('Algorithm', esc(plainAlgorithm(read.parsed.getAlgorithmInfo()))) +
        fact('Created', esc(longDate(read.parsed.getCreationTime()))) +
        fact('Expires', esc(expiry)));
    }).catch(function () {
      /* A key that will not parse is still a key you can save or forget, so
         the detail pane keeps what it has rather than reporting a failure
         about a row you only clicked on. */
    });
  }

  function setActions(key, pair) {
    $('key-copy').disabled = !key;
    $('key-save').disabled = !key;
    $('key-pair').disabled = !key || !pair;
    $('key-drop').disabled = !key;
  }

  function select(index) {
    var key = keys[index];
    if (!key) return;
    selected = { fingerprint: key.fingerprint, kind: key.kind };
    renderKeyring();
  }

  /* Whether both halves of one key are here, which is what makes "Save the
     pair" a thing you can do. The two halves share a fingerprint and are two
     separate rows. */
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
    var url = objectUrl(new Blob([text], { type: 'text/plain' }));
    link.href = url;
    link.download = name;
    link.click();
    // The click has been dispatched; give the browser a moment to grab the blob,
    // then revoke so a stream of saves does not pin one blob each.
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  /* The dropdowns: public keys are who you can write to, private keys are who
     you can be. */
  function fillPickers() {
    var publics = keys.filter(function (k) { return k.kind === 'public'; });
    var privates = keys.filter(function (k) { return k.kind === 'private'; });
    // A private key carries its public half, so it can also be a recipient —
    // encrypting something to yourself is a normal thing to want. But if the
    // public half was also imported on its own, the same fingerprint would
    // list twice; the public entry wins and the private duplicate is dropped.
    var seen = {};
    publics.forEach(function (k) { seen[k.fingerprint] = true; });
    var recipients = publics.concat(privates.filter(function (k) { return !seen[k.fingerprint]; }));

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
        // Said before the key is attempted rather than after: OpenPGP.js will
        // not build a user ID out of an address it dislikes, and all it says
        // about one is "Invalid user ID format".
        var trouble = kit.emailProblem(email);
        if (trouble) { $('key-email').focus(); throw new Error(trouble); }

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
          selected = { fingerprint: about.fingerprint, kind: kept ? 'private' : 'public' };
          show('keys');
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
        var message = (err && err.message) || String(err);
        // Anything that still gets past the check above arrives as a sentence
        // about the library's internals. Say what it means instead.
        if (/invalid user id format/i.test(message)) {
          message = 'The name or the email on the key cannot be written into one. Check the email box: an address there needs an @ with a domain after it, and no spaces.';
        }
        fail(message);
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
      selected = { fingerprint: done[0].fingerprint, kind: 'public' };
      show('keys');
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
          work.push(privateKeyFrom(as, $('enc-pass').value || ''));
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
            // A v4 key's ID is the rightmost 16 hex of its fingerprint, a v6
            // key's is the leftmost 16; match either end so a v6 signer is
            // named, not printed as a bare key ID.
            var who = keys.find(function (k) {
              var fp = k.fingerprint.toUpperCase();
              return fp.endsWith(id) || fp.startsWith(id);
            });
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

  /* The source list, and the part of it this file owns.
   *
   * Encrypting to a key and locking with a password used to be two tabs with
   * a second row of tabs inside each, which is two programs in one window
   * pretending to be one. They are one rail of screens now, and this file
   * still only implements seven of them, so it has to know the names of the
   * other two in order to put them away. lock-page.js does the same in
   * reverse. Neither can show a screen the other owns; both can hide one. */
  var ALL = ['keys', 'newkey', 'import', 'encrypt', 'decrypt', 'sign', 'verify', 'lock', 'unlock'];
  var OWN = ['keys', 'newkey', 'import', 'encrypt', 'decrypt', 'sign', 'verify'];

  function show(name) {
    clearError();
    ALL.forEach(function (other) {
      $('mode-' + other).classList.toggle('hidden', other !== name);
      var item = $('tab-' + other);
      item.classList.toggle('is-active', other === name);
      item.setAttribute('aria-pressed', other === name ? 'true' : 'false');
    });
    ready().then(renderKeyring).catch(function (err) { fail(err.message); });
  }

  OWN.forEach(function (name) {
    $('tab-' + name).addEventListener('click', function () { show(name); });
  });

  /* Clicking a row picks it; the arrow keys walk the list, because a list
     you can only use with a mouse is a list half the people cannot use. */
  $('keyring').addEventListener('click', function (event) {
    var row = event.target.closest ? event.target.closest('tr[data-index]') : null;
    if (row) select(Number(row.dataset.index));
  });

  $('keyring').addEventListener('keydown', function (event) {
    var row = event.target.closest ? event.target.closest('tr[data-index]') : null;
    if (!row) return;
    var index = Number(row.dataset.index);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Down means the next row you can see, which is not keys[index + 1]
      // once the list is sorted into pairs.
      var rows = ordered();
      var here = rows.findIndex(function (entry) { return entry.index === index; });
      var step = here + (event.key === 'ArrowDown' ? 1 : -1);
      if (here === -1 || step < 0 || step >= rows.length) return;
      var next = rows[step].index;
      event.preventDefault();
      select(next);
      var moved = $('keyring').querySelector('tr[data-index="' + next + '"]');
      if (moved) moved.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(index);
    }
  });

  /* The four things you can do to the key you picked. They were on every row
     before, which is the same four buttons N times over. */
  $('key-copy').addEventListener('click', function () {
    var key = currentKey();
    if (!key) return;
    // Putting a private key on the clipboard means every other page on this
    // machine that reads it gets the key. Worth one deliberate click.
    if (key.kind === 'private' &&
        !confirm('Copy the PRIVATE key "' + key.name + '" to the clipboard?\n\nAnything that reads your clipboard can then take it. Saving it to a file is usually what you want.')) {
      return;
    }
    copy(key.armored, $('key-copy'));
  });

  $('key-save').addEventListener('click', function () {
    var key = currentKey();
    if (key) download(key.armored, kit.backupName(key.name, key.kind));
  });

  $('key-pair').addEventListener('click', function () {
    var key = currentKey();
    if (!key) return;
    var pub = halfOf(key.fingerprint, 'public');
    var priv = halfOf(key.fingerprint, 'private');
    if (pub && priv) download(kit.keyPairArmor(pub.armored, priv.armored), kit.backupName(key.name, 'pair'));
  });

  $('key-drop').addEventListener('click', function () {
    var key = currentKey();
    if (!key) return;
    // A private key is the one thing here that cannot be recovered.
    var warning = key.kind === 'private'
      ? 'Forget the private key "' + key.name + '"? Anything encrypted to it becomes unreadable unless you have it saved elsewhere.'
      : 'Forget the public key "' + key.name + '"?';
    if (!confirm(warning)) return;
    keys = kit.forgetKey(key.fingerprint, key.kind);
    selected = null;
    renderKeyring();
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

  // The signing passphrase only makes sense once you have chosen to sign, so
  // the masked field appears with the checkbox rather than a prompt() that
  // would render it in the clear.
  (function () {
    var sign = $('enc-sign');
    var row = $('enc-pass-row');
    if (!sign || !row) return;
    var sync = function () { row.classList.toggle('hidden', !sign.checked); };
    sign.addEventListener('change', sync);
    sync();
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

  // Revoke every outstanding object URL when the tab goes away, so the ones
  // embedded in result areas do not leak for the life of the session.
  window.addEventListener('pagehide', function () {
    liveUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    liveUrls = [];
  });

  function init() {
    ready().then(function () {
      renderKeyring();
      showProfile();
      updateMeter();
    }).catch(function (err) { fail(err.message); });
  }

  // On the merged /lock.html the PGP tools share the page with password locking,
  // which is the default tab. Loading OpenPGP (~390 KB) is the PGP half's cost,
  // so don't pay it until someone opens the "Key pair" tab. tabs.js fires
  // 'tab:shown' when it appears; on the standalone page (no tabs) init at once.
  var tabs = document.querySelector('[data-tabs]');
  if (tabs) {
    var started = false;
    var start = function () { if (!started) { started = true; init(); } };
    tabs.addEventListener('tab:shown', function (e) { if (e.detail && e.detail.tab === 'pgp') start(); });
    var panel = tabs.querySelector('[data-panel="pgp"]');
    if (panel && !panel.classList.contains('hidden')) start();
  } else {
    init();
  }
})();

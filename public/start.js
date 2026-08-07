/* 1999.LOC Start menu, Run box, and MS-DOS Prompt.
 *
 * Pure enhancement, like desk.js: with scripting off, Start is still a plain
 * anchor that goes somewhere useful, and nothing on any page depends on a
 * line of this file. With it on, the taskbar grows the menu the taskbar has
 * been implying since the day it appeared.
 *
 * Nothing here is built from a list that has to be kept in step by hand: the
 * Programs menu is read out of the page's own toolkit bar, and Documents out
 * of the windows the page actually has, so neither can drift.
 */
(function () {
  'use strict';

  var desk = document.querySelector('.desktop, .desk-shell');
  if (!desk) return;
  var bar = desk.querySelector('.taskbar');
  var startBtn = bar && bar.querySelector('.start');
  if (!bar || !startBtn) return;

  var esc = function (v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  var el = function (tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  // ------------------------------------------------------------- the tools
  // Read straight out of the nav, so the menu lists exactly what the site
  // lists. A <strong> in there is the current page, which has no href of its
  // own: it is where we already are.

  function toolGroups() {
    var groups = [];
    Array.prototype.forEach.call(document.querySelectorAll('.nav .nav-group'), function (g) {
      var label = g.querySelector('.nav-label');
      var items = [];
      Array.prototype.forEach.call(g.querySelectorAll('a, strong'), function (node) {
        items.push({ label: node.textContent, href: node.getAttribute('href') || location.pathname });
      });
      if (label && items.length) groups.push({ label: label.textContent, items: items });
    });
    return groups;
  }

  var GROUPS = toolGroups();
  var ALL_TOOLS = GROUPS.reduce(function (all, g) { return all.concat(g.items); }, []);

  /** The tool a typed word means, matched generously: "wallet", "WALLET.HTM",
   *  "/wallet.html" and "count code" all land in the same place. */
  function findTool(word) {
    var want = String(word || '').toLowerCase().trim().replace(/^\/+/, '').replace(/\.(htm|html|exe)$/, '');
    if (!want) return null;
    for (var i = 0; i < ALL_TOOLS.length; i++) {
      var tool = ALL_TOOLS[i];
      var slug = tool.href.replace(/^\//, '').replace(/\.html$/, '').toLowerCase();
      if (want === slug || want === tool.label.toLowerCase() || want === tool.label.toLowerCase().replace(/\s+/g, '')) {
        return tool;
      }
    }
    return null;
  }

  function dosName(tool) {
    var base = tool.label.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (base.slice(0, 8) + '        ').slice(0, 8);
  }

  // ----------------------------------------------------------------- menu

  var menu = el('div', 'start-menu');
  menu.setAttribute('role', 'menu');
  var spine = el('div', 'start-spine');
  spine.appendChild(el('span', null, '1999.LOC'));
  menu.appendChild(spine);
  var items = el('div', 'start-items');
  menu.appendChild(items);

  var openFlyout = null;

  function closeFlyouts() {
    if (openFlyout) openFlyout.classList.remove('is-open');
    openFlyout = null;
  }

  function menuItem(label, arrow) {
    var row = el('button', 'start-item');
    row.type = 'button';
    row.innerHTML = esc(label) + (arrow ? '<span class="start-arrow">&#9654;</span>' : '');
    return row;
  }

  /** A row that opens a submenu of links. */
  function submenu(label, entries) {
    var wrap = el('div', 'start-row');
    var row = menuItem(label, true);
    var fly = el('div', 'start-fly');
    entries.forEach(function (entry) {
      if (entry.divider) { fly.appendChild(el('div', 'start-sep')); return; }
      var link = el('a', 'start-item', entry.label);
      link.href = entry.href;
      if (entry.onClick) {
        link.addEventListener('click', function (event) { event.preventDefault(); closeMenu(); entry.onClick(); });
      }
      fly.appendChild(link);
    });
    row.addEventListener('click', function (event) {
      event.stopPropagation();
      var wasOpen = fly.classList.contains('is-open');
      closeFlyouts();
      if (!wasOpen) { fly.classList.add('is-open'); openFlyout = fly; }
    });
    row.addEventListener('mouseenter', function () {
      closeFlyouts();
      fly.classList.add('is-open');
      openFlyout = fly;
    });
    wrap.appendChild(row);
    wrap.appendChild(fly);
    return wrap;
  }

  function action(label, fn) {
    var row = menuItem(label, false);
    row.addEventListener('click', function () { closeMenu(); fn(); });
    row.addEventListener('mouseenter', closeFlyouts);
    return row;
  }

  // On a tool page the Start button used to be the way back to the desktop.
  // The menu took its click, so the menu owes you the door.
  if (desk.classList.contains('desk-shell')) {
    var home = el('a', 'start-item', 'Desktop');
    home.href = '/';
    home.addEventListener('mouseenter', closeFlyouts);
    items.appendChild(home);
    items.appendChild(el('div', 'start-sep'));
  }

  // Programs: every tool, grouped the way the site groups them.
  var programEntries = [];
  GROUPS.forEach(function (group, i) {
    if (i) programEntries.push({ divider: true });
    group.items.forEach(function (tool) {
      programEntries.push({ label: tool.label, href: tool.href });
    });
  });
  items.appendChild(submenu('Programs', programEntries));

  // Documents: the windows on this page, plus the read-me pages.
  var docEntries = [];
  Array.prototype.forEach.call(desk.querySelectorAll('.app-window'), function (win) {
    var title = win.querySelector('.client-title h2');
    if (title && win.id) docEntries.push({ label: title.textContent, href: '#' + win.id });
  });
  if (docEntries.length) docEntries.push({ divider: true });
  docEntries.push({ label: 'How the counter works', href: '/how.html' });
  docEntries.push({ label: 'Security', href: '/security.html' });
  docEntries.push({ label: 'The page that is 1999 bytes', href: '/1999' });
  items.appendChild(submenu('Documents', docEntries));

  items.appendChild(el('div', 'start-sep'));
  items.appendChild(action('Run...', openRun));
  items.appendChild(action('MS-DOS Prompt', function () { openDos(true); }));
  var help = el('a', 'start-item', 'Help');
  help.href = '/how.html';
  help.addEventListener('mouseenter', closeFlyouts);
  items.appendChild(help);
  items.appendChild(el('div', 'start-sep'));
  items.appendChild(action('Shut Down...', shutDown));

  desk.appendChild(menu);

  function menuOpen() { return menu.classList.contains('is-open'); }
  function closeMenu() {
    menu.classList.remove('is-open');
    startBtn.classList.remove('is-pressed');
    closeFlyouts();
  }
  function openMenu() {
    menu.classList.add('is-open');
    startBtn.classList.add('is-pressed');
  }

  startBtn.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (menuOpen()) closeMenu(); else openMenu();
  });

  document.addEventListener('click', function (event) {
    if (menuOpen() && !menu.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { closeMenu(); closeRun(); }
  });

  // ------------------------------------------------------------ Run box

  var run = null;
  function openRun() {
    if (!run) {
      run = el('div', 'run-box');
      run.innerHTML =
        '<div class="client-title"><h2>Run</h2></div>' +
        '<div class="app-body">' +
        '<p class="note">Type the name of a tool and 1999.LOC will open it for you.</p>' +
        '<p><label class="inline" for="run-line">Open</label> ' +
        '<input type="text" id="run-line" autocomplete="off" spellcheck="false" size="22"></p>' +
        '<p><button type="button" class="run-ok">OK</button> ' +
        '<button type="button" class="run-cancel">Cancel</button> ' +
        '<span class="note run-note"></span></p></div>';
      desk.appendChild(run);
      run.querySelector('.run-cancel').addEventListener('click', closeRun);
      run.querySelector('.run-ok').addEventListener('click', doRun);
      run.querySelector('#run-line').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') doRun();
      });
    }
    run.classList.add('is-open');
    run.querySelector('.run-note').textContent = '';
    var line = run.querySelector('#run-line');
    line.value = '';
    line.focus();
  }
  function closeRun() { if (run) run.classList.remove('is-open'); }
  function doRun() {
    var typed = run.querySelector('#run-line').value.trim();
    if (!typed) return;
    var word = typed.toLowerCase();
    if (word === 'command' || word === 'command.com' || word === 'cmd' || word === 'dos') {
      closeRun();
      openDos(true);
      return;
    }
    var tool = findTool(word);
    if (tool) { location.href = tool.href; return; }
    run.querySelector('.run-note').textContent = 'Cannot find ' + typed + '. Check the spelling, or try Programs.';
  }

  // ---------------------------------------------------------- shut down

  function shutDown() {
    var screen = el('div', 'shutdown');
    screen.innerHTML = '<p>It is now safe to turn off<br>your browser.</p>' +
      '<p class="shutdown-note">(click anywhere, it was a joke, nothing was running)</p>';
    document.body.appendChild(screen);
    var leave = function () { screen.remove(); };
    setTimeout(function () { screen.addEventListener('click', leave); }, 250);
    document.addEventListener('keydown', function once() {
      document.removeEventListener('keydown', once);
      leave();
    });
  }

  // -------------------------------------------------------- MS-DOS Prompt

  var dos = null;
  var out = null;
  var input = null;
  var history = [];
  var histAt = 0;

  function dosWindow() {
    if (dos) return dos;
    dos = el('div', 'app-window dos-window');
    dos.id = 'dos';
    dos.innerHTML =
      '<div class="client-title"><h2>MS-DOS Prompt</h2>' +
      '<a class="win-min" href="#" aria-label="Minimise MS-DOS Prompt">_</a></div>' +
      '<div class="app-body dos-body">' +
      '<pre class="dos-out" aria-live="polite"></pre>' +
      '<p class="dos-line"><span class="dos-prompt">C:\\1999LOC&gt;</span>' +
      '<input type="text" class="dos-in" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
      'aria-label="MS-DOS command"></p></div>';

    var host = desk.querySelector('.desk-windows');
    if (host) host.appendChild(dos); else desk.insertBefore(dos, bar);

    out = dos.querySelector('.dos-out');
    input = dos.querySelector('.dos-in');

    var button = el('a', 'task-btn', 'MS-DOS Prompt');
    button.href = '#dos';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      openDos(!dos.classList.contains('is-open'));
    });
    bar.insertBefore(button, bar.querySelector('.task-clock'));
    dos.taskButton = button;

    dos.querySelector('.win-min').addEventListener('click', function (event) {
      event.preventDefault();
      openDos(false);
    });
    dos.querySelector('.dos-body').addEventListener('click', function () { input.focus(); });
    input.addEventListener('keydown', onKey);

    print('1999.LOC [Version 4.19.99]');
    print('(c) 1999 nobody. There is no company.');
    print('');
    print('Type HELP for a list of commands.');
    print('');
    return dos;
  }

  function openDos(open) {
    dosWindow();
    dos.classList.toggle('is-open', open);
    dos.taskButton.classList.toggle('is-open', open);
    if (open) {
      dos.scrollIntoView({ block: 'nearest' });
      input.focus();
    }
  }

  function print(text) {
    out.textContent += (text == null ? '' : text) + '\n';
    out.scrollTop = out.scrollHeight;
  }

  function onKey(event) {
    if (event.key === 'Enter') {
      var line = input.value;
      input.value = '';
      print('C:\\1999LOC>' + line);
      if (line.trim()) { history.push(line); histAt = history.length; }
      runCommand(line);
      out.scrollTop = out.scrollHeight;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (histAt > 0) input.value = history[--histAt];
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (histAt < history.length - 1) input.value = history[++histAt];
      else { histAt = history.length; input.value = ''; }
    }
  }

  function go(href, what) {
    print('Starting ' + what + '...');
    setTimeout(function () { location.href = href; }, 400);
  }

  var COMMANDS = {
    help: function () {
      print('Commands. Most of them even do something.');
      print('');
      print('  DIR              list the tools');
      print('  OPEN <tool>      open one (also CD, START, RUN)');
      print('  TREE             the toolkit, drawn');
      print('  PROVE            check that nothing leaves your browser');
      print('  SOURCE           the repository');
      print('  VER              version');
      print('  DATE, TIME       what the clock says');
      print('  WHOAMI           good question');
      print('  ECHO <text>      say it back');
      print('  CLS              clear the screen');
      print('  EXIT             close this window');
      print('');
      print('There are others. This machine was built in 1999, poke at it.');
    },
    dir: function () {
      print(' Volume in drive C is 1999LOC');
      print(' Directory of C:\\1999LOC');
      print('');
      var bytes = 0;
      ALL_TOOLS.forEach(function (tool, i) {
        var size = 2048 + ((i * 5407) % 61000);
        bytes += size;
        print(dosName(tool) + ' HTM' + String('        ' + size.toLocaleString('en-US')).slice(-10) +
          '  04-19-99  ' + (10 + (i % 2)) + ':' + String('0' + ((i * 7) % 60)).slice(-2) + 'p');
      });
      print('       ' + ALL_TOOLS.length + ' file(s)' + String('           ' + bytes.toLocaleString('en-US')).slice(-13) + ' bytes');
      print('        0 dir(s)   everything else is somebody else\'s problem');
    },
    tree: function () {
      print('C:\\1999LOC');
      GROUPS.forEach(function (group, gi) {
        var last = gi === GROUPS.length - 1;
        print((last ? '\\---' : '+---') + group.label.toUpperCase());
        group.items.forEach(function (tool, ti) {
          var end = ti === group.items.length - 1;
          print((last ? '    ' : '|   ') + (end ? '\\---' : '+---') + tool.label);
        });
      });
    },
    open: function (args) {
      if (!args) { print('Open what? Try DIR.'); return; }
      var tool = findTool(args);
      if (tool) go(tool.href, tool.label);
      else print('Bad command or file name: ' + args);
    },
    cls: function () { out.textContent = ''; },
    ver: function () {
      print('1999.LOC [Version 4.19.99]');
      print('Static pages, a few kilobytes each. No framework detected.');
    },
    echo: function (args) { print(args || ''); },
    date: function () {
      print('Current date is ' + new Date().toDateString());
      print('The taskbar clock says 1999. The taskbar clock is lying, and it knows.');
    },
    time: function () { print('Current time is ' + new Date().toLocaleTimeString()); },
    whoami: function () {
      print('nobody');
      print('');
      print('There are no accounts here, so there is nothing for you to be.');
      print('That is the feature.');
    },
    exit: function () { openDos(false); },
    prove: function () {
      print('Every tool page carries a proof panel: it tries to send data off this');
      print('domain and lets you watch the browser refuse.');
      print('');
      var tool = ALL_TOOLS[0];
      if (tool) print('Open one and press "Prove it". Start with ' + tool.label.toUpperCase() + '.');
    },
    source: function () { go('https://github.com/letsgettoworkbro/countlinesofcode', 'the repository'); },
    uptime: function () { print('up since 1999, 0 users, load average: deliberately low'); },
    credits: function () {
      print('Written by an argument about bloat.');
      print('No trackers were harmed, because none were present.');
    },

    // ------------------------------------------------------------ eggs
    sudo: function (args) {
      print('sudo: command not found.');
      print('No root, no users, no accounts. There is nobody here to become.');
      if (/sandwich/i.test(args || '')) print('And no, get your own sandwich.');
    },
    rm: function (args) {
      if (/-rf?\s*\/?$|-rf\s/.test(args || '')) {
        print('Deleting everything...');
        print('');
        print('0 files removed.');
        print('Your files were never uploaded, so there was nothing here to delete.');
        print('That is the entire point of the place.');
      } else print('rm: nothing of yours is on this machine.');
    },
    format: function () {
      print('WARNING: ALL DATA ON DRIVE C: WILL BE LOST!');
      print('Proceed with Format (Y/N)? Y');
      print('');
      print('0% complete.');
      print('Formatting cancelled: there is no drive. This is a web page.');
    },
    hack: function () {
      print('ACCESS GRANTED');
      print('');
      print('You are in. In your own browser. Where you already were.');
      print('Everything the tools touch is on your side of the wire already.');
    },
    matrix: function () {
      var glyphs = '01#$%&@*+=<>{}[]/\\|';
      var frames = 0;
      var rows = 8;
      var timer = setInterval(function () {
        var line = '';
        for (var i = 0; i < 46; i++) line += glyphs[Math.floor(Math.random() * glyphs.length)];
        print(line);
        if (++frames >= rows) {
          clearInterval(timer);
          print('');
          print('Wake up, Neo. The page weighs 17 kilobytes.');
        }
      }, 90);
    },
    clippy: function () {
      print('  __');
      print(' /  \\   It looks like you are trying to avoid');
      print(' |  |   uploading a private document to a stranger.');
      print(' @  @   Would you like help with that?');
      print(' |  |');
      print(' || |/  [ Yes ]  [ Already doing it ]');
      print(' \\__/');
    },
    cowsay: function (args) {
      var text = args || 'moo';
      print(' ' + new Array(text.length + 3).join('_'));
      print('< ' + text + ' >');
      print(' ' + new Array(text.length + 3).join('-'));
      print('        \\   ^__^');
      print('         \\  (oo)\\_______');
      print('            (__)\\       )\\/\\');
      print('                ||----w |');
      print('                ||     ||');
    },
    fortune: function () {
      var lines = [
        'A megabyte of JavaScript to centre a heading is not progress.',
        'The fastest request is the one you never make.',
        'If it needs an account, ask what the account is for. It is rarely for you.',
        'Every cookie banner is a confession.',
        'Your PDF does not need the cloud. Your PDF needs a function call.',
        'They called it a free tier because "hostage" tested badly.',
        'A donation address should not also be a tracking pixel.',
      ];
      print(lines[Math.floor(Math.random() * lines.length)]);
    },
    ping: function (args) {
      var host = (args || '1999loc.com').split(/\s+/)[0];
      print('Pinging ' + host + ' with 32 bytes of data:');
      for (var i = 0; i < 3; i++) print('Reply from ' + host + ': bytes=32 time<1ms TTL=1999');
      print('');
      print('It is a static page. It was always going to be fast.');
    },
    dial: function () {
      print('ATDT 5551999');
      print('');
      print('  SCREEEE... BEEDLE-EEP... KSSSHHHHHH...');
      print('');
      print('CONNECT 56000');
      print('Every page here fits down this line. That was the design brief.');
    },
    telnet: function () {
      print('Trying towel.blinkenlights.nl...');
      print('Connection refused: connect-src \'self\'.');
      print('Your browser just stopped this page reaching another host. Good browser.');
    },
    coffee: function () {
      print('HTTP/1.1 418 I\'m a teapot');
      print('This machine is short, stout, and out of scope.');
    },
    xyzzy: function () { print('Nothing happens.'); },
    solitaire: function () { print('Not installed. This machine is for work. (The work is avoiding subscriptions.)'); },
    minesweeper: function () { print('Not installed. Try INSPECT FILE, it is the same game with real stakes.'); },
    '1999': function () {
      print('There is a page on this site that is exactly 1999 bytes long.');
      print('Not about 1999. Exactly 1999, counted by a test that fails otherwise.');
      go('/1999', 'the 1999 byte page');
    },
  };

  var ALIASES = {
    ls: 'dir', cd: 'open', start: 'open', run: 'open', clear: 'cls',
    quit: 'exit', bye: 'exit', about: 'ver', motd: 'fortune', neo: 'matrix',
    party: '1999', delete: 'rm', del: 'rm', man: 'help', '?': 'help',
  };

  function runCommand(line) {
    var text = String(line).trim();
    if (!text) return;
    var space = text.indexOf(' ');
    var name = (space < 0 ? text : text.slice(0, space)).toLowerCase();
    var args = space < 0 ? '' : text.slice(space + 1).trim();
    if (ALIASES[name]) name = ALIASES[name];

    if (COMMANDS[name]) { COMMANDS[name](args); print(''); return; }

    // A bare tool name should just work: "wallet" opens the wallet.
    var tool = findTool(text);
    if (tool) { go(tool.href, tool.label); return; }

    print('Bad command or file name: ' + text);
    print('Type HELP.');
    print('');
  }

  // The old cheat code, for the people who will try it.
  var KONAMI = 'ArrowUp,ArrowUp,ArrowDown,ArrowDown,ArrowLeft,ArrowRight,ArrowLeft,ArrowRight,b,a';
  var typed = [];
  document.addEventListener('keydown', function (event) {
    if (input && document.activeElement === input) return;
    typed.push(event.key.length === 1 ? event.key.toLowerCase() : event.key);
    if (typed.length > 10) typed.shift();
    if (typed.join(',') === KONAMI) {
      typed = [];
      openDos(true);
      print('30 lives granted. There was never anything to lose: no account, no');
      print('upload, no subscription. Play on.');
      print('');
    }
  });
})();

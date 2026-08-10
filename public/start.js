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
  // The taskbar moved out of the desk and onto the screen, where a taskbar
  // belongs: last thing in #page, riding the bottom of the view.
  var bar = document.querySelector('#page > .taskbar') || document.querySelector('.taskbar');
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

  /* ------------------------------------------------------------ shortcuts
     A tool page is one app on an otherwise empty desk. Minimising it used to
     leave nothing to look at and nowhere to go but Start, so the rest of the
     toolkit is laid out underneath: minimise, click another, which is how
     switching between programs has always worked. Read out of the page's own
     nav like the Programs menu, so there is still one list. */

  /* The real desktop icons, lifted out of the landing page into icons.js by
     `npm run build:icons` so there is one drawing of each and not two. The
     plain window below is only the fallback for a tool that has no icon yet,
     or for a page that did not load the file. */
  var ICONS = window.LOC1999_ICONS || {};
  var APP_ICON =
    '<svg viewBox="0 0 32 32" aria-hidden="true">' +
    '<rect x="3" y="5" width="26" height="22" fill="#c0c0c0" stroke="#333333" stroke-width="2"/>' +
    '<rect x="4" y="6" width="24" height="5" fill="#000080"/>' +
    '<rect x="23" y="7" width="4" height="3" fill="#c0c0c0"/>' +
    '<rect x="6" y="14" width="14" height="2" fill="#808080"/>' +
    '<rect x="6" y="18" width="18" height="2" fill="#808080"/>' +
    '<rect x="6" y="22" width="10" height="2" fill="#808080"/></svg>';

  function iconFor(href) {
    var icon = ICONS[href];
    return icon && icon.svg ? icon.svg : APP_ICON;
  }

  /** The icon's own name for the tool ("Inspect File"), which is what the
   *  desktop calls it, falling back to the nav's lower-case label. */
  function iconLabel(tool) {
    var icon = ICONS[tool.href];
    return icon && icon.label ? icon.label : tool.label;
  }

  function layShortcuts() {
    var APP = desk.querySelector('.app-window');
    // Only where there is a single app on the desk: the landing page has its
    // own icons, drawn properly, and does not need these.
    if (!desk.classList.contains('desk-shell')) return;
    var here = location.pathname;
    var box = el('div', 'desk-shortcuts');
    GROUPS.forEach(function (group) {
      if (!group.items.length) return;
      box.appendChild(el('span', 'desk-shortcut-label', group.label));
      /* Every tool, including the one you are in.
       *
       * It used to be filtered out, on the reasoning that you are already
       * there. But this is a desktop, and a desktop does not take an icon
       * away because its program is running: the icon stays where it was and
       * the taskbar tells you it is open. Minimising the app and finding a
       * hole where its icon should be is the desk rearranging itself behind
       * your back. */
      group.items.forEach(function (tool) {
        var mine = tool.href === here;
        var link = el('a', 'desk-shortcut' + (mine ? ' is-here' : ''));
        link.href = mine ? '#' + (APP ? APP.id : '') : tool.href;
        link.innerHTML = iconFor(tool.href) + '<span>' + esc(iconLabel(tool)) + '</span>';
        if (mine) {
          link.setAttribute('aria-current', 'page');
          /* Pressing your own icon restores the window rather than loading
             the page again, which would throw away whatever is open in it. */
          link.addEventListener('click', function (event) {
            event.preventDefault();
            if (APP) { APP.classList.add('is-open'); APP.scrollIntoView({ block: 'nearest' }); }
            var button = document.querySelector('.taskbar .task-btn');
            if (button) button.classList.add('is-open');
          });
        }
        box.appendChild(link);
      });
    });
    var window_ = desk.querySelector('.app-window');
    if (window_ && window_.nextSibling) desk.insertBefore(box, window_.nextSibling);
    else desk.appendChild(box);
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
  var CAN_HOVER = !window.matchMedia || window.matchMedia('(hover: hover)').matches;

  function closeFlyouts() {
    if (openFlyout) openFlyout.classList.remove('is-open');
    openFlyout = null;
  }

  function menuItem(label, arrow) {
    var row = el('button', 'start-item');
    row.type = 'button';
    row.innerHTML = esc(label) + (arrow ? '<span class="start-arrow">&#9658;</span>' : '');
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
    /* Hover opens a submenu on a mouse, and must not be bound on a touch
       screen: a tap there fires mouseenter and then click, so the pointer
       would open the flyout and the tap would immediately toggle it shut
       again, which is exactly what it did on a phone. */
    if (CAN_HOVER) {
      row.addEventListener('mouseenter', function () {
        closeFlyouts();
        fly.classList.add('is-open');
        openFlyout = fly;
      });
    }
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
  /* Help opens what this desktop has to say about itself, where there is
   * such a thing; firstrun.js is listening for data-help and runs after
   * this file. Elsewhere it stays a link to the long-form page. */
  var help = el('a', 'start-item', 'Help');
  if (document.getElementById('first-run')) {
    help.href = '#';
    help.setAttribute('data-help', '');
    help.addEventListener('click', function (e) { e.preventDefault(); closeMenu(); });
  } else {
    help.href = '/how.html';
  }
  help.addEventListener('mouseenter', closeFlyouts);
  items.appendChild(help);
  items.appendChild(el('div', 'start-sep'));
  items.appendChild(action('Shut Down...', shutDown));

  bar.appendChild(menu);

  layShortcuts();

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

    var host = desk.querySelector('.desk-windows') || desk;
    host.appendChild(dos);

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
      print('The taskbar clock declines to comment on the year.');
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

  /* The clock tells the time.
   *
   * It used to say "1999" and keep saying it, on the argument that a
   * machine whose whole premise is 1999 cannot display this year the
   * moment scripting runs. That argument only ever applied to the year.
   * A clock showing the time of day names no year at all, so the render
   * without scripting and this one cannot contradict each other about
   * one, and the taskbar stops advertising a clock that does not work.
   * The markup still ships "1999" for the no-JavaScript render, where a
   * stopped clock beats an empty box. The date it is 1999 on stays in
   * the tooltip, which costs nothing and disagrees with nobody.
   *
   * Ticked on the minute boundary rather than once every sixty seconds,
   * so it changes when the minute does instead of drifting off it. */
  var clock = bar.querySelector('.task-clock');
  if (clock) {
    clock.title = 'Friday, 31 December 1999';
    var tick = function () {
      var now = new Date();
      var hour = now.getHours();
      var minute = now.getMinutes();
      clock.textContent = ((hour % 12) || 12) + ':' + (minute < 10 ? '0' : '') + minute +
        ' ' + (hour < 12 ? 'AM' : 'PM');
      setTimeout(tick, 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()));
    };
    tick();
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

  /* =====================================================================
     THE CHIN, AND THE THINGS ON IT

     The controls under the screen were painted on: pseudo-elements, which
     look like buttons and cannot be pressed. These are the same controls
     as real ones, built here rather than written into seventeen pages,
     and the painted versions are hidden the moment these exist. With
     scripting off you still get the painted chin, which is the right
     fallback: a machine with buttons you cannot press is a photograph of
     a machine, and that is what this page is without JavaScript anyway.
     ===================================================================== */

  var page = document.getElementById('page');

  if (page) {
    var chin = el('div', 'chin');
    chin.setAttribute('role', 'group');
    chin.setAttribute('aria-label', 'Machine controls');

    /* --- feedback you can see ----------------------------------------
     *
     * Every control on this chin has an :active state and on a phone you
     * could not see it. iOS only applies :active while something is
     * listening for a touch, and the stylesheet gives up the default tap
     * highlight so the pad does not flash a blue box every time you step
     * through the icons — which between them left a button that did its job
     * and looked completely dead.
     *
     * So the press is held rather than left to the pseudo-class. It is also
     * held for a beat after release: a tap is frequently shorter than the
     * two frames it takes to notice one, and a highlight nobody saw is the
     * same as no highlight. */
    var HELD = 130;
    function pressable(node) {
      var since = 0;
      var timer = null;

      function down() {
        if (timer) { clearTimeout(timer); timer = null; }
        since = Date.now();
        node.classList.add('is-held');
      }
      function up() {
        if (!node.classList.contains('is-held')) return;
        var left = HELD - (Date.now() - since);
        if (left <= 0) { node.classList.remove('is-held'); return; }
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          node.classList.remove('is-held');
          timer = null;
        }, left);
      }

      node.addEventListener('pointerdown', down);
      // pointerleave as well as up: dragging off a button is a cancelled
      // press, and it has to stop looking pressed when you do it.
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
        node.addEventListener(name, up);
      });
      // A button pressed with the keyboard is pressed too.
      node.addEventListener('keydown', function (event) {
        if (event.key === ' ' || event.key === 'Enter') down();
      });
      node.addEventListener('keyup', up);
      node.addEventListener('blur', up);
    }

    /* --- the power button, on both machines --------------------------
     * It turns the screen off, the way the button on the front of a
     * monitor does: the picture collapses to a line and goes, the light
     * under it drops to amber, and pressing it again brings it back. */
    var power = el('button', 'chin-power');
    power.type = 'button';
    power.setAttribute('aria-label', 'Power');
    power.setAttribute('aria-pressed', 'true');
    var led = el('span', 'chin-led');
    led.setAttribute('aria-hidden', 'true');

    function setPower(on) {
      page.classList.toggle('is-off', !on);
      power.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    power.addEventListener('click', function () {
      setPower(page.classList.contains('is-off'));
    });

    /* --- the three buttons beside the pad ----------------------------
     * A palmtop of this age had a row of them under the screen. Three,
     * centred: Back and Forward for the history, the way the browser
     * chrome around it does them, with Info between the two chevrons. The
     * i tells you what the selected icon is; the chevrons are the pages
     * you have already been to. */
    var pad = el('div', 'chin-keys');
    var targets = [
      { label: 'Back', glyph: '<', act: function () { window.history.back(); } },
      { label: 'What this is', info: true, glyph: 'i', act: showInfo },
      { label: 'Forward', glyph: '>', act: function () { window.history.forward(); } },
    ];

    targets.forEach(function (target) {
      var key = el('button', 'chin-key' + (target.info ? ' is-info' : ' is-nav'));
      key.type = 'button';
      key.setAttribute('aria-label', target.label);
      key.textContent = target.glyph;
      key.addEventListener('click', function () {
        if (page.classList.contains('is-off')) return;   // nothing runs with the screen off
        target.act();
      });
      pad.appendChild(key);
    });

    /* --- the d-pad ---------------------------------------------------
     * Moves the selection around the icon field and opens what is under
     * it, which is what a d-pad on a device with a desktop was for. */
    var dpad = el('div', 'chin-dpad');
    var DIRS = [['up', 'Up'], ['right', 'Right'], ['down', 'Down'], ['left', 'Left']];
    var pressed = [];

    /* What there is to move between.
     *
     * The landing page has an icon field; a tool page has the shortcut strip
     * instead, and the pad used to look only for .desk-icon, so on every tool
     * page it moved nothing and read as broken. Both, then, and whichever of
     * them is actually on the glass. */
    function icons() {
      var found = Array.prototype.slice.call(desk.querySelectorAll('.desk-icon, .desk-shortcut'));
      return found.filter(function (node) { return node.offsetParent !== null; });
    }

    /* An open application covers the desk, so there is nothing to walk. Rather
       than have the pad do nothing — which is what it looked like — the first
       press puts the application down, the way pressing a direction on a
       device with a launcher brings the launcher up. The taskbar button still
       has it, and nothing it was holding is lost. */
    function revealDesk() {
      if (icons().length) return false;
      var open = desk.querySelector('.app-window.is-open');
      var button = document.querySelector('.taskbar .task-btn.is-open');
      if (!open || !button) return false;
      button.click();
      return true;
    }

    /* The pad keeps its own cursor rather than reading document.activeElement,
     * because pressing a button on the pad *is* a focus change: the button
     * takes focus, the icon loses it, and every press would read as "nothing
     * is selected" and jump back to the first icon. Which is exactly what it
     * did. The cursor is the selection; focus and the ring follow it. */
    var cursor = -1;

    function pick(next) {
      var all = icons();
      if (!all.length) return;
      cursor = Math.max(0, Math.min(all.length - 1, next));
      all.forEach(function (node, i) { node.classList.toggle('is-picked', i === cursor); });
      all[cursor].focus({ preventScroll: true });
      all[cursor].scrollIntoView({ block: 'nearest' });
    }

    /* Left and right walk the list; up and down jump by a row, worked out
     * from where the icons actually are rather than from a column count,
     * because the column count changes with the width. */
    function move(dir) {
      var all = icons();
      if (!all.length) return;
      if (cursor < 0) { pick(0); return; }
      if (dir === 'left') { pick(cursor - 1); return; }
      if (dir === 'right') { pick(cursor + 1); return; }
      var top = all[cursor].getBoundingClientRect().top;
      var perRow = all.filter(function (node) {
        return Math.abs(node.getBoundingClientRect().top - top) < 4;
      }).length || 1;
      pick(dir === 'down' ? cursor + perRow : cursor - perRow);
    }

    /* One selection, not two.
     *
     * The pad keeps its own cursor, and a finger or a mouse landing on an icon
     * is the same act of choosing. Without saying so, the two drifted apart:
     * the pad lit one icon and a tap lit another, and the next press on the pad
     * jumped the highlight back to wherever the pad still thought it was rather
     * than carrying on from the one you had just touched. So a pointer on an
     * icon, and the focus a click brings with it, move the cursor there, and
     * there is only ever the one highlight. */
    function syncCursorTo(node) {
      var all = icons();
      var idx = all.indexOf(node);
      if (idx < 0) return;
      cursor = idx;
      all.forEach(function (n, i) { n.classList.toggle('is-picked', i === cursor); });
    }
    function pointerToIcon(event) {
      var node = event.target && event.target.closest
        ? event.target.closest('.desk-icon, .desk-shortcut') : null;
      if (node && desk.contains(node)) syncCursorTo(node);
    }
    if (desk) {
      desk.addEventListener('pointerdown', pointerToIcon);
      desk.addEventListener('focusin', pointerToIcon);
    }

    /* ---- Info -------------------------------------------------------
     *
     * Pick an icon — with a finger or with the pad — and press i, and the
     * machine says what that program is for before you open it. The
     * sentences are the ones the landing page already prints beside each
     * tool, lifted into icons.js by the same build step that lifts the
     * pictures, so there is one copy of them.
     *
     * With nothing picked it falls back to this program's own Help, which
     * is the right answer on a tool page: the thing you want told about is
     * the window that is open. */
    function pickedNow() {
      return desk.querySelector('.desk-icon.is-picked, .desk-shortcut.is-picked') ||
             desk.querySelector('.desk-icon:focus, .desk-shortcut:focus');
    }

    function showInfo() {
      var node = pickedNow();
      if (!node) {
        var help = document.querySelector('[data-help]');
        if (help) { help.click(); return; }
        var first = icons()[0];
        if (revealDesk() || first) { pick(0); return; }
        return;
      }
      var href = node.getAttribute('href') || '';
      var entry = ICONS[href] || null;
      var label = (node.querySelector('span') || node).textContent.trim();
      // The picture is already on the glass in front of you; take that one
      // rather than the copy in icons.js, which the landing page does not load.
      var art = node.querySelector('svg');
      openInfo(label, noteFor(href, entry), href,
        art ? art.outerHTML : (entry && entry.svg ? entry.svg : ''));
    }

    /* Where the sentence comes from, in the order the page can supply it.
     *
     * A tool page loads icons.js and has it there. The landing page does
     * not load icons.js at all — it draws its own desktop with no script,
     * which is the whole point of it — but it is the page the sentences are
     * written on, so on that page it reads them straight out of the
     * directory table underneath the icons. Same words either way. */
    function noteFor(href, entry) {
      if (entry && entry.note) return entry.note;
      var link = document.querySelector('.tool-dir a[href="' + href.replace(/"/g, '\\"') + '"]');
      var cell = link && link.closest ? link.closest('td') : null;
      var next = cell && cell.nextElementSibling;
      if (!next) return '';
      var text = next.cloneNode(true);
      // The server badge is a note about hosting, not about the program.
      Array.prototype.forEach.call(text.querySelectorAll('.srv'), function (b) { b.remove(); });
      return text.textContent.replace(/\s+/g, ' ').trim();
    }

    /* The era's About box: a title bar, the icon, a sentence, and one button
       that opens the thing you were asking about. */
    function openInfo(label, note, href, svg) {
      var back = el('div', 'fr-back');
      var box = el('div', 'fr-box info-box');
      var title = el('div', 'fr-title');
      title.appendChild(el('span', null, label));
      var x = el('button', 'fr-x', 'x');
      x.type = 'button';
      x.setAttribute('aria-label', 'Close');
      title.appendChild(x);
      box.appendChild(title);

      var body = el('div', 'fr-body');
      var row = el('div', 'info-row');
      if (svg) {
        var art = el('span', 'info-art');
        art.innerHTML = svg;
        row.appendChild(art);
      }
      row.appendChild(el('p', 'info-note', note || 'No description was written for this one.'));
      body.appendChild(row);
      box.appendChild(body);

      var foot = el('div', 'fr-foot');
      foot.appendChild(el('span', 'fr-count', 'Select an icon and press i for any of them.'));
      var go = el('a', 'fr-next', 'Open');
      go.href = href || '#';
      foot.appendChild(go);
      var close = el('button', 'fr-back-btn', 'Close');
      close.type = 'button';
      foot.appendChild(close);
      box.appendChild(foot);

      back.appendChild(box);
      document.body.appendChild(back);

      // The Escape listener comes off in shut(), whichever way the box is
      // closed; tearing it down only from its own handler left one document
      // listener behind per mouse-closed box.
      function onKey(e) { if (e.key === 'Escape') shut(); }
      function shut() {
        document.removeEventListener('keydown', onKey);
        back.remove();
      }
      x.addEventListener('click', shut);
      close.addEventListener('click', shut);
      back.addEventListener('click', function (e) { if (e.target === back) shut(); });
      document.addEventListener('keydown', onKey);
      go.focus();
    }

    /* The cheat code, on the pad this time. Up up down down left right
     * left right, then any two of the application buttons. */
    var CODE = 'up,up,down,down,left,right,left,right';
    function note(name) {
      pressed.push(name);
      if (pressed.length > 8) pressed.shift();
      if (pressed.join(',') === CODE) {
        pressed = [];
        chin.classList.add('is-cheating');
        setTimeout(function () { chin.classList.remove('is-cheating'); }, 1400);
        openDos(true);
        print('30 lives granted. There was never anything to lose: no account, no');
        print('upload, no subscription. Play on.');
        print('');
      }
    }

    DIRS.forEach(function (pair) {
      var arrow = el('button', 'chin-dir is-' + pair[0]);
      arrow.type = 'button';
      arrow.setAttribute('aria-label', pair[1]);
      arrow.addEventListener('click', function () {
        if (page.classList.contains('is-off')) return;
        note(pair[0]);
        if (revealDesk()) { pick(0); return; }
        move(pair[0]);
      });
      dpad.appendChild(arrow);
    });
    /* No centre button: it was smaller than a fingertip and the thing it
     * did — open what is selected — is a tap on the icon itself, which is
     * right there on the glass. The middle of the pad is moulded dish now. */

    chin.appendChild(dpad);
    chin.appendChild(pad);
    chin.appendChild(power);
    chin.appendChild(led);

    // One place, after the cluster is whole, so a control added later cannot
    // be the one that forgot to say it had been pressed.
    Array.prototype.forEach.call(
      chin.querySelectorAll('.chin-dir, .chin-key, .chin-power'), pressable);

    page.appendChild(chin);
    page.classList.add('has-chin');
  }

  /* The keyboard's lock lamp and its cord were built here: a real element
   * so the lamp could be lit by the actual Caps Lock, and an SVG for the
   * cord because a coiled cable is thirty ellipses along a curve and CSS
   * has no way to say that. The keyboard they belonged to was painted by
   * the stylesheet on the desk in front of the monitor, and the desk is
   * gone: the case fills the display, so there is no in front of it. */
})();

# 1999.LOC: the easter eggs

Everything hidden in the site, so it does not get lost. All of it lives in
`public/start.js` unless noted.

---

## Getting to the prompt

Click **Start** on the taskbar (any page), then **MS-DOS Prompt**. Or Start →
**Run...** and type `command`, `cmd` or `dos`.

The Run box also opens any tool by name: type `wallet`, `pgp`, `count code`,
`WALLET.HTM` or `/wallet.html` and it goes there. Anything it does not know
gets "Cannot find …", the way Run always did.

At the prompt: **up arrow** walks back through your command history. Typing a
tool's name on its own (`wallet`, `swap`, `email`) opens it.

---

## The real commands

| Command | What it does |
|---|---|
| `help` (`man`, `?`) | Lists the commands. Ends with "This machine was built in 1999, poke at it." |
| `dir` (`ls`) | The whole toolkit as a 1999 file listing, with invented sizes and `04-19-99` timestamps. Ends with "0 dir(s) everything else is somebody else's problem". |
| `tree` | Draws the toolkit as an ASCII tree, grouped the way the nav groups it. |
| `open X` (`cd`, `start`, `run`) | Opens that tool. |
| `cls` (`clear`) | Clears the screen. |
| `ver` (`about`) | `1999.LOC [Version 4.19.99]` and "No framework detected." |
| `echo …` | Says it back. |
| `date` | Real date, plus: "The taskbar clock says 1999. The taskbar clock is lying, and it knows." |
| `time` | Real time. |
| `whoami` | `nobody` — "There are no accounts here, so there is nothing for you to be. That is the feature." |
| `prove` | Explains the proof panel and points you at a tool page. |
| `source` | Opens the repository. |
| `uptime` | "up since 1999, 0 users, load average: deliberately low" |
| `credits` | "Written by an argument about bloat. No trackers were harmed, because none were present." |
| `exit` (`quit`, `bye`) | Closes the prompt window. |

Anything unknown answers `Bad command or file name: …` exactly like DOS.

---

## The eggs

Most of these make the site's own argument back at you. That is the joke.

| Command | What happens |
|---|---|
| `sudo` | "No root, no users, no accounts. There is nobody here to become." Add **`sudo make me a sandwich`** for "And no, get your own sandwich." |
| `rm -rf /` (`del`, `delete`) | "Deleting everything… **0 files removed.** Your files were never uploaded, so there was nothing here to delete. That is the entire point of the place." |
| `format c:` | Full DOS format warning, `0% complete`, then "Formatting cancelled: there is no drive. This is a web page." |
| `hack` | `ACCESS GRANTED` — "You are in. In your own browser. Where you already were." |
| `matrix` (`neo`) | Eight frames of animated character rain, then "Wake up, Neo. The page weighs 17 kilobytes." |
| `clippy` | ASCII Clippy: "It looks like you are trying to avoid uploading a private document to a stranger. Would you like help with that?" `[ Yes ] [ Already doing it ]` |
| `cowsay …` | A cow says whatever you typed. Try `cowsay bloat is a choice`. |
| `fortune` (`motd`) | One of seven lines about bloat. "Every cookie banner is a confession." "They called it a free tier because 'hostage' tested badly." |
| `ping [host]` | Three replies, `TTL=1999`, then "It is a static page. It was always going to be fast." |
| `dial` | `ATDT 5551999`, a modem handshake in ASCII, `CONNECT 56000`, "Every page here fits down this line. That was the design brief." |
| `telnet …` | "Connection refused: `connect-src 'self'`. Your browser just stopped this page reaching another host. Good browser." |
| `coffee` | `HTTP/1.1 418 I'm a teapot` — "This machine is short, stout, and out of scope." |
| `xyzzy` | "Nothing happens." (The oldest one in computing, from Colossal Cave.) |
| `solitaire` | "Not installed. This machine is for work. (The work is avoiding subscriptions.)" |
| `minesweeper` | "Not installed. Try INSPECT FILE, it is the same game with real stakes." |
| `1999` (`party`) | Tells you there is a page on the site that is **exactly 1999 bytes long**, counted by a test that fails otherwise, then opens it. |

---

## Outside the prompt

- **Konami code.** ↑ ↑ ↓ ↓ ← → ← → B A anywhere on the desktop (not while typing
  in the prompt) opens the prompt and grants 30 lives: "There was never anything
  to lose: no account, no upload, no subscription. Play on."
- **Shut Down…** in the Start menu fills the browser with the amber
  "It is now safe to turn off your browser," with a small line underneath
  admitting nothing was running. Click anywhere, or press a key, to come back.
- **The taskbar clock** always says `1999`. It is not a clock.
- **The wordmark on the landing page.** The `1999` in `1999.LOC` is a link, set
  so it does not announce itself. It goes to `/1999`: a page that is exactly
  1999 bytes long, enforced by `test/exact1999.test.ts`.
- **`_` in any window's title bar** minimises it to the taskbar. Landing windows
  start minimised; tools start open.

---

## Where they live

- `public/start.js` — the menu, the Run box, the prompt, every command, the
  Konami code, the shutdown screen.
- `public/desk.js` — window minimising.
- `src/worker/exact1999.ts` — the 1999 byte page.
- `public/index.html` — the quiet wordmark link.

/**
 * A page that is exactly 1999 bytes.
 *
 * The wish was for the site's own line count to be exactly 1999, which is not a
 * number anyone can hold: the count moves every time a feature lands or a
 * comment is rewritten, and a number you can only keep true by not working is a
 * bad number to promise.
 *
 * So the constraint moved to something that *can* be held forever. The count of
 * a growing codebase cannot be 1999. The length of one fixed page can be, and
 * unlike a line count it needs no explaining and no methodology page: anyone
 * with curl can check it in one command, and it is either true or it is not.
 *
 * There is no padding in here. No run of spaces, no filler comment sized to
 * make the arithmetic work. Every byte is a byte of the page, which means any
 * edit to the text has to be paid for by an equal edit somewhere else in it.
 * `test/exact1999.test.ts` counts the bytes and fails the build otherwise, and
 * tells you how many you are over or under so the balancing is a minute's work
 * rather than a puzzle.
 *
 * The page is served rather than stored as a file so that what is counted is
 * the response body itself, with no chance of a build step or an editor's
 * trailing newline getting between the claim and the thing claimed.
 */

export const EXACTLY_1999 = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Exactly 1999 Bytes | 1999.LOC</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<div id="page">
<h1><a href="/">1999.LOC</a></h1>
<hr>
<h2>This page is exactly 1999 bytes</h2>
<p>
Not about 1999. Not 1999 before compression, or after it. The HTML your browser
was handed to draw this is 1999 bytes long, and you do not have to believe that:
</p>
<pre>curl -s https://1999loc.com/1999 | wc -c</pre>
<p>
The obvious version of this joke was to make the site itself 1999 lines of code.
That number cannot be kept. It moves every time anything is built or a comment
is rewritten, and a number you can only hold by never working again is not worth
holding. The length of one page, though, is a thing that can be true forever.
</p>
<p>
There is no padding in here. No run of spaces, no filler comment cut to size.
Every byte is a byte of this page, so changing a sentence costs an equal change
to another one. A test counts the bytes on every build and refuses anything else,
which means the only way this page is still exactly 1999 bytes is that somebody
kept paying for it.
</p>
<p>
There is a second one, and it costs nothing to keep. The
<a href="/board">standings</a> carry a board ranked by how close a repository's
line count lands to 1999. It always has a winner, because nearest is a question
that always has an answer, and so far nobody has hit it exactly. Land on it and
nothing can beat you, because nothing beats zero.
</p>
<p>
Which is the trick the rest of the site runs on:
<a href="/inspect.html">do not believe us</a>, go take the measurement.
</p>
<hr>
<p class="footer">
<a href="/">the tools</a> |
<a href="/how.html">how we count</a> |
<a href="/golf">code golf</a> |
<a href="https://github.com/letsgettoworkbro/countlinesofcode">source</a>
</p>
</div>
</body>
</html>
`;

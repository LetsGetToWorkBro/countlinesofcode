/**
 * Reading an email.
 *
 * Two failure modes are worth more attention than the rest. Calling a genuine
 * message forged teaches people to ignore the warning, and missing a tracker
 * tells somebody they are not being watched when they are. The tests lean on
 * both: a clean message must come back clean, and the awkward real-world shapes
 * (folded headers, wrapped links, a display name carrying a fake address) must
 * not slip past.
 */

import { describe, expect, it } from 'vitest';
import {
  addressOf,
  authChecks,
  authVerdict,
  decodeBase64,
  decodeQuotedPrintable,
  displayBody,
  domainOf,
  findTrackers,
  header,
  headerValues,
  hops,
  parseMessage,
  redirectTarget,
  senderCheck,
  trackerHosts,
  trackerVerdict,
} from '../src/client/email';

const CLEAN = [
  'Return-Path: <ada@example.com>',
  'Received: from mail.example.com (mail.example.com [203.0.113.9])',
  '\tby mx.recipient.org with ESMTPS id abc123;',
  '\tTue, 4 Aug 2026 10:00:00 +0000',
  'Authentication-Results: mx.recipient.org;',
  '\tspf=pass smtp.mailfrom=example.com;',
  '\tdkim=pass header.d=example.com;',
  '\tdmarc=pass header.from=example.com',
  'From: Ada Lovelace <ada@example.com>',
  'To: you@recipient.org',
  'Subject: Lunch',
  '',
  '<p>Are you free on Thursday?</p>',
].join('\n');

const PHISH = [
  'Return-Path: <bounce@sendy-mailer.ru>',
  'Authentication-Results: mx.recipient.org; spf=fail smtp.mailfrom=sendy-mailer.ru;',
  '\tdkim=none; dmarc=fail header.from=yourbank.com',
  'From: "PayPal Security <service@paypal.com>" <no-reply@sendy-mailer.ru>',
  'Reply-To: recover@totally-not-paypal.info',
  'Subject: Verify your account',
  '',
  '<a href="http://sendy-mailer.ru/r?url=https%3A%2F%2Fpaypa1.com%2Flogin">Click here</a>',
].join('\n');

describe('parsing', () => {
  it('unfolds a header split across lines', () => {
    // A Received header is routinely four lines. Splitting on newlines alone
    // turns one hop into four fragments and loses the path.
    const message = parseMessage(CLEAN);
    const received = header(message, 'Received')!;
    expect(received).toContain('mail.example.com');
    expect(received).toContain('mx.recipient.org');
    expect(received).not.toContain('\n');
  });

  it('separates headers from body at the first blank line', () => {
    expect(parseMessage(CLEAN).body.trim()).toBe('<p>Are you free on Thursday?</p>');
  });

  it('keeps every copy of a repeated header', () => {
    const raw = 'Received: from a\nReceived: from b\nReceived: from c\n\nbody';
    expect(headerValues(parseMessage(raw), 'Received')).toHaveLength(3);
  });

  it('is not case sensitive about header names', () => {
    expect(header(parseMessage('SUBJECT: hi\n\nbody'), 'subject')).toBe('hi');
  });

  it('copes with a message that is only headers', () => {
    const message = parseMessage('From: a@b.c');
    expect(message.headers).toHaveLength(1);
    expect(message.body).toBe('');
  });

  it('copes with nothing at all', () => {
    expect(parseMessage('').headers).toEqual([]);
    expect(parseMessage(undefined as unknown as string).headers).toEqual([]);
  });

  it('handles Windows line endings, which is how headers arrive when pasted', () => {
    expect(header(parseMessage('From: a@b.c\r\nTo: d@e.f\r\n\r\nbody'), 'To')).toBe('d@e.f');
  });
});

describe('addresses', () => {
  it('pulls the address out of a display name', () => {
    expect(addressOf('Ada Lovelace <ada@example.com>')).toBe('ada@example.com');
    expect(addressOf('<ada@example.com>')).toBe('ada@example.com');
    expect(addressOf('ada@example.com')).toBe('ada@example.com');
  });

  it('is empty rather than wrong when there is no address', () => {
    expect(addressOf('')).toBeNull();
    expect(addressOf('nobody at all')).toBeNull();
  });

  it('takes the domain from the last @, not the first', () => {
    // Local parts can contain an @ when quoted, and taking the first would
    // give the wrong domain, which is the field everything else keys on.
    expect(domainOf('"odd@name"@example.com')).toBe('example.com');
    expect(domainOf(null)).toBeNull();
  });
});

describe('authentication results', () => {
  it('reads all three verdicts', () => {
    const checks = authChecks(parseMessage(CLEAN));
    expect(checks.map((c) => `${c.method}=${c.result}`)).toEqual(['spf=pass', 'dkim=pass', 'dmarc=pass']);
  });

  it('names the domain each check was made against', () => {
    const checks = authChecks(parseMessage(CLEAN));
    expect(checks.find((c) => c.method === 'dmarc')!.domain).toBe('example.com');
  });

  it('explains what a result means rather than just printing it', () => {
    for (const check of authChecks(parseMessage(CLEAN))) {
      expect(check.meaning.length, check.method).toBeGreaterThan(30);
    }
  });

  it('reads a failure', () => {
    const checks = authChecks(parseMessage(PHISH));
    expect(checks.find((c) => c.method === 'spf')!.result).toBe('fail');
    expect(checks.find((c) => c.method === 'dmarc')!.result).toBe('fail');
  });

  it('falls back to Received-SPF when there is no Authentication-Results', () => {
    const raw = 'Received-SPF: pass (example.com: domain of ada@example.com designates 1.2.3.4)\n\nbody';
    expect(authChecks(parseMessage(raw))[0]).toMatchObject({ method: 'spf', result: 'pass' });
  });

  it('says plainly when there is nothing to go on', () => {
    // The dangerous case: someone pastes only the visible headers and reads a
    // blank result as a clean bill of health.
    expect(authVerdict([], senderCheck(parseMessage('From: a@b.c\n\nx')))).toMatch(/nothing here can tell you/i);
  });
});

describe('the verdict', () => {
  it('calls a failure forged, in those words', () => {
    const message = parseMessage(PHISH);
    expect(authVerdict(authChecks(message), senderCheck(message))).toMatch(/forged/i);
  });

  it('is satisfied by a DMARC pass', () => {
    const message = parseMessage(CLEAN);
    expect(authVerdict(authChecks(message), senderCheck(message))).toMatch(/DMARC passed/);
  });

  it('does not confuse authenticated with trustworthy', () => {
    // Spam passes DMARC all day. A passing verdict on a message with mismatched
    // reply-to must still point at the concerns.
    const raw = CLEAN.replace('To: you@recipient.org', 'Reply-To: elsewhere@other.example\nTo: you@recipient.org');
    const message = parseMessage(raw);
    expect(authVerdict(authChecks(message), senderCheck(message))).toMatch(/not the same as being trustworthy/i);
  });

  it('is careful about a missing DMARC rather than alarming', () => {
    const raw = 'Authentication-Results: mx; spf=pass smtp.mailfrom=example.com\nFrom: a@example.com\n\nx';
    const message = parseMessage(raw);
    expect(authVerdict(authChecks(message), senderCheck(message))).toMatch(/not proven/i);
  });
});

describe('the sender', () => {
  it('finds nothing to say about an ordinary message', () => {
    // The most important test here. A tool that flags every normal email is one
    // people learn to ignore.
    expect(senderCheck(parseMessage(CLEAN)).concerns).toEqual([]);
  });

  it('catches an address hidden in the display name', () => {
    const check = senderCheck(parseMessage(PHISH));
    expect(check.concerns.join(' ')).toMatch(/your mail client shows you the first one/i);
    expect(check.from).toBe('no-reply@sendy-mailer.ru');
  });

  it('catches a reply-to pointing somewhere else', () => {
    expect(senderCheck(parseMessage(PHISH)).concerns.join(' ')).toMatch(/Replies go to/);
  });

  it('flags a brand name that does not match the domain', () => {
    const raw = 'From: "Microsoft Account Team" <alerts@random-host.xyz>\n\nx';
    expect(senderCheck(parseMessage(raw)).concerns.join(' ')).toMatch(/does not look like that organisation/i);
  });

  it('does not flag a brand sending from its own domain', () => {
    const raw = 'From: "Microsoft Account Team" <alerts@microsoft.com>\n\nx';
    expect(senderCheck(parseMessage(raw)).concerns).toEqual([]);
  });

  it('describes an envelope mismatch without calling it fraud', () => {
    // Every mailing list on earth does this. The wording has to say so.
    const raw = 'Return-Path: <bounce@mailinglist.example>\nFrom: Ada <ada@example.com>\n\nx';
    const concerns = senderCheck(parseMessage(raw)).concerns.join(' ');
    expect(concerns).toMatch(/normal for mailing lists/i);
  });
});

describe('trackers', () => {
  it('finds a one-pixel image and says what it is for', () => {
    const html = '<img src="https://track.example/open?uid=abc123def" width="1" height="1">';
    const [tracker] = findTrackers(html);
    expect(tracker!.kind).toBe('pixel');
    expect(tracker!.why).toMatch(/tells the sender you opened this/i);
  });

  it('catches a full-size image on a tracking service', () => {
    // The modern shape: not tiny at all, just hosted somewhere that counts.
    const html = '<img src="https://x.list-manage.com/track/img?u=999" width="600" height="200">';
    expect(findTrackers(html)[0]).toMatchObject({ kind: 'image' });
    expect(findTrackers(html)[0]!.why).toMatch(/knowing who opened what/i);
  });

  it('catches an ordinary image carrying an identifier', () => {
    const html = '<img src="https://cdn.example/banner.png?recipient=8f2b91cc44de" width="600">';
    expect(findTrackers(html)[0]!.why).toMatch(/identifier for you specifically/i);
  });

  it('still mentions a plain remote image, because it leaks an IP', () => {
    const html = '<img src="https://cdn.example/logo.png" width="200" height="50">';
    expect(findTrackers(html)[0]!.why).toMatch(/your IP address/i);
  });

  it('ignores embedded and inline images, which fetch nothing', () => {
    expect(findTrackers('<img src="cid:logo@example">')).toEqual([]);
    expect(findTrackers('<img src="data:image/png;base64,AAA">')).toEqual([]);
  });

  it('unwraps a click tracker and says where it really goes', () => {
    const html = '<a href="https://sendy.example/r?url=https%3A%2F%2Freal.example%2Fpage">Read more</a>';
    const [link] = findTrackers(html);
    expect(link!.kind).toBe('link');
    expect(link!.destination).toBe('https://real.example/page');
    expect(link!.label).toBe('Read more');
  });

  it('leaves an honest link alone', () => {
    expect(findTrackers('<a href="https://example.com/article">Read</a>')).toEqual([]);
  });

  it('ignores mailto and anchors', () => {
    expect(findTrackers('<a href="mailto:a@b.c">mail</a><a href="#top">top</a>')).toEqual([]);
  });

  it('finds a tracked link even when the anchor never closes', () => {
    // No </a> anywhere: the label is empty but the tracker is still surfaced.
    const html = '<a href="https://sendy.example/r?url=https%3A%2F%2Freal.example%2Fx">no close tag ever';
    const [link] = findTrackers(html);
    expect(link!.kind).toBe('link');
    expect(link!.destination).toBe('https://real.example/x');
  });

  it('stays linear on a hostile body of unclosed anchors (ReDoS guard)', () => {
    // Thousands of `<a>` openings with no closing tag was quadratic under the old
    // lazy-tail regex. The opening-tag scan plus the no-close short-circuit make
    // this near-instant; a generous ceiling catches a regression without being
    // flaky on a slow machine.
    const html = '<a href="http://x">'.repeat(40000);
    const start = performance.now();
    const found = findTrackers(html);
    const elapsed = performance.now() - start;
    expect(Array.isArray(found)).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it('does not count the same thing twice', () => {
    const html = '<img src="https://t.example/p?uid=aaaaaaaa" width="1"><img src="https://t.example/p?uid=aaaaaaaa" width="1">';
    expect(findTrackers(html)).toHaveLength(1);
  });

  it('lists the distinct hosts a message would contact', () => {
    const html = '<img src="https://a.example/x?uid=aaaaaaaa" width="1"><img src="https://b.example/y" width="1">';
    expect(trackerHosts(findTrackers(html))).toEqual(['a.example', 'b.example']);
  });

  it('finds every tracker in a real-looking message body', () => {
    const message = parseMessage(PHISH);
    const trackers = findTrackers(message.body);
    expect(trackers).toHaveLength(1);
    expect(trackers[0]!.destination).toBe('https://paypa1.com/login');
  });
});

describe('the tracker verdict', () => {
  it('says plainly when a message is clean', () => {
    expect(trackerVerdict([])).toMatch(/Nothing in this message reports back/);
  });

  it('counts each kind and tells you what to do about it', () => {
    const html = '<img src="https://t.example/p?uid=aaaaaaaa" width="1" height="1">' +
      '<img src="https://cdn.example/pic.png" width="400">' +
      '<a href="https://x.list-manage.com/click?u=1">Buy</a>';
    const line = trackerVerdict(findTrackers(html));
    expect(line).toMatch(/1 tracking pixel/);
    expect(line).toMatch(/1 remote image/);
    expect(line).toMatch(/1 wrapped link/);
    expect(line).toMatch(/Blocking remote images/);
  });
});

describe('redirectTarget', () => {
  it('recovers a destination from the usual parameter names', () => {
    expect(redirectTarget('https://a.example/r?url=https%3A%2F%2Fb.example')).toBe('https://b.example');
    expect(redirectTarget('https://a.example/go?target=https%3A%2F%2Fc.example%2Fx')).toBe('https://c.example/x');
  });

  it('does not invent one', () => {
    expect(redirectTarget('https://a.example/page')).toBeNull();
    expect(redirectTarget('https://a.example/r?url=notaurl')).toBeNull();
    expect(redirectTarget('nonsense')).toBeNull();
  });
});

describe('the path it took', () => {
  it('reads hops oldest first, which is how anyone wants to read a journey', () => {
    const raw = [
      'Received: from third by fourth; Tue, 4 Aug 2026 10:00:02 +0000',
      'Received: from first by second; Tue, 4 Aug 2026 10:00:00 +0000',
      '',
      'body',
    ].join('\n');
    const path = hops(parseMessage(raw));
    expect(path.map((h) => h.from)).toEqual(['first', 'third']);
  });

  it('reads a folded Received header as one hop', () => {
    expect(hops(parseMessage(CLEAN))).toHaveLength(1);
    expect(hops(parseMessage(CLEAN))[0]).toMatchObject({ from: 'mail.example.com', by: 'mx.recipient.org' });
  });

  it('has nothing to say when there are no Received headers', () => {
    expect(hops(parseMessage('From: a@b.c\n\nx'))).toEqual([]);
  });
});

describe('the trick this tool exists for', () => {
  // Kept apart from the rest because it is the exact shape that broke an
  // earlier version of addressOf, which took the first bracketed address and
  // so reported the sender as whatever the phisher had put in the display
  // name. The tool would have confirmed the lie rather than exposing it.
  const RAW = 'From: "Security <service@paypal.com>" <no-reply@sendy-mailer.example>\n\nx';

  it('reads the real sender, not the one hidden in the display name', () => {
    expect(senderCheck(parseMessage(RAW)).from).toBe('no-reply@sendy-mailer.example');
  });

  it('takes the last bracketed address, which is where RFC 5322 puts it', () => {
    expect(addressOf('"Security <service@paypal.com>" <no-reply@sendy-mailer.example>'))
      .toBe('no-reply@sendy-mailer.example');
  });

  it('keeps the whole quoted display name, brackets and all', () => {
    expect(senderCheck(parseMessage(RAW)).displayName).toBe('Security <service@paypal.com>');
  });

  it('says the two disagree', () => {
    expect(senderCheck(parseMessage(RAW)).concerns.join(' ')).toMatch(/shows you the first one/i);
  });
});

describe('decoding the body it actually displays', () => {
  it('undoes quoted-printable, so src=3D"..." becomes a real URL', () => {
    expect(decodeQuotedPrintable('src=3D"https://x.example/o?rid=3Dabc"'))
      .toBe('src="https://x.example/o?rid=abc"');
  });

  it('rejoins quoted-printable soft line breaks', () => {
    expect(decodeQuotedPrintable('a very long=\nline')).toBe('a very longline');
  });

  it('undoes base64, and never throws on junk', () => {
    expect(decodeBase64('aGVsbG8=')).toBe('hello');
    expect(decodeBase64('')).toBe('');
    // Malformed input (a lone padding run) must degrade to '', not throw.
    expect(() => decodeBase64('=')).not.toThrow();
    expect(typeof decodeBase64('%%%%')).toBe('string');
  });

  it('pulls the HTML part out of a multipart quoted-printable message', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'plain version',
      '--B',
      'Content-Type: text/html',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<img src=3D"https://open.mailchimp.com/o?rid=3D8f2b91cc44de" width=3D"1">',
      '--B--',
    ].join('\n');
    const body = displayBody(parseMessage(raw));
    expect(body).toContain('src="https://open.mailchimp.com/o?rid=8f2b91cc44de"');
  });

  it('decodes a base64 HTML part', () => {
    const html = '<img src="https://t.example/p?uid=aaaaaaaa" width="1">';
    const raw = [
      'Content-Type: multipart/mixed; boundary="X"',
      '',
      '--X',
      'Content-Type: text/html',
      'Content-Transfer-Encoding: base64',
      '',
      btoa(html),
      '--X--',
    ].join('\n');
    expect(displayBody(parseMessage(raw))).toBe(html);
  });

  it('leaves a plain non-MIME body untouched', () => {
    expect(displayBody(parseMessage('From: a@b.c\n\n<p>hi</p>'))).toBe('<p>hi</p>');
  });
});

describe('trackers survive real-world encoding', () => {
  it('finds the tracking pixel that only the raw scan would have missed', () => {
    // The HIGH finding: a quoted-printable Mailchimp pixel reads on the wire as
    // src=3D"...". The old scan captured "3D" and reported a false all-clear.
    const raw = [
      'Content-Type: text/html',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<img src=3D"https://open.mailchimp.com/o?rid=3D8f2b91cc44de" width=3D"1" height=3D"1">',
    ].join('\n');
    const trackers = findTrackers(displayBody(parseMessage(raw)));
    expect(trackers).toHaveLength(1);
    expect(trackers[0]!.host).toBe('open.mailchimp.com');
  });
});

describe('redirectTarget with awkward destinations', () => {
  it('recovers a destination containing a bare percent sign', () => {
    // The old double-decode threw on %off and returned null, dropping the link.
    expect(redirectTarget('https://track.example/c?url=https%3A%2F%2Fevil.example%2F100%25off'))
      .toBe('https://evil.example/100%off');
  });
});

describe('resilience to hostile input', () => {
  it('reads auth results in linear time on a padded header', () => {
    // The ReDoS finding: a spf= value padded with a long letter run and no ';'
    // used to freeze the tab for seconds. It must now finish promptly.
    const raw = 'Authentication-Results: mx; spf=' + 'a'.repeat(120_000) + '\nFrom: a@b.c\n\nx';
    const start = performance.now();
    authChecks(parseMessage(raw));
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('scans an unclosed anchor in linear time', () => {
    const body = '<a href=' + 'a'.repeat(200_000);
    const start = performance.now();
    findTrackers(body);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('still reads a normal Authentication-Results header correctly', () => {
    const checks = authChecks(parseMessage(CLEAN));
    expect(checks.map((c) => `${c.method}=${c.result}`)).toEqual(['spf=pass', 'dkim=pass', 'dmarc=pass']);
    expect(checks.find((c) => c.method === 'dmarc')!.domain).toBe('example.com');
  });
});

/**
 * Reading an email, bundled to public/email.js.
 *
 * Two questions, one file, because they are asked about the same message and
 * answered from the same bytes.
 *
 * **Is this really from who it says?** Everything needed is already in the
 * headers. SPF, DKIM and DMARC were evaluated by the receiving server before it
 * ever reached you, and the verdicts are written down in Authentication-Results.
 * Nothing here needs to look anything up, which is worth stating because the
 * existing tools for this ask you to paste headers into a website, and headers
 * carry your address, your IP, your correspondents and your employer's internal
 * mail servers.
 *
 * **Who is watching me open it?** A marketing email is full of things that
 * report back: an invisible image whose URL is unique to you, links that go
 * through a click-tracker before arriving where they claim, remote images that
 * leak your IP and the moment you looked. None of that is visible when you read
 * the message, and all of it is plainly there in the source.
 *
 * Nothing in here fetches anything. The trackers are found, named and counted,
 * and their URLs are shown as text. Loading one to "check" it is exactly the
 * thing that tells the sender you opened the mail, and the security policy on
 * this site would not permit it anyway.
 */

// ---------------------------------------------------------------------------
// Taking a message apart
// ---------------------------------------------------------------------------

export interface Header {
  name: string;
  value: string;
}

export interface Message {
  headers: Header[];
  body: string;
}

/**
 * Split a raw message into headers and body.
 *
 * Continuation lines matter: a header may be folded across several lines, and a
 * naive split on newlines turns one Received header into four fragments and
 * loses the path. RFC 5322 says a line starting with space or tab continues the
 * one before it.
 */
export function parseMessage(raw: string): Message {
  const text = String(raw ?? '').replace(/\r\n/g, '\n');
  const blank = text.indexOf('\n\n');
  const headerBlock = blank === -1 ? text : text.slice(0, blank);
  const body = blank === -1 ? '' : text.slice(blank + 2);
  return { headers: parseHeaderBlock(headerBlock), body };
}

/** Parse one block of headers, unfolding continuation lines. */
function parseHeaderBlock(block: string): Header[] {
  const headers: Header[] = [];
  for (const line of block.split('\n')) {
    if (/^[ \t]/.test(line) && headers.length) {
      headers[headers.length - 1]!.value += ' ' + line.trim();
      continue;
    }
    const at = line.indexOf(':');
    if (at > 0) headers.push({ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
  }
  return headers;
}

function headerFrom(headers: Header[], name: string): string | null {
  const wanted = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === wanted)?.value ?? null;
}

/** Every value for a header name, in the order they appear. */
export function headerValues(message: Message, name: string): string[] {
  const wanted = name.toLowerCase();
  return message.headers.filter((h) => h.name.toLowerCase() === wanted).map((h) => h.value);
}

export function header(message: Message, name: string): string | null {
  return headerValues(message, name)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Decoding the body
// ---------------------------------------------------------------------------

/**
 * Undo quoted-printable: =XX hex escapes and the soft line breaks that wrap it.
 *
 * The reason the tracker scan needs this at all: real marketing mail is sent
 * quoted-printable, where `<img src="...">` appears on the wire as
 * `<img src=3D"...">`. Scanning the raw bytes finds `src="3D"`, which is not a
 * URL, so the pixel is missed and the tool reports a false all-clear on exactly
 * the tracker-laden mail it exists to catch.
 */
export function decodeQuotedPrintable(text: string): string {
  return String(text ?? '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Undo base64. Returns '' rather than throwing on malformed input. */
export function decodeBase64(text: string): string {
  const clean = String(text ?? '').replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return '';
  try {
    return typeof atob === 'function' ? atob(clean) : '';
  } catch {
    return '';
  }
}

interface MimePart {
  headers: Header[];
  body: string;
}

const MAX_MIME_DEPTH = 8;

function contentType(headers: Header[]): string {
  return (headerFrom(headers, 'Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
}

function boundaryOf(headers: Header[]): string | null {
  const match = /boundary\s*=\s*"?([^";]+)"?/i.exec(headerFrom(headers, 'Content-Type') ?? '');
  return match ? match[1]!.trim() : null;
}

function decodePart(headers: Header[], body: string): string {
  const cte = (headerFrom(headers, 'Content-Transfer-Encoding') ?? '').trim().toLowerCase();
  if (cte === 'quoted-printable') return decodeQuotedPrintable(body);
  if (cte === 'base64') return decodeBase64(body);
  return body;
}

function splitOnBoundary(body: string, boundary: string): string[] {
  const pieces = body.split('--' + boundary);
  const parts: string[] = [];
  // pieces[0] is the preamble; a piece beginning with '--' is the closing
  // delimiter and ends the multipart.
  for (let i = 1; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (piece.startsWith('--')) break;
    parts.push(piece.replace(/^\r?\n/, '').replace(/\r?\n$/, ''));
  }
  return parts;
}

function flattenParts(headers: Header[], body: string, depth: number): MimePart[] {
  const type = contentType(headers);
  if (depth <= MAX_MIME_DEPTH && type.startsWith('multipart/')) {
    const boundary = boundaryOf(headers);
    if (boundary) {
      const out: MimePart[] = [];
      for (const chunk of splitOnBoundary(body, boundary)) {
        const blank = chunk.indexOf('\n\n');
        const partHeaders = parseHeaderBlock(blank === -1 ? chunk : chunk.slice(0, blank));
        const partBody = blank === -1 ? '' : chunk.slice(blank + 2);
        out.push(...flattenParts(partHeaders, partBody, depth + 1));
      }
      return out;
    }
  }
  // A leaf. Binary attachments (images and the like) are not scanned, so there
  // is no reason to decode a multi-megabyte base64 blob just to throw it away.
  if (type && !type.startsWith('text/')) return [];
  return [{ headers, body: decodePart(headers, body) }];
}

/**
 * The decoded text the message actually displays.
 *
 * Walks the MIME parts, decodes each per its Content-Transfer-Encoding, and
 * returns the HTML part if there is one (that is where trackers live), falling
 * back to plain text, then to the raw body for a message that is not MIME at
 * all. This is what the tracker scan must run on rather than the raw body.
 */
export function displayBody(message: Message): string {
  const parts = flattenParts(message.headers, message.body, 0);
  const html = parts.find((p) => contentType(p.headers) === 'text/html');
  const text = parts.find((p) => contentType(p.headers) === 'text/plain');
  const chosen = html ?? text ?? parts[0];
  return chosen ? chosen.body : decodePart(message.headers, message.body);
}

// ---------------------------------------------------------------------------
// Who sent it
// ---------------------------------------------------------------------------

export type AuthResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror' | 'unknown';

export interface AuthCheck {
  method: 'spf' | 'dkim' | 'dmarc';
  result: AuthResult;
  /** The domain the check was made against, when it names one. */
  domain: string | null;
  /** What this result means, in words. */
  meaning: string;
}

const MEANINGS: Record<string, Partial<Record<AuthResult, string>>> = {
  spf: {
    pass: 'The server that sent this was on the sending domain’s published list of permitted servers.',
    fail: 'The sending domain publishes a list of servers permitted to send its mail, and this was not one of them.',
    softfail: 'The sending domain does not authorise this server, but asked receivers not to reject on that alone.',
    neutral: 'The sending domain explicitly takes no position on whether that server may send its mail.',
    none: 'The sending domain publishes no list of permitted servers, so there was nothing to check against.',
  },
  dkim: {
    pass: 'The message carries a signature that matches, so its content was not altered after the sender signed it.',
    fail: 'A signature is present and does not match. Either the message was modified in transit, or it is forged.',
    none: 'The message is not signed, so nothing about its contents can be verified.',
  },
  dmarc: {
    pass: 'The domain in the From line lines up with an authenticated one, which is the check that matters most.',
    fail: 'The From line does not line up with anything that authenticated. This is what a forged sender looks like.',
    none: 'The sending domain publishes no policy, so nothing was enforced.',
  },
};

/**
 * The verdicts the receiving server recorded.
 *
 * Read out of Authentication-Results rather than recomputed, because they
 * cannot be recomputed here: SPF depends on the connecting IP, which is not in
 * the message, and DKIM needs a DNS lookup this page will not make. The header
 * is the record of what a server that *could* check actually found.
 */
export function authChecks(message: Message): AuthCheck[] {
  // Split into `;`-separated segments up front rather than searching one giant
  // string. Authentication-Results already puts each method's result and its
  // domain qualifier in a single segment, so this both matches the structure
  // and removes a quadratic-backtracking regex over an attacker-controlled
  // header: the old domain pattern (`method=[a-z]+[^;]*?\b(keyword)`) froze the
  // tab for seconds on a header padded with a long run of letters and no `;`.
  const segments = [
    ...headerValues(message, 'Authentication-Results'),
    ...headerValues(message, 'ARC-Authentication-Results'),
    ...headerValues(message, 'Received-SPF').map((v) => `spf=${v}`),
  ]
    .join('; ')
    .split(';');

  // Each of these searches is now linear: a fixed keyword followed by a bounded
  // capture, never an ambiguous quantifier that can overlap what follows it.
  const DOMAIN = /\b(?:header\.(?:d|from)|smtp\.(?:mailfrom|helo)|domain of)[= ]([^\s;]+)/i;

  const found: AuthCheck[] = [];
  for (const method of ['spf', 'dkim', 'dmarc'] as const) {
    const resultPattern = new RegExp(`\\b${method}=([a-z]+)`, 'i');
    const segment = segments.find((s) => resultPattern.test(s));
    if (!segment) continue;
    const result = resultPattern.exec(segment)![1]!.toLowerCase() as AuthResult;
    const domainMatch = DOMAIN.exec(segment);
    found.push({
      method,
      result,
      domain: domainMatch ? domainMatch[1]!.replace(/^.*@/, '').replace(/[,;]$/, '') : null,
      meaning: MEANINGS[method]?.[result] ?? `The server recorded ${method}=${result}.`,
    });
  }
  return found;
}

/**
 * Just the address out of a From line, without the display name.
 *
 * The **last** angle-bracketed group, not the first, and the difference is the
 * whole tool. A display name may contain anything, including a complete fake
 * address in brackets, and that is exactly what the trick below looks like:
 *
 *     From: "Security <service@paypal.com>" <no-reply@sendy-mailer.example>
 *
 * Taking the first match reports the sender as service@paypal.com, which is
 * the lie the message was built to tell. RFC 5322 puts the real angle-addr
 * last, after the display name, so the last match is the right one.
 */
export function addressOf(value: string): string | null {
  const text = String(value ?? '');
  const angled = [...text.matchAll(/<([^<>]+)>/g)];
  const last = angled.length ? angled[angled.length - 1]![1] : null;
  const bare = /([^\s<>,;"]+@[^\s<>,;"]+)/.exec(text)?.[1] ?? null;
  const found = last ?? bare;
  return found ? found.trim().toLowerCase() : null;
}

export function domainOf(address: string | null): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  return at === -1 ? null : address.slice(at + 1).toLowerCase() || null;
}

export interface SenderCheck {
  /** What the mail client shows you. */
  displayName: string | null;
  from: string | null;
  /** Where a reply actually goes. */
  replyTo: string | null;
  /** The envelope sender, which bounces go to and which nobody sees. */
  returnPath: string | null;
  /** Things worth a second look, in plain words. */
  concerns: string[];
}

/**
 * The parts of the From line that disagree with each other.
 *
 * Nearly every phishing message is a mismatch somewhere: a display name saying
 * one thing while the address says another, or a Reply-To pointing somewhere
 * the From line does not. Mail clients show the display name and hide the rest,
 * which is the entire reason this works.
 */
export function senderCheck(message: Message): SenderCheck {
  const fromRaw = header(message, 'From') ?? '';
  const from = addressOf(fromRaw);
  const replyTo = addressOf(header(message, 'Reply-To') ?? '');
  const returnPath = addressOf(header(message, 'Return-Path') ?? '');
  // A quoted display name has to be read as a quoted string, not "everything
  // up to the first angle bracket". The whole point of the trick below is that
  // the name itself contains a fake address, brackets and all, and stopping at
  // the first < throws away the evidence.
  const displayName = (/^\s*"((?:[^"\\]|\\.)*)"/.exec(fromRaw)?.[1]
    ?? /^\s*([^"<]*?)\s*</.exec(fromRaw)?.[1]
    ?? '').trim() || null;

  const concerns: string[] = [];
  const fromDomain = domainOf(from);

  // A display name containing an address is the oldest trick there is: the
  // client shows "billing@yourbank.com" and the real address is elsewhere.
  const nameAddress = displayName ? addressOf(displayName) : null;
  if (nameAddress && nameAddress !== from) {
    concerns.push(`The name on this message reads as "${displayName}", but the address it was actually sent from is ${from ?? 'not stated'}. Those are different, and your mail client shows you the first one.`);
  }

  if (replyTo && domainOf(replyTo) !== fromDomain) {
    concerns.push(`Replies go to ${replyTo}, which is a different domain from the sender, ${fromDomain ?? 'unknown'}. Legitimate mail does this sometimes; so does every message designed to collect your answer somewhere else.`);
  }

  if (returnPath && fromDomain && domainOf(returnPath) !== fromDomain) {
    concerns.push(`The envelope sender is ${returnPath}, a different domain from the visible sender. This is normal for mailing lists and marketing platforms, and also normal for forgeries.`);
  }

  if (displayName && /\b(bank|paypal|apple|microsoft|amazon|hmrc|irs|netflix|google)\b/i.test(displayName) &&
      fromDomain && !new RegExp(`\\b${displayName.match(/\b(bank|paypal|apple|microsoft|amazon|hmrc|irs|netflix|google)\b/i)![0]}\\b`, 'i').test(fromDomain)) {
    concerns.push(`The name claims to be "${displayName}" but the message comes from ${fromDomain}, which does not look like that organisation.`);
  }

  return { displayName, from, replyTo, returnPath, concerns };
}

/** The verdict line for the whole authentication section. */
export function authVerdict(checks: AuthCheck[], sender: SenderCheck): string {
  if (!checks.length) {
    return 'No authentication results in this message. Either the headers were trimmed before you copied them, or the receiving server did not record any. Nothing here can tell you whether the sender is genuine.';
  }
  const dmarc = checks.find((c) => c.method === 'dmarc');
  const failed = checks.filter((c) => c.result === 'fail');

  if (failed.length) {
    return `${failed.map((c) => c.method.toUpperCase()).join(' and ')} failed. Treat this as forged until you have another reason to think otherwise.`;
  }
  if (dmarc?.result === 'pass') {
    const extra = sender.concerns.length ? ' The sender is who they say, which is not the same as being trustworthy: read the notes below.' : '';
    return `DMARC passed, so the domain in the From line really did authorise this message.${extra}`;
  }
  return 'Nothing failed outright, but DMARC did not pass either, so the From line is not proven. That is common for older domains and for mail forwarded through a list.';
}

// ---------------------------------------------------------------------------
// Who is watching
// ---------------------------------------------------------------------------

export type TrackerKind = 'pixel' | 'image' | 'link' | 'beacon';

export interface Tracker {
  kind: TrackerKind;
  url: string;
  host: string;
  /** Why this one was picked out. */
  why: string;
  /** The text of the link, for a wrapped link. */
  label?: string;
  /** Where a wrapped link claims to go, when that can be recovered. */
  destination?: string;
}

const PIXEL_SIZE = /(?:width|height)\s*[=:]\s*["']?\s*(\d+)/gi;

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Services whose entire business is knowing that you opened it. */
const KNOWN_TRACKERS = [
  'list-manage.com', 'mailchimp.com', 'sendgrid.net', 'sparkpostmail.com', 'mandrillapp.com',
  'hubspot.com', 'hs-sites.com', 'marketo.com', 'mktoresp.com', 'pardot.com', 'exacttarget.com',
  'salesforce.com', 'braze.com', 'iterable.com', 'customer.io', 'klaviyo.com', 'klclick.com',
  'sailthru.com', 'cmail19.com', 'createsend.com', 'constantcontact.com', 'rs6.net',
  'doubleclick.net', 'google-analytics.com', 'omtrdc.net', 'go.pardot.com', 'mixpanel.com',
  'amplitude.com', 'segment.io', 'branch.io', 'appsflyer.com', 'sendinblue.com', 'brevo.com',
  'postmarkapp.com', 'mailgun.org', 'awstrack.me', 'sendibt2.com', 'ctrk.klclick.com',
];

function knownTracker(host: string): string | null {
  const hit = KNOWN_TRACKERS.find((t) => host === t || host.endsWith('.' + t));
  return hit ?? null;
}

/**
 * Everything in the message that reports back.
 *
 * Deliberately generous about what counts as a tracking pixel. A one-by-one
 * transparent image is the textbook case, but the modern version is a normal
 * looking image on a tracking domain with a unique identifier in the path, and
 * calling only the tiny ones trackers would miss most of them.
 */
/** Beyond this the scan is capped; a real HTML email part is far smaller. */
const MAX_SCAN = 1_000_000;

export function findTrackers(html: string): Tracker[] {
  // Cap the scanned length: trackers live near the top of a real email's HTML,
  // and this bounds the work on a hostile multi-megabyte body regardless of the
  // regexes below.
  const source = String(html ?? '').slice(0, MAX_SCAN);
  const found: Tracker[] = [];
  const seen = new Set<string>();

  const push = (t: Tracker) => {
    const key = `${t.kind}:${t.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(t);
  };

  for (const match of source.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0]!;
    const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!src || /^(cid:|data:)/i.test(src)) continue;
    const host = hostOf(src);
    if (!host) continue;

    const sizes = [...tag.matchAll(PIXEL_SIZE)].map((m) => Number(m[1]));
    const tiny = sizes.length > 0 && sizes.every((n) => n <= 3);
    const service = knownTracker(host);
    const identified = /[?&/](?:uid|u|id|e|eid|rid|mid|sid|token|recipient|subscriber|open)[=/][A-Za-z0-9._%-]{8,}/i.test(src);

    if (tiny) {
      push({ kind: 'pixel', url: src, host, why: 'An image sized one pixel or smaller. It is not there to be seen; it is there to be fetched, which tells the sender you opened this.' });
    } else if (service) {
      push({ kind: 'image', url: src, host, why: `Hosted on ${service}, which is a service for knowing who opened what. Loading it reports back.` });
    } else if (identified) {
      push({ kind: 'image', url: src, host, why: 'The address contains what looks like an identifier for you specifically, so fetching it says who opened the message.' });
    } else {
      push({ kind: 'image', url: src, host, why: 'A remote image. Loading it tells that server your IP address and the moment you read this.' });
    }
  }

  // Match only the opening tag (up to its first `>`, linear), then find the
  // matching `</a>` by a forward index scan. The old single pattern paired an
  // opening `[^>]*` with a lazy `[\s\S]*?...<\/a>` tail: on a body of many
  // `<a ...>` openings with no closing tag it retried the tail from every
  // opening, O(n^2) backtracking. Given N unclosed anchors this is a real
  // ReDoS on the attacker-authored HTML this tool exists to consume. A single
  // `includes('</a>')` check short-circuits the whole close-tag search when
  // there is no closing tag anywhere.
  const anyClose = source.includes('</a>');
  const openTag = /<a\b([^>]*)>/gi;
  let anchor: RegExpExecArray | null;
  while ((anchor = openTag.exec(source)) !== null) {
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(anchor[1]!)?.[1];
    if (!href || /^(mailto:|tel:|#)/i.test(href)) continue;
    const host = hostOf(href);
    if (!host) continue;
    // The label is whatever sits before the next `</a>`. indexOf is a linear
    // forward scan from the opening tag's end, not a backtracking match.
    const closeAt = anyClose ? source.indexOf('</a>', openTag.lastIndex) : -1;
    const inner = closeAt >= 0 ? source.slice(openTag.lastIndex, closeAt) : '';
    const label = inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const service = knownTracker(host);
    const destination = redirectTarget(href);

    if (service || destination) {
      push({
        kind: 'link',
        url: href,
        host,
        label: label || undefined,
        destination: destination ?? undefined,
        why: service
          ? `Goes through ${service} first, which records the click before sending you on.`
          : 'Goes somewhere else first and forwards you on, so the click is recorded.',
      });
    }
  }

  return found;
}

/** A redirector's real destination, when it is sitting in the query string. */
export function redirectTarget(url: string): string | null {
  try {
    const parsed = new URL(url);
    for (const key of ['url', 'u', 'redirect', 'target', 'dest', 'destination', 'link', 'r', 'q']) {
      // searchParams.get already returns the decoded value. Decoding it a second
      // time threw on a destination containing a bare `%` (e.g. `.../100%off`),
      // dropping exactly the wrapped phishing links this is meant to surface.
      const value = parsed.searchParams.get(key);
      if (value && /^https?:\/\//i.test(value)) return value;
    }
  } catch {
    return null;
  }
  return null;
}

/** Every distinct host the message would contact if you let it load. */
export function trackerHosts(trackers: Tracker[]): string[] {
  return [...new Set(trackers.map((t) => t.host))].sort();
}

export function trackerVerdict(trackers: Tracker[]): string {
  if (!trackers.length) {
    return 'Nothing in this message reports back. No remote images, no tracking pixel, no wrapped links. That is rarer than it should be.';
  }
  const pixels = trackers.filter((t) => t.kind === 'pixel').length;
  const links = trackers.filter((t) => t.kind === 'link').length;
  const hosts = trackerHosts(trackers).length;

  const parts: string[] = [];
  if (pixels) parts.push(`${pixels} tracking ${pixels === 1 ? 'pixel' : 'pixels'}`);
  const images = trackers.filter((t) => t.kind === 'image').length;
  if (images) parts.push(`${images} remote ${images === 1 ? 'image' : 'images'}`);
  if (links) parts.push(`${links} wrapped ${links === 1 ? 'link' : 'links'}`);

  return `${parts.join(', ')}, across ${hosts} ${hosts === 1 ? 'host' : 'hosts'}. Blocking remote images in your mail client stops most of this; the links only report back if you click them.`;
}

// ---------------------------------------------------------------------------
// The path it took
// ---------------------------------------------------------------------------

export interface Hop {
  from: string | null;
  by: string | null;
  /** As written in the header. */
  when: string | null;
}

/**
 * The Received headers, oldest first.
 *
 * They arrive newest-first because each server adds its own to the top, which
 * is the opposite of how anyone wants to read a journey. Worth knowing that
 * everything below the first server you actually trust can be forged: a sender
 * can invent as many hops as they like before handing the message over.
 */
export function hops(message: Message): Hop[] {
  return headerValues(message, 'Received')
    .map((value) => ({
      from: /\bfrom\s+([^\s;]+)/i.exec(value)?.[1] ?? null,
      by: /\bby\s+([^\s;]+)/i.exec(value)?.[1] ?? null,
      when: value.includes(';') ? value.slice(value.lastIndexOf(';') + 1).trim() : null,
    }))
    .reverse();
}

const globalScope = globalThis as unknown as { LOC1999_EMAIL?: Record<string, unknown> };
globalScope.LOC1999_EMAIL = {
  parseMessage,
  header,
  headerValues,
  displayBody,
  decodeQuotedPrintable,
  decodeBase64,
  authChecks,
  authVerdict,
  senderCheck,
  addressOf,
  domainOf,
  findTrackers,
  trackerHosts,
  trackerVerdict,
  redirectTarget,
  hops,
};

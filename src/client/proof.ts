/**
 * The proof panel's logic, bundled to public/proof.js.
 *
 * Every tool on this site says it does not upload your file. Saying it is
 * worth nothing — every site that does upload your file says the same thing,
 * usually in the same words. This is the part that lets a visitor check.
 *
 * Three kinds of evidence, in increasing order of how much they are worth:
 *
 *   **What this page did.** Every request the browser has made since the page
 *   loaded, read out of the Performance timeline — which records them whether
 *   or not the code that made them wanted it recorded. If any of them went
 *   somewhere other than this domain, it says so.
 *
 *   **What this page is allowed to do.** The Content-Security-Policy served
 *   with the page forbids talking to any other origin. That is not a promise
 *   from us, it is a rule the browser enforces against us.
 *
 *   **The browser's own word for it.** The panel deliberately tries to send
 *   data to somewhere else, several ways, and shows the browser refusing —
 *   with the refusal reported by the browser's own securitypolicyviolation
 *   event rather than by our code claiming it happened.
 *
 * The honest limit, which the panel states plainly: this is a page auditing
 * itself, and a page that wanted to lie could lie here too. The version that
 * does not require trusting anyone is the Network tab in your own browser, or
 * turning off your wifi and watching the tool keep working. The panel says so.
 */

// ---------------------------------------------------------------------------
// Where requests went
// ---------------------------------------------------------------------------

export interface RequestRecord {
  url: string;
  /** What kind of thing it was: script, css, fetch, img… */
  kind: string;
}

export interface NetworkAudit {
  /** Requests to this site, which are the page's own files. */
  own: RequestRecord[];
  /** Requests anywhere else. Should always be empty. */
  foreign: RequestRecord[];
}

/**
 * The host part of a URL, or '' when there is not one.
 *
 * `base` is used only to resolve a relative URL. It is deliberately not a
 * default: `new URL('', base)` succeeds and returns the *base's* host, so a
 * blank or unparseable entry would come back looking like it belonged to
 * whatever was passed in — which, in a panel whose whole job is spotting
 * requests that went somewhere unexpected, is the wrong way to be wrong.
 */
export function hostOf(url: string, base?: string): string {
  if (!String(url ?? '').trim()) return '';
  try {
    return new URL(url, base).host;
  } catch {
    return '';
  }
}

/**
 * Sort requests into ours and everyone else's.
 *
 * `data:` and `blob:` are neither: they are bytes the page already holds and
 * never touch the network, so counting them as requests would inflate the
 * number and counting them as foreign would be a false alarm.
 */
export function classify(entries: RequestRecord[], origin: string): NetworkAudit {
  const home = hostOf(origin);
  const own: RequestRecord[] = [];
  const foreign: RequestRecord[] = [];

  for (const entry of entries) {
    if (/^(data|blob):/i.test(entry.url)) continue;
    (hostOf(entry.url, origin) === home ? own : foreign).push(entry);
  }
  return { own, foreign };
}

/** The one-line verdict for the network section. */
export function describeNetwork(audit: NetworkAudit, host: string): string {
  const n = audit.own.length;
  if (audit.foreign.length) {
    return `${audit.foreign.length} request${audit.foreign.length === 1 ? '' : 's'} went somewhere other than ${host}. That should never happen. Please report it.`;
  }
  return `${n} request${n === 1 ? '' : 's'}, all to ${host}. Nothing has been sent anywhere else.`;
}

// ---------------------------------------------------------------------------
// What is stored
// ---------------------------------------------------------------------------

export interface StoredThing {
  key: string;
  /** Roughly how big it is, in bytes. */
  size: number;
  /** What it holds, in plain words, or null when we do not recognise it. */
  purpose: string | null;
}

/**
 * Everything this site is known to keep, and why.
 *
 * A key that turns up here and is *not* on this list is worth flagging rather
 * than explaining away — it would mean something is storing data that nobody
 * documented.
 */
export const KNOWN_STORAGE: Record<string, string> = {
  'loc1999:convert-profiles':
    'A number per PDF-producing program, so the converter remembers when you corrected its heading detection. No document text, no filenames.',
  'loc1999:signatures':
    'Signatures you chose to save on the PDF editor, as images. Only ones you explicitly saved.',
  'loc1999:pgp-keys':
    'PGP keys you made or imported. Private keys are here if you made one, protected by their passphrase if you set one.',
  'loc1999:fiat':
    'Whether the swap and wallet pages show what an amount is worth in dollars. The word on or off, nothing else.',
};

/**
 * The shell also writes one flag per program under these prefixes, with the
 * program's name appended: loc1999:seen:audio, loc1999:read:zip:<hash>,
 * loc1999:warned:<key>. They hold no content, only "you have seen / dismissed
 * this once". Matching by exact key missed them, so the panel meant to be the
 * honest arbiter of storage was red-flagging the site's own UI-state flags as
 * undocumented and "worth reporting" the moment you dismissed the first-run
 * dialog. These are that documentation.
 */
export const KNOWN_STORAGE_PREFIXES: Record<string, string> = {
  'loc1999:seen:':
    "A flag that you have seen a program's first-run dialog, so it does not reopen every visit. One per program, no content.",
  'loc1999:read:':
    'A flag that you dismissed a specific note or warning, so it stays dismissed. No content, just that you closed it.',
  'loc1999:warned:':
    'A flag that a one-time warning has been shown, so it is not shown again. No content.',
};

/** What a stored key is for: an exact match first, then a known prefix. */
export function purposeOf(key: string): string | null {
  if (key in KNOWN_STORAGE) return KNOWN_STORAGE[key]!;
  for (const prefix of Object.keys(KNOWN_STORAGE_PREFIXES)) {
    if (key.startsWith(prefix)) return KNOWN_STORAGE_PREFIXES[prefix]!;
  }
  return null;
}

export function describeStorage(entries: { key: string; size: number }[]): StoredThing[] {
  return entries.map((entry) => ({
    key: entry.key,
    size: entry.size,
    purpose: purposeOf(entry.key),
  }));
}

export function storageVerdict(things: StoredThing[]): string {
  if (!things.length) return 'Nothing. This site has stored no data in your browser.';
  const unknown = things.filter((t) => !t.purpose).length;
  if (unknown) {
    return `${things.length} item${things.length === 1 ? '' : 's'}, ${unknown} of which is not one this site documents. That is worth reporting.`;
  }
  return `${things.length} item${things.length === 1 ? '' : 's'}, all of them things you did here. Listed below, and you can delete them.`;
}

// ---------------------------------------------------------------------------
// The leak test
// ---------------------------------------------------------------------------

export type LeakOutcome = 'blocked' | 'failed' | 'sent' | 'unsupported';

export interface LeakResult {
  /** What was attempted, in words. */
  route: string;
  outcome: LeakOutcome;
  /** What happened, for the visitor to read. */
  detail: string;
}

/**
 * How to read the result of a leak attempt.
 *
 * `blocked` is the browser reporting a policy violation — the strongest
 * evidence, because the browser said it, not us. `failed` means the request
 * did not succeed but no violation was reported, which usually means it was
 * stopped some other way. `sent` would mean data actually left, and would be a
 * serious bug: the panel says so in those words rather than softening it.
 */
export function leakVerdict(results: LeakResult[]): { ok: boolean; summary: string } {
  const escaped = results.filter((r) => r.outcome === 'sent');
  if (escaped.length) {
    return {
      ok: false,
      summary: `${escaped.length} of ${results.length} attempts got through. That is a serious bug. Please report it.`,
    };
  }
  const blocked = results.filter((r) => r.outcome === 'blocked').length;
  return {
    ok: true,
    summary: `All ${results.length} attempts failed. ${blocked} of them were refused by your browser's own policy enforcement, which reported the refusal itself.`,
  };
}

// ---------------------------------------------------------------------------
// Where the code is
// ---------------------------------------------------------------------------

export const REPO = 'https://github.com/letsgettoworkbro/countlinesofcode';

/**
 * Which files actually implement each tool.
 *
 * Pointing at the repository root is not much of an answer when someone wants
 * to check a specific claim. These are the files to read, in the order that
 * makes sense: the page, then the engine behind it.
 */
export const SOURCES: Record<string, string[]> = {
  '/video.html': ['public/video-page.js', 'public/video-timeline.js', 'src/client/video.ts', 'src/client/gif.ts'],
  '/zip.html': ['public/zip-page.js', 'src/client/zipkit.ts', 'src/client/zip.ts'],
  // 'encrypt' page: password locking and PGP keys, on tabs, over one engine.
  '/lock.html': ['public/lock-page.js', 'public/pgp-page.js', 'public/tabs.js', 'src/client/pgpkit.ts'],
  // The money page: the Monero and Bitcoin wallets and the address checker.
  '/wallet.html': [
    'public/wallet-page.js',
    'src/client/walletkit.ts',
    'public/btc-page.js',
    'src/client/btcwallet.ts',
    'public/monero-page.js',
    'src/client/monero.ts',
    'src/client/monero-words.ts',
    'public/tabs.js',
    'src/lib/xmrproxy.ts',
    'src/lib/btcproxy.ts',
    'public/fiat.js',
    'src/lib/pricekit.ts',
    'src/worker/price.ts',
  ],
  // The swap page: a thin client over the Worker's relay to the exchanges.
  '/swap.html': [
    'public/swap-page.js',
    'src/worker/swap.ts',
    'src/lib/swapkit.ts',
    'public/fiat.js',
    'src/lib/pricekit.ts',
    'src/worker/price.ts',
  ],
  // The payment-request page: the address checks and URI builder, and the QR
  // encoder it shares with the code tool. No server half; it makes no request.
  '/pay.html': ['public/pay-page.js', 'src/client/paykit.ts', 'src/client/qrkit.ts'],
  // Two tools on one page: the message checker, and the throwaway inbox (its
  // server half stores incoming mail for an hour).
  '/email.html': [
    'public/email-page.js',
    'src/client/email.ts',
    'public/mail-page.js',
    'public/tabs.js',
    'src/worker/mail.ts',
    'src/lib/mailbox.ts',
  ],
  // The PDF page: the editor and page operations, on tabs, over the same engine.
  '/sign.html': ['public/sign.js', 'src/client/pdfedit.ts', 'src/client/pdfstream.ts', 'src/client/pdfpages.ts'],
  '/convert.html': ['public/convert-page.js', 'src/client/convert.ts', 'src/client/docmodel.ts'],
  '/inspect.html': ['public/inspect-page.js', 'src/client/inspect.ts'],
  '/sheet.html': ['public/sheet-page.js', 'src/client/sheet.ts'],
  '/image.html': ['public/image.js'],
  '/unlock.html': ['public/unlock.js', 'public/pdfrender.js', 'src/client/pdfedit.ts'],
  '/shrink.html': ['public/shrink.js', 'public/pdfrender.js', 'src/client/pdfedit.ts'],
  '/audio.html': ['public/audio-page.js', 'src/client/audiokit.ts', 'public/vendor/lame/lame.min.js'],
  // The QR page: the in-house encoder and reader are both in one module.
  '/qr.html': ['public/qr-page.js', 'src/client/qrkit.ts'],
  // The invoice page: the totals and the three PDF templates.
  '/invoice.html': ['public/invoice-page.js', 'src/client/invoicekit.ts'],
  '/code.html': ['public/app.js', 'src/client/bigcount.ts', 'src/lib/counter.ts'],
};

/** The files behind whatever page this is, or the general ones. */
export function sourcesFor(path: string): string[] {
  return SOURCES[path] ?? ['public/index.html', 'src/worker/index.ts'];
}

export function sourceLink(file: string): string {
  return `${REPO}/blob/main/${file}`;
}

/**
 * Which tools genuinely never touch the network after the page loads, and
 * which have a reason to.
 *
 * The counter is the honest exception on this site: counting a GitHub
 * repository means asking GitHub about it. Pretending otherwise would make
 * every other claim here worth less.
 */
export const SERVER_PAGES: Record<string, string> = {
  '/code.html': 'Counting a repository means fetching it. Public repositories go through our server; connecting your GitHub account sends the request from your browser instead.',
  '/golf': 'Submitting a score records it on our server, which is what a leaderboard is.',
  '/board': 'The standings are held on our server.',
  '/email.html': 'The disposable-inbox tab asks this site’s server for mail sent to your address, and the server stores it for an hour. The message-checker tab makes no network request at all; it reads what you paste, in the tab.',
  '/wallet.html': 'The Monero tab talks to a Monero node, and the Bitcoin tab to a block explorer, both through this site’s server, which is what syncing a wallet is; neither ever sees your IP, and no key ever crosses the wire. The dollar line under a balance is worked out here from a price table this site fetches once for everybody and caches, so no balance, amount or address is ever sent to price anything, and it can be switched off. The address-checker tab makes no network request at all.',
  '/swap.html': 'Quotes and orders go to the exchange services (Exolix, Godex, and ChangeNOW or Trocador where configured) through this site’s server, so they see Cloudflare rather than you. The server stores nothing about a swap; the order id lives in this tab alone. The dollar figures are worked out here from a price table this site fetches once for everybody and caches, so no amount is ever sent to price it, and they can be switched off.',
};

export function networkNote(path: string): string | null {
  return SERVER_PAGES[path] ?? null;
}

const globalScope = globalThis as unknown as { LOC1999_PROOF?: Record<string, unknown> };
globalScope.LOC1999_PROOF = {
  hostOf,
  classify,
  describeNetwork,
  describeStorage,
  storageVerdict,
  leakVerdict,
  sourcesFor,
  sourceLink,
  networkNote,
  purposeOf,
  KNOWN_STORAGE,
  KNOWN_STORAGE_PREFIXES,
  REPO,
};

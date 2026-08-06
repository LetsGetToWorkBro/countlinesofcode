/**
 * The temporary-inbox tool's server half: receive a message, store it briefly,
 * hand it back to the one browser that knows the address, and forget it.
 *
 * It reuses two things the site already has. The parser is the same one the
 * email checker uses (src/client/email.ts), so a message that arrives here is
 * read exactly as the checker reads a pasted one; and every stored message
 * carries the checker's own verdict on it, so a throwaway inbox does not just
 * show you the mail, it tells you whether the sender was forged and what in it
 * would have phoned home. Nothing untrusted is ever rendered as live HTML: the
 * body is reduced to plain text on the way in.
 *
 * The privacy story is stated plainly on the page and enforced here: addresses
 * are generated and unguessable, mail to anything that does not look generated
 * is dropped rather than stored, every row self-destructs, and the API returns
 * no-store so nothing lingers in a cache.
 */

import {
  authChecks,
  authVerdict,
  displayBody,
  findTrackers,
  parseMessage,
  senderCheck,
  trackerHosts,
  trackerVerdict,
  header,
} from '../client/email';
import {
  MAX_MESSAGES_PER_INBOX,
  MAX_MESSAGE_BYTES,
  INBOX_TTL_MS,
  expiryFrom,
  makeAddress,
  parseInboxAddress,
  preview,
  randomId,
  truncateBody,
} from '../lib/mailbox';
import type { Env } from './env';

/** The subset of the Email Workers message we use. */
interface IncomingEmail {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize?: number;
}

/** A JSON reply plus its status; index.ts wraps it with the site headers. */
export interface MailReply {
  status: number;
  body: unknown;
}

/**
 * What a receive did, for the log. Deliberately carries no address, sender or
 * body — only whether it was stored and coarse, non-identifying counts — so the
 * operator can watch delivery in `wrangler tail` without the log becoming the
 * one place a throwaway inbox's contents leak.
 */
export type MailReceipt =
  | { stored: true; size: number; trackers: number }
  | { stored: false; reason: 'unconfigured' | 'not_an_inbox' };

const now = () => Date.now();

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Decode RFC 2047 encoded-word runs in a header (=?utf-8?B?..?= / ?Q?..?=),
 *  so a subject in another language is readable rather than gibberish. */
function bytesOfLatin1(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

function decodeEncodedWords(value: string): string {
  return String(value ?? '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_whole, _charset: string, enc: string, text: string) => {
    try {
      if (enc.toLowerCase() === 'b') {
        return new TextDecoder('utf-8').decode(bytesOfLatin1(atob(text)));
      }
      // Q encoding: underscores are spaces, =XX are bytes.
      const q = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16)));
      return new TextDecoder('utf-8').decode(bytesOfLatin1(q));
    } catch {
      return text;
    }
  });
}

/** Reduce an HTML (or plain) body to readable text. Never rendered as HTML; the
 *  temp inbox shows text only, which is also the whole safety posture. */
function htmlToText(source: string): string {
  return String(source ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => { const n = Number(d); return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : _m; })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Receive one message. Anything sent to an address that does not look generated
 * (admin@, info@, a guessed one) is dropped, not stored.
 */
export async function handleIncomingEmail(message: IncomingEmail, env: Env): Promise<MailReceipt> {
  const domain = env.MAIL_DOMAIN;
  const db = env.MAIL_DB;
  if (!domain || !db) return { stored: false, reason: 'unconfigured' };

  const inbox = parseInboxAddress(message.to, domain);
  if (!inbox) return { stored: false, reason: 'not_an_inbox' };

  // Read the raw message, capped so a huge mail cannot be forced into storage.
  const buffer = await new Response(message.raw).arrayBuffer();
  const capped = new Uint8Array(buffer).subarray(0, MAX_MESSAGE_BYTES);
  const raw = new TextDecoder('utf-8').decode(capped);

  const parsed = parseMessage(raw);
  const body = displayBody(parsed);
  const bodyText = truncateBody(htmlToText(body));
  const subject = decodeEncodedWords(header(parsed, 'Subject') ?? '');
  const sender = senderCheck(parsed);
  const checks = authChecks(parsed);
  const trackers = findTrackers(body);

  const senderLabel = sender.displayName ? `${sender.displayName} <${sender.from ?? ''}>` : (sender.from ?? message.from);
  const analysis = JSON.stringify({
    verdict: authVerdict(checks, sender),
    trackerVerdict: trackerVerdict(trackers),
    trackerHosts: trackerHosts(trackers),
    trackers: trackers.slice(0, 25).map((t) => ({ kind: t.kind, host: t.host, why: t.why, destination: t.destination ?? null })),
    sender: { from: sender.from ?? null, displayName: sender.displayName ?? null, replyTo: sender.replyTo ?? null, concerns: sender.concerns },
    auth: checks.map((c) => ({ method: c.method, result: c.result, domain: c.domain ?? null })),
  });

  const at = now();
  const id = randomId(randomBytes(20));

  // Insert, then trim the inbox to its newest N so a flood cannot grow it
  // without bound. Both in one batch so a reader never sees a half state.
  await db.batch([
    db.prepare(
      'INSERT INTO messages (id, inbox, sender, subject, preview, body_text, analysis, size, received_at, expires_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)',
    ).bind(id, inbox, senderLabel, subject, preview(bodyText), bodyText, analysis, capped.byteLength, at, expiryFrom(at)),
    db.prepare(
      'DELETE FROM messages WHERE inbox = ?1 AND id NOT IN (SELECT id FROM messages WHERE inbox = ?1 ORDER BY received_at DESC LIMIT ?2)',
    ).bind(inbox, MAX_MESSAGES_PER_INBOX),
  ]);

  return { stored: true, size: capped.byteLength, trackers: trackers.length };
}

/** The scheduled sweep: drop everything past its expiry. Queries also filter on
 *  expiry, so a late sweep never leaks a message; this just reclaims space. */
export async function purgeExpired(env: Env): Promise<void> {
  if (!env.MAIL_DB) return;
  await env.MAIL_DB.prepare('DELETE FROM messages WHERE expires_at < ?1').bind(now()).run();
}

/**
 * The /api/mail/* routes. Returns plain data; index.ts adds the site headers
 * and a no-store cache directive.
 */
export async function mailApi(request: Request, env: Env, path: string): Promise<MailReply> {
  const domain = env.MAIL_DOMAIN;
  const db = env.MAIL_DB;
  if (!domain || !db) return { status: 503, body: { error: 'The temporary inbox is not configured on this deployment.' } };

  const url = new URL(request.url);
  const route = path.replace(/^\/api\/mail\/?/, '');

  // A fresh throwaway address. Generated here so the client and server agree on
  // the format; no row is written until mail actually arrives.
  if (route === 'new' && request.method === 'GET') {
    return { status: 200, body: { address: makeAddress(randomBytes(16), domain), domain, ttlMs: INBOX_TTL_MS } };
  }

  if (route === 'inbox' && request.method === 'GET') {
    const inbox = parseInboxAddress(url.searchParams.get('address') ?? '', domain);
    if (!inbox) return { status: 400, body: { error: 'Not a valid inbox address.' } };
    const rows = await db.prepare(
      'SELECT id, sender, subject, preview, analysis, received_at, expires_at FROM messages WHERE inbox = ?1 AND expires_at > ?2 ORDER BY received_at DESC',
    ).bind(inbox, now()).all();
    const messages = (rows.results as Record<string, unknown>[]).map((r) => {
      const a = safeParse(r.analysis as string);
      return {
        id: r.id,
        sender: r.sender,
        subject: r.subject,
        preview: r.preview,
        receivedAt: r.received_at,
        expiresAt: r.expires_at,
        verdict: a?.verdict ?? null,
        trackerCount: Array.isArray(a?.trackers) ? a.trackers.length : 0,
      };
    });
    return { status: 200, body: { address: inbox, ttlMs: INBOX_TTL_MS, messages } };
  }

  if (route === 'message' && request.method === 'GET') {
    const inbox = parseInboxAddress(url.searchParams.get('address') ?? '', domain);
    const id = url.searchParams.get('id') ?? '';
    if (!inbox || !/^[a-z2-7]{8,40}$/.test(id)) return { status: 400, body: { error: 'Not a valid message reference.' } };
    const row = await db.prepare(
      'SELECT id, sender, subject, body_text, analysis, received_at, expires_at FROM messages WHERE inbox = ?1 AND id = ?2 AND expires_at > ?3',
    ).bind(inbox, id, now()).first() as Record<string, unknown> | null;
    if (!row) return { status: 404, body: { error: 'That message is gone.' } };
    return {
      status: 200,
      body: {
        id: row.id,
        sender: row.sender,
        subject: row.subject,
        bodyText: row.body_text,
        analysis: safeParse(row.analysis as string),
        receivedAt: row.received_at,
        expiresAt: row.expires_at,
      },
    };
  }

  if (route === 'burn' && request.method === 'POST') {
    const inbox = parseInboxAddress(url.searchParams.get('address') ?? '', domain);
    if (!inbox) return { status: 400, body: { error: 'Not a valid inbox address.' } };
    await db.prepare('DELETE FROM messages WHERE inbox = ?1').bind(inbox).run();
    return { status: 200, body: { ok: true } };
  }

  return { status: 404, body: { error: 'No such mail endpoint.' } };
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

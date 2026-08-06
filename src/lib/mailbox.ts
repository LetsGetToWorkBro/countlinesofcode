/**
 * The throwaway-inbox primitives: making an address, deciding whether one is
 * well formed, and the small shaping helpers around a stored message. Pure and
 * DOM-free, so both the Worker and the tests use the same code.
 *
 * The security model is deliberately simple and stated on the page: an address
 * is a secret only by being unguessable. There are no accounts and no
 * passwords, so a fourteen-character random local part (seventy bits) is what
 * stands between a stranger and the mail, which is why addresses are generated,
 * never chosen, and why anything sent to a non-generated local part is dropped
 * rather than stored. Everything expires.
 */

/** How long a message lives before it is swept. Temporary means temporary. */
export const INBOX_TTL_MS = 60 * 60 * 1000; // one hour

/** Beyond this a received message is not stored whole; the body is truncated. */
export const MAX_MESSAGE_BYTES = 1_000_000;

/** A single inbox keeps at most this many messages; the oldest fall off. */
export const MAX_MESSAGES_PER_INBOX = 50;

/** Stored body and preview ceilings, so one enormous mail cannot bloat a row. */
export const MAX_BODY_CHARS = 100_000;
export const PREVIEW_CHARS = 140;

/** RFC 4648 base32, lower case: no 0/1/8/9 to confuse with letters when read
 *  aloud, and every character is URL and address safe. */
export const ADDRESS_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Local-part length. Fourteen base32 characters is seventy bits of address,
 *  which is not guessable, and it is copied rather than typed. */
export const LOCALPART_LEN = 14;

/** Message-id length, same alphabet. Only needs to be unique, not secret. */
export const ID_LEN = 20;

/**
 * Map random bytes onto the base32 alphabet, one character per byte. A byte is
 * uniform over 0..255 and 256 is a whole multiple of 32, so `byte & 31` is a
 * perfectly uniform base32 symbol with no modulo bias. `bytes` must be at least
 * `length` long.
 */
export function encodeBase32(bytes: Uint8Array, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ADDRESS_ALPHABET[bytes[i]! & 31];
  return out;
}

/** A fresh random local part from a byte source (crypto in the Worker). */
export function randomLocalPart(bytes: Uint8Array): string {
  return encodeBase32(bytes, LOCALPART_LEN);
}

/** A fresh random message id. */
export function randomId(bytes: Uint8Array): string {
  return encodeBase32(bytes, ID_LEN);
}

/** A full throwaway address for a domain. */
export function makeAddress(bytes: Uint8Array, domain: string): string {
  return `${randomLocalPart(bytes)}@${String(domain).toLowerCase()}`;
}

/** Whether a local part is one this service would have generated: exactly the
 *  base32 alphabet, within a sane length band. Anything else is not ours. */
export function localPartValid(localpart: string): boolean {
  return /^[a-z2-7]{12,40}$/.test(localpart);
}

/**
 * Validate and normalise a full address, or return null.
 *
 * The domain must be the configured mail domain and the local part must look
 * generated. This gates the API (only well-formed inboxes can be queried) and
 * the receiver (mail to `admin@`, `info@` and every other non-generated address
 * is dropped rather than stored, which keeps random spam out of the database).
 */
export function parseInboxAddress(address: string, domain: string): string | null {
  const value = String(address ?? '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return null;
  const localpart = value.slice(0, at);
  const dom = value.slice(at + 1);
  if (dom !== String(domain).toLowerCase()) return null;
  if (!localPartValid(localpart)) return null;
  return `${localpart}@${dom}`;
}

/** When a message received now should expire. */
export function expiryFrom(nowMs: number): number {
  return nowMs + INBOX_TTL_MS;
}

/** Collapse whitespace and cut to a short one-line preview. */
export function preview(text: string, max = PREVIEW_CHARS): string {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** Cap stored text so a giant mail cannot bloat a row. */
export function truncateBody(text: string, max = MAX_BODY_CHARS): string {
  const value = String(text ?? '');
  return value.length > max ? value.slice(0, max) + '\n\n[truncated]' : value;
}

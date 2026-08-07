/**
 * The onion mirror's half of the handshake.
 *
 * A Tor onion service for this site removes two parties from the path at
 * once: there is no exit node, and there is no Cloudflare. The site sees a
 * circuit rather than a person, and nobody in the middle sees anything but
 * onion-encrypted cells. That mirror runs on a box of its own (see
 * docs/onion.md); what lives here is the one thing the clearnet site has to
 * do to advertise it, which is the Onion-Location header.
 *
 * Tor Browser reads that header, checks the address, and offers ".onion
 * available" in the URL bar. The rules it enforces, and therefore the rules
 * below, are:
 *
 *   - the page carrying the header must be HTTPS (or itself an onion), so a
 *     header on plain http is ignored and worth not sending;
 *   - the value must be an absolute URL whose host is a valid onion;
 *   - it must not be sent by the onion about itself, which is a loop.
 *
 * On top of those, this refuses to advertise on /api/ paths. Nothing reads a
 * header on a JSON reply, and a swap or a wallet call is not where a browser
 * should be invited to switch transports mid-flight.
 */

/**
 * A v3 onion address: 56 characters of lowercase base32 and ".onion". The v2
 * form (16 characters) is dead, unsafe, and refused rather than tolerated.
 */
const ONION_HOST = /^[a-z2-7]{56}\.onion$/;

export function isOnionHost(host: string): boolean {
  return ONION_HOST.test(String(host ?? '').trim().toLowerCase().replace(/\.$/, ''));
}

/**
 * Normalise whatever the operator put in the ONION_HOST var: a bare host, a
 * URL, a trailing slash, some capitals. Returns the clean host or null, so a
 * typo turns the feature off rather than advertising a broken address.
 */
export function normaliseOnionHost(raw: string | undefined): string | null {
  let text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  return isOnionHost(text) ? text : null;
}

/**
 * The Onion-Location value for this request, or null if it should not be
 * advertised here. Onion services are plain http on the inside: the transport
 * is already authenticated and encrypted by the address itself, and https on
 * top of it buys a certificate warning rather than security.
 */
export function onionLocationFor(url: URL, configured: string | undefined): string | null {
  const host = normaliseOnionHost(configured);
  if (!host) return null;
  // Already there.
  if (isOnionHost(url.hostname)) return null;
  // Tor Browser ignores the header on a page that was not served over HTTPS,
  // so sending it there is noise. Localhost during development is the one
  // place we still answer, so the wiring can be tested without a certificate.
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null;
  if (url.pathname.startsWith('/api/')) return null;
  return `http://${host}${url.pathname}${url.search}`;
}

/** Add the header to a response, leaving one already set alone. */
export function withOnionLocation(response: Response, url: URL, configured: string | undefined): Response {
  const value = onionLocationFor(url, configured);
  if (!value || response.headers.has('onion-location')) return response;
  const copy = new Response(response.body, response);
  copy.headers.set('onion-location', value);
  return copy;
}

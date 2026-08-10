/**
 * Per-IP fixed-window rate limit backed by KV.
 *
 * KV is eventually consistent, so a determined client racing many colos can
 * exceed the window slightly. That is acceptable here: this is a courtesy limit
 * protecting our GitHub token, not a security control. Cloudflare's own rate
 * limiting rules sit in front for anything adversarial (see README).
 *
 * Authenticated users are exempt — they spend their own GitHub quota.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetSeconds: number;
}

const WINDOW_SECONDS = 60;

export async function checkRateLimit(
  kv: KVNamespace | undefined,
  ip: string,
  limit: number,
  scope = '',
): Promise<RateLimitResult> {
  if (!kv || limit <= 0) {
    return { allowed: true, remaining: limit, limit, resetSeconds: 0 };
  }
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / WINDOW_SECONDS);
  // A scope keeps buckets apart: a wallet syncing through the node proxy has
  // a much higher ceiling than counting, and burning one must not 429 the
  // other for the same visitor.
  const key = scope ? `rl:${scope}:${window}:${ip}` : `rl:${window}:${ip}`;
  const resetSeconds = (window + 1) * WINDOW_SECONDS - now;

  const current = Number((await kv.get(key, 'text')) ?? '0');
  const used = Number.isFinite(current) ? current : 0;

  if (used >= limit) {
    return { allowed: false, remaining: 0, limit, resetSeconds };
  }

  await kv.put(key, String(used + 1), { expirationTtl: WINDOW_SECONDS * 2 });
  return { allowed: true, remaining: Math.max(0, limit - used - 1), limit, resetSeconds };
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    '0.0.0.0'
  );
}

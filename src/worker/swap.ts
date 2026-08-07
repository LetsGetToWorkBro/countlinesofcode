/**
 * The swap page's server half: a narrow relay to two instant exchanges.
 *
 * The page cannot call Exolix or ChangeNOW itself (connect-src 'self', on
 * purpose), so it calls these three endpoints and the Worker forwards:
 *
 *   GET  /api/swap/quote?from=btc&to=xmr&amount=0.05   ask every provider
 *   POST /api/swap/create      { provider, from, to, amount, address, refund? }
 *   GET  /api/swap/status?provider=..&id=..            where an order stands
 *
 * Either direction: one side of the pair has to be Monero, and swapkit is
 * what enforces that along with checking the payout address belongs on the
 * chain it is being paid to.
 *
 * This is deliberately not the Monero-node proxy's "forward whatever": the
 * only URLs ever fetched are the handful swapkit builds against the two
 * providers' fixed origins, with the visitor's input reduced to validated
 * parameters. Nothing about an order is stored here; the order id lives in
 * the visitor's browser and nowhere else on this side.
 *
 * Exolix answers with no key. ChangeNOW joins when the CHANGENOW_API_KEY
 * secret is set (a free partner key from changenow.io); until then the quote
 * list simply has one entry.
 */

import {
  changeNowCreateBody,
  changeNowEstimateUrl,
  changeNowMinUrl,
  changeNowStatusUrl,
  exolixCreateBody,
  exolixRateUrl,
  exolixStatusUrl,
  isPlausibleOrderId,
  parseAmount,
  parseChangeNowCreate,
  parseChangeNowEstimate,
  parseChangeNowStatus,
  parseCreateRequest,
  parseExolixCreate,
  parseExolixRate,
  parseExolixStatus,
  parsePair,
  STAGE_LINES,
  type SwapQuote,
  type SwapStatus,
} from '../lib/swapkit';
import type { Env } from './env';

export interface SwapReply {
  status: number;
  body: unknown;
}

const bad = (status: number, message: string): SwapReply => ({ status, body: { error: message } });

/** One upstream call: JSON in, JSON out, 12 seconds, no redirects followed.
 *  Workers' fetch has no redirect:'error', so 'manual' plus treating any 3xx
 *  as unreadable does the same job: an exchange bouncing us somewhere else is
 *  an answer we refuse, never one we follow. */
async function upstream(
  url: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/json', ...init.headers },
    });
    if (response.status >= 300 && response.status < 400) {
      return { status: response.status, json: { error: `redirected (HTTP ${response.status})` } };
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text.slice(0, 200) || `HTTP ${response.status}` };
    }
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const cnHeaders = (key: string): Record<string, string> => ({ 'x-changenow-api-key': key });

export async function swapApi(request: Request, env: Env, path: string): Promise<SwapReply> {
  if (path === '/api/swap/quote' && request.method === 'GET') return quote(request, env);
  if (path === '/api/swap/create' && request.method === 'POST') return create(request, env);
  if (path === '/api/swap/status' && request.method === 'GET') return status(request, env);
  return bad(404, 'No such swap endpoint.');
}

/** Ask every provider that can answer; a provider failing is a missing quote,
 *  never a failed page. */
async function quote(request: Request, env: Env): Promise<SwapReply> {
  const url = new URL(request.url);
  const parsed = parsePair(url.searchParams.get('from'), url.searchParams.get('to'));
  if (!parsed.ok) return bad(400, parsed.problem);
  const pair = parsed.pair;
  const amount = parseAmount(url.searchParams.get('amount'));
  if (amount === null) return bad(400, 'That amount is not a number this can send.');

  const asks: Promise<SwapQuote>[] = [
    upstream(exolixRateUrl(pair, amount))
      .then((r) => parseExolixRate(r.json))
      .catch(() => ({ provider: 'exolix', ok: false, reason: 'Exolix did not answer.' }) as SwapQuote),
  ];

  const key = env.CHANGENOW_API_KEY;
  if (key) {
    asks.push(
      Promise.all([
        upstream(changeNowEstimateUrl(pair, amount), { headers: cnHeaders(key) }),
        upstream(changeNowMinUrl(pair), { headers: cnHeaders(key) }),
      ])
        .then(([est, min]) => parseChangeNowEstimate(est.json, min.json))
        .catch(() => ({ provider: 'changenow', ok: false, reason: 'ChangeNOW did not answer.' }) as SwapQuote),
    );
  }

  const quotes = await Promise.all(asks);
  return { status: 200, body: { from: pair.from.id, to: pair.to.id, amount, quotes } };
}

async function create(request: Request, env: Env): Promise<SwapReply> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad(400, 'Send JSON.');
  }
  const parsed = parseCreateRequest(body);
  if (!parsed.ok) return bad(400, parsed.problem);
  const req = parsed.req;

  if (req.provider === 'changenow') {
    const key = env.CHANGENOW_API_KEY;
    if (!key) return bad(503, 'ChangeNOW is not configured on this server.');
    const { url, body: cnBody } = changeNowCreateBody(req);
    const reply = await upstream(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cnHeaders(key) },
      body: JSON.stringify(cnBody),
    });
    const order = parseChangeNowCreate(reply.json);
    if (!order) return bad(502, upstreamProblem(reply.json, 'ChangeNOW'));
    return { status: 200, body: order };
  }

  const { url, body: exBody } = exolixCreateBody(req);
  const reply = await upstream(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(exBody),
  });
  const order = parseExolixCreate(reply.json);
  if (!order) return bad(502, upstreamProblem(reply.json, 'Exolix'));
  return { status: 200, body: order };
}

/** The provider's own words when it refuses, trimmed to something printable. */
function upstreamProblem(json: unknown, who: string): string {
  const j = (json ?? {}) as Record<string, unknown>;
  const raw = j['error'] ?? j['message'] ?? (j['errors'] ? JSON.stringify(j['errors']) : '');
  const text = String(raw).slice(0, 200).trim();
  return text ? `${who} refused: ${text}` : `${who} sent back something unreadable.`;
}

async function status(request: Request, env: Env): Promise<SwapReply> {
  const url = new URL(request.url);
  const provider = url.searchParams.get('provider') ?? '';
  const id = url.searchParams.get('id') ?? '';
  if (!isPlausibleOrderId(id)) return bad(400, 'That is not an order id.');

  if (provider === 'exolix') {
    const reply = await upstream(exolixStatusUrl(id));
    if (reply.status === 404) return bad(404, 'Exolix does not know that order.');
    return { status: 200, body: narrated(parseExolixStatus(reply.json)) };
  }
  if (provider === 'changenow') {
    const key = env.CHANGENOW_API_KEY;
    if (!key) return bad(503, 'ChangeNOW is not configured on this server.');
    const reply = await upstream(changeNowStatusUrl(id), { headers: cnHeaders(key) });
    if (reply.status === 404) return bad(404, 'ChangeNOW does not know that order.');
    return { status: 200, body: narrated(parseChangeNowStatus(reply.json)) };
  }
  return bad(400, 'Unknown provider.');
}

/** The status plus its one-line narration, so the page never invents words. */
function narrated(status: SwapStatus): SwapStatus & { line: string } {
  return { ...status, line: STAGE_LINES[status.stage] };
}

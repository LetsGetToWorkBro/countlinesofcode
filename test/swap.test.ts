/**
 * The swap relay, end to end through the Worker with the exchanges faked.
 *
 * What matters here is the shape of the trust boundary: the Worker must only
 * ever fetch the two providers' fixed origins, must refuse malformed input
 * before a byte leaves, must not offer ChangeNOW when no key is configured,
 * and must attach the key when there is one. A provider timing out or
 * answering garbage costs that provider's quote, never the page.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/worker/index';
import type { Env } from '../src/worker/env';
import { fakeCtx, fakeKv } from './fixtures/fake-github';

const XMR_ADDR =
  '83TQcTwusSQ4WKbPQE5osrF3cR4GWe2zmcNWeozK6BSqHSaeLvjUVe476ouVwLKn1uVwEFcbJQvnme7W6dTV5SB93x45DEy';

/** Every upstream call the fake network served, for asserting boundaries. */
let fetched: { url: string; init?: RequestInit }[] = [];
let responses: Record<string, () => Response> = {};
const realFetch = globalThis.fetch;

function fakeNetwork(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push({ url, init });
    for (const [prefix, make] of Object.entries(responses)) {
      if (url.startsWith(prefix)) return make();
    }
    throw new Error(`unexpected upstream fetch: ${url}`);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { LOC_KV: fakeKv(), CANONICAL_ORIGIN: 'https://loc.example', ...overrides };
}

async function call(path: string, init: RequestInit = {}, env: Env = makeEnv()) {
  const ctx = fakeCtx();
  const request = new Request(`https://loc.example${path}`, {
    headers: { 'cf-connecting-ip': '203.0.113.7', ...(init.headers ?? {}) },
    ...init,
  });
  const response = await worker.fetch(request, env, ctx);
  await ctx.settled();
  return response;
}

const post = (path: string, body: unknown, env?: Env) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);

beforeEach(() => {
  fetched = [];
  responses = {};
  fakeNetwork();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('GET /api/swap/quote', () => {
  it('quotes both keyless desks when no ChangeNOW key is configured', async () => {
    /* The point of a second keyless provider: with no secret set anywhere, the
     * board is still a comparison rather than one price with nothing to beat. */
    responses['https://exolix.com/api/v2/rate'] = () => json({ toAmount: 8.7, minAmount: 0.0008, maxAmount: 10 });
    responses['https://api.godex.io/api/v1/info'] = () => json({ amount: '8.65', min_amount: '0.0009' });
    const response = await call('/api/swap/quote?from=btc&to=xmr&amount=0.05');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { quotes: { provider: string; ok: boolean }[] };
    expect(body.quotes.map((q) => q.provider).sort()).toEqual(['exolix', 'godex']);
    expect(body.quotes.every((q) => q.ok)).toBe(true);
    // The boundary: only the two keyless origins were fetched.
    expect(fetched.every((f) => /^https:\/\/(exolix\.com|api\.godex\.io)\//.test(f.url))).toBe(true);
  });

  it('adds a ChangeNOW quote, with the key attached, when configured', async () => {
    responses['https://exolix.com/api/v2/rate'] = () => json({ toAmount: 8.7, minAmount: 0.0008 });
    responses['https://api.godex.io/api/v1/info'] = () => json({ amount: '8.65' });
    responses['https://api.changenow.io/v2/exchange/estimated-amount'] = () => json({ toAmount: 8.75 });
    responses['https://api.changenow.io/v2/exchange/min-amount'] = () => json({ minAmount: 0.00013 });
    const response = await call('/api/swap/quote?from=btc&to=xmr&amount=0.05', {}, makeEnv({ CHANGENOW_API_KEY: 'k-123' }));
    const body = (await response.json()) as { quotes: { provider: string; toAmount?: number }[] };
    expect(body.quotes.map((q) => q.provider).sort()).toEqual(['changenow', 'exolix', 'godex']);
    const cnCalls = fetched.filter((f) => f.url.includes('changenow.io'));
    expect(cnCalls.length).toBe(2);
    for (const f of cnCalls) {
      expect((f.init?.headers as Record<string, string>)['x-changenow-api-key']).toBe('k-123');
    }
  });

  it('turns one provider failing into a missing quote, not a failed page', async () => {
    responses['https://exolix.com/api/v2/rate'] = () => {
      throw new Error('connection reset');
    };
    responses['https://api.godex.io/api/v1/info'] = () => json({ amount: '8.65' });
    responses['https://api.changenow.io/v2/exchange/estimated-amount'] = () => json({ toAmount: 8.75 });
    responses['https://api.changenow.io/v2/exchange/min-amount'] = () => json({ minAmount: 0.00013 });
    const response = await call('/api/swap/quote?from=btc&to=xmr&amount=0.05', {}, makeEnv({ CHANGENOW_API_KEY: 'k' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { quotes: { provider: string; ok: boolean }[] };
    expect(body.quotes.find((q) => q.provider === 'exolix')!.ok).toBe(false);
    expect(body.quotes.find((q) => q.provider === 'godex')!.ok).toBe(true);
    expect(body.quotes.find((q) => q.provider === 'changenow')!.ok).toBe(true);
  });

  it('rejects a coin or amount it does not serve before anything is fetched', async () => {
    for (const path of ['/api/swap/quote?from=doge&to=xmr&amount=1', '/api/swap/quote?from=btc&to=xmr&amount=-5',
                        '/api/swap/quote?from=btc&to=usdttrc&amount=1']) {
      const response = await call(path);
      expect(response.status, path).toBe(400);
    }
    expect(fetched).toHaveLength(0);
  });

  it('never caches a quote', async () => {
    responses['https://exolix.com/api/v2/rate'] = () => json({ toAmount: 8.7 });
    const response = await call('/api/swap/quote?from=btc&to=xmr&amount=0.05');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /api/swap/create', () => {
  const good = { provider: 'exolix', from: 'btc', to: 'xmr', amount: 0.05, address: XMR_ADDR };

  it('creates an Exolix order and hands back the normalised deposit slip', async () => {
    responses['https://exolix.com/api/v2/transactions'] = () =>
      json({ id: 'Kj9mX2pQ', amount: 0.05, amountTo: 8.69, depositAddress: 'bc1qdeposit', withdrawalAddress: XMR_ADDR });
    const response = await post('/api/swap/create', good);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      provider: 'exolix',
      id: 'Kj9mX2pQ',
      payinAddress: 'bc1qdeposit',
      payinAmount: 0.05,
      payoutAddress: XMR_ADDR,
    });
  });

  it('refuses to create on ChangeNOW when the server has no key', async () => {
    const response = await post('/api/swap/create', { ...good, provider: 'changenow' });
    expect(response.status).toBe(503);
    expect(fetched).toHaveLength(0);
  });

  it('creates on ChangeNOW with the key when configured', async () => {
    responses['https://api.changenow.io/v2/exchange'] = () =>
      json({ id: 'a1b2c3d4', fromAmount: 0.05, toAmount: 8.75, payinAddress: 'bc1qcn', payoutAddress: XMR_ADDR });
    const response = await post('/api/swap/create', { ...good, provider: 'changenow' }, makeEnv({ CHANGENOW_API_KEY: 'k' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: 'changenow', payinAddress: 'bc1qcn' });
    expect((fetched[0]!.init?.headers as Record<string, string>)['x-changenow-api-key']).toBe('k');
  });

  it('creates on Godex, which needs no key at all', async () => {
    responses['https://api.godex.io/api/v1/transaction'] = () =>
      json({
        transaction_id: 'c6a79d666b28a7',
        deposit: 'bc1qgx',
        deposit_amount: '0.05',
        withdrawal_amount: '8.02',
        withdrawal: XMR_ADDR,
      });
    const response = await post('/api/swap/create', { ...good, provider: 'godex' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      provider: 'godex', id: 'c6a79d666b28a7', payinAddress: 'bc1qgx', payinAmount: 0.05,
    });
    // No key header anywhere: the point of this desk.
    expect(JSON.stringify(fetched[0]!.init?.headers ?? {})).not.toMatch(/api-key/i);
  });

  it('relays the provider refusing, in words, as a 502', async () => {
    responses['https://exolix.com/api/v2/transactions'] = () => json({ error: 'Invalid withdrawal address' }, 422);
    const response = await post('/api/swap/create', good);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid withdrawal address');
  });

  it('rejects a bad Monero address before a byte leaves', async () => {
    const response = await post('/api/swap/create', { ...good, address: 'bc1qnotmonero' });
    expect(response.status).toBe(400);
    expect(fetched).toHaveLength(0);
  });
});

describe('GET /api/swap/status', () => {
  it('normalises an Exolix status', async () => {
    responses['https://exolix.com/api/v2/transactions/Kj9mX2pQ'] = () =>
      json({ status: 'sending', hashOut: { hash: 'deadbeef' } });
    const response = await call('/api/swap/status?provider=exolix&id=Kj9mX2pQ');
    expect(await response.json()).toEqual({
      stage: 'sending',
      raw: 'sending',
      txId: 'deadbeef',
      line: expect.stringMatching(/on their way/i),
    });
  });

  it('normalises a ChangeNOW status when the key is configured', async () => {
    responses['https://api.changenow.io/v2/exchange/by-id'] = () => json({ status: 'finished', payoutHash: 'cafe' });
    const response = await call('/api/swap/status?provider=changenow&id=a1b2c3d4', {}, makeEnv({ CHANGENOW_API_KEY: 'k' }));
    expect(await response.json()).toEqual({
      stage: 'done',
      raw: 'finished',
      txId: 'cafe',
      line: expect.stringMatching(/done/i),
    });
  });

  it('normalises a Godex status', async () => {
    responses['https://api.godex.io/api/v1/transaction/c6a79d666b28a7'] = () =>
      json({ status: 'success', hash_out: 'f00d' });
    const response = await call('/api/swap/status?provider=godex&id=c6a79d666b28a7');
    expect(await response.json()).toEqual({
      stage: 'done',
      raw: 'success',
      txId: 'f00d',
      line: expect.stringMatching(/done/i),
    });
  });

  it('reads Godex’s empty answer as an unknown order, not a failed swap', async () => {
    /* Godex answers 200 with {} for an id it has never seen. Narrated blind
     * that is stage "failed", which would tell somebody with a perfectly good
     * order that their swap had broken. */
    responses['https://api.godex.io/api/v1/transaction/nosuchorder'] = () => json({});
    const response = await call('/api/swap/status?provider=godex&id=nosuchorder');
    expect(response.status).toBe(404);
  });

  it('refuses an order id that could steer the path', async () => {
    const response = await call('/api/swap/status?provider=exolix&id=../secrets');
    expect(response.status).toBe(400);
    expect(fetched).toHaveLength(0);
  });

  it('says when the provider does not know the order', async () => {
    responses['https://exolix.com/api/v2/transactions/unknown1'] = () => json({ error: 'not found' }, 404);
    const response = await call('/api/swap/status?provider=exolix&id=unknown1');
    expect(response.status).toBe(404);
  });
});

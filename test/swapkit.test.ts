/**
 * The swap logic.
 *
 * The fixtures are shaped like real replies captured from both providers, so
 * a parser drifting from what the exchanges actually send fails here first.
 * The tests worth the most are the ugly ones: a quote that is under the
 * minimum, a create reply missing its deposit address, a status word nobody
 * mapped. A swap page must fail closed on all of those, because the visitor
 * is about to send money to whatever address this code hands back.
 */

import { describe, expect, it } from 'vitest';
import {
  COINS,
  COUNTER_COINS,
  PROVIDERS,
  STAGE_LINES,
  changeNowCreateBody,
  changeNowEstimateUrl,
  changeNowMinUrl,
  exolixCreateBody,
  exolixRateUrl,
  exolixStatusUrl,
  godexCreateBody,
  godexRateBody,
  godexStatusUrl,
  parseGodexCreate,
  parseGodexRate,
  parseGodexStatus,
  addressHint,
  addressLooksRight,
  coin,
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
  type CreateRequest,
} from '../src/lib/swapkit';

const XMR_ADDR =
  '83TQcTwusSQ4WKbPQE5osrF3cR4GWe2zmcNWeozK6BSqHSaeLvjUVe476ouVwLKn1uVwEFcbJQvnme7W6dTV5SB93x45DEy';

const btc = coin('btc')!;
const usdc = coin('usdc')!;
const xmr = coin('xmr')!;
const usdtTrc = coin('usdttrc')!;

const BTC_ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const EVM_ADDR = '0x52908400098527886E0F7030069857D2E4169EE7';
const SOL_ADDR = '4Nd1mYQx8kbXVWjR8oVGwGJp1FkVbqYYriDbBxkD6ZcV';
const TRON_ADDR = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const request = (over: Partial<CreateRequest> = {}): CreateRequest => ({
  provider: 'exolix',
  from: btc,
  to: xmr,
  amount: 0.05,
  address: XMR_ADDR,
  refund: '',
  ...over,
});

describe('the coins on offer', () => {
  it('trades Monero against BTC, USDT, ETH and USDC', () => {
    expect(COINS.map((c) => c.id)).toEqual(['xmr', 'btc', 'usdttrc', 'usdteth', 'eth', 'usdc', 'usdcsol']);
    expect(COUNTER_COINS.some((c) => c.id === 'xmr')).toBe(false);
    expect(coin('doge')).toBeNull();
  });

  it('keeps a coin\u2019s networks apart while naming the same currency', () => {
    // A provider knows one USDT; the network is the whole difference, and
    // sending TRC-20 to an ERC-20 deposit address loses the money.
    expect(coin('usdttrc')!.ticker).toBe('usdt');
    expect(coin('usdteth')!.ticker).toBe('usdt');
    expect(coin('usdttrc')!.network).toBe('TRX');
    expect(coin('usdteth')!.network).toBe('ETH');
    expect(coin('usdttrc')!.family).toBe('tron');
    expect(coin('usdteth')!.family).toBe('evm');
  });

  it('knows which provider needs a key', () => {
    expect(PROVIDERS.find((p) => p.id === 'exolix')!.needsKey).toBe(false);
    expect(PROVIDERS.find((p) => p.id === 'changenow')!.needsKey).toBe(true);
  });
});

describe('the pair', () => {
  it('accepts Monero on either side', () => {
    expect(parsePair('btc', 'xmr')).toMatchObject({ ok: true });
    expect(parsePair('xmr', 'usdttrc')).toMatchObject({ ok: true });
  });

  it('refuses a trade with no Monero in it, which is not what this page is', () => {
    expect(parsePair('btc', 'usdttrc')).toMatchObject({ ok: false, problem: /Monero on one side/ as unknown as string });
  });

  it('refuses a coin traded for itself, and an unknown coin', () => {
    expect(parsePair('xmr', 'xmr').ok).toBe(false);
    expect(parsePair('btc', 'doge').ok).toBe(false);
    expect(parsePair('', '').ok).toBe(false);
  });
});

describe('addresses, per chain', () => {
  it('knows the shape of every chain it can pay', () => {
    expect(addressLooksRight('xmr', XMR_ADDR)).toBe(true);
    expect(addressLooksRight('xmr', ` ${XMR_ADDR} `)).toBe(true);
    expect(addressLooksRight('btc', BTC_ADDR)).toBe(true);
    expect(addressLooksRight('btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
    expect(addressLooksRight('evm', EVM_ADDR)).toBe(true);
    expect(addressLooksRight('sol', SOL_ADDR)).toBe(true);
    expect(addressLooksRight('tron', TRON_ADDR)).toBe(true);
  });

  it('rejects the right address on the wrong chain, which is the mistake that costs money', () => {
    expect(addressLooksRight('xmr', BTC_ADDR)).toBe(false);
    expect(addressLooksRight('btc', XMR_ADDR)).toBe(false);
    expect(addressLooksRight('evm', TRON_ADDR)).toBe(false);
    expect(addressLooksRight('tron', EVM_ADDR)).toBe(false);
    expect(addressLooksRight('sol', EVM_ADDR)).toBe(false);
    // A Tron address is base58 of a length Solana would take, so the T prefix
    // is doing real work here.
    expect(addressLooksRight('tron', SOL_ADDR)).toBe(false);
  });

  it('rejects malformed Monero addresses specifically', () => {
    expect(addressLooksRight('xmr', '')).toBe(false);
    expect(addressLooksRight('xmr', XMR_ADDR.slice(0, 90))).toBe(false);
    expect(addressLooksRight('xmr', '9' + XMR_ADDR.slice(1))).toBe(false); // stagenet
    expect(addressLooksRight('xmr', XMR_ADDR.replace('8', 'l'))).toBe(false); // not base58
  });

  it('describes what it wanted, per chain, for the error message', () => {
    expect(addressHint(xmr)).toMatch(/Monero/);
    expect(addressHint(btc)).toMatch(/bc1/);
    expect(addressHint(usdtTrc)).toMatch(/Tron/);
    expect(addressHint(usdc)).toMatch(/0x/);
  });
});

describe('what the visitor typed', () => {

  it('keeps amount nonsense off the wire', () => {
    expect(parseAmount('0.05')).toBe(0.05);
    expect(parseAmount(500)).toBe(500);
    for (const bad of ['', 'ten', '-1', '0', 'NaN', 'Infinity', '1e10']) {
      expect(parseAmount(bad), bad).toBeNull();
    }
  });

  it('validates a whole create request and says what is wrong in words', () => {
    const good = parseCreateRequest({ provider: 'exolix', from: 'btc', to: 'xmr', amount: '0.05', address: XMR_ADDR });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.req.from.id).toBe('btc');
      expect(good.req.to.id).toBe('xmr');
    }

    expect(parseCreateRequest({ provider: 'kraken', from: 'btc', to: 'xmr', amount: 1, address: XMR_ADDR })).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/provider/i),
    });
    expect(parseCreateRequest({ provider: 'exolix', from: 'btc', to: 'xmr', amount: 1, address: 'nope' })).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/Monero address/),
    });
    expect(
      parseCreateRequest({ provider: 'exolix', from: 'usdc', to: 'xmr', amount: 500, address: XMR_ADDR, refund: 'not-hex' }),
    ).toMatchObject({ ok: false, problem: expect.stringMatching(/refund/i) });
  });

  it('checks the payout address against the coin going out, not against Monero', () => {
    // Leaving Monero: the address has to be a Bitcoin one, and a perfectly
    // good XMR address is now the wrong answer.
    const out = parseCreateRequest({ provider: 'exolix', from: 'xmr', to: 'btc', amount: 2, address: BTC_ADDR });
    expect(out.ok).toBe(true);
    expect(parseCreateRequest({ provider: 'exolix', from: 'xmr', to: 'btc', amount: 2, address: XMR_ADDR })).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/Bitcoin address/),
    });
    // And out to Tron, the refund has to be a Monero address.
    expect(parseCreateRequest({
      provider: 'exolix', from: 'xmr', to: 'usdttrc', amount: 2, address: TRON_ADDR, refund: BTC_ADDR,
    })).toMatchObject({ ok: false, problem: expect.stringMatching(/refund/i) });
  });

  it('refuses a pair with no Monero in it before anything is built', () => {
    expect(parseCreateRequest({ provider: 'exolix', from: 'btc', to: 'usdttrc', amount: 1, address: TRON_ADDR }))
      .toMatchObject({ ok: false, problem: expect.stringMatching(/Monero on one side/) });
  });

  it('accepts the order-id shapes providers use and nothing weirder', () => {
    expect(isPlausibleOrderId('abc123XYZ')).toBe(true);
    expect(isPlausibleOrderId('e9f8a7b6-1234-4cde-9f00-aabbccddeeff')).toBe(true);
    expect(isPlausibleOrderId('../secrets')).toBe(false);
    expect(isPlausibleOrderId('a b')).toBe(false);
    expect(isPlausibleOrderId('ab')).toBe(false);
  });
});

describe('Exolix', () => {
  it('asks for a float-rate XMR quote on the right pair', () => {
    const url = new URL(exolixRateUrl({ from: usdc, to: xmr }, 500));
    expect(url.origin + url.pathname).toBe('https://exolix.com/api/v2/rate');
    expect(url.searchParams.get('coinFrom')).toBe('USDC');
    expect(url.searchParams.get('networkFrom')).toBe('ETH');
    expect(url.searchParams.get('coinTo')).toBe('XMR');
    expect(url.searchParams.get('rateType')).toBe('float');
  });

  it('asks for Solana USDC as the same currency on its own network', () => {
    const url = new URL(exolixRateUrl({ from: coin('usdcsol')!, to: xmr }, 500));
    expect(url.searchParams.get('coinFrom')).toBe('USDC');
    expect(url.searchParams.get('networkFrom')).toBe('SOL');
  });

  it('asks the other way round when the swap leaves Monero', () => {
    const url = new URL(exolixRateUrl({ from: xmr, to: usdtTrc }, 2));
    expect(url.searchParams.get('coinFrom')).toBe('XMR');
    expect(url.searchParams.get('networkFrom')).toBe('XMR');
    expect(url.searchParams.get('coinTo')).toBe('USDT');
    expect(url.searchParams.get('networkTo')).toBe('TRX');
  });

  it('reads a live rate reply', () => {
    // Captured from the real endpoint, 2026-08-06.
    const quote = parseExolixRate({
      fromAmount: 0.05,
      toAmount: 8.7042942,
      rate: 174.08588141,
      message: null,
      minAmount: 0.00076265,
      withdrawMin: 0.0007088,
      maxAmount: 10,
    });
    expect(quote).toMatchObject({ provider: 'exolix', ok: true, toAmount: 8.7042942, minAmount: 0.00076265 });
  });

  it('turns an under-minimum reply into a reason, not a quote of zero', () => {
    const quote = parseExolixRate({ toAmount: 0, minAmount: 0.001, message: 'Amount to exchange is below the minimum' });
    expect(quote.ok).toBe(false);
    expect(quote.minAmount).toBe(0.001);
    expect(quote.reason).toMatch(/minimum/i);
  });

  it('builds a create body with the visitor exactly as typed', () => {
    const { url, body } = exolixCreateBody(request({ refund: BTC_ADDR }));
    expect(url).toBe('https://exolix.com/api/v2/transactions');
    expect(body).toMatchObject({
      coinFrom: 'BTC',
      networkFrom: 'BTC',
      coinTo: 'XMR',
      withdrawalAddress: XMR_ADDR,
      refundAddress: BTC_ADDR,
      rateType: 'float',
    });
  });

  it('builds the reverse create body when the swap leaves Monero', () => {
    const { body } = exolixCreateBody(request({ from: xmr, to: usdtTrc, amount: 2, address: TRON_ADDR }));
    expect(body).toMatchObject({
      coinFrom: 'XMR',
      networkFrom: 'XMR',
      coinTo: 'USDT',
      networkTo: 'TRX',
      withdrawalAddress: TRON_ADDR,
    });
  });

  it('leaves the refund field off entirely when there is none', () => {
    expect('refundAddress' in exolixCreateBody(request()).body).toBe(false);
  });

  it('reads a created order', () => {
    const order = parseExolixCreate({
      id: 'Kj9mX2pQ',
      amount: 0.05,
      amountTo: 8.69,
      depositAddress: 'bc1qdeposit',
      withdrawalAddress: XMR_ADDR,
      status: 'wait',
    });
    expect(order).toMatchObject({
      provider: 'exolix',
      id: 'Kj9mX2pQ',
      payinAddress: 'bc1qdeposit',
      payinAmount: 0.05,
      toAmount: 8.69,
      payoutAddress: XMR_ADDR,
      payinExtra: null,
    });
  });

  it('refuses a created order with no deposit address, whatever else it says', () => {
    // Handing the page an order without a payin address would render a swap
    // that can never complete; better to fail loudly at creation.
    expect(parseExolixCreate({ id: 'x1y2z3', amount: 0.05 })).toBeNull();
    expect(parseExolixCreate({ error: 'Invalid withdrawal address' })).toBeNull();
    expect(parseExolixCreate(null)).toBeNull();
  });

  it('maps every status word it documents, and fails closed on new ones', () => {
    expect(parseExolixStatus({ status: 'wait' }).stage).toBe('waiting');
    expect(parseExolixStatus({ status: 'confirmation' }).stage).toBe('confirming');
    expect(parseExolixStatus({ status: 'exchanging' }).stage).toBe('exchanging');
    expect(parseExolixStatus({ status: 'sending' }).stage).toBe('sending');
    expect(parseExolixStatus({ status: 'success' }).stage).toBe('done');
    expect(parseExolixStatus({ status: 'overdue' }).stage).toBe('expired');
    expect(parseExolixStatus({ status: 'refunded' }).stage).toBe('refunded');
    expect(parseExolixStatus({ status: 'brand-new-word' }).stage).toBe('failed');
    expect(parseExolixStatus({ status: 'brand-new-word' }).raw).toBe('brand-new-word');
  });

  it('surfaces the outgoing transaction hash once there is one', () => {
    const s = parseExolixStatus({ status: 'success', hashOut: { hash: 'deadbeef', link: 'https://x' } });
    expect(s.txId).toBe('deadbeef');
  });

  it('URL-encodes the order id into the status path', () => {
    expect(exolixStatusUrl('abc123')).toBe('https://exolix.com/api/v2/transactions/abc123');
    expect(exolixStatusUrl('a/b')).toContain('a%2Fb');
  });
});

describe('ChangeNOW', () => {
  it('asks for standard-flow estimates on the right pair', () => {
    const est = new URL(changeNowEstimateUrl({ from: btc, to: xmr }, 0.05));
    expect(est.searchParams.get('fromCurrency')).toBe('btc');
    expect(est.searchParams.get('toCurrency')).toBe('xmr');
    expect(est.searchParams.get('fromAmount')).toBe('0.05');
    const min = new URL(changeNowMinUrl({ from: usdc, to: xmr }));
    expect(min.searchParams.get('fromNetwork')).toBe('eth');
    const sol = new URL(changeNowMinUrl({ from: coin('usdcsol')!, to: xmr }));
    expect(sol.searchParams.get('fromCurrency')).toBe('usdc');
    expect(sol.searchParams.get('fromNetwork')).toBe('sol');
  });

  it('names both networks when the swap leaves Monero', () => {
    const est = new URL(changeNowEstimateUrl({ from: xmr, to: usdtTrc }, 2));
    expect(est.searchParams.get('fromCurrency')).toBe('xmr');
    expect(est.searchParams.get('fromNetwork')).toBe('xmr');
    expect(est.searchParams.get('toCurrency')).toBe('usdt');
    expect(est.searchParams.get('toNetwork')).toBe('trx');
  });

  it('reads an estimate plus the separate minimum', () => {
    const quote = parseChangeNowEstimate(
      { fromAmount: 0.05, toAmount: 8.71, flow: 'standard' },
      { minAmount: 0.0001292 },
    );
    expect(quote).toMatchObject({ provider: 'changenow', ok: true, toAmount: 8.71, minAmount: 0.0001292 });
  });

  it('reports their refusal in words rather than a zero', () => {
    const quote = parseChangeNowEstimate({ message: 'deposit_too_small', error: 'deposit_too_small' }, { minAmount: 0.001 });
    expect(quote.ok).toBe(false);
    expect(quote.minAmount).toBe(0.001);
  });

  it('builds a create body for their v2 exchange call', () => {
    const { url, body } = changeNowCreateBody(request({ provider: 'changenow', from: usdc, amount: 500 }));
    expect(url).toBe('https://api.changenow.io/v2/exchange');
    expect(body).toMatchObject({
      fromCurrency: 'usdc',
      fromNetwork: 'eth',
      toCurrency: 'xmr',
      address: XMR_ADDR,
      flow: 'standard',
    });
  });

  it('reads a created exchange and refuses one with no payin address', () => {
    const order = parseChangeNowCreate({
      id: 'a1b2c3d4e5',
      fromAmount: 0.05,
      toAmount: 8.7,
      payinAddress: 'bc1qpayin',
      payoutAddress: XMR_ADDR,
    });
    expect(order).toMatchObject({ provider: 'changenow', id: 'a1b2c3d4e5', payinAddress: 'bc1qpayin' });
    expect(parseChangeNowCreate({ id: 'x', fromAmount: 1 })).toBeNull();
  });

  it('maps their status words, and fails closed on new ones', () => {
    for (const [raw, stage] of [
      ['new', 'waiting'],
      ['waiting', 'waiting'],
      ['confirming', 'confirming'],
      ['verifying', 'confirming'],
      ['exchanging', 'exchanging'],
      ['sending', 'sending'],
      ['finished', 'done'],
      ['failed', 'failed'],
      ['refunded', 'refunded'],
      ['expired', 'expired'],
      ['who-knows', 'failed'],
    ] as const) {
      expect(parseChangeNowStatus({ status: raw }).stage, raw).toBe(stage);
    }
  });
});

describe('Godex', () => {
  it('asks for a quote with both networks named', () => {
    // The networks are the whole safety question on a multi-network coin, and
    // Godex takes its query as a POST body rather than a query string.
    const { url, body } = godexRateBody({ from: usdtTrc, to: xmr }, 200);
    expect(url).toBe('https://api.godex.io/api/v1/info');
    expect(body).toEqual({
      from: 'USDT', to: 'XMR', amount: '200', network_from: 'TRX', network_to: 'XMR',
    });
  });

  it('reads a quote, with the minimum and maximum it came with', () => {
    const quote = parseGodexRate({ amount: '8.0261', min_amount: '0.0007', max_amount: '10' });
    expect(quote).toEqual({ provider: 'godex', ok: true, toAmount: 8.0261, minAmount: 0.0007, maxAmount: 10 });
  });

  it('treats a zero amount as a refusal, because that is how Godex says no', () => {
    /* Under the minimum it answers 200 with amount "0" and the minimum filled
     * in, rather than an error. Read as a quote that would be a swap paying
     * out nothing. */
    const quote = parseGodexRate({ amount: '0', min_amount: '160' });
    expect(quote.ok).toBe(false);
    expect(quote.minAmount).toBe(160);
    expect(quote.reason).toMatch(/no quote/i);
    expect(parseGodexRate({ error: 'Pair is disabled' }).reason).toBe('Pair is disabled');
  });

  it('sends both extra-id fields, which Godex rejects the order without', () => {
    const { url, body } = godexCreateBody(request({ provider: 'godex', refund: BTC_ADDR }));
    expect(url).toBe('https://api.godex.io/api/v1/transaction');
    expect(body['coin_from']).toBe('BTC');
    expect(body['coin_to']).toBe('XMR');
    expect(body['coin_from_network']).toBe('BTC');
    expect(body['coin_to_network']).toBe('XMR');
    expect(body['withdrawal']).toBe(XMR_ADDR);
    expect(body['return']).toBe(BTC_ADDR);
    // Present-but-empty is the requirement; absent is a validation error.
    expect(body).toHaveProperty('withdrawal_extra_id', '');
    expect(body).toHaveProperty('return_extra_id', '');
  });

  it('reads a created order into the common shape', () => {
    const order = parseGodexCreate({
      transaction_id: 'c6a79d666b28a7',
      status: 'wait',
      deposit: 'bc1qmpxvnu9ewncd274az5arzvdgrzwq0yzselsswn',
      deposit_amount: '0.05',
      withdrawal: XMR_ADDR,
      withdrawal_amount: '8.02612525',
      deposit_extra_id: null,
    });
    expect(order).toEqual({
      provider: 'godex',
      id: 'c6a79d666b28a7',
      payinAddress: 'bc1qmpxvnu9ewncd274az5arzvdgrzwq0yzselsswn',
      payinExtra: null,
      payinAmount: 0.05,
      toAmount: 8.02612525,
      payoutAddress: XMR_ADDR,
    });
    // No deposit address is no order, however cheerful the rest of it looks.
    expect(parseGodexCreate({ transaction_id: 'x', deposit_amount: '1' })).toBeNull();
  });

  it('builds a status url and maps every stage it reports', () => {
    expect(godexStatusUrl('c6a79d')).toBe('https://api.godex.io/api/v1/transaction/c6a79d');
    for (const [raw, stage] of [
      ['wait', 'waiting'],
      ['confirmation', 'confirming'],
      ['exchanging', 'exchanging'],
      ['sending', 'sending'],
      ['success', 'done'],
      ['overdue', 'expired'],
      ['refunded', 'refunded'],
      ['error', 'failed'],
      ['who-knows', 'failed'],
    ] as const) {
      expect(parseGodexStatus({ status: raw }).stage, raw).toBe(stage);
    }
    expect(parseGodexStatus({ status: 'success', hash_out: 'abc' }).txId).toBe('abc');
  });
});

describe('the words on the page', () => {
  it('narrates every stage', () => {
    for (const line of Object.values(STAGE_LINES)) expect(line.length).toBeGreaterThan(10);
  });

  it('tells the expired case not to send to the dead address', () => {
    // The one stage where the wrong next move loses money outright.
    expect(STAGE_LINES.expired).toMatch(/do not send/i);
  });
});

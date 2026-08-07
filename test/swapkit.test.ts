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
  FROM_COINS,
  PROVIDERS,
  STAGE_LINES,
  changeNowCreateBody,
  changeNowEstimateUrl,
  changeNowMinUrl,
  exolixCreateBody,
  exolixRateUrl,
  exolixStatusUrl,
  fromCoin,
  isPlausibleOrderId,
  looksLikeXmrAddress,
  parseAmount,
  parseChangeNowCreate,
  parseChangeNowEstimate,
  parseChangeNowStatus,
  parseCreateRequest,
  parseExolixCreate,
  parseExolixRate,
  parseExolixStatus,
  plausibleRefund,
  type CreateRequest,
} from '../src/lib/swapkit';

const XMR_ADDR =
  '83TQcTwusSQ4WKbPQE5osrF3cR4GWe2zmcNWeozK6BSqHSaeLvjUVe476ouVwLKn1uVwEFcbJQvnme7W6dTV5SB93x45DEy';

const btc = fromCoin('btc')!;
const usdc = fromCoin('usdc')!;

const request = (over: Partial<CreateRequest> = {}): CreateRequest => ({
  provider: 'exolix',
  coin: btc,
  amount: 0.05,
  address: XMR_ADDR,
  refund: '',
  ...over,
});

describe('the coins on offer', () => {
  it('swaps exactly BTC and USDC (ERC-20 or Solana) into Monero', () => {
    expect(FROM_COINS.map((c) => c.id)).toEqual(['btc', 'usdc', 'usdcsol']);
    // Both USDC entries are the same currency to a provider; the network is
    // the whole difference.
    expect(fromCoin('usdcsol')!.ticker).toBe('usdc');
    expect(fromCoin('usdcsol')!.network).toBe('SOL');
    expect(fromCoin('doge')).toBeNull();
  });

  it('knows which provider needs a key', () => {
    expect(PROVIDERS.find((p) => p.id === 'exolix')!.needsKey).toBe(false);
    expect(PROVIDERS.find((p) => p.id === 'changenow')!.needsKey).toBe(true);
  });
});

describe('what the visitor typed', () => {
  it('accepts a real mainnet Monero address', () => {
    expect(looksLikeXmrAddress(XMR_ADDR)).toBe(true);
    expect(looksLikeXmrAddress(` ${XMR_ADDR} `)).toBe(true);
  });

  it('rejects everything that is not one', () => {
    // The wrong way to be wrong here is accepting: this address is where the
    // exchange will send the Monero.
    expect(looksLikeXmrAddress('')).toBe(false);
    expect(looksLikeXmrAddress(XMR_ADDR.slice(0, 90))).toBe(false);
    expect(looksLikeXmrAddress('9' + XMR_ADDR.slice(1))).toBe(false); // stagenet prefix
    expect(looksLikeXmrAddress(XMR_ADDR.replace('8', 'l'))).toBe(false); // not base58
    expect(looksLikeXmrAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(false);
  });

  it('takes a bech32 or legacy BTC refund address, or none at all', () => {
    expect(plausibleRefund('btc', '')).toBe(true);
    expect(plausibleRefund('btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true);
    expect(plausibleRefund('btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
    expect(plausibleRefund('btc', '0x52908400098527886E0F7030069857D2E4169EE7')).toBe(false);
  });

  it('takes an 0x address for an ERC-20 USDC refund and nothing else', () => {
    expect(plausibleRefund('usdc', '0x52908400098527886E0F7030069857D2E4169EE7')).toBe(true);
    expect(plausibleRefund('usdc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(false);
  });

  it('takes a base58 address for a Solana USDC refund and nothing else', () => {
    expect(plausibleRefund('usdcsol', '4Nd1mYQx8kbXVWjR8oVGwGJp1FkVbqYYriDbBxkD6ZcV')).toBe(true);
    expect(plausibleRefund('usdcsol', '0x52908400098527886E0F7030069857D2E4169EE7')).toBe(false);
    expect(plausibleRefund('usdcsol', 'tooshort')).toBe(false);
  });

  it('keeps amount nonsense off the wire', () => {
    expect(parseAmount('0.05')).toBe(0.05);
    expect(parseAmount(500)).toBe(500);
    for (const bad of ['', 'ten', '-1', '0', 'NaN', 'Infinity', '1e10']) {
      expect(parseAmount(bad), bad).toBeNull();
    }
  });

  it('validates a whole create request and says what is wrong in words', () => {
    const good = parseCreateRequest({ provider: 'exolix', from: 'btc', amount: '0.05', address: XMR_ADDR });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.req.coin.id).toBe('btc');

    expect(parseCreateRequest({ provider: 'kraken', from: 'btc', amount: 1, address: XMR_ADDR })).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/provider/i),
    });
    expect(parseCreateRequest({ provider: 'exolix', from: 'btc', amount: 1, address: 'nope' })).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/Monero address/),
    });
    expect(
      parseCreateRequest({ provider: 'exolix', from: 'usdc', amount: 500, address: XMR_ADDR, refund: 'not-hex' }),
    ).toMatchObject({ ok: false, problem: expect.stringMatching(/refund/i) });
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
    const url = new URL(exolixRateUrl(usdc, 500));
    expect(url.origin + url.pathname).toBe('https://exolix.com/api/v2/rate');
    expect(url.searchParams.get('coinFrom')).toBe('USDC');
    expect(url.searchParams.get('networkFrom')).toBe('ETH');
    expect(url.searchParams.get('coinTo')).toBe('XMR');
    expect(url.searchParams.get('rateType')).toBe('float');
  });

  it('asks for Solana USDC as the same currency on its own network', () => {
    const url = new URL(exolixRateUrl(fromCoin('usdcsol')!, 500));
    expect(url.searchParams.get('coinFrom')).toBe('USDC');
    expect(url.searchParams.get('networkFrom')).toBe('SOL');
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
    const { url, body } = exolixCreateBody(request({ refund: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' }));
    expect(url).toBe('https://exolix.com/api/v2/transactions');
    expect(body).toMatchObject({
      coinFrom: 'BTC',
      networkFrom: 'BTC',
      coinTo: 'XMR',
      withdrawalAddress: XMR_ADDR,
      refundAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      rateType: 'float',
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
    const est = new URL(changeNowEstimateUrl(btc, 0.05));
    expect(est.searchParams.get('fromCurrency')).toBe('btc');
    expect(est.searchParams.get('toCurrency')).toBe('xmr');
    expect(est.searchParams.get('fromAmount')).toBe('0.05');
    const min = new URL(changeNowMinUrl(usdc));
    expect(min.searchParams.get('fromNetwork')).toBe('eth');
    const sol = new URL(changeNowMinUrl(fromCoin('usdcsol')!));
    expect(sol.searchParams.get('fromCurrency')).toBe('usdc');
    expect(sol.searchParams.get('fromNetwork')).toBe('sol');
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
    const { url, body } = changeNowCreateBody(request({ provider: 'changenow', coin: usdc, amount: 500 }));
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

describe('the words on the page', () => {
  it('narrates every stage', () => {
    for (const line of Object.values(STAGE_LINES)) expect(line.length).toBeGreaterThan(10);
  });

  it('tells the expired case not to send to the dead address', () => {
    // The one stage where the wrong next move loses money outright.
    expect(STAGE_LINES.expired).toMatch(/do not send/i);
  });
});

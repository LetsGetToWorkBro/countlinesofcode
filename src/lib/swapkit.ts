/**
 * The swap page's brains: everything about talking to exchange services that
 * can be pure and unit-tested.
 *
 * The page swaps into Monero and back out of it through third-party instant
 * exchanges. The browser never talks to them: the site's Content-Security-
 * Policy is `connect-src 'self'`, so the page calls `/api/swap/...` on this
 * origin and the Worker forwards to the exchange. The exchange sees
 * Cloudflare, not the visitor.
 *
 * Two providers, deliberately:
 *
 *   - Exolix answers rate and order-creation calls with no API key, so the
 *     swap works out of the box.
 *   - ChangeNOW needs a free partner key (CHANGENOW_API_KEY secret). When the
 *     key is present the Worker asks both and the page shows both quotes;
 *     when it is absent ChangeNOW simply does not appear.
 *
 * Every swap has Monero on exactly one side. That is not a limitation of the
 * providers, which will trade anything for anything; it is what this page is
 * for, and it keeps the address checking down to one question with a right
 * answer: does this address belong on the chain the money is going to.
 *
 * Nothing here fetches. This module builds requests, parses replies into one
 * common shape, and validates what the visitor typed; the Worker in
 * src/worker/swap.ts is the thin shell that moves the bytes.
 */

/** Which chain an address belongs to, which is all we need to check one. */
export type AddressFamily = 'xmr' | 'btc' | 'evm' | 'sol' | 'tron';

export interface Coin {
  /** Our id, unique per coin AND network: USDT on Tron is not USDT on Ethereum. */
  id: string;
  /** The currency as the providers name it; shared across a coin's networks. */
  ticker: string;
  label: string;
  /** Network as Exolix names it. */
  network: string;
  /** Network as ChangeNOW names it. */
  cnNetwork: string;
  /** Network as Godex names it. Godex happens to use the same codes Exolix
   *  does, but stated rather than shared: two providers agreeing today is not
   *  a promise, and the coin that breaks the coincidence would send somebody's
   *  USDT down the wrong chain. */
  gxNetwork: string;
  family: AddressFamily;
}

/**
 * Everything swappable here, Monero first because it is on every trade.
 *
 * The rest are ordered by how much XMR volume actually moves against them:
 * USDT is the overwhelming majority of it and Tron is where most USDT lives
 * (the transfer costs cents rather than dollars), then BTC, then ETH, then
 * USDC. Bitcoin leads the picker anyway, because this site has a Bitcoin
 * wallet built into the page next door and that is the pairing people arrive
 * wanting.
 */
export const COINS: Coin[] = [
  { id: 'xmr', ticker: 'xmr', label: 'Monero', network: 'XMR', cnNetwork: 'xmr', gxNetwork: 'XMR', family: 'xmr' },
  { id: 'btc', ticker: 'btc', label: 'Bitcoin', network: 'BTC', cnNetwork: 'btc', gxNetwork: 'BTC', family: 'btc' },
  { id: 'usdttrc', ticker: 'usdt', label: 'USDT (Tron)', network: 'TRX', cnNetwork: 'trx', gxNetwork: 'TRX', family: 'tron' },
  { id: 'usdteth', ticker: 'usdt', label: 'USDT (Ethereum)', network: 'ETH', cnNetwork: 'eth', gxNetwork: 'ETH', family: 'evm' },
  { id: 'eth', ticker: 'eth', label: 'Ethereum', network: 'ETH', cnNetwork: 'eth', gxNetwork: 'ETH', family: 'evm' },
  { id: 'usdc', ticker: 'usdc', label: 'USDC (Ethereum)', network: 'ETH', cnNetwork: 'eth', gxNetwork: 'ETH', family: 'evm' },
  { id: 'usdcsol', ticker: 'usdc', label: 'USDC (Solana)', network: 'SOL', cnNetwork: 'sol', gxNetwork: 'SOL', family: 'sol' },
];

export const XMR: Coin = COINS[0]!;

/** Everything Monero can be traded against here, in picker order. */
export const COUNTER_COINS: Coin[] = COINS.filter((c) => c.id !== 'xmr');

export function coin(id: string): Coin | null {
  return COINS.find((c) => c.id === id) ?? null;
}

export type ProviderId = 'exolix' | 'changenow' | 'godex';

export const PROVIDERS: { id: ProviderId; label: string; note: string; needsKey: boolean }[] = [
  { id: 'exolix', label: 'Exolix', note: 'exolix.com', needsKey: false },
  { id: 'godex', label: 'Godex', note: 'godex.io', needsKey: false },
  { id: 'changenow', label: 'ChangeNOW', note: 'changenow.io', needsKey: true },
];

/** One provider's answer to "how much of that for this much of this". */
export interface SwapQuote {
  provider: ProviderId;
  ok: boolean;
  /** Estimated amount received, when ok. */
  toAmount?: number;
  /** The provider's minimum for this pair, when it told us. */
  minAmount?: number;
  maxAmount?: number;
  /** Why there is no quote, in words fit for the page. */
  reason?: string;
}

/** A created swap, normalised across providers. */
export interface SwapOrder {
  provider: ProviderId;
  id: string;
  /** Where the visitor sends the coin they are spending. */
  payinAddress: string;
  /** An extra id/memo some chains need. Null for everything here today, but
   *  carried through so adding one cannot silently lose it. */
  payinExtra: string | null;
  payinAmount: number;
  /** Estimated amount out, as quoted at creation. */
  toAmount: number;
  /** The address the exchange will pay. Echoed so the page can show the
   *  visitor exactly what the provider recorded. */
  payoutAddress: string;
}

/** Where a swap stands, in stages the page can narrate. */
export type SwapStage =
  | 'waiting' // nothing received yet
  | 'confirming' // deposit seen, waiting for confirmations
  | 'exchanging' // provider is trading
  | 'sending' // coins on their way out
  | 'done'
  | 'refunded'
  | 'expired' // deposit window closed with nothing received
  | 'failed';

export interface SwapStatus {
  stage: SwapStage;
  /** The provider's own word for it, for the curious. */
  raw: string;
  /** Outgoing transaction hash, once there is one. */
  txId?: string;
}

// ---------------------------------------------------------------------------
// Addresses.

/**
 * Does this address belong on that chain?
 *
 * Deliberately shape-only: the provider validates properly and will refuse a
 * bad one, and the wallet page does real checksum work in the browser. What
 * this catches is the mistake that actually happens, which is pasting the
 * right address for the wrong chain, and it catches it before an order exists
 * rather than after the money has moved.
 */
const ADDRESS_SHAPES: Record<AddressFamily, RegExp[]> = {
  // Standard/subaddress (95 chars, 4 or 8) and integrated (106).
  xmr: [/^[48][1-9A-HJ-NP-Za-km-z]{94}$/, /^4[1-9A-HJ-NP-Za-km-z]{105}$/],
  btc: [/^bc1[a-z0-9]{8,87}$/, /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/],
  evm: [/^0x[0-9a-fA-F]{40}$/],
  sol: [/^[1-9A-HJ-NP-Za-km-z]{32,44}$/],
  tron: [/^T[1-9A-HJ-NP-Za-km-z]{33}$/],
};

export function addressLooksRight(family: AddressFamily, text: string): boolean {
  const addr = String(text ?? '').trim();
  return ADDRESS_SHAPES[family].some((shape) => shape.test(addr));
}

/** What to tell someone whose address is the wrong shape for the chain. */
export function addressHint(target: Coin): string {
  switch (target.family) {
    case 'xmr': return 'a mainnet Monero address, starting 4 or 8';
    case 'btc': return 'a Bitcoin address, starting bc1, 1 or 3';
    case 'evm': return 'an Ethereum address, starting 0x';
    case 'sol': return 'a Solana address';
    case 'tron': return 'a Tron address, starting T';
  }
}

/** Amounts must be a plain positive number. The pair's real minimum and
 *  maximum belong to the provider; this only keeps nonsense off the wire. */
export function parseAmount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return null;
  return n;
}

/** The two coins of a swap, once we know both are real and one is Monero. */
export interface Pair {
  from: Coin;
  to: Coin;
}

export function parsePair(fromId: unknown, toId: unknown): { ok: true; pair: Pair } | { ok: false; problem: string } {
  const from = coin(String(fromId ?? ''));
  const to = coin(String(toId ?? ''));
  if (!from || !to) return { ok: false, problem: 'Unknown coin.' };
  if (from.id === to.id) return { ok: false, problem: 'Those are the same coin.' };
  if (from.id !== 'xmr' && to.id !== 'xmr') {
    return { ok: false, problem: 'Every swap here has Monero on one side.' };
  }
  return { ok: true, pair: { from, to } };
}

export interface CreateRequest {
  provider: ProviderId;
  from: Coin;
  to: Coin;
  amount: number;
  address: string;
  refund: string;
}

/** Validate a create-swap body. Returns the clean request or a message. */
export function parseCreateRequest(body: unknown): { ok: true; req: CreateRequest } | { ok: false; problem: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const provider = PROVIDERS.find((p) => p.id === b['provider']);
  if (!provider) return { ok: false, problem: 'Unknown provider.' };
  const pair = parsePair(b['from'], b['to']);
  if (!pair.ok) return { ok: false, problem: pair.problem };
  const { from, to } = pair.pair;

  const amount = parseAmount(b['amount']);
  if (amount === null) return { ok: false, problem: 'That amount is not a number this can send.' };

  const address = String(b['address'] ?? '').trim();
  if (!addressLooksRight(to.family, address)) {
    return { ok: false, problem: `That does not look like ${addressHint(to)}.` };
  }
  const refund = String(b['refund'] ?? '').trim();
  if (refund && !addressLooksRight(from.family, refund)) {
    return { ok: false, problem: `That refund address does not look like ${addressHint(from)}.` };
  }
  return { ok: true, req: { provider: provider.id, from, to, amount, address, refund } };
}

/** Order ids appear in URLs we build; keep them to the shapes providers use. */
export function isPlausibleOrderId(id: string): boolean {
  return /^[A-Za-z0-9_-]{4,64}$/.test(id);
}

// ---------------------------------------------------------------------------
// Exolix. https://exolix.com/developers
// Rates and transactions answer without an API key.

const EXOLIX = 'https://exolix.com/api/v2';

export function exolixRateUrl(pair: Pair, amount: number): string {
  const q = new URLSearchParams({
    coinFrom: pair.from.ticker.toUpperCase(),
    networkFrom: pair.from.network,
    coinTo: pair.to.ticker.toUpperCase(),
    networkTo: pair.to.network,
    amount: String(amount),
    rateType: 'float',
  });
  return `${EXOLIX}/rate?${q}`;
}

export function parseExolixRate(json: unknown): SwapQuote {
  const j = (json ?? {}) as Record<string, unknown>;
  const toAmount = Number(j['toAmount']);
  const minAmount = Number(j['minAmount']);
  if (Number.isFinite(toAmount) && toAmount > 0) {
    const quote: SwapQuote = { provider: 'exolix', ok: true, toAmount };
    if (Number.isFinite(minAmount) && minAmount > 0) quote.minAmount = minAmount;
    const maxAmount = Number(j['maxAmount']);
    if (Number.isFinite(maxAmount) && maxAmount > 0) quote.maxAmount = maxAmount;
    return quote;
  }
  // Exolix says "your amount is under the minimum" via message/minAmount with
  // toAmount 0, and other failures via an error field.
  const reason = String(j['message'] ?? j['error'] ?? 'No quote.');
  const quote: SwapQuote = { provider: 'exolix', ok: false, reason };
  if (Number.isFinite(minAmount) && minAmount > 0) quote.minAmount = minAmount;
  return quote;
}

export function exolixCreateBody(req: CreateRequest): { url: string; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {
    coinFrom: req.from.ticker.toUpperCase(),
    networkFrom: req.from.network,
    coinTo: req.to.ticker.toUpperCase(),
    networkTo: req.to.network,
    amount: req.amount,
    withdrawalAddress: req.address,
    rateType: 'float',
  };
  if (req.refund) body['refundAddress'] = req.refund;
  return { url: `${EXOLIX}/transactions`, body };
}

export function parseExolixCreate(json: unknown): SwapOrder | null {
  const j = (json ?? {}) as Record<string, unknown>;
  const id = String(j['id'] ?? '');
  const payinAddress = String(j['depositAddress'] ?? '');
  const payinAmount = Number(j['amount']);
  const toAmount = Number(j['amountTo']);
  if (!id || !payinAddress || !Number.isFinite(payinAmount)) return null;
  return {
    provider: 'exolix',
    id,
    payinAddress,
    payinExtra: j['depositExtraId'] ? String(j['depositExtraId']) : null,
    payinAmount,
    toAmount: Number.isFinite(toAmount) ? toAmount : 0,
    payoutAddress: String(j['withdrawalAddress'] ?? ''),
  };
}

export function exolixStatusUrl(id: string): string {
  return `${EXOLIX}/transactions/${encodeURIComponent(id)}`;
}

const EXOLIX_STAGES: Record<string, SwapStage> = {
  wait: 'waiting',
  confirmation: 'confirming',
  confirmed: 'confirming',
  exchanging: 'exchanging',
  sending: 'sending',
  success: 'done',
  overdue: 'expired',
  refunded: 'refunded',
};

export function parseExolixStatus(json: unknown): SwapStatus {
  const j = (json ?? {}) as Record<string, unknown>;
  const raw = String(j['status'] ?? 'unknown');
  const status: SwapStatus = { stage: EXOLIX_STAGES[raw] ?? 'failed', raw };
  if (j['hashOut'] && typeof j['hashOut'] === 'object') {
    const hash = (j['hashOut'] as Record<string, unknown>)['hash'];
    if (hash) status.txId = String(hash);
  }
  return status;
}

// ---------------------------------------------------------------------------
// ChangeNOW. https://documenter.getpostman.com/view/8180765/SVfTPnM8
// v2; every call below except min-amount needs the partner key header.

const CHANGENOW = 'https://api.changenow.io/v2';

function cnPair(pair: Pair): Record<string, string> {
  return {
    fromCurrency: pair.from.ticker,
    fromNetwork: pair.from.cnNetwork,
    toCurrency: pair.to.ticker,
    toNetwork: pair.to.cnNetwork,
  };
}

export function changeNowMinUrl(pair: Pair): string {
  const q = new URLSearchParams({ ...cnPair(pair), flow: 'standard' });
  return `${CHANGENOW}/exchange/min-amount?${q}`;
}

export function changeNowEstimateUrl(pair: Pair, amount: number): string {
  const q = new URLSearchParams({ ...cnPair(pair), fromAmount: String(amount), flow: 'standard' });
  return `${CHANGENOW}/exchange/estimated-amount?${q}`;
}

export function parseChangeNowEstimate(json: unknown, minJson: unknown): SwapQuote {
  const j = (json ?? {}) as Record<string, unknown>;
  const m = (minJson ?? {}) as Record<string, unknown>;
  const toAmount = Number(j['toAmount']);
  const minAmount = Number(m['minAmount']);
  if (Number.isFinite(toAmount) && toAmount > 0) {
    const quote: SwapQuote = { provider: 'changenow', ok: true, toAmount };
    if (Number.isFinite(minAmount) && minAmount > 0) quote.minAmount = minAmount;
    return quote;
  }
  const reason = String(j['message'] ?? j['error'] ?? 'No quote.');
  const quote: SwapQuote = { provider: 'changenow', ok: false, reason };
  if (Number.isFinite(minAmount) && minAmount > 0) quote.minAmount = minAmount;
  return quote;
}

export function changeNowCreateBody(req: CreateRequest): { url: string; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {
    ...cnPair({ from: req.from, to: req.to }),
    fromAmount: String(req.amount),
    address: req.address,
    flow: 'standard',
  };
  if (req.refund) body['refundAddress'] = req.refund;
  return { url: `${CHANGENOW}/exchange`, body };
}

export function parseChangeNowCreate(json: unknown): SwapOrder | null {
  const j = (json ?? {}) as Record<string, unknown>;
  const id = String(j['id'] ?? '');
  const payinAddress = String(j['payinAddress'] ?? '');
  const payinAmount = Number(j['fromAmount']);
  const toAmount = Number(j['toAmount']);
  if (!id || !payinAddress || !Number.isFinite(payinAmount)) return null;
  return {
    provider: 'changenow',
    id,
    payinAddress,
    payinExtra: j['payinExtraId'] ? String(j['payinExtraId']) : null,
    payinAmount,
    toAmount: Number.isFinite(toAmount) ? toAmount : 0,
    payoutAddress: String(j['payoutAddress'] ?? ''),
  };
}

export function changeNowStatusUrl(id: string): string {
  return `${CHANGENOW}/exchange/by-id?id=${encodeURIComponent(id)}`;
}

const CHANGENOW_STAGES: Record<string, SwapStage> = {
  new: 'waiting',
  waiting: 'waiting',
  confirming: 'confirming',
  verifying: 'confirming',
  exchanging: 'exchanging',
  sending: 'sending',
  finished: 'done',
  failed: 'failed',
  refunded: 'refunded',
  expired: 'expired',
};

export function parseChangeNowStatus(json: unknown): SwapStatus {
  const j = (json ?? {}) as Record<string, unknown>;
  const raw = String(j['status'] ?? 'unknown');
  const status: SwapStatus = { stage: CHANGENOW_STAGES[raw] ?? 'failed', raw };
  if (j['payoutHash']) status.txId = String(j['payoutHash']);
  return status;
}

// ---------------------------------------------------------------------------
// Godex. https://godex.io/api
// Rates, order creation and status all answer without an API key, which is why
// it is here: it makes the board a comparison rather than a single price on
// the machines of visitors who never set a secret.

const GODEX = 'https://api.godex.io/api/v1';

/** Godex takes its rate query as a POST body rather than a query string. */
export function godexRateBody(pair: Pair, amount: number): { url: string; body: Record<string, unknown> } {
  return {
    url: `${GODEX}/info`,
    body: {
      from: pair.from.ticker.toUpperCase(),
      to: pair.to.ticker.toUpperCase(),
      amount: String(amount),
      network_from: pair.from.gxNetwork,
      network_to: pair.to.gxNetwork,
    },
  };
}

export function parseGodexRate(json: unknown): SwapQuote {
  const j = (json ?? {}) as Record<string, unknown>;
  const toAmount = Number(j['amount']);
  const minAmount = Number(j['min_amount']);
  const maxAmount = Number(j['max_amount']);
  if (Number.isFinite(toAmount) && toAmount > 0) {
    const quote: SwapQuote = { provider: 'godex', ok: true, toAmount };
    if (Number.isFinite(minAmount) && minAmount > 0) quote.minAmount = minAmount;
    if (Number.isFinite(maxAmount) && maxAmount > 0) quote.maxAmount = maxAmount;
    return quote;
  }
  /* Under the minimum, Godex answers 200 with amount "0" and the minimum
   * filled in rather than an error, so a zero is a refusal and the reason has
   * to be built here. */
  const stated = j['error'] ?? j['message'];
  const reason = stated ? String(stated) : 'No quote at this amount.';
  const quote: SwapQuote = { provider: 'godex', ok: false, reason };
  if (Number.isFinite(minAmount) && minAmount > 0) quote.minAmount = minAmount;
  if (Number.isFinite(maxAmount) && maxAmount > 0) quote.maxAmount = maxAmount;
  return quote;
}

export function godexCreateBody(req: CreateRequest): { url: string; body: Record<string, unknown> } {
  return {
    url: `${GODEX}/transaction`,
    body: {
      coin_from: req.from.ticker.toUpperCase(),
      coin_to: req.to.ticker.toUpperCase(),
      deposit_amount: String(req.amount),
      withdrawal: req.address,
      return: req.refund ?? '',
      coin_from_network: req.from.gxNetwork,
      coin_to_network: req.to.gxNetwork,
      /* Both extra-id fields must be *present* or Godex rejects the call with a
       * validation error, even for chains that have no such thing. Empty is
       * fine; absent is not. */
      withdrawal_extra_id: '',
      return_extra_id: '',
    },
  };
}

export function parseGodexCreate(json: unknown): SwapOrder | null {
  const j = (json ?? {}) as Record<string, unknown>;
  const id = String(j['transaction_id'] ?? '');
  const payinAddress = String(j['deposit'] ?? '');
  const payinAmount = Number(j['deposit_amount']);
  const toAmount = Number(j['withdrawal_amount']);
  if (!id || !payinAddress || !Number.isFinite(payinAmount)) return null;
  return {
    provider: 'godex',
    id,
    payinAddress,
    payinExtra: j['deposit_extra_id'] ? String(j['deposit_extra_id']) : null,
    payinAmount,
    toAmount: Number.isFinite(toAmount) ? toAmount : 0,
    payoutAddress: String(j['withdrawal'] ?? ''),
  };
}

export function godexStatusUrl(id: string): string {
  return `${GODEX}/transaction/${encodeURIComponent(id)}`;
}

const GODEX_STAGES: Record<string, SwapStage> = {
  wait: 'waiting',
  confirmation: 'confirming',
  confirmed: 'confirming',
  exchanging: 'exchanging',
  sending: 'sending',
  success: 'done',
  overdue: 'expired',
  refunded: 'refunded',
  error: 'failed',
};

export function parseGodexStatus(json: unknown): SwapStatus {
  const j = (json ?? {}) as Record<string, unknown>;
  const raw = String(j['status'] ?? 'unknown');
  const status: SwapStatus = { stage: GODEX_STAGES[raw] ?? 'failed', raw };
  if (j['hash_out']) status.txId = String(j['hash_out']);
  return status;
}

// ---------------------------------------------------------------------------

/** What each stage means, in the page's voice. Lives here so the words are
 *  tested and the client stays a thin renderer. */
export const STAGE_LINES: Record<SwapStage, string> = {
  waiting: 'Waiting for your deposit. Send the exact amount to the address above.',
  confirming: 'Deposit seen. Waiting for network confirmations.',
  exchanging: 'Confirmed. The exchange is trading it now.',
  sending: 'The coins are on their way to your address.',
  done: 'Done. The exchange has sent the coins to your address.',
  refunded: 'The exchange refunded the deposit instead of completing the swap.',
  expired: 'The deposit window closed with nothing received. Start a new swap; do not send to the old address.',
  failed: 'The exchange reports a problem. Check the swap on their site with the id above.',
};

/**
 * The swap page's brains: everything about talking to exchange services that
 * can be pure and unit-tested.
 *
 * The page swaps BTC or USDC into Monero through third-party instant
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
 * Nothing here fetches. This module builds requests, parses replies into one
 * common shape, and validates what the visitor typed; the Worker in
 * src/worker/swap.ts is the thin shell that moves the bytes.
 */

/** What the page may swap from. Short on purpose; XMR is always the target.
 *  `id` names the choice in our API; `ticker` is the currency the providers
 *  know it by, which USDC shares across its networks. */
export const FROM_COINS = [
  { id: 'btc', ticker: 'btc', label: 'Bitcoin', network: 'BTC', cnNetwork: 'btc', decimals: 8 },
  { id: 'usdc', ticker: 'usdc', label: 'USDC (ERC-20)', network: 'ETH', cnNetwork: 'eth', decimals: 6 },
  { id: 'usdcsol', ticker: 'usdc', label: 'USDC (Solana)', network: 'SOL', cnNetwork: 'sol', decimals: 6 },
] as const;

export type FromCoinId = (typeof FROM_COINS)[number]['id'];

export function fromCoin(id: string): (typeof FROM_COINS)[number] | null {
  return FROM_COINS.find((c) => c.id === id) ?? null;
}

export type ProviderId = 'exolix' | 'changenow';

export const PROVIDERS: { id: ProviderId; label: string; note: string; needsKey: boolean }[] = [
  { id: 'exolix', label: 'Exolix', note: 'exolix.com', needsKey: false },
  { id: 'changenow', label: 'ChangeNOW', note: 'changenow.io', needsKey: true },
];

/** One provider's answer to "how much XMR for this much X". */
export interface SwapQuote {
  provider: ProviderId;
  ok: boolean;
  /** Estimated XMR received, when ok. */
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
  /** Where the visitor sends their BTC or USDC. */
  payinAddress: string;
  /** An extra id/memo some coins need. Null for BTC and USDC, but carried
   *  through so a future coin cannot silently lose it. */
  payinExtra: string | null;
  payinAmount: number;
  /** Estimated XMR out, as quoted at creation. */
  toAmount: number;
  /** The XMR address the exchange will pay. Echoed so the page can show the
   *  visitor exactly what the provider recorded. */
  payoutAddress: string;
}

/** Where a swap stands, in stages the page can narrate. */
export type SwapStage =
  | 'waiting' // nothing received yet
  | 'confirming' // deposit seen, waiting for confirmations
  | 'exchanging' // provider is trading
  | 'sending' // XMR on its way out
  | 'done'
  | 'refunded'
  | 'expired' // deposit window closed with nothing received
  | 'failed';

export interface SwapStatus {
  stage: SwapStage;
  /** The provider's own word for it, for the curious. */
  raw: string;
  /** Outgoing XMR transaction hash, once there is one. */
  txId?: string;
}

// ---------------------------------------------------------------------------
// Validation of what the visitor sent.

/** A standard or subaddress (95 chars starting 4/8) or integrated (106)
 *  mainnet Monero address. The wallet page validates properly in the browser;
 *  this is the server's plausibility gate, and the provider checks again. */
export function looksLikeXmrAddress(text: string): boolean {
  const addr = String(text ?? '').trim();
  return /^[48][1-9A-HJ-NP-Za-km-z]{94}$/.test(addr) || /^4[1-9A-HJ-NP-Za-km-z]{105}$/.test(addr);
}

/** A plausible refund address for the coin being sent, or empty. Loose by
 *  design: the provider is the authority, this only rejects obvious noise. */
export function plausibleRefund(coin: FromCoinId, text: string): boolean {
  const addr = String(text ?? '').trim();
  if (!addr) return true;
  if (coin === 'btc') return /^(bc1[a-z0-9]{8,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(addr);
  if (coin === 'usdcsol') return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/** Amounts must be a plain positive number. The pair's real minimum and
 *  maximum belong to the provider; this only keeps nonsense off the wire. */
export function parseAmount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return null;
  return n;
}

export interface CreateRequest {
  provider: ProviderId;
  coin: (typeof FROM_COINS)[number];
  amount: number;
  address: string;
  refund: string;
}

/** Validate a create-swap body. Returns the clean request or a message. */
export function parseCreateRequest(body: unknown): { ok: true; req: CreateRequest } | { ok: false; problem: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const provider = PROVIDERS.find((p) => p.id === b['provider']);
  if (!provider) return { ok: false, problem: 'Unknown provider.' };
  const coin = fromCoin(String(b['from'] ?? ''));
  if (!coin) return { ok: false, problem: 'Unknown coin. This swaps BTC or USDC.' };
  const amount = parseAmount(b['amount']);
  if (amount === null) return { ok: false, problem: 'That amount is not a number this can send.' };
  const address = String(b['address'] ?? '').trim();
  if (!looksLikeXmrAddress(address)) {
    return { ok: false, problem: 'That does not look like a mainnet Monero address.' };
  }
  const refund = String(b['refund'] ?? '').trim();
  if (!plausibleRefund(coin.id, refund)) {
    return { ok: false, problem: `That refund address does not look like a ${coin.label} address.` };
  }
  return { ok: true, req: { provider: provider.id, coin, amount, address, refund } };
}

/** Order ids appear in URLs we build; keep them to the shapes providers use. */
export function isPlausibleOrderId(id: string): boolean {
  return /^[A-Za-z0-9_-]{4,64}$/.test(id);
}

// ---------------------------------------------------------------------------
// Exolix. https://exolix.com/developers
// Rates and transactions answer without an API key.

const EXOLIX = 'https://exolix.com/api/v2';

export function exolixRateUrl(coin: (typeof FROM_COINS)[number], amount: number): string {
  const q = new URLSearchParams({
    coinFrom: coin.ticker.toUpperCase(),
    networkFrom: coin.network,
    coinTo: 'XMR',
    networkTo: 'XMR',
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
    coinFrom: req.coin.ticker.toUpperCase(),
    networkFrom: req.coin.network,
    coinTo: 'XMR',
    networkTo: 'XMR',
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

export function changeNowMinUrl(coin: (typeof FROM_COINS)[number]): string {
  const q = new URLSearchParams({
    fromCurrency: coin.ticker,
    fromNetwork: coin.cnNetwork,
    toCurrency: 'xmr',
    toNetwork: 'xmr',
    flow: 'standard',
  });
  return `${CHANGENOW}/exchange/min-amount?${q}`;
}

export function changeNowEstimateUrl(coin: (typeof FROM_COINS)[number], amount: number): string {
  const q = new URLSearchParams({
    fromCurrency: coin.ticker,
    fromNetwork: coin.cnNetwork,
    toCurrency: 'xmr',
    toNetwork: 'xmr',
    fromAmount: String(amount),
    flow: 'standard',
  });
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
    fromCurrency: req.coin.ticker,
    fromNetwork: req.coin.cnNetwork,
    toCurrency: 'xmr',
    toNetwork: 'xmr',
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

/** What each stage means, in the page's voice. Lives here so the words are
 *  tested and the client stays a thin renderer. */
export const STAGE_LINES: Record<SwapStage, string> = {
  waiting: 'Waiting for your deposit. Send the exact amount to the address above.',
  confirming: 'Deposit seen. Waiting for network confirmations.',
  exchanging: 'Confirmed. The exchange is trading it for Monero.',
  sending: 'The Monero is on its way to your address.',
  done: 'Done. The Monero has been sent to your address.',
  refunded: 'The exchange refunded the deposit instead of completing the swap.',
  expired: 'The deposit window closed with nothing received. Start a new swap; do not send to the old address.',
  failed: 'The exchange reports a problem. Check the swap on their site with the id above.',
};

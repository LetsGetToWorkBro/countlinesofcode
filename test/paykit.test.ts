/**
 * Payment requests.
 *
 * The address check is the load-bearing part: a payment QR with a mistyped
 * address scans perfectly and sends the money nowhere, so the check has to
 * catch a wrong character with the real checksum, not a regular expression.
 * The Monero side is cross-checked against the wallet's own address parser so
 * the two cannot drift; the Bitcoin side is checked against known-good and
 * known-bad addresses; and the whole request is round-tripped through the QR
 * encoder and reader it will actually be shown through.
 */

import { describe, expect, it } from 'vitest';
import { buildUri, checkAddress, parseAmount } from '../src/client/paykit';
import { parseAddress } from '../src/client/monero';
import { decodeQr, encodeQr } from '../src/client/qrkit';

const XMR_DONATION = '83TQcTwusSQ4WKbPQE5osrF3cR4GWe2zmcNWeozK6BSqHSaeLvjUVe476ouVwLKn1uVwEFcbJQvnme7W6dTV5SB93x45DEy';
const XMR_STANDARD = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

describe('checkAddress, Bitcoin', () => {
  it('accepts the four mainnet address kinds', () => {
    expect(checkAddress('btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa').valid).toBe(true); // P2PKH
    expect(checkAddress('btc', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy').valid).toBe(true); // P2SH
    expect(checkAddress('btc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').valid).toBe(true); // P2WPKH
    expect(checkAddress('btc', 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr').valid).toBe(true); // Taproot
  });

  it('rejects a one-character typo by its checksum', () => {
    expect(checkAddress('btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7Divfna').valid).toBe(false); // base58check
    expect(checkAddress('btc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5').valid).toBe(false); // bech32
  });

  it('rejects a mixed-case bech32 address, which the standard forbids', () => {
    expect(checkAddress('btc', 'bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').valid).toBe(false);
  });

  it('rejects anything that is not on the mainnet', () => {
    // A valid testnet address, but a payment request is a mainnet thing.
    expect(checkAddress('btc', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx').valid).toBe(false);
  });

  it('names the kind of a valid address', () => {
    expect(checkAddress('btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa').kind).toContain('P2PKH');
    expect(checkAddress('btc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').kind).toContain('P2WPKH');
  });
});

describe('checkAddress, Monero, agreeing with the wallet parser', () => {
  it('accepts a standard address and a subaddress', () => {
    expect(checkAddress('xmr', XMR_STANDARD).valid).toBe(true);
    expect(checkAddress('xmr', XMR_DONATION).valid).toBe(true);
  });

  it('rejects a corrupted address', () => {
    const bad = XMR_DONATION.slice(0, -1) + (XMR_DONATION.endsWith('y') ? 'x' : 'y');
    expect(checkAddress('xmr', bad).valid).toBe(false);
  });

  it('returns the same verdict as the wallet address parser', () => {
    // Two implementations of the same checksum must never disagree, or one
    // page would wave through what the other flags.
    for (const addr of [XMR_STANDARD, XMR_DONATION, XMR_DONATION.slice(0, -1) + 'x', 'not an address']) {
      expect(checkAddress('xmr', addr).valid).toBe(parseAddress(addr).valid);
    }
  });
});

describe('parseAmount', () => {
  it('accepts an empty amount as a request without one', () => {
    expect(parseAmount('btc', '')).toMatchObject({ ok: true, value: null });
  });

  it('normalises a decimal, dropping trailing zeros and a leading dot', () => {
    expect(parseAmount('btc', '0.0100').value).toBe('0.01');
    expect(parseAmount('btc', '.5').value).toBe('0.5');
    expect(parseAmount('xmr', '2.000').value).toBe('2');
  });

  it('rejects zero, a negative, and a non-number', () => {
    expect(parseAmount('btc', '0').ok).toBe(false);
    expect(parseAmount('btc', '-1').ok).toBe(false);
    expect(parseAmount('btc', 'abc').ok).toBe(false);
  });

  it('holds each coin to its own number of decimal places', () => {
    expect(parseAmount('btc', '1.234567891').ok).toBe(false); // 9 > 8 for BTC
    expect(parseAmount('xmr', '1.234567891').ok).toBe(true); // fine within 12
  });
});

describe('buildUri', () => {
  it('builds a BIP-21 bitcoin: link with the standard parameter names', () => {
    const uri = buildUri('btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', { amount: '0.001', label: 'Coffee Shop', message: 'table 4' });
    expect(uri).toBe('bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa?amount=0.001&label=Coffee%20Shop&message=table%204');
  });

  it('builds a monero: link with its own parameter names', () => {
    const uri = buildUri('xmr', XMR_DONATION, { amount: '2.5', label: 'Alice' });
    expect(uri).toBe(`monero:${XMR_DONATION}?tx_amount=2.5&recipient_name=Alice`);
  });

  it('leaves out the parameters that were not given', () => {
    expect(buildUri('btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe('bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  });
});

describe('the request survives being made into a QR and read back', () => {
  function raster(qr: { size: number; modules: boolean[][] }, scale: number, margin = 4) {
    const dim = (qr.size + margin * 2) * scale;
    const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (!qr.modules[r]![c]) continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          const i = (((r + margin) * scale + dy) * dim + (c + margin) * scale + dx) * 4;
          data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
        }
      }
    }
    return { data, dim };
  }

  it('reads back the exact bitcoin: link the payer would scan', () => {
    const uri = buildUri('btc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', { amount: '0.005', label: 'Shop' });
    const qr = encodeQr(uri, 'M');
    const { data, dim } = raster(qr, 6);
    expect(decodeQr(data, dim, dim)).toBe(uri);
  });
});

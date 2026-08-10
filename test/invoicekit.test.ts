/**
 * The invoice engine.
 *
 * The money is the part someone acts on, so it is tested away from the drawing:
 * a line amount, a subtotal, the tax and the total, each rounded to the cent
 * the same way every time. Then the document itself is built in all three
 * templates and reopened, because a generator that produces a file no reader
 * can open has produced nothing.
 */

import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  type Invoice,
  TEMPLATES,
  computeTotals,
  formatMoney,
  lineAmount,
  renderInvoicePdf,
  round2,
} from '../src/client/invoicekit';

describe('the arithmetic', () => {
  it('rounds a line amount to the cent', () => {
    expect(lineAmount({ description: 'x', quantity: 3, rate: 10.005 })).toBe(30.02);
    expect(lineAmount({ description: 'x', quantity: 0, rate: 99 })).toBe(0);
  });

  it('sums a subtotal, applies tax, and totals', () => {
    const items = [
      { description: 'a', quantity: 10, rate: 120 },
      { description: 'b', quantity: 1, rate: 29.99 },
    ];
    expect(computeTotals(items, 8.25)).toEqual({ subtotal: 1229.99, tax: 101.47, total: 1331.46 });
  });

  it('treats a missing tax rate as no tax', () => {
    expect(computeTotals([{ description: 'a', quantity: 2, rate: 50 }], 0)).toEqual({ subtotal: 100, tax: 0, total: 100 });
  });

  it('handles an empty invoice without inventing a charge', () => {
    expect(computeTotals([], 10)).toEqual({ subtotal: 0, tax: 0, total: 0 });
  });

  it('rounds half-up predictably', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
  });
});

describe('formatMoney', () => {
  it('groups thousands and keeps two decimals', () => {
    expect(formatMoney(1234567.5, '$')).toBe('$1,234,567.50');
    expect(formatMoney(0, '$')).toBe('$0.00');
    expect(formatMoney(29.9, '$')).toBe('$29.90');
  });

  it('carries the currency symbol it is given, and a minus for a credit', () => {
    expect(formatMoney(1234.5, '£')).toBe('£1,234.50');
    expect(formatMoney(-50, '$')).toBe('-$50.00');
  });
});

const SAMPLE: Invoice = {
  business: { name: 'Acme LLC', address: '1 Main St, Anytown', email: 'billing@acme.test' },
  client: { name: 'Bob Client', address: '2 Oak Ave', email: 'bob@example.test' },
  number: 'INV-001',
  date: '2026-08-10',
  due: '2026-08-24',
  items: [
    { description: 'Consulting work, a deliberately long line that has to wrap across more than one row inside the description column', quantity: 10, rate: 120 },
    { description: 'Hosting', quantity: 1, rate: 29.99 },
  ],
  taxRate: 8.25,
  currency: '$',
  notes: 'Payment due within 14 days.',
  template: 'classic',
};

describe('renderInvoicePdf', () => {
  it('exposes the three templates it can draw', () => {
    expect(TEMPLATES.map((t) => t.id).sort()).toEqual(['classic', 'minimal', 'modern']);
  });

  for (const t of ['classic', 'modern', 'minimal'] as const) {
    it(`produces a PDF a reader can open in the ${t} template`, async () => {
      const bytes = await renderInvoicePdf({ ...SAMPLE, template: t });
      expect(bytes.length).toBeGreaterThan(1000);
      // The header is the four-byte %PDF signature.
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
      // And it reopens as a real document with a page.
      const reloaded = await PDFDocument.load(bytes);
      expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(1);
    });
  }

  it('does not throw on a name a standard font cannot encode, it substitutes', async () => {
    const bytes = await renderInvoicePdf({ ...SAMPLE, client: { ...SAMPLE.client, name: 'Bob \u{1F600} 日本' } });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('grows to a second page when there are too many lines for one', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ description: 'Line item ' + i, quantity: 1, rate: 10 }));
    const bytes = await renderInvoicePdf({ ...SAMPLE, items: many });
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBeGreaterThanOrEqual(2);
  });
});

/**
 * An invoice generator: the numbers, and the PDF.
 *
 * The arithmetic is the part a person is trusting, so it is kept apart from the
 * drawing and tested on its own: line amounts, a subtotal, tax, and a total,
 * each rounded to the cent the same way every time. The PDF is drawn with
 * pdf-lib and the standard fonts, in three plain templates, so the whole
 * document is built in the browser with nothing fetched and no invoice service
 * quietly keeping a copy of who owes whom.
 */

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

export interface LineItem {
  description: string;
  quantity: number;
  rate: number;
}

export interface Party {
  name: string;
  address: string;
  email: string;
}

export type TemplateId = 'classic' | 'modern' | 'minimal';

export const TEMPLATES: { id: TemplateId; name: string; note: string }[] = [
  { id: 'classic', name: 'Classic', note: 'A ruled ledger in a serif face.' },
  { id: 'modern', name: 'Modern', note: 'A sans-serif sheet with a colour band.' },
  { id: 'minimal', name: 'Minimal', note: 'Thin lines and a lot of white space.' },
];

export interface Invoice {
  business: Party;
  client: Party;
  number: string;
  date: string;
  due: string;
  items: LineItem[];
  taxRate: number;
  currency: string;
  notes: string;
  template: TemplateId;
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

/** Round to two decimals the boring, predictable way. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function lineAmount(item: LineItem): number {
  const q = Number(item.quantity) || 0;
  const r = Number(item.rate) || 0;
  return round2(q * r);
}

export interface Totals {
  subtotal: number;
  tax: number;
  total: number;
}

export function computeTotals(items: LineItem[], taxRate: number): Totals {
  const subtotal = round2(items.reduce((sum, it) => sum + lineAmount(it), 0));
  const rate = Number(taxRate) || 0;
  const tax = round2((subtotal * rate) / 100);
  return { subtotal, tax, total: round2(subtotal + tax) };
}

/** A currency prefix and a grouped, two-decimal number: $1,234.50. */
export function formatMoney(n: number, currency = '$'): string {
  const value = Math.abs(round2(n)).toFixed(2);
  const [intPart, frac] = value.split('.');
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + (currency || '$') + grouped + '.' + frac;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * The standard PDF fonts encode Latin (WinAnsi) and nothing else, so a
 * character outside that set would make pdf-lib throw and lose the whole
 * document. This keeps everything it can and turns the rest into a question
 * mark, which is honest about the limit rather than crashing on it.
 */
const WINANSI_EXTRA = new Set([
  0x20ac, 0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020,
  0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x2122, 0x0152, 0x0153, 0x0160,
  0x0161, 0x0178, 0x017d, 0x017e, 0x0192, 0x02c6, 0x02dc,
]);

function sanitize(text: string): string {
  let out = '';
  for (const ch of String(text ?? '')) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WINANSI_EXTRA.has(cp)) out += ch;
    else if (cp < 0x20) out += ' '; // a stray tab or newline becomes a space, never a '?'
    else out += '?'; // a script the standard fonts cannot draw
  }
  return out;
}

/** A party's address and email as separate display lines, the address broken
 *  on its own newlines so a two-line address prints as two lines. */
function partyLines(party: Party): string[] {
  const lines: string[] = [];
  for (const l of String(party.address || '').split(/\r?\n/)) {
    if (l.trim()) lines.push(l.trim());
  }
  if (party.email && party.email.trim()) lines.push(party.email.trim());
  return lines;
}

/** Break text into lines that fit a width, since pdf-lib does not wrap. */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = sanitize(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const candidate = cur ? cur + ' ' + word : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !cur) cur = candidate;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

interface Style {
  title: string;
  titleAlign: 'left' | 'center';
  band: boolean;
  rule: boolean;
  zebra: boolean;
  accent: ReturnType<typeof rgb>;
  regular: StandardFonts;
  bold: StandardFonts;
}

const STYLES: Record<TemplateId, Style> = {
  classic: { title: 'INVOICE', titleAlign: 'center', band: false, rule: true, zebra: false, accent: rgb(0.12, 0.12, 0.12), regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold },
  modern: { title: 'Invoice', titleAlign: 'left', band: true, rule: false, zebra: true, accent: rgb(0.13, 0.45, 0.29), regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold },
  minimal: { title: 'invoice', titleAlign: 'left', band: false, rule: false, zebra: false, accent: rgb(0.25, 0.25, 0.25), regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold },
};

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const INK = rgb(0.1, 0.1, 0.1);
const MUTE = rgb(0.42, 0.42, 0.42);
const LINE = rgb(0.8, 0.8, 0.8);

/** Render an invoice to PDF bytes, in the template it names. */
export async function renderInvoicePdf(invoice: Invoice): Promise<Uint8Array> {
  const style = STYLES[invoice.template] || STYLES.classic;
  const doc = await PDFDocument.create();
  doc.setTitle(sanitize('Invoice ' + (invoice.number || '')));
  doc.setProducer('1999.LOC invoice');
  const font = await doc.embedFont(style.regular);
  const bold = await doc.embedFont(style.bold);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  const right = PAGE_W - MARGIN;
  const currency = invoice.currency || '$';

  const text = (p: PDFPage, s: string, x: number, y: number, size: number, f = font, color = INK) =>
    p.drawText(sanitize(s), { x, y, size, font: f, color });
  const textRight = (p: PDFPage, s: string, xRight: number, y: number, size: number, f = font, color = INK) => {
    const clean = sanitize(s);
    p.drawText(clean, { x: xRight - f.widthOfTextAtSize(clean, size), y, size, font: f, color });
  };

  // ---- header: the title band or plain title, and the business block ----
  let y = PAGE_H - MARGIN;
  if (style.band) {
    page.drawRectangle({ x: 0, y: PAGE_H - 96, width: PAGE_W, height: 96, color: style.accent });
    text(page, style.title, MARGIN, PAGE_H - 58, 30, bold, rgb(1, 1, 1));
    textRight(page, sanitize(invoice.business.name || 'Your business'), right, PAGE_H - 46, 15, bold, rgb(1, 1, 1));
    // The header band is one line, so a multi-line address is joined with bars.
    const bizLine = partyLines(invoice.business).join('  |  ');
    if (bizLine) textRight(page, bizLine, right, PAGE_H - 64, 9, font, rgb(0.92, 0.96, 0.93));
    y = PAGE_H - 96 - 34;
  } else {
    text(page, invoice.business.name || 'Your business', MARGIN, y, 16, bold, style.accent);
    let by = y - 15;
    for (const l of partyLines(invoice.business)) { text(page, l, MARGIN, by, 9, font, MUTE); by -= 12; }
    if (style.titleAlign === 'center') textRight(page, style.title, right, y, 28, bold, style.accent);
    else text(page, style.title, MARGIN, y - 66, 26, bold, style.accent);
    y = Math.min(by, y - 78) - 6;
  }

  // ---- meta (number, dates) and bill-to ----
  const metaX = right - 150;
  let metaY = y;
  const metaRow = (label: string, value: string) => {
    text(page, label, metaX, metaY, 9, bold, MUTE);
    textRight(page, value || '-', right, metaY, 9, font, INK);
    metaY -= 14;
  };
  metaRow('Invoice #', invoice.number);
  metaRow('Date', invoice.date);
  metaRow('Due', invoice.due);

  text(page, 'Bill to', MARGIN, y, 9, bold, MUTE);
  let cy = y - 14;
  text(page, invoice.client.name || 'Client', MARGIN, cy, 12, bold, INK); cy -= 14;
  for (const l of partyLines(invoice.client)) { text(page, l, MARGIN, cy, 9, font, MUTE); cy -= 12; }

  y = Math.min(cy, metaY) - 16;

  // ---- the items table ----
  const colDesc = MARGIN;
  const colQty = right - 210;
  const colRate = right - 120;
  const colAmt = right;
  const descWidth = colQty - colDesc - 12;

  // header row
  if (style.band || style.zebra) page.drawRectangle({ x: MARGIN - 6, y: y - 6, width: PAGE_W - 2 * MARGIN + 12, height: 20, color: rgb(0.94, 0.94, 0.94) });
  text(page, 'Description', colDesc, y, 9, bold, MUTE);
  textRight(page, 'Qty', colQty + 24, y, 9, bold, MUTE);
  textRight(page, 'Rate', colRate + 30, y, 9, bold, MUTE);
  textRight(page, 'Amount', colAmt, y, 9, bold, MUTE);
  y -= 10;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 1, color: style.accent });
  y -= 16;

  const newPageIfNeeded = () => {
    if (y > MARGIN + 120) return;
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };

  let idx = 0;
  for (const item of invoice.items) {
    if (!item || (!item.description && !Number(item.quantity) && !Number(item.rate))) continue;
    const lines = wrapText(item.description || '', font, 10, descWidth);
    const rowHeight = Math.max(lines.length * 12, 14) + 6;
    newPageIfNeeded();
    if (style.zebra && idx % 2 === 1) {
      page.drawRectangle({ x: MARGIN - 6, y: y - rowHeight + 12, width: PAGE_W - 2 * MARGIN + 12, height: rowHeight, color: rgb(0.97, 0.97, 0.97) });
    }
    let ly = y;
    (lines.length ? lines : ['']).forEach((l) => { text(page, l, colDesc, ly, 10, font, INK); ly -= 12; });
    textRight(page, String(Number(item.quantity) || 0), colQty + 24, y, 10, font, INK);
    textRight(page, formatMoney(Number(item.rate) || 0, currency), colRate + 30, y, 10, font, INK);
    textRight(page, formatMoney(lineAmount(item), currency), colAmt, y, 10, font, INK);
    y -= rowHeight;
    if (style.rule) { page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: right, y: y + 4 }, thickness: 0.5, color: LINE }); }
    idx += 1;
  }

  // ---- totals ----
  const totals = computeTotals(invoice.items, invoice.taxRate);
  y -= 6;
  page.drawLine({ start: { x: colRate - 10, y: y + 6 }, end: { x: right, y: y + 6 }, thickness: 0.5, color: LINE });
  y -= 8;
  const totalRow = (label: string, value: number, strong = false) => {
    const f = strong ? bold : font;
    const size = strong ? 12 : 10;
    text(page, label, colRate - 10, y, size, f, strong ? INK : MUTE);
    textRight(page, formatMoney(value, currency), colAmt, y, size, f, strong ? style.accent : INK);
    y -= strong ? 18 : 14;
  };
  totalRow('Subtotal', totals.subtotal);
  if ((Number(invoice.taxRate) || 0) !== 0) totalRow('Tax (' + (Number(invoice.taxRate) || 0) + '%)', totals.tax);
  if (style.accent) page.drawLine({ start: { x: colRate - 10, y: y + 6 }, end: { x: right, y: y + 6 }, thickness: 1, color: style.accent });
  y -= 6;
  totalRow('Total', totals.total, true);

  // ---- notes ----
  if (invoice.notes && invoice.notes.trim()) {
    y -= 20;
    newPageIfNeeded();
    text(page, 'Notes', MARGIN, y, 9, bold, MUTE);
    y -= 14;
    for (const l of wrapText(invoice.notes, font, 10, PAGE_W - 2 * MARGIN)) {
      newPageIfNeeded();
      text(page, l, MARGIN, y, 10, font, INK);
      y -= 13;
    }
  }

  // ---- footer ----
  const foot = 'Thank you.';
  page.drawText(sanitize(foot), { x: MARGIN, y: MARGIN - 18, size: 9, font, color: MUTE });

  return doc.save();
}

const globalScope = globalThis as unknown as { LOC1999_INVOICE?: Record<string, unknown> };
globalScope.LOC1999_INVOICE = {
  TEMPLATES,
  round2,
  lineAmount,
  computeTotals,
  formatMoney,
  renderInvoicePdf,
};

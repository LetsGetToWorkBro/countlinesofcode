/**
 * Spreadsheets: .xlsx and CSV, both directions.
 *
 * An .xlsx is a ZIP of XML, exactly like the .docx the converter already reads,
 * so this is mostly assembly over machinery that exists. The parts that matter:
 *
 *   xl/workbook.xml        the sheets, their names and order
 *   xl/worksheets/sheetN   the cells, by A1 reference
 *   xl/sharedStrings.xml   every string in the book, stored once and referenced
 *
 * That last one is the thing that surprises people writing an xlsx reader for
 * the first time: a cell of type `s` does not hold text, it holds an index into
 * a shared table. Miss it and every cell reads as a number.
 *
 * CSV is not a format so much as a family of dialects. The reader here handles
 * the one thing that actually matters — quoted fields containing commas,
 * newlines and doubled quotes — and detects the delimiter rather than assuming
 * a comma, because half of Europe exports semicolons.
 */

import { entry, unzip, zip, type ZipEntry } from './zip';

export type Cell = string;
export type Row = Cell[];

export interface Sheet {
  name: string;
  rows: Row[];
}

export interface Workbook {
  sheets: Sheet[];
}

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s);

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters make Excel declare the file corrupt.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Guess the delimiter from the first few lines.
 *
 * Counting occurrences outside quotes and picking the most consistent one
 * across lines beats picking the most frequent: a column of prose full of
 * commas would otherwise beat the semicolons actually separating the fields.
 */
export function sniffDelimiter(text: string): string {
  const candidates = [',', ';', '\t', '|'];
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  if (!lines.length) return ',';

  let best = ',';
  let bestScore = -1;
  for (const delimiter of candidates) {
    const counts = lines.map((line) => {
      let count = 0;
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') quoted = !quoted;
        else if (!quoted && line[i] === delimiter) count++;
      }
      return count;
    });
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    // Consistent across lines is what a real delimiter looks like.
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = consistent * 10 + Math.min(first, 20) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** Parse CSV, honouring quotes around fields that contain the delimiter. */
export function parseCsv(text: string, delimiter?: string): Row[] {
  const sep = delimiter ?? sniffDelimiter(text);
  // A byte-order mark at the front becomes part of the first header otherwise.
  const source = text.replace(/^﻿/, '');
  const rows: Row[] = [];
  let row: Row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'; // an escaped quote inside a quoted field
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  // A trailing newline should not add a phantom empty row.
  while (rows.length && rows[rows.length - 1]!.every((c) => c === '')) rows.pop();
  return rows;
}

export function writeCsv(rows: Row[], delimiter = ','): string {
  const needsQuote = new RegExp(`["\\n\\r${delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`);
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell ?? '';
          return needsQuote.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(delimiter),
    )
    .join('\r\n');
}

// ---------------------------------------------------------------------------
// Reading .xlsx
// ---------------------------------------------------------------------------

/** "BC12" -> column 54 (zero-based). Column letters are base-26 with no zero. */
export function columnOf(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase())?.[1] ?? 'A';
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return column - 1;
}

/** Column index 0 -> "A", 26 -> "AA". */
export function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

const decodeEntities = (value: string): string =>
  value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, code: string) => {
    if (code === 'amp') return '&';
    if (code === 'lt') return '<';
    if (code === 'gt') return '>';
    if (code === 'quot') return '"';
    if (code === 'apos') return "'";
    const value = code.startsWith('#x') || code.startsWith('#X')
      ? parseInt(code.slice(2), 16)
      : parseInt(code.slice(1), 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
  });

/** The shared string table, in order. Cells of type `s` index into this. */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const item of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    // A string can be split into runs (<r><t>…</t></r>) when parts of one cell
    // are formatted differently; joining the <t> elements puts it back.
    const parts = [...item[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1]!));
    out.push(parts.join(''));
  }
  return out;
}

function parseSheet(xml: string, shared: string[]): Row[] {
  const rows: Row[] = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const index = Number(/r="(\d+)"/.exec(rowMatch[1]!)?.[1] ?? rows.length + 1) - 1;
    const cells: Row = [];
    for (const cellMatch of rowMatch[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1]!;
      const body = cellMatch[2] ?? '';
      const reference = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const column = reference ? columnOf(reference) : cells.length;

      let value = '';
      if (type === 's') {
        const at = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '-1');
        value = shared[at] ?? '';
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1]!)).join('');
      } else {
        // Everything else — numbers, dates, booleans, formula results — is
        // taken as its stored value. A formula's cached result is what a
        // spreadsheet shows, and recomputing formulas is not this tool's job.
        value = decodeEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
      }

      while (cells.length < column) cells.push('');
      cells[column] = value;
    }
    while (rows.length < index) rows.push([]);
    rows[index] = cells;
  }
  return rows;
}

export async function readXlsx(source: Uint8Array): Promise<Workbook> {
  const parts = await unzip(source);
  const workbookXml = entry(parts, 'xl/workbook.xml');
  if (!workbookXml) throw new Error('That file is a ZIP but not a spreadsheet: it has no xl/workbook.xml.');

  const decode = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : '');
  const shared = parseSharedStrings(decode(entry(parts, 'xl/sharedStrings.xml')));
  const book = decode(workbookXml);
  const rels = decode(entry(parts, 'xl/_rels/workbook.xml.rels'));

  // Sheet order comes from workbook.xml; the file each one lives in comes from
  // the relationship id, because sheet1.xml is not necessarily the first sheet.
  const targets = new Map<string, string>();
  for (const rel of rels.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = /Id="([^"]+)"/.exec(rel[1]!)?.[1];
    const target = /Target="([^"]+)"/.exec(rel[1]!)?.[1];
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const sheets: Sheet[] = [];
  let fallback = 0;
  for (const sheet of book.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = sheet[1]!;
    const name = decodeEntities(/name="([^"]*)"/.exec(attrs)?.[1] ?? `Sheet${sheets.length + 1}`);
    const relId = /r:id="([^"]+)"/.exec(attrs)?.[1];
    const path = (relId && targets.get(relId)) || `worksheets/sheet${++fallback}.xml`;
    const xml = decode(entry(parts, `xl/${path}`));
    sheets.push({ name, rows: xml ? parseSheet(xml, shared) : [] });
  }

  if (!sheets.length) throw new Error('That spreadsheet has no worksheets in it.');
  return { sheets };
}

// ---------------------------------------------------------------------------
// Writing .xlsx
// ---------------------------------------------------------------------------

/** Whether a cell should be written as a number rather than as text. */
export function isNumeric(value: string): boolean {
  if (!value || /^\s|\s$/.test(value)) return false;
  // Leading zeros are almost always an identifier — a postcode, a phone number,
  // an account — and turning "007" into 7 is the classic spreadsheet betrayal.
  if (/^0\d/.test(value)) return false;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return false;
  return Number.isFinite(Number(value));
}

function sheetXml(rows: Row[]): string {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const value = cell ?? '';
          if (value === '') return '';
          const reference = `${columnName(c)}${r + 1}`;
          return isNumeric(value)
            ? `<c r="${reference}"><v>${escapeXml(value)}</v></c>`
            : `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export async function writeXlsx(book: Workbook): Promise<Uint8Array> {
  const sheets = book.sheets.length ? book.sheets : [{ name: 'Sheet1', rows: [] }];

  const overrides = sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  const sheetTags = sheets
    .map((s, i) => `<sheet name="${escapeXml(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  const relTags = sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');

  const parts: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${overrides}</Types>`),
    },
    {
      name: '_rels/.rels',
      data: bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    },
    {
      name: 'xl/workbook.xml',
      data: bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetTags}</sheets></workbook>`),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relTags}</Relationships>`),
    },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: bytes(sheetXml(sheet.rows)) })),
  ];

  return zip(parts);
}

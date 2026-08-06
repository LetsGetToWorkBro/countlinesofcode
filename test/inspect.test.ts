/**
 * The document leak audit.
 *
 * Two different risks. Missing a real leak makes the tool worse than useless —
 * somebody sends a contract believing it is clean. But crying wolf is nearly as
 * bad: a report that flags every ordinary document trains people to ignore it.
 * So the visibility test is checked from both directions, against numbers
 * measured off a real rendered page.
 */

import { describe, expect, it } from 'vitest';
import {
  FLAT_VARIANCE,
  textBox,
  editingTime,
  inspectOoxml,
  inspectPdf,
  looksHidden,
  osFrom,
  patchStats,
  pdfFeaturesFromBytes,
  timezoneOf,
} from '../src/client/inspect';
import type { ZipEntry } from '../src/client/zip';

const bytes = (s: string) => new TextEncoder().encode(s);
const part = (name: string, body: string): ZipEntry => ({ name, data: bytes(body) });
const titles = (leaks: { title: string }[]) => leaks.map((l) => l.title).join(' | ');

describe('timezoneOf', () => {
  it('reads the offset a PDF date carries', () => {
    expect(timezoneOf("D:20180706091725+03'00'")).toBe('UTC+03:00');
    expect(timezoneOf("D:20140818155917-07'00'")).toBe('UTC-07:00');
  });

  it('recognises a UTC timestamp', () => {
    expect(timezoneOf('D:20240410211143Z')).toBe('UTC');
  });

  it('says nothing when there is no date', () => {
    expect(timezoneOf(undefined)).toBeNull();
    expect(timezoneOf('')).toBeNull();
  });
});

describe('osFrom', () => {
  it('spots an operating system named in a producer string', () => {
    expect(osFrom('Adobe InDesign CC 2014 (Macintosh)')).toBe('macOS');
    expect(osFrom('Microsoft® Word 2016 for Windows')).toBe('Windows');
  });

  it('does not invent one', () => {
    expect(osFrom('pdfTeX-1.40.25')).toBeNull();
    expect(osFrom(undefined)).toBeNull();
  });
});

describe('editingTime', () => {
  it('turns Word’s minutes into something readable', () => {
    expect(editingTime('45')).toBe('45 minutes');
    expect(editingTime('135')).toBe('2 hours 15 minutes');
  });

  it('ignores a missing or nonsense value', () => {
    expect(editingTime(null)).toBeNull();
    expect(editingTime('0')).toBeNull();
  });
});

describe('looksHidden / patchStats', () => {
  /** Build a patch of solid colour, or of alternating light and dark. */
  const solid = (v: number, n = 64) => {
    const px = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < px.length; i += 4) { px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255; }
    return px;
  };
  const striped = (n = 64) => {
    const px = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < px.length; i += 4) {
      const v = (i / 4) % 2 === 0 ? 20 : 235;
      px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
    }
    return px;
  };

  it('calls a solid black box hidden — the classic bad redaction', () => {
    // Measured on a real page: a black box over text scores variance 0.
    const stats = patchStats(solid(0));
    expect(stats.mean).toBeCloseTo(0);
    expect(looksHidden(stats)).toBe(true);
  });

  it('calls white text on white paper hidden', () => {
    const stats = patchStats(solid(255));
    expect(stats.mean).toBeCloseTo(255);
    expect(looksHidden(stats)).toBe(true);
  });

  it('leaves ordinary visible writing alone', () => {
    // Real body text measured ~8,000 variance; the threshold is 120.
    const stats = patchStats(striped());
    expect(stats.variance).toBeGreaterThan(FLAT_VARIANCE * 10);
    expect(looksHidden(stats)).toBe(false);
  });

  it('does not flag a patch that is merely dark but still has writing on it', () => {
    // White text on a dark background is a design choice, not a redaction.
    const px = new Uint8ClampedArray(64 * 4);
    for (let i = 0; i < px.length; i += 4) {
      const v = (i / 4) % 3 === 0 ? 240 : 30;
      px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
    }
    expect(looksHidden(patchStats(px))).toBe(false);
  });

  it('treats an empty patch as unremarkable rather than crashing', () => {
    expect(() => patchStats(new Uint8ClampedArray(0))).not.toThrow();
  });
});

describe('textBox', () => {
  // A page 800 points tall, rendered at 2x.
  const PAGE = 800;

  it('boxes ordinary horizontal text around its baseline', () => {
    // Font size 10 at (100, 700): the glyphs stand above the baseline.
    const box = textBox([10, 0, 0, 10, 100, 700], 50, 10, PAGE, 2);
    expect(box.x).toBe(200);
    expect(box.w).toBe(100);
    // Top of the box is the baseline plus the glyph height, flipped for canvas.
    expect(box.y).toBe(Math.round((PAGE - 710) * 2));
    expect(box.h).toBeGreaterThan(20);
  });

  it('boxes text rotated ninety degrees where it actually is', () => {
    // This is the case that produced 64 false alarms in a real paper: the
    // transform turns the run vertical, so the box must be tall and narrow.
    const box = textBox([0, 7.78, -7.78, 0, 127, 631], 40, 7.78, PAGE, 2);
    expect(box.h).toBeGreaterThan(box.w);
    expect(box.h).toBeGreaterThan(70);
    // It must sit at the transform's origin, not to the right of it.
    expect(Math.abs(box.x - Math.round((127 - 7.78) * 2))).toBeLessThan(6);
  });

  it('boxes upside-down text without collapsing', () => {
    const box = textBox([-10, 0, 0, -10, 300, 400], 50, 10, PAGE, 2);
    expect(box.w).toBeGreaterThan(90);
    expect(box.h).toBeGreaterThan(20);
  });

  it('never returns a zero-sized box, which would sample nothing', () => {
    const box = textBox([0, 0, 0, 0, 10, 10], 0, 0, PAGE, 2);
    expect(box.w).toBeGreaterThanOrEqual(1);
    expect(box.h).toBeGreaterThanOrEqual(1);
  });
});

describe('pdfFeaturesFromBytes', () => {
  it('spots the structures that carry risk', () => {
    const found = pdfFeaturesFromBytes(bytes('%PDF-1.7 /EmbeddedFiles /JavaScript /OCProperties <x:xmpmeta'));
    expect(found.hasEmbeddedFiles).toBe(true);
    expect(found.hasJavaScript).toBe(true);
    expect(found.hasLayers).toBe(true);
    expect(found.hasXmp).toBe(true);
  });

  it('finds external links, without repeating one twice', () => {
    const found = pdfFeaturesFromBytes(bytes('/URI (https://a.example/x) /URI (https://a.example/x) /URI (https://b.example)'));
    expect(found.externalLinks).toEqual(['https://a.example/x', 'https://b.example']);
  });

  it('reports a plain document as plain', () => {
    const found = pdfFeaturesFromBytes(bytes('%PDF-1.4 nothing interesting here'));
    expect(found.hasJavaScript).toBe(false);
    expect(found.hasEmbeddedFiles).toBe(false);
    expect(found.externalLinks).toEqual([]);
  });
});

describe('inspectPdf', () => {
  it('leads with text that can be copied but not seen', () => {
    const report = inspectPdf({}, { hiddenText: [{ page: 0, text: 'SETTLEMENT IS 4.2 MILLION' }] });
    expect(report.leaks[0]!.severity).toBe('high');
    expect(report.leaks[0]!.title).toMatch(/cannot see/i);
    expect(report.leaks[0]!.detail).toContain('SETTLEMENT');
  });

  it('says so plainly when nothing is hidden, but does not over-promise', () => {
    const report = inspectPdf({}, { hiddenText: [], pages: 3, pagesChecked: 3 });
    const line = report.clean.find((c) => /solid box|white-on-white/i.test(c));
    expect(line).toBeTruthy();
    // The all-clear must disclaim the textured-cover blind spot rather than
    // claiming nothing at all can be hiding.
    expect(line).toMatch(/photographic|patterned/i);
  });

  it('discloses an incomplete scan, and still keeps the textured-cover caveat', () => {
    const report = inspectPdf({}, { hiddenText: [], pages: 30, pagesChecked: 20 });
    // The scope of the scan is disclosed: 20 of 30 pages.
    const scope = report.clean.find((c) => /first 20 of 30 page/i.test(c));
    expect(scope).toBeTruthy();
    expect(scope).toMatch(/not checked/i);
    // The textured-cover caveat is NOT dropped just because the scan was partial;
    // both facts must be stated.
    const caveat = report.clean.find((c) => /photographic|patterned/i.test(c));
    expect(caveat).toBeTruthy();
  });

  it('discloses an incomplete scan even when hidden text was found on a checked page', () => {
    const report = inspectPdf({}, { hiddenText: [{ page: 2, text: 'REDACTED SALARY' }], pages: 30, pagesChecked: 20 });
    // The hidden-text leak leads, but the report must not read as a full scan:
    // the other ten pages were never examined.
    expect(report.leaks[0]!.title).toMatch(/cannot see/i);
    const scope = report.clean.find((c) => /first 20 of 30 page/i.test(c));
    expect(scope).toBeTruthy();
  });

  it('reports the author, and treats it as serious', () => {
    const report = inspectPdf({ Author: 'R. Whitfield' }, {});
    const leak = report.leaks.find((l) => /author/i.test(l.title));
    expect(leak?.severity).toBe('high');
    expect(leak?.detail).toContain('R. Whitfield');
  });

  it('calls out the operating system when the producer names one', () => {
    const report = inspectPdf({ Creator: 'Adobe InDesign CC 2014 (Macintosh)' }, {});
    expect(titles(report.leaks)).toMatch(/macOS/);
  });

  it('calls out the timezone, because it says roughly where they were', () => {
    const report = inspectPdf({ CreationDate: "D:20180706091725+03'00'" }, {});
    expect(titles(report.leaks)).toMatch(/UTC\+03:00/);
  });

  it('does not claim a timezone leak for a UTC timestamp', () => {
    const report = inspectPdf({ CreationDate: 'D:20240410211143Z' }, {});
    expect(titles(report.leaks)).not.toMatch(/timezone/i);
  });

  it('finds nothing to report in a genuinely bare PDF', () => {
    const report = inspectPdf({}, { hiddenText: [] });
    expect(report.leaks).toHaveLength(0);
    expect(report.clean.length).toBeGreaterThan(2);
  });
});

describe('inspectOoxml', () => {
  const core = (body: string) => part('docProps/core.xml', `<cp:coreProperties>${body}</cp:coreProperties>`);

  it('names whoever wrote and last saved it', () => {
    const report = inspectOoxml(
      [core('<dc:creator>Alice Doe</dc:creator><cp:lastModifiedBy>Bob Roe</cp:lastModifiedBy>')],
      'docx',
    );
    const leak = report.leaks.find((l) => /names of the people/i.test(l.title));
    expect(leak?.severity).toBe('high');
    expect(leak?.detail).toContain('Alice Doe');
    expect(leak?.detail).toContain('Bob Roe');
  });

  it('finds tracked changes and who made them', () => {
    const document = part(
      'word/document.xml',
      '<w:p><w:ins w:author="Legal Review"><w:r><w:t>added</w:t></w:r></w:ins>' +
        '<w:del w:author="Legal Review"><w:r><w:delText>the old number</w:delText></w:r></w:del></w:p>',
    );
    const report = inspectOoxml([document], 'docx');
    const leak = report.leaks.find((l) => /tracked change/i.test(l.title));
    expect(leak?.severity).toBe('high');
    expect(leak?.detail).toContain('Legal Review');
  });

  it('finds comments and their authors', () => {
    const report = inspectOoxml(
      [part('word/document.xml', '<w:p/>'), part('word/comments.xml', '<w:comment w:author="Dana"><w:p/></w:comment>')],
      'docx',
    );
    expect(titles(report.leaks)).toMatch(/comment/i);
    expect(report.leaks.find((l) => /comment/i.test(l.title))?.detail).toContain('Dana');
  });

  it('finds the company name Office fills in by itself', () => {
    const report = inspectOoxml([part('docProps/app.xml', '<Properties><Company>Initech Ltd</Company></Properties>')], 'docx');
    expect(report.leaks.find((l) => /company/i.test(l.title))?.detail).toContain('Initech Ltd');
  });

  it('finds hidden text', () => {
    const report = inspectOoxml([part('word/document.xml', '<w:r><w:rPr><w:vanish/></w:rPr><w:t>secret</w:t></w:r>')], 'docx');
    expect(titles(report.leaks)).toMatch(/hidden/i);
  });

  it('does not flag a run that explicitly un-hides itself', () => {
    // <w:vanish w:val="false"/> turns hidden OFF (a run overriding a style);
    // the text displays normally and must not be reported as hidden.
    const report = inspectOoxml([part('word/document.xml', '<w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t>Visible</w:t></w:r>')], 'docx');
    expect(titles(report.leaks)).not.toMatch(/hidden/i);
  });

  it('counts moved passages as tracked changes', () => {
    // Text that was only rearranged (w:moveFrom/w:moveTo) is still a tracked
    // change; the old count of ins+del alone gave a false "no tracked changes".
    const report = inspectOoxml(
      [part('word/document.xml', '<w:p><w:moveFrom w:author="Editor"><w:r><w:t>moved bit</w:t></w:r></w:moveFrom></w:p>')],
      'docx',
    );
    const leak = report.leaks.find((l) => /tracked change/i.test(l.title));
    expect(leak?.severity).toBe('high');
    expect(leak?.detail).toMatch(/moved passage/i);
    expect(report.clean.some((c) => /no tracked changes/i.test(c))).toBe(false);
  });

  it('finds a path from the author’s own machine', () => {
    const report = inspectOoxml(
      [part('word/_rels/document.xml.rels', '<Relationship Target="C:\\Users\\jsmith\\Clients\\Acme\\draft.docx"/>')],
      'docx',
    );
    const leak = report.leaks.find((l) => /file path/i.test(l.title));
    expect(leak?.severity).toBe('high');
    expect(leak?.detail).toContain('jsmith');
  });

  it('finds a hidden worksheet in a spreadsheet', () => {
    const report = inspectOoxml(
      [
        part('xl/worksheets/sheet1.xml', '<worksheet/>'),
        part('xl/worksheets/sheet2.xml', '<worksheet/>'),
        part('xl/workbook.xml', '<workbook><sheets><sheet name="Public"/><sheet name="Costs" state="hidden"/></sheets></workbook>'),
      ],
      'xlsx',
    );
    const leak = report.leaks.find((l) => /hidden worksheet/i.test(l.title));
    expect(leak?.severity).toBe('high');
  });

  it('reports a clean document as clean, rather than reaching', () => {
    const report = inspectOoxml([part('word/document.xml', '<w:p><w:r><w:t>ordinary</w:t></w:r></w:p>')], 'docx');
    expect(report.leaks).toHaveLength(0);
    expect(report.clean.length).toBeGreaterThan(2);
  });
});

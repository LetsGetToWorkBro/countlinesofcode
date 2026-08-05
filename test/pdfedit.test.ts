/**
 * The sign/redact engine's pure parts.
 *
 * The coordinate maths matters because a signature landing in the wrong place
 * is obvious but a *redaction* landing in the wrong place is not — it looks
 * fine and leaves the secret visible. The redaction rules matter because the
 * whole feature rests on which pages get flattened.
 *
 * The surgical delete is covered end to end below against a real document,
 * because it is the one operation here that destroys something on purpose.
 * Flattening needs a canvas, so that half is exercised in a browser.
 */

import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  MIN_REDACTION_POINTS,
  applyEdits,
  buildPdfFromPages,
  canvasRectToPdf,
  canvasToPdf,
  imageFormat,
  loadForEditing,
  pageTextOps,
  pagesNeedingRaster,
  placeForRotation,
  readContentStream,
  readFormFields,
  usefulRedactions,
  type Edit,
} from '../src/client/pdfedit';

/** An A4 page rendered at 2x: 595x842 points becomes 1190x1684 pixels. */
const A4_AT_2X = { width: 1190, height: 1684, scale: 2 };

type Rect = { x: number; y: number; width: number; height: number };

const redact = (page: number, rect: Partial<Rect> = {}): Edit => ({
  kind: 'redact',
  page,
  rect: { x: 10, y: 10, width: 100, height: 20, ...rect },
});

describe('canvasToPdf', () => {
  it('flips the y axis, because canvases count down and PDFs count up', () => {
    // Top-left of the canvas is the top-left of the page: y = page height.
    expect(canvasToPdf({ x: 0, y: 0 }, A4_AT_2X)).toEqual({ x: 0, y: 842 });
    // Bottom-left of the canvas is the PDF origin.
    expect(canvasToPdf({ x: 0, y: 1684 }, A4_AT_2X)).toEqual({ x: 0, y: 0 });
  });

  it('undoes the render scale', () => {
    expect(canvasToPdf({ x: 1190, y: 842 }, A4_AT_2X)).toEqual({ x: 595, y: 421 });
  });

  it('is identity-ish at scale 1', () => {
    const vp = { width: 595, height: 842, scale: 1 };
    expect(canvasToPdf({ x: 100, y: 742 }, vp)).toEqual({ x: 100, y: 100 });
  });

  it('round-trips a click through the middle of the page', () => {
    const middle = canvasToPdf({ x: 595, y: 842 }, A4_AT_2X);
    expect(middle.x).toBeCloseTo(297.5);
    expect(middle.y).toBeCloseTo(421);
  });
});

describe('canvasRectToPdf', () => {
  it('normalises a box dragged in any direction', () => {
    const downRight = canvasRectToPdf({ x: 100, y: 100 }, { x: 300, y: 200 }, A4_AT_2X);
    const upLeft = canvasRectToPdf({ x: 300, y: 200 }, { x: 100, y: 100 }, A4_AT_2X);
    expect(downRight).toEqual(upLeft);
    expect(downRight.width).toBeGreaterThan(0);
    expect(downRight.height).toBeGreaterThan(0);
  });

  it('places the rect by its bottom-left corner, as PDF expects', () => {
    // Dragging from y=100 to y=200 on the canvas covers the *higher* part of
    // the page, so the PDF y is measured from the lower canvas edge.
    const rect = canvasRectToPdf({ x: 100, y: 100 }, { x: 300, y: 200 }, A4_AT_2X);
    expect(rect.x).toBe(50);
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(50);
    expect(rect.y).toBe((1684 - 200) / 2);
  });

  it('gives a zero-size rect for a click with no drag', () => {
    const rect = canvasRectToPdf({ x: 50, y: 50 }, { x: 50, y: 50 }, A4_AT_2X);
    expect(rect.width).toBe(0);
    expect(rect.height).toBe(0);
  });
});

describe('usefulRedactions', () => {
  it('drops boxes too small to be a deliberate selection', () => {
    const tiny = redact(0, { width: MIN_REDACTION_POINTS - 1, height: 40 });
    const thin = redact(0, { height: MIN_REDACTION_POINTS - 1 });
    const real = redact(0);
    expect(usefulRedactions([tiny, thin, real])).toEqual([real]);
  });

  it('ignores text and signature edits entirely', () => {
    const edits: Edit[] = [
      { kind: 'text', page: 0, at: { x: 1, y: 1 }, value: 'hi', size: 12 },
      { kind: 'stamp', page: 0, at: { x: 1, y: 1 }, bytes: new Uint8Array([1]), width: 100 },
      redact(0),
    ];
    expect(usefulRedactions(edits)).toHaveLength(1);
  });
});

describe('pagesNeedingRaster', () => {
  it('names every page carrying a redaction, once', () => {
    const pages = pagesNeedingRaster([redact(3), redact(0), redact(3)]);
    expect([...pages].sort()).toEqual([0, 3]);
  });

  it('is empty when nothing was redacted, so no page gets flattened', () => {
    // This is the property that keeps text selectable on untouched pages.
    const edits: Edit[] = [
      { kind: 'text', page: 0, at: { x: 1, y: 1 }, value: 'hi', size: 12 },
      { kind: 'stamp', page: 2, at: { x: 1, y: 1 }, bytes: new Uint8Array([1]), width: 80 },
    ];
    expect(pagesNeedingRaster(edits).size).toBe(0);
  });

  it('flattens only the pages asked for, never the whole document', () => {
    const pages = pagesNeedingRaster([redact(5)]);
    expect(pages.has(5)).toBe(true);
    expect(pages.has(4)).toBe(false);
    expect(pages.size).toBe(1);
  });
});

/**
 * Deleting text, against a real PDF.
 *
 * This is the only operation here that removes something irreversibly, and the
 * failure that matters is not "nothing happened" — it is "the wrong line went",
 * which looks like success. So each case checks both halves: the target is gone
 * *and* its neighbours are still there.
 */
describe('applyEdits: surgical removal', () => {
  /** Three lines on page one, one line on page two, at known positions. */
  async function fixture(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const first = doc.addPage([612, 792]);
    first.drawText('PUBLIC HEADING', { x: 60, y: 760, size: 20, font });
    first.drawText('SUPERSECRETCODEWORD', { x: 60, y: 700, size: 20, font });
    first.drawText('KEEP THIS LINE', { x: 60, y: 200, size: 14, font });
    doc.addPage([612, 792]).drawText('SECOND PAGE', { x: 60, y: 700, size: 14, font });
    return doc.save();
  }

  /**
   * A page's content stream, with hex strings turned back into readable text.
   *
   * pdf-lib writes show-text operands as `<50554243…>` rather than `(PUBLIC…)`,
   * so asserting on the raw stream would silently pass no matter what it says.
   */
  async function streamOf(bytes: Uint8Array, page: number): Promise<string> {
    const doc = await loadForEditing(bytes);
    const raw = new TextDecoder('latin1').decode(readContentStream(doc, page));
    return raw.replace(/<([0-9A-Fa-f]+)>/g, (_whole, hex: string) => {
      let out = '';
      for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      return `(${out})`;
    });
  }

  it('finds one operator per line, in the order they were drawn', async () => {
    const ops = pageTextOps(await loadForEditing(await fixture()), 0);
    expect(ops).toHaveLength(3);
    expect(ops.map((o) => [Math.round(o.x), Math.round(o.y), Math.round(o.size)])).toEqual([
      [60, 760, 20],
      [60, 700, 20],
      [60, 200, 14],
    ]);
  });

  it('removes the targeted line from the file and leaves the others', async () => {
    const source = await fixture();
    const out = await applyEdits(source, [], [], [{ page: 0, opIndices: [1] }]);
    const page1 = await streamOf(out, 0);

    expect(page1).not.toContain('SUPERSECRETCODEWORD');
    expect(page1).toContain('PUBLIC HEADING');
    expect(page1).toContain('KEEP THIS LINE');
  });

  it('leaves the other pages completely alone', async () => {
    const out = await applyEdits(await fixture(), [], [], [{ page: 0, opIndices: [1] }]);
    expect(await streamOf(out, 1)).toContain('SECOND PAGE');
  });

  it('keeps the survivors as real text, not a picture', async () => {
    // If this ever starts failing, something has begun rasterising pages that
    // were only edited — which is exactly what this tool exists not to do.
    const out = await applyEdits(await fixture(), [], [], [{ page: 0, opIndices: [1] }]);
    const page1 = await streamOf(out, 0);
    expect(page1).toContain('Tj');
    expect(page1).not.toContain('/Image');
  });

  it('removes several lines at once', async () => {
    const out = await applyEdits(await fixture(), [], [], [{ page: 0, opIndices: [0, 2] }]);
    const page1 = await streamOf(out, 0);
    expect(page1).not.toContain('PUBLIC HEADING');
    expect(page1).not.toContain('KEEP THIS LINE');
    expect(page1).toContain('SUPERSECRETCODEWORD');
  });

  it('changes nothing when the removal list is empty', async () => {
    const out = await applyEdits(await fixture(), [], [], []);
    const page1 = await streamOf(out, 0);
    expect(page1).toContain('SUPERSECRETCODEWORD');
    expect(page1).toContain('PUBLIC HEADING');
  });

  it('writes added text onto a page it also cut', async () => {
    const edits: Edit[] = [
      { kind: 'text', page: 0, at: { x: 60, y: 700 }, value: 'REDACTED BY REQUEST', size: 20 },
    ];
    const out = await applyEdits(await fixture(), edits, [], [{ page: 0, opIndices: [1] }]);
    const page1 = await streamOf(out, 0);
    expect(page1).not.toContain('SUPERSECRETCODEWORD');
    expect(page1).toContain('REDACTED BY REQUEST');
  });
});

/**
 * Putting a picture in.
 *
 * The format is sniffed from the bytes rather than trusted from the file name
 * or the browser's reported MIME type, because a PDF that embeds mislabelled
 * bytes does not fail — it opens showing a blank rectangle where the photo
 * should be, which nobody notices until it is printed.
 */
describe('imageFormat', () => {
  const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  it('recognises a PNG', () => {
    expect(imageFormat(PNG_MAGIC)).toBe('png');
  });

  it('recognises a JPEG, whatever flavour of header it carries', () => {
    expect(imageFormat(JPEG_MAGIC)).toBe('jpg');
    // Exif rather than JFIF: different fourth byte, same file type.
    expect(imageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0]))).toBe('jpg');
  });

  it('refuses anything else rather than guessing', () => {
    expect(imageFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull(); // GIF
    expect(imageFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull(); // WebP/RIFF
    expect(imageFormat(new Uint8Array(0))).toBeNull();
    expect(imageFormat(new Uint8Array([0x89, 0x50]))).toBeNull(); // truncated PNG
  });
});

describe('applyEdits: pictures', () => {
  /** A real 2x2 PNG, so pdf-lib actually decodes it. */
  const PNG_2X2 = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8DAwMDAwMDEAAWEG' +
        'ABBJgHl7fWlwQAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  );

  async function onePage(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    doc.addPage([300, 300]);
    return doc.save();
  }

  const place = (page: number, width = 100): Edit => ({
    kind: 'stamp',
    page,
    at: { x: 20, y: 200 },
    bytes: PNG_2X2,
    width,
  });

  it('puts a picture into the page', async () => {
    const out = await applyEdits(await onePage(), [place(0)], []);
    const doc = await loadForEditing(out);
    expect(doc.getPageCount()).toBe(2);
    // An XObject reference is how a placed image shows up in the stream.
    const stream = new TextDecoder('latin1').decode(readContentStream(doc, 0));
    expect(stream).toContain('Do');
  });

  /** How many image XObjects the file actually carries. */
  function imageCount(doc: PDFDocument): number {
    let found = 0;
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      const dict = (object as { dict?: { get(name: PDFName): unknown } }).dict;
      if (dict && String(dict.get(PDFName.of('Subtype'))) === '/Image') found++;
    }
    return found;
  }

  it('embeds one copy however many times it is placed', async () => {
    // A logo stamped through a long document should not put a copy of itself
    // in the file per page. Compared against a single placement rather than
    // against 1, because a PNG with transparency embeds as two objects — the
    // image and its soft mask — and file size is too blunt to tell either way.
    const once = await applyEdits(await onePage(), [place(0)], []);
    const many = await applyEdits(
      await onePage(),
      [place(0), place(0, 50), place(1), place(1, 70)],
      [],
    );
    expect(imageCount(await loadForEditing(many))).toBe(imageCount(await loadForEditing(once)));
  });

  it('really does place it four times, so the count above means something', async () => {
    const many = await applyEdits(await onePage(), [place(0), place(0, 50), place(1), place(1, 70)], []);
    const doc = await loadForEditing(many);
    const draws = (page: number) =>
      (new TextDecoder('latin1').decode(readContentStream(doc, page)).match(/\bDo\b/g) || []).length;
    expect(draws(0)).toBe(2);
    expect(draws(1)).toBe(2);
  });

  it('refuses bytes that are not a picture a PDF can hold', async () => {
    const bad: Edit = { kind: 'stamp', page: 0, at: { x: 1, y: 1 }, bytes: new Uint8Array([1, 2, 3]), width: 50 };
    await expect(applyEdits(await onePage(), [bad], [])).rejects.toThrow(/PNG or a JPEG/);
  });

  it('leaves a page nothing was placed on unchanged', async () => {
    const out = await applyEdits(await onePage(), [place(0)], []);
    const doc = await loadForEditing(out);
    expect(new TextDecoder('latin1').decode(readContentStream(doc, 1))).not.toContain('Do');
  });
});

/**
 * Filling a real form.
 *
 * The point of this over a floating text box is that the values land exactly
 * where the form's own fields are, and come out as normal page content that
 * shows the same in every reader. So the tests read the flattened text back and
 * check the answers are actually there.
 */
describe('AcroForm fields', () => {
  async function formDoc(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const p1 = doc.addPage([612, 792]);
    const p2 = doc.addPage([612, 792]);
    const form = doc.getForm();

    const name = form.createTextField('applicant.name');
    name.addToPage(p1, { x: 140, y: 695, width: 200, height: 18 });
    const agree = form.createCheckBox('applicant.agree');
    agree.addToPage(p1, { x: 60, y: 650, width: 14, height: 14 });
    const colour = form.createRadioGroup('applicant.colour');
    colour.addOptionToPage('red', p1, { x: 60, y: 610, width: 14, height: 14 });
    colour.addOptionToPage('blue', p1, { x: 160, y: 610, width: 14, height: 14 });
    const country = form.createDropdown('applicant.country');
    country.addOptions(['UK', 'US', 'FR']);
    country.addToPage(p2, { x: 60, y: 700, width: 120, height: 18 });
    return doc.save();
  }

  /**
   * The visible text of a page, read the way a viewer reads it.
   *
   * pdf-lib flattens a field by drawing its appearance as a Form XObject and
   * referencing it with `Do`, so the value is not inline in the page's own
   * content stream — scraping the stream finds nothing. pdf.js follows the
   * XObject, which is the whole point: it sees what a person would see.
   */
  async function visibleText(bytes: Uint8Array, page: number): Promise<string> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: bytes.slice(),
      standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/',
    }).promise;
    const content = await (await doc.getPage(page + 1)).getTextContent();
    return content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
  }

  it('reports no fields for an ordinary PDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    expect(readFormFields(await loadForEditing(await doc.save()))).toEqual([]);
  });

  it('finds every field, on the right page, with its type', async () => {
    const fields = readFormFields(await loadForEditing(await formDoc()));
    const byName = (n: string) => fields.filter((f) => f.name === n);

    expect(byName('applicant.name')[0]).toMatchObject({ kind: 'text', page: 0 });
    expect(byName('applicant.agree')[0]).toMatchObject({ kind: 'checkbox', page: 0 });
    expect(byName('applicant.country')[0]).toMatchObject({ kind: 'dropdown', page: 1, options: ['UK', 'US', 'FR'] });
    // A radio group appears once per option, each carrying its own choice.
    const radios = byName('applicant.colour');
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.radioOption)).toEqual(['red', 'blue']);
  });

  it('places each field where the form drew it', async () => {
    const name = readFormFields(await loadForEditing(await formDoc())).find((f) => f.name === 'applicant.name')!;
    // pdf-lib's widget rectangle carries the field border, so the reported
    // box is about a point larger than the one asked for; near is what matters.
    expect(Math.abs(name.rect.x - 140)).toBeLessThanOrEqual(1);
    expect(Math.abs(name.rect.y - 695)).toBeLessThanOrEqual(1);
    expect(Math.abs(name.rect.width - 200)).toBeLessThanOrEqual(2);
  });

  it('writes the answers in and flattens them to page content', async () => {
    const out = await applyEdits(await formDoc(), [], [], [], [
      { name: 'applicant.name', kind: 'text', value: 'Jane Q. Doe' },
      { name: 'applicant.agree', kind: 'checkbox', value: 'on' },
      { name: 'applicant.colour', kind: 'radio', value: 'blue' },
      { name: 'applicant.country', kind: 'dropdown', value: 'FR' },
    ]);

    // The interactive form is gone; the answers are baked into the pages.
    expect(readFormFields(await loadForEditing(out))).toEqual([]);
    expect(await visibleText(out, 0)).toContain('Jane Q. Doe');
    expect(await visibleText(out, 1)).toContain('FR');
  });

  it('ignores a value for a field that is not there rather than throwing', async () => {
    const out = await applyEdits(await formDoc(), [], [], [], [
      { name: 'no.such.field', kind: 'text', value: 'x' },
      { name: 'applicant.name', kind: 'text', value: 'Only Me' },
    ]);
    expect(await visibleText(out, 0)).toContain('Only Me');
  });

  it('flattens the form on save even when no answers were typed', async () => {
    // The pages are copied into a fresh document, which an interactive AcroForm
    // does not survive — so saving a form always flattens it, leaving the page
    // looking the same but no longer fillable. Better that than dead widgets.
    const out = await applyEdits(await formDoc(), [], [], [], []);
    expect(readFormFields(await loadForEditing(out))).toEqual([]);
  });
});

/**
 * Rebuilding a PDF from rendered pages (the unlock/shrink engine).
 *
 * The output must be a fresh, unencrypted document, and the optional invisible
 * word layer must actually be there — that is what keeps a rebuilt page
 * selectable rather than a flat picture.
 */
describe('buildPdfFromPages', () => {
  const PNG_2X2 = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8DAwMDAwMDEAAWEG' +
        'ABBJgHl7fWlwQAAAABJRU5ErkJggg==',
    ),
    (c) => c.charCodeAt(0),
  );

  async function visibleText(bytes: Uint8Array, page: number): Promise<string> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: bytes.slice(),
      standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/',
    }).promise;
    const content = await (await doc.getPage(page + 1)).getTextContent();
    return content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
  }

  it('makes a document with one page per input, at the given sizes', async () => {
    const out = await buildPdfFromPages([
      { width: 200, height: 300, png: PNG_2X2 },
      { width: 400, height: 100, png: PNG_2X2 },
    ]);
    const doc = await loadForEditing(out);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toMatchObject({ width: 200, height: 300 });
    expect(doc.getPage(1).getSize()).toMatchObject({ width: 400, height: 100 });
  });

  it('is not encrypted, whatever the source was', async () => {
    // The whole point of unlock: a document built from scratch has no security
    // handler, so it opens with no password and no restrictions.
    const out = await buildPdfFromPages([{ width: 200, height: 200, png: PNG_2X2 }]);
    await expect(loadForEditing(out)).resolves.toBeDefined();
    expect(new TextDecoder('latin1').decode(out)).not.toContain('/Encrypt');
  });

  it('lays the words back as selectable text', async () => {
    const out = await buildPdfFromPages([
      {
        width: 300,
        height: 300,
        png: PNG_2X2,
        words: [
          { str: 'Selectable', x: 20, y: 250, size: 12 },
          { str: 'again', x: 20, y: 230, size: 12 },
        ],
      },
    ]);
    expect(await visibleText(out, 0)).toContain('Selectable');
  });

  it('skips a word a standard font cannot encode without dropping the page', async () => {
    const out = await buildPdfFromPages([
      { width: 300, height: 300, png: PNG_2X2, words: [{ str: '中文', x: 10, y: 10, size: 12 }] },
    ]);
    // The page still builds; the un-encodable word is simply absent.
    expect((await loadForEditing(out)).getPageCount()).toBe(1);
  });
});

describe('placeForRotation (finding: rotated pages misplace signatures)', () => {
  // The viewer maps a native point to display space by rotating the page
  // clockwise by /Rotate. placeForRotation must invert that for the anchor, so
  // round-tripping through the forward mapping returns the original display
  // point, for every rotation.
  const forward = (r: number, nw: number, nh: number, nx: number, ny: number): [number, number] => {
    switch (((r % 360) + 360) % 360) {
      case 90: return [ny, nw - nx];
      case 180: return [nw - nx, nh - ny];
      case 270: return [nh - ny, nx];
      default: return [nx, ny];
    }
  };

  const NW = 612;
  const NH = 792;
  const points: [number, number][] = [[0, 0], [100, 700], [612, 792], [300, 150]];

  for (const rotation of [0, 90, 180, 270]) {
    it(`inverts the display↔native mapping at /Rotate ${rotation}`, () => {
      for (const [dx, dy] of points) {
        const { x, y, angle } = placeForRotation(rotation, NW, NH, dx, dy);
        const [bx, by] = forward(rotation, NW, NH, x, y);
        expect(bx).toBeCloseTo(dx, 6);
        expect(by).toBeCloseTo(dy, 6);
        // The draw is counter-rotated so it reads upright once the viewer rotates.
        expect(angle).toBe(((rotation % 360) + 360) % 360);
      }
    });
  }

  it('is the identity on an unrotated page', () => {
    expect(placeForRotation(0, NW, NH, 100, 700)).toEqual({ x: 100, y: 700, angle: 0 });
  });

  it('normalises odd rotation values', () => {
    expect(placeForRotation(-90, NW, NH, 100, 700).angle).toBe(270);
    expect(placeForRotation(450, NW, NH, 100, 700).angle).toBe(90);
  });
});

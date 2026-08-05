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
  canvasRectToPdf,
  canvasToPdf,
  imageFormat,
  loadForEditing,
  pageTextOps,
  pagesNeedingRaster,
  readContentStream,
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

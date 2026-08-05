/**
 * The sign/redact engine's pure parts.
 *
 * The coordinate maths matters because a signature landing in the wrong place
 * is obvious but a *redaction* landing in the wrong place is not — it looks
 * fine and leaves the secret visible. The redaction rules matter because the
 * whole feature rests on which pages get flattened.
 *
 * applyEdits itself needs a real document, so it is exercised in a browser.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_REDACTION_POINTS,
  canvasRectToPdf,
  canvasToPdf,
  pagesNeedingRaster,
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
      { kind: 'stamp', page: 0, at: { x: 1, y: 1 }, png: new Uint8Array([1]), width: 100 },
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
      { kind: 'stamp', page: 2, at: { x: 1, y: 1 }, png: new Uint8Array([1]), width: 80 },
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

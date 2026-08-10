/**
 * The ReadableStream async-iteration shim.
 *
 * pdf.js 6 reads a page's text with `for await (const chunk of stream)`. That
 * calls `stream[Symbol.asyncIterator]()`, which Safari only shipped in 18.4.
 * Safari 17.4 through 18.3 have Promise.withResolvers (so pdf.js loads) but not
 * this, so the converter died on the first page with the JavaScriptCore wording
 * of the same failure Chromium words as "not async iterable":
 *
 *     undefined is not a function (near '...t of e...')
 *
 * These tests pin the shim's behaviour and that every page which runs pdf.js or
 * mediabunny loads it before the engine that needs it.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SHIM = readFileSync(new URL('../public/pdf-compat.js', import.meta.url), 'utf8');

/** Run the shim's IIFE against the current realm. */
function installShim(): void {
  // The file is a self-invoking function; evaluating it installs the method.
  // eslint-disable-next-line no-eval
  (0, eval)(SHIM);
}

describe('pdf-compat shim', () => {
  const proto = ReadableStream.prototype as unknown as Record<symbol | string, unknown>;
  let original: unknown;
  let originalValues: unknown;

  beforeEach(() => {
    original = proto[Symbol.asyncIterator];
    originalValues = (proto as Record<string, unknown>).values;
  });

  afterEach(() => {
    if (original === undefined) delete proto[Symbol.asyncIterator];
    else proto[Symbol.asyncIterator] = original;
    if (originalValues === undefined) delete (proto as Record<string, unknown>).values;
    else (proto as Record<string, unknown>).values = originalValues;
  });

  function makeStream(chunks: string[]): ReadableStream<string> {
    return new ReadableStream<string>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  it('does nothing where the browser already has the iterator', () => {
    // A modern realm (this Node) already defines it; the shim must not clobber a
    // working implementation.
    const before = proto[Symbol.asyncIterator];
    if (typeof before !== 'function') return; // nothing to protect on this runtime
    installShim();
    expect(proto[Symbol.asyncIterator]).toBe(before);
  });

  it('restores async iteration when the browser lacks it', async () => {
    // Emulate Safari 17.4-18.3: no async iterator on the stream.
    delete proto[Symbol.asyncIterator];
    delete (proto as Record<string, unknown>).values;
    expect(proto[Symbol.asyncIterator]).toBeUndefined();

    installShim();
    expect(typeof proto[Symbol.asyncIterator]).toBe('function');

    const seen: string[] = [];
    for await (const chunk of makeStream(['a', 'b', 'c'])) seen.push(chunk);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('releases the reader when iteration stops early', async () => {
    delete proto[Symbol.asyncIterator];
    delete (proto as Record<string, unknown>).values;
    installShim();

    const stream = makeStream(['a', 'b', 'c']);
    for await (const chunk of stream) {
      expect(chunk).toBe('a');
      break; // triggers the iterator's return()
    }
    // A released lock means the stream can be locked again without throwing.
    expect(() => stream.getReader()).not.toThrow();
  });
});

describe('pages that run pdf.js or mediabunny load the shim first', () => {
  // convert/shrink/unlock/sign/inspect read PDFs; audio/video iterate media
  // streams. Each must pull in the shim before the engine that needs it.
  const pages: Record<string, string> = {
    'convert.html': 'convert-page.js',
    'shrink.html': 'pdfrender.js',
    'unlock.html': 'pdfrender.js',
    'sign.html': 'sign.js',
    'inspect.html': 'inspect-page.js',
    'audio.html': 'audio-page.js',
    'video.html': 'video-page.js',
  };

  for (const [page, engine] of Object.entries(pages)) {
    it(`${page} loads pdf-compat.js before ${engine}`, () => {
      const html = readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8');
      const shimAt = html.indexOf('/pdf-compat.js');
      const engineAt = html.indexOf(`/${engine}`);
      expect(shimAt, 'pdf-compat.js is not on the page').toBeGreaterThan(-1);
      expect(engineAt, `${engine} is not on the page`).toBeGreaterThan(-1);
      expect(shimAt, 'pdf-compat.js must come before the engine').toBeLessThan(engineAt);
    });
  }
});

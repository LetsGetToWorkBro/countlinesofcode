/**
 * The other archive formats, bundled to public/archive.js.
 *
 * The ZIP half of this tool is ours: src/client/zip.ts, written for the Word
 * and EPUB converters, small and reading a format we understand end to end.
 * RAR and 7z are not that. Both are large, both have several generations, and
 * a half-implementation of either is worse than none: it opens the easy
 * archives and quietly mangles the rest.
 *
 * So this is libarchive, the BSD-licensed C library behind bsdtar and most of
 * the extract buttons on a Linux desktop, compiled to WebAssembly. It brings
 * its own readers for RAR (both the old format and RAR5), 7z, tar, cpio, ISO,
 * CAB and the rest. Note "its own": no RARLAB code is involved here, which
 * matters, because the reference unrar source is published under a licence
 * that forbids using it to build a compressor and this site is not going
 * anywhere near that question.
 *
 * WHAT THIS CANNOT DO, said plainly, because a tool that hides its limits is
 * worse than one that has them:
 *
 *   Making a RAR is impossible, here or anywhere outside WinRAR. The format
 *   is proprietary and there has never been a free compressor for it. Nothing
 *   about this page changes that.
 *
 *   Making a 7z is possible in principle and not done here: libarchive can
 *   write one, but the WebAssembly build this uses exposes the reader only.
 *   Reading is the thing people arrive with an archive wanting.
 *
 * So: opens zip, 7z, rar, tar and friends; writes zip. The page says so.
 *
 * It loads on demand and only when a non-ZIP turns up, because it is 600KB of
 * WebAssembly and most archives are ZIPs the other engine reads in seven.
 */

import { ArchiveReader, libarchiveWasm } from 'libarchive-wasm';
import { formatLabel, needsLibarchive, sniffFormat, type ArchiveFormat } from './archive-format';
import type { ZipListing } from './zip';

export { formatLabel, needsLibarchive, sniffFormat, type ArchiveFormat };

/** Seconds since the epoch as libarchive reports them, in milliseconds. */
function modifiedMs(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

let wasm: unknown = null;

/** Bring the library up once, and only once. */
async function ready(): Promise<unknown> {
  if (wasm) return wasm;
  /* In a browser, the vendored copy, hash-pinned like every other binary
     here. Under the tests there is no document root to be relative to, so
     the loader is left to find it beside its own glue in node_modules:
     overriding the path there would only break the thing being tested. */
  const inBrowser = typeof globalThis !== 'undefined' &&
    (globalThis as { document?: unknown }).document !== undefined;
  wasm = await libarchiveWasm(
    inBrowser
      ? ({ locateFile: (path: string) =>
            (path.endsWith('.wasm') ? '/vendor/libarchive/libarchive.wasm' : path) } as never)
      : (undefined as never),
  );
  return wasm;
}

/**
 * List an archive as the ZIP engine would, so the page draws one table.
 *
 * libarchive gives a stream rather than an index: the only way to know how
 * big an entry is, in several of these formats, is to read it. Sizes it does
 * not know come back as 0 and are reported as such rather than guessed at.
 */
export async function listArchive(bytes: Uint8Array): Promise<ZipListing[]> {
  const mod = await ready();
  const reader = new ArchiveReader(mod as never, new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const out: ZipListing[] = [];
  try {
    for (const entry of reader.entries()) {
      const name = entry.getPathname();
      const directory = entry.getFiletype() === 'Directory';
      const size = Number(entry.getSize() ?? 0);
      out.push({
        name,
        size,
        // Not a lie about compression: these formats do not hand back a
        // per-entry packed size, so the ratio column has nothing to show.
        compressedSize: 0,
        method: 0,
        crc: 0,
        directory,
        // Both of these the library actually knows, so neither is guessed.
        // A RAR or 7z with a password lists its names and refuses its data,
        // which is worth saying in the table rather than at download time.
        encrypted: entry.isEncrypted(),
        modified: modifiedMs(entry.getModificationTime()),
        // A ZIP entry's offset is where its header sits, so it can be read
        // directly. These formats are streams with no such thing, which is
        // why extracting walks from the start.
        offset: -1,
      });
    }
  } finally {
    reader.free();
  }
  return out;
}

/**
 * One entry's bytes.
 *
 * Streamed formats have no seek, so this walks from the start each time. That
 * is genuinely slower for the last file in a big archive and it is still the
 * right shape: the alternative is holding every entry of a multi-gigabyte
 * archive in memory on the chance somebody wants one of them.
 */
export async function extractFromArchive(bytes: Uint8Array, name: string): Promise<Uint8Array | null> {
  const mod = await ready();
  const reader = new ArchiveReader(mod as never, new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  try {
    for (const entry of reader.entries()) {
      if (entry.getPathname() !== name) continue;
      if (entry.getFiletype() === 'Directory') return new Uint8Array(0);
      const data = entry.readData();
      return data ? new Uint8Array(data) : new Uint8Array(0);
    }
  } finally {
    reader.free();
  }
  return null;
}

const globalScope = globalThis as unknown as { LOC1999_ARCHIVE?: Record<string, unknown> };
globalScope.LOC1999_ARCHIVE = {
  sniffFormat,
  needsLibarchive,
  formatLabel,
  listArchive,
  extractFromArchive,
};

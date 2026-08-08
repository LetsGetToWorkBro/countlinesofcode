/**
 * The other archive formats.
 *
 * The ZIP half of the tool is ours and tested against its own writer. This
 * half is libarchive in WebAssembly, and the only test worth having of it is
 * one that reads an archive made by something else: the fixture is a 7z built
 * by p7zip, so a pass means our reader and a real 7-Zip agree about a real
 * file rather than agreeing with ourselves.
 *
 * The sniffing is pure and gets the harder attention, because it is the part
 * that decides whether 600KB of WebAssembly loads at all, and because a
 * format guessed from a file name is a guess about the wrong thing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  extractFromArchive,
  formatLabel,
  listArchive,
  needsLibarchive,
  sniffFormat,
} from '../src/client/archive';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('what an archive is, from its first bytes', () => {
  it('knows the formats it can open', () => {
    expect(sniffFormat(bytes(0x50, 0x4b, 0x03, 0x04))).toBe('zip');
    expect(sniffFormat(bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c))).toBe('7z');
    expect(sniffFormat(bytes(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00))).toBe('rar');
    expect(sniffFormat(bytes(0x1f, 0x8b, 0x08))).toBe('gz');
    expect(sniffFormat(bytes(0x42, 0x5a, 0x68, 0x39))).toBe('bz2');
    expect(sniffFormat(bytes(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00))).toBe('xz');
    expect(sniffFormat(bytes(0x28, 0xb5, 0x2f, 0xfd))).toBe('zstd');
    expect(sniffFormat(bytes(0x4d, 0x53, 0x43, 0x46))).toBe('cab');
  });

  it('reads RAR5 as RAR, which is a different format wearing the same name', () => {
    // "Rar!\x1a\x07\x01\x00". libarchive has readers for both generations, so
    // the page does not need to care which one turned up, but it must not
    // decide this is unknown and refuse it.
    expect(sniffFormat(bytes(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00))).toBe('rar');
  });

  it('finds a tar by the magic 257 bytes in, where it lives', () => {
    const tar = new Uint8Array(512);
    tar.set([0x75, 0x73, 0x74, 0x61, 0x72], 257);
    expect(sniffFormat(tar)).toBe('tar');
    // And does not read past the end of something too short to hold one.
    expect(sniffFormat(new Uint8Array(100))).toBe('unknown');
  });

  it('takes the bytes over the name', () => {
    // A .zip that is really a 7z should open, and the only way that happens
    // is if nothing here ever looks at the extension.
    const seven = readFileSync(new URL('./fixtures/sample.7z', import.meta.url));
    expect(sniffFormat(new Uint8Array(seven))).toBe('7z');
  });

  it('sends only ZIP down the fast path', () => {
    expect(needsLibarchive('zip')).toBe(false);
    for (const format of ['7z', 'rar', 'tar', 'gz', 'cab', 'iso'] as const) {
      expect(needsLibarchive(format), `${format} would be handed to the ZIP reader`).toBe(true);
    }
  });

  it('has a name for every format it can return', () => {
    for (const format of ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'zstd', 'cab', 'iso', 'unknown'] as const) {
      expect(formatLabel(format), `${format} has no label`).toBeTruthy();
    }
  });
});

describe('reading a 7z that 7-Zip made', () => {
  const archive = new Uint8Array(readFileSync(new URL('./fixtures/sample.7z', import.meta.url)));

  it('lists what is in it', async () => {
    const entries = await listArchive(archive);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['src/', 'src/hello.txt', 'src/notes.md', 'src/sub/', 'src/sub/deep.txt']);
  });

  it('tells a directory from a file, and sizes the files', async () => {
    const entries = await listArchive(archive);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['src/']!.directory).toBe(true);
    expect(byName['src/sub/']!.directory).toBe(true);
    expect(byName['src/hello.txt']!.directory).toBe(false);
    expect(byName['src/hello.txt']!.size).toBe(23);
    expect(byName['src/sub/deep.txt']!.size).toBe(7);
  });

  it('hands back the bytes, not a plausible-looking approximation of them', async () => {
    const data = await extractFromArchive(archive, 'src/hello.txt');
    expect(data).not.toBeNull();
    expect(new TextDecoder().decode(data!)).toBe('hello from a seven zip\n');

    const nested = await extractFromArchive(archive, 'src/sub/deep.txt');
    expect(new TextDecoder().decode(nested!)).toBe('nested\n');
  });

  it('says so rather than inventing something when an entry is not there', async () => {
    expect(await extractFromArchive(archive, 'src/nothing-like-this.txt')).toBeNull();
  });

  it('can be read twice, so the library is not left in a used-up state', async () => {
    // Each call makes its own reader over the same bytes; a leaked one would
    // show up as the second listing coming back short or empty.
    const first = await listArchive(archive);
    const second = await listArchive(archive);
    expect(second.length).toBe(first.length);
    expect(second.length).toBeGreaterThan(0);
  });
});

describe('reading a RAR that WinRAR made', () => {
  /* The point of the whole exercise, and the format most likely to arrive
   * from somewhere else. This fixture was written by the real `rar`, not by
   * anything in this repository, so a pass means libarchive's own reader and
   * RARLAB's writer agree about a real file.
   *
   * It is a RAR5 archive, which is what `rar` has produced by default for
   * years and what anybody's .rar almost certainly is now. libarchive keeps
   * a separate reader for the pre-5 format and this does not exercise it;
   * the build in front of it makes only RAR5, so there is no honest fixture
   * to be had here for the older one.
   */
  const archive = new Uint8Array(readFileSync(new URL('./fixtures/sample.rar', import.meta.url)));

  it('is recognised as a RAR before anything is loaded to read it', () => {
    expect(sniffFormat(archive)).toBe('rar');
    expect(needsLibarchive('rar')).toBe(true);
  });

  it('lists what is in it', async () => {
    const entries = await listArchive(archive);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['src', 'src/hello.txt', 'src/notes.md', 'src/sub', 'src/sub/deep.txt']);
  });

  it('hands back the bytes', async () => {
    const data = await extractFromArchive(archive, 'src/hello.txt');
    expect(data).not.toBeNull();
    expect(new TextDecoder().decode(data!)).toBe('hello from a seven zip\n');
  });

  it('sizes the files and marks the folders', async () => {
    const entries = await listArchive(archive);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['src']!.directory).toBe(true);
    expect(byName['src/hello.txt']!.size).toBe(23);
    expect(byName['src/hello.txt']!.encrypted).toBe(false);
  });
});

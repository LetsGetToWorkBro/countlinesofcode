/**
 * The ZIP reader, as a general archive tool rather than a .docx opener.
 *
 * Listing and extracting are separate here, and the split is the point: a
 * viewer has to show what is in a 500 MB archive without inflating 500 MB to
 * find out. These check that the index alone answers the question, and that the
 * things this reader deliberately cannot do — ZIP64, encrypted entries, exotic
 * compression — are refused with a reason rather than half-read.
 */

import { describe, expect, it } from 'vitest';
import { extractEntry, listZip, ratio, unzip, zip, type ZipEntry } from '../src/client/zip';
import {
  archiveName,
  asText,
  escapesArchive,
  folderOf,
  formatBytes,
  kindOf,
  previewable,
  mimeOf,
  safeName,
  safePath,
  sortListing,
  summarise,
  uniqueName,
} from '../src/client/zipkit';

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Something compressible enough that deflate actually wins. */
const prose = 'the quick brown fox jumps over the lazy dog. '.repeat(60);

const sample: ZipEntry[] = [
  { name: 'readme.txt', data: bytes(prose) },
  { name: 'data/values.csv', data: bytes('a,b,c\n1,2,3\n') },
  { name: 'tiny', data: bytes('x') },
];

describe('listZip', () => {
  it('reads every entry out of the index', async () => {
    const listing = listZip(await zip(sample));
    expect(listing.map((e) => e.name)).toEqual(['readme.txt', 'data/values.csv', 'tiny']);
  });

  it('reports both sizes, so a viewer can show what compression bought', async () => {
    const listing = listZip(await zip(sample));
    const readme = listing.find((e) => e.name === 'readme.txt')!;
    expect(readme.size).toBe(prose.length);
    expect(readme.compressedSize).toBeLessThan(readme.size);
  });

  it('does no inflating — a listing is cheap by construction', async () => {
    // Nothing to assert about timing; what is asserted is that the API can
    // answer without the async step at all.
    const listing = listZip(await zip(sample));
    expect(listing).toHaveLength(3);
    expect(listing.every((e) => typeof e.offset === 'number')).toBe(true);
  });

  it('records which entries are stored and which are deflated', async () => {
    const listing = listZip(await zip(sample));
    // A single byte cannot deflate smaller than itself, so it is stored.
    expect(listing.find((e) => e.name === 'tiny')!.method).toBe(0);
    expect(listing.find((e) => e.name === 'readme.txt')!.method).toBe(8);
  });

  it('carries a checksum for every entry', async () => {
    const listing = listZip(await zip(sample));
    expect(listing.every((e) => e.crc !== 0 || e.size === 0)).toBe(true);
  });

  it('refuses a file that is not an archive, rather than returning nothing', () => {
    expect(() => listZip(bytes('this is just some text'))).toThrow(/not a ZIP/i);
  });

  it('says so when the archive is ZIP64 rather than half-reading it', () => {
    // ZIP64 puts sentinels in the 32-bit fields and the real values elsewhere.
    // Reading the sentinels as counts produces nonsense, silently.
    const fake = new Uint8Array(22);
    const view = new DataView(fake.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(10, 0xffff, true);
    expect(() => listZip(fake)).toThrow(/ZIP64/i);
  });

  it('says the archive is damaged when the index points at nothing', async () => {
    const raw = await zip(sample);
    // Corrupt the offset of the central directory.
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const end = raw.length - 22;
    view.setUint32(end + 16, 5, true);
    expect(() => listZip(raw)).toThrow(/damaged/i);
  });

  it('finds the index even when the archive has a comment after it', async () => {
    // The end record is not at a fixed offset; it has to be searched for.
    const raw = await zip(sample);
    const withComment = new Uint8Array(raw.length + 5);
    withComment.set(raw);
    withComment.set(bytes('hello'), raw.length);
    const view = new DataView(withComment.buffer);
    view.setUint16(raw.length - 22 + 20, 5, true); // comment length
    expect(listZip(withComment)).toHaveLength(3);
  });
});

describe('extractEntry', () => {
  it('pulls one entry out without touching the others', async () => {
    const raw = await zip(sample);
    const listing = listZip(raw);
    const csv = listing.find((e) => e.name === 'data/values.csv')!;
    expect(text(await extractEntry(raw, csv))).toBe('a,b,c\n1,2,3\n');
  });

  it('inflates a deflated entry and stores a stored one', async () => {
    const raw = await zip(sample);
    const listing = listZip(raw);
    expect(text(await extractEntry(raw, listing[0]!))).toBe(prose);
    expect(text(await extractEntry(raw, listing[2]!))).toBe('x');
  });

  it('refuses an encrypted entry by name', async () => {
    const raw = await zip(sample);
    const listing = listZip(raw);
    const locked = { ...listing[0]!, encrypted: true };
    await expect(extractEntry(raw, locked)).rejects.toThrow(/password-protected/i);
  });

  it('refuses a compression it cannot read, and says which', async () => {
    const raw = await zip(sample);
    const listing = listZip(raw);
    // Method 12 is bzip2 — legal in ZIP, and not something the platform inflates.
    await expect(extractEntry(raw, { ...listing[0]!, method: 12 })).rejects.toThrow(/method 12/);
  });

  it('refuses an entry whose header is not where the index says', async () => {
    const raw = await zip(sample);
    const listing = listZip(raw);
    await expect(extractEntry(raw, { ...listing[0]!, offset: 7 })).rejects.toThrow(/not where/i);
  });
});

describe('round trip', () => {
  it('survives every byte value', async () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const back = await unzip(await zip([{ name: 'bytes.bin', data: all }]));
    expect(Array.from(back[0]!.data)).toEqual(Array.from(all));
  });

  it('keeps names with paths, spaces and accents', async () => {
    const names = ['a/b/c.txt', 'with space.txt', 'café/naïve.txt', 'ФАЙЛ.txt'];
    const back = await unzip(await zip(names.map((name) => ({ name, data: bytes('x') }))));
    expect(back.map((e) => e.name)).toEqual(names);
  });

  it('handles an empty file and an empty archive', async () => {
    expect(await unzip(await zip([]))).toEqual([]);
    const back = await unzip(await zip([{ name: 'empty', data: new Uint8Array(0) }]));
    expect(back[0]!.data).toHaveLength(0);
  });

  it('skips directory entries when reading whole', async () => {
    // A folder in a ZIP is a zero-length entry whose name ends in a slash. It
    // is not a file and must not come back as one.
    const raw = await zip([{ name: 'folder/', data: new Uint8Array(0) }, { name: 'folder/a', data: bytes('a') }]);
    expect(listZip(raw).filter((e) => e.directory).map((e) => e.name)).toEqual(['folder/']);
    expect((await unzip(raw)).map((e) => e.name)).toEqual(['folder/a']);
  });
});

describe('ratio', () => {
  it('reports how much smaller an entry got', () => {
    expect(ratio({ size: 1000, compressedSize: 250 })).toBe(75);
  });

  it('is zero rather than negative when compression made it bigger', () => {
    expect(ratio({ size: 100, compressedSize: 140 })).toBe(0);
  });

  it('is zero for an empty entry rather than dividing by nothing', () => {
    expect(ratio({ size: 0, compressedSize: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The archive tool's own layer
// ---------------------------------------------------------------------------

const listingOf = (over: Partial<ReturnType<typeof listZip>[number]> = {}) => ({
  name: 'a.txt',
  compressedSize: 10,
  size: 20,
  method: 8,
  crc: 1,
  directory: false,
  encrypted: false,
  modified: null,
  offset: 0,
  ...over,
});

describe('safeName', () => {
  it('keeps an ordinary name', () => {
    expect(safeName('report.pdf')).toBe('report.pdf');
  });

  it('drops the path, so an entry cannot name where it lands', () => {
    expect(safeName('docs/2026/report.pdf')).toBe('report.pdf');
  });

  it('neutralises a traversal', () => {
    // Zip Slip: an archive whose entry is named ../../../.ssh/authorized_keys.
    expect(safeName('../../../.ssh/authorized_keys')).toBe('authorized_keys');
    expect(safeName('..\\..\\windows\\system32\\evil.dll')).toBe('evil.dll');
  });

  it('never returns an empty name', () => {
    expect(safeName('../..')).toBe('file');
    expect(safeName('')).toBe('file');
    expect(safeName('/')).toBe('file');
  });

  it('removes characters an operating system refuses', () => {
    expect(safeName('a:b?c*d.txt')).toBe('a_b_c_d.txt');
  });
});

describe('safePath', () => {
  it('keeps the folders, because re-packing should not flatten a project', () => {
    expect(safePath('docs/2026/report.pdf')).toBe('docs/2026/report.pdf');
  });

  it('removes a traversal without removing the structure', () => {
    // The difference from safeName: this is a path to write back into an
    // archive, so an archive this tool produces must not carry the trick.
    expect(safePath('../../../etc/passwd')).toBe('etc/passwd');
    expect(safePath('a/b/../c.txt')).toBe('a/c.txt');
  });

  it('drops an absolute prefix and a drive letter', () => {
    expect(safePath('/etc/passwd')).toBe('etc/passwd');
    expect(safePath('C:\\Windows\\evil.dll')).toBe('Windows/evil.dll');
  });

  it('never returns an empty path', () => {
    expect(safePath('../..')).toBe('file');
    expect(safePath('')).toBe('file');
  });

  it('produces a path that no longer escapes', () => {
    for (const nasty of ['../../x', '/x', 'C:\\x', 'a/../../x', './../x']) {
      expect(escapesArchive(safePath(nasty)), nasty).toBe(false);
    }
  });
});

describe('mimeOf', () => {
  it('types an image so a preview blob actually decodes', () => {
    // Without this the blob is octet-stream and the <img> silently shows
    // nothing — which is exactly what happened the first time.
    expect(mimeOf('a.png')).toBe('image/png');
    expect(mimeOf('a.JPG')).toBe('image/jpeg');
  });

  it('refuses to hand an SVG to the browser as an image', () => {
    // An SVG is a document that can carry script; from an untrusted archive
    // that is not worth a preview.
    expect(mimeOf('a.svg')).not.toContain('svg');
  });

  it('falls back to bytes for anything else', () => {
    expect(mimeOf('a.exe')).toBe('application/octet-stream');
  });
});

describe('escapesArchive', () => {
  it('is false for ordinary paths, including ones that go down and back up', () => {
    expect(escapesArchive('a/b/c.txt')).toBe(false);
    expect(escapesArchive('a/b/../c.txt')).toBe(false);
  });

  it('is true for a path that climbs past the top', () => {
    expect(escapesArchive('../secret')).toBe(true);
    expect(escapesArchive('a/../../secret')).toBe(true);
  });

  it('is true for an absolute path, which is the other half of the trick', () => {
    expect(escapesArchive('/etc/passwd')).toBe(true);
    expect(escapesArchive('C:\\Windows\\evil.dll')).toBe(true);
  });
});

describe('folderOf and sortListing', () => {
  it('splits the folder off the name', () => {
    expect(folderOf('a/b/c.txt')).toBe('a/b');
    expect(folderOf('top.txt')).toBe('');
  });

  it('groups by folder, then orders naturally within it', () => {
    // Archives come out in whatever order the writer felt like, and "file10"
    // must not sort before "file2".
    const names = ['b/file10.txt', 'a/z.txt', 'b/file2.txt', 'a/a.txt'];
    const sorted = sortListing(names.map((name) => listingOf({ name })));
    expect(sorted.map((e) => e.name)).toEqual(['a/a.txt', 'a/z.txt', 'b/file2.txt', 'b/file10.txt']);
  });
});

describe('summarise', () => {
  it('counts files and folders separately', () => {
    const summary = summarise([
      listingOf({ name: 'a/', directory: true, size: 0, compressedSize: 0 }),
      listingOf({ name: 'a/x.txt' }),
      listingOf({ name: 'a/y.txt' }),
    ]);
    expect(summary.files).toBe(2);
    expect(summary.folders).toBe(1);
  });

  it('reports how much the compression saved overall', () => {
    const summary = summarise([listingOf({ size: 1000, compressedSize: 200 })]);
    expect(summary.saved).toBe(80);
  });

  it('names what it cannot open rather than failing at extract time', () => {
    const summary = summarise([listingOf({ encrypted: true }), listingOf({ name: 'b', method: 12 })]);
    expect(summary.problems.join(' ')).toMatch(/password-protected/i);
    expect(summary.problems.join(' ')).toMatch(/compression this cannot read/i);
  });

  it('warns about entries that would escape the folder, and says they cannot', () => {
    const summary = summarise([listingOf({ name: '../../evil.sh' })]);
    expect(summary.problems.join(' ')).toMatch(/climbs out of the archive/i);
    expect(summary.problems.join(' ')).toMatch(/flattened/i);
  });

  it('has nothing to say about an ordinary archive', () => {
    expect(summarise([listingOf()]).problems).toEqual([]);
  });
});

describe('kindOf', () => {
  it('recognises the families that matter for a listing', () => {
    expect(kindOf('a.png')).toBe('image');
    expect(kindOf('a.mp4')).toBe('video');
    expect(kindOf('a.pdf')).toBe('pdf');
    expect(kindOf('a.docx')).toBe('document');
    expect(kindOf('a.exe')).toBe('program');
    expect(kindOf('a.ts')).toBe('text');
  });

  it('is case-insensitive, because Windows archives shout', () => {
    expect(kindOf('PHOTO.JPG')).toBe('image');
  });

  it('falls back rather than guessing', () => {
    expect(kindOf('LICENSE')).toBe('file');
    expect(kindOf('a.qqq')).toBe('file');
  });
});

describe('previewable', () => {
  it('offers text and images', () => {
    expect(previewable(listingOf({ name: 'a.txt', size: 500 }))).toBe(true);
    expect(previewable(listingOf({ name: 'a.png', size: 50000 }))).toBe(true);
  });

  it('refuses things there is no point showing', () => {
    expect(previewable(listingOf({ name: 'a.exe', size: 500 }))).toBe(false);
    expect(previewable(listingOf({ name: 'a/', directory: true }))).toBe(false);
    expect(previewable(listingOf({ name: 'a.txt', encrypted: true }))).toBe(false);
  });

  it('refuses a text file too big to be worth previewing', () => {
    expect(previewable(listingOf({ name: 'huge.log', size: 40 * 1024 * 1024 }))).toBe(false);
  });
});

describe('asText', () => {
  it('decodes real text', () => {
    expect(asText(bytes('hello — café'))).toBe('hello — café');
  });

  it('returns nothing for bytes that are not text', () => {
    // A .txt full of binary should show as "not text", not as a screen of
    // replacement characters.
    expect(asText(new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x81]))).toBeNull();
  });

  it('stops at the limit rather than decoding a whole log file', () => {
    expect(asText(bytes('x'.repeat(5000)), 100)).toHaveLength(100);
  });
});

describe('uniqueName', () => {
  it('leaves a free name alone', () => {
    expect(uniqueName('a.txt', new Set())).toBe('a.txt');
  });

  it('numbers a collision before the extension', () => {
    expect(uniqueName('a.txt', new Set(['a.txt']))).toBe('a (2).txt');
    expect(uniqueName('a.txt', new Set(['a.txt', 'a (2).txt']))).toBe('a (3).txt');
  });

  it('copes with a name that has no extension', () => {
    expect(uniqueName('LICENSE', new Set(['LICENSE']))).toBe('LICENSE (2)');
  });
});

describe('archiveName', () => {
  it('names a single-file archive after the file', () => {
    expect(archiveName(['report.pdf'])).toBe('report.zip');
  });

  it('falls back for several files', () => {
    expect(archiveName(['a.txt', 'b.txt'])).toBe('archive.zip');
  });
});

describe('formatBytes', () => {
  it('scales the unit', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('the UTF-8 name flag', () => {
  it('is set on a non-ASCII name and left off an ASCII one', async () => {
    const enc = new TextEncoder();
    const out = await zip([
      { name: 'plain.txt', data: enc.encode('a') },
      { name: 'résumé.txt', data: enc.encode('b') },
    ] as ZipEntry[]);
    // General-purpose bit 11 lives at local-header offset 6. Find each local
    // header by its signature and read the flag two bytes in.
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const flags: number[] = [];
    for (let i = 0; i + 30 <= out.length; i++) {
      if (view.getUint32(i, true) === 0x04034b50) flags.push(view.getUint16(i + 6, true) & 0x0800);
    }
    expect(flags).toEqual([0, 0x0800]); // plain: off, résumé: on
  });

  it('round-trips a non-ASCII name through unzip', async () => {
    const enc = new TextEncoder();
    const out = await zip([{ name: '日本語.txt', data: enc.encode('x') }] as ZipEntry[]);
    const listed = await listZip(out);
    expect(listed[0]!.name).toBe('日本語.txt');
  });
});

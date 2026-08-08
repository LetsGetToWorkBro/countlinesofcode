/**
 * What an archive is, decided from its first bytes.
 *
 * Split out of archive.ts on purpose. That file carries 600KB of WebAssembly
 * for RAR and 7z; this one is a few hundred bytes of magic numbers, and the
 * page needs the answer *before* it can know whether to fetch the big half.
 * With the two together, opening a plain ZIP downloaded the RAR reader to
 * find out it was not needed.
 *
 * Both bundles import this, so there is one table of magic numbers rather
 * than two that can drift.
 */

/** The formats worth naming when we see one. */
export type ArchiveFormat = 'zip' | '7z' | 'rar' | 'tar' | 'gz' | 'bz2' | 'xz' | 'zstd' | 'cab' | 'iso' | 'unknown';

/**
 * What an archive is, from its first bytes rather than its name.
 *
 * A name is a claim and a magic number is evidence: a .zip that is really a
 * 7z should open, and a .7z that is really a ZIP should take the fast path.
 * Kept here rather than in the WebAssembly half so the page can decide which
 * engine to load before loading either.
 */
export function sniffFormat(bytes: Uint8Array): ArchiveFormat {
  const has = (offset: number, sig: number[]) =>
    bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

  // PK\x03\x04, PK\x05\x06 (empty) and PK\x07\x08 (spanned).
  if (has(0, [0x50, 0x4b]) && [0x03, 0x05, 0x07].includes(bytes[2] ?? -1)) return 'zip';
  if (has(0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  // "Rar!\x1a\x07\x00" is RAR 1.5 to 4.x; "...\x01\x00" is RAR5.
  if (has(0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar';
  if (has(0, [0x1f, 0x8b])) return 'gz';
  if (has(0, [0x42, 0x5a, 0x68])) return 'bz2';
  if (has(0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz';
  if (has(0, [0x28, 0xb5, 0x2f, 0xfd])) return 'zstd';
  if (has(0, [0x4d, 0x53, 0x43, 0x46])) return 'cab';
  // A tar has no header of its own; the magic sits 257 bytes in.
  if (has(257, [0x75, 0x73, 0x74, 0x61, 0x72])) return 'tar';
  // A raw ISO's identifier is one sector and a byte in.
  if (has(0x8001, [0x43, 0x44, 0x30, 0x30, 0x31])) return 'iso';
  return 'unknown';
}

/** Everything the ZIP engine reads on its own, so we never load 600KB for one. */
export function needsLibarchive(format: ArchiveFormat): boolean {
  return format !== 'zip';
}

/** A human name for a format, for the status line and the error. */
export function formatLabel(format: ArchiveFormat): string {
  const names: Record<ArchiveFormat, string> = {
    zip: 'ZIP', '7z': '7z', rar: 'RAR', tar: 'tar', gz: 'gzip', bz2: 'bzip2',
    xz: 'xz', zstd: 'zstd', cab: 'CAB', iso: 'ISO', unknown: 'unknown',
  };
  return names[format];
}

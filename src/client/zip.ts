/**
 * A ZIP reader and writer, in about two hundred lines and no dependency.
 *
 * A .docx is a ZIP of XML, so both directions of the Word converter need this.
 * The compression itself is the platform's: `CompressionStream('deflate-raw')`
 * is a browser built-in (and a Node one), which is exactly the algorithm ZIP
 * stores, so there is no deflate implementation here to get wrong.
 *
 * Deliberately narrow. It handles the subset of ZIP that Office actually
 * writes — stored or deflated entries, no encryption, no ZIP64, no spanning —
 * and refuses anything else rather than guessing. A .docx that needs ZIP64 is
 * a document with four billion parts in it, which is not a thing.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /**
   * Force this entry to be stored uncompressed.
   *
   * EPUB requires it: the `mimetype` entry must be first in the archive and
   * stored, so a reader can identify the file by reading its first few bytes
   * without inflating anything. It happens to come out stored anyway — twenty
   * bytes deflate larger than they started — but relying on that would be
   * relying on a coincidence, and the spec is not a coincidence.
   */
  store?: boolean;
}

const SIGNATURE = {
  local: 0x04034b50,
  central: 0x02014b50,
  end: 0x06054b50,
};

/* CRC-32, the checksum ZIP uses. The table is built once on first use. */
let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/* Streams rather than Blob/Response: this module is shared with Node for its
 * tests, and ReadableStream is the one spelling both platforms agree on. */
async function pipe(bytes: Uint8Array, through: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = input.pipeThrough(through as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(chunks);
}

const deflate = (bytes: Uint8Array) => pipe(bytes, new CompressionStream('deflate-raw'));
const inflate = (bytes: Uint8Array) => pipe(bytes, new DecompressionStream('deflate-raw'));

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Write a ZIP.
 *
 * Everything is deflated; Office is happy either way, and a document is text
 * that compresses to a fraction of its size.
 */
export async function zip(entries: ZipEntry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    // A tiny file can deflate *larger* than it started; store those as-is.
    const compressed = entry.store ? entry.data : await deflate(entry.data);
    const deflated = !entry.store && compressed.length < entry.data.length;
    const body = deflated ? compressed : entry.data;
    const method = deflated ? 8 : 0;

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, SIGNATURE.local, true);
    header.setUint16(4, 20, true); // version needed
    header.setUint16(8, method, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, body.length, true);
    header.setUint32(22, entry.data.length, true);
    header.setUint16(26, name.length, true);
    local.push(new Uint8Array(header.buffer), name, body);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, SIGNATURE.central, true);
    record.setUint16(4, 20, true); // version made by
    record.setUint16(6, 20, true); // version needed
    record.setUint16(10, method, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, body.length, true);
    record.setUint32(24, entry.data.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), name);

    offset += 30 + name.length + body.length;
  }

  const centralBytes = concat(central);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIGNATURE.end, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralBytes.length, true);
  end.setUint32(16, offset, true);

  return concat([...local, centralBytes, new Uint8Array(end.buffer)]);
}

/**
 * One entry as the index describes it, without unpacking anything.
 *
 * Listing and extracting are separate on purpose. A viewer wants to show what
 * is in a 500 MB archive immediately; inflating every entry to do that would
 * take the memory of the whole uncompressed contents to answer a question the
 * index already answers.
 */
export interface ZipListing {
  name: string;
  /** Bytes it occupies in the archive. */
  compressedSize: number;
  /** Bytes it becomes. */
  size: number;
  /** 0 stored, 8 deflated. Anything else this cannot read. */
  method: number;
  crc: number;
  /** Directory entries are a name ending in a slash and no content. */
  directory: boolean;
  /** Locked with the old ZIP password scheme; the bytes cannot be read. */
  encrypted: boolean;
  /** Milliseconds since the epoch, from the DOS timestamp, or null. */
  modified: number | null;
  /** Where the entry's own header sits. Needed to extract it later. */
  offset: number;
}

/** How much smaller an entry got, as a percentage. */
export function ratio(entry: Pick<ZipListing, 'size' | 'compressedSize'>): number {
  if (!entry.size) return 0;
  return Math.max(0, Math.round((1 - entry.compressedSize / entry.size) * 100));
}

/**
 * DOS date and time, which is what ZIP stores.
 *
 * Two 16-bit fields with two-second resolution, no timezone at all, and years
 * counted from 1980. It is the timestamp the archive actually holds, so it is
 * read as local time — which is what the machine that wrote it meant.
 */
function dosTime(date: number, time: number): number | null {
  if (!date) return null;
  const year = 1980 + ((date >> 9) & 0x7f);
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  const hours = (time >> 11) & 0x1f;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  const stamp = new Date(year, month, day, hours, minutes, seconds).getTime();
  return Number.isFinite(stamp) ? stamp : null;
}

/** Where the end-of-central-directory record is, or -1. */
function findEnd(bytes: Uint8Array, view: DataView): number {
  // It sits at the tail, after an archive comment of unknown length — so it has
  // to be searched for backwards rather than read from a fixed offset.
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === SIGNATURE.end) return i;
  }
  return -1;
}

/**
 * What is in the archive, read from its index alone.
 *
 * The central directory is the authority — walking local headers instead is how
 * readers get fooled by archives with junk prepended, and it cannot tell a
 * deleted entry from a live one.
 */
export function listZip(bytes: Uint8Array): ZipListing[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  const end = findEnd(bytes, view);
  if (end < 0) throw new Error('That file is not a ZIP archive.');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);

  // ZIP64 puts 0xffff / 0xffffffff in the 32-bit fields and the real values in
  // a separate record. Rather than half-read one, say so.
  if (count === 0xffff || at === 0xffffffff) {
    throw new Error('That archive is in ZIP64 form, which this cannot read. It holds over four gigabytes or over 65,535 files.');
  }

  const entries: ZipListing[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== SIGNATURE.central) {
      throw new Error('That archive is damaged: its index does not match its contents.');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const raw = bytes.subarray(at + 46, at + 46 + nameLength);
    // Bit 11 promises the name is UTF-8. Without it the name is officially
    // CP437, but every modern tool writes UTF-8 anyway, so decoding as UTF-8
    // and tolerating the odd wrong accent beats mangling every non-ASCII name.
    const name = decoder.decode(raw);

    entries.push({
      name,
      compressedSize,
      size,
      method,
      crc,
      directory: name.endsWith('/') || (size === 0 && compressedSize === 0 && name.endsWith('\\')),
      encrypted: Boolean(flags & 0x1),
      modified: dosTime(date, time),
      offset,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Pull one entry's bytes out, inflating it if it needs it. */
export async function extractEntry(bytes: Uint8Array, listing: ZipListing): Promise<Uint8Array> {
  if (listing.encrypted) {
    throw new Error(`"${listing.name}" is password-protected. This cannot open encrypted archives.`);
  }
  if (listing.method !== 0 && listing.method !== 8) {
    throw new Error(`"${listing.name}" uses compression method ${listing.method}, which this cannot read. Only stored and deflated entries work.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(listing.offset, true) !== SIGNATURE.local) {
    throw new Error(`"${listing.name}" is not where the archive's index says it is.`);
  }
  // The local header repeats the name and extra field, at its own lengths —
  // which are not always the same as the central directory's.
  const localName = view.getUint16(listing.offset + 26, true);
  const localExtra = view.getUint16(listing.offset + 28, true);
  const start = listing.offset + 30 + localName + localExtra;
  const raw = bytes.subarray(start, start + listing.compressedSize);
  return listing.method === 8 ? inflate(raw) : new Uint8Array(raw);
}

/**
 * Read a ZIP whole.
 *
 * Convenient for the small archives the document tools deal with — a .docx is
 * a dozen files — and built on the two functions above so there is one parser.
 */
export async function unzip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  for (const listing of listZip(bytes)) {
    if (listing.directory) continue;
    entries.push({ name: listing.name, data: await extractEntry(bytes, listing) });
  }
  return entries;
}

/** The one entry with this name, or null. Names in a .docx are exact paths. */
export function entry(entries: ZipEntry[], name: string): Uint8Array | null {
  return entries.find((e) => e.name === name)?.data ?? null;
}

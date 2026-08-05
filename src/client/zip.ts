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
    const compressed = await deflate(entry.data);
    // A tiny file can deflate *larger* than it started; store those as-is.
    const deflated = compressed.length < entry.data.length;
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
 * Read a ZIP, via its central directory.
 *
 * The central directory is the authority on what is in the archive — walking
 * local headers instead is how readers get fooled by archives with junk
 * prepended, and it cannot tell a deleted entry from a live one.
 */
export async function unzip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // The end record is at the tail, after a comment of unknown length.
  let end = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === SIGNATURE.end) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('That file is not a ZIP archive, so it cannot be a Word document.');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== SIGNATURE.central) {
      throw new Error('That Word document is damaged: its index does not match its contents.');
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));

    if (flags & 0x1) throw new Error('That Word document is password-protected, so it cannot be opened here.');
    if (method !== 0 && method !== 8) {
      throw new Error(`That Word document uses a compression this tool does not support (method ${method}).`);
    }

    // The local header repeats the name and extra field, at its own lengths.
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    const raw = bytes.subarray(start, start + compressedSize);
    entries.push({ name, data: method === 8 ? await inflate(raw) : new Uint8Array(raw) });

    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** The one entry with this name, or null. Names in a .docx are exact paths. */
export function entry(entries: ZipEntry[], name: string): Uint8Array | null {
  return entries.find((e) => e.name === name)?.data ?? null;
}

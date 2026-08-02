/** Minimal tar writer, used to build archive fixtures for the tar reader. */

const BLOCK = 512;
const encoder = new TextEncoder();

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  block.set(bytes.subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  writeString(block, offset, length, `${text}\0`);
}

function header(path: string, size: number, typeflag: string): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeString(block, 0, 100, path);
  writeOctal(block, 100, 8, 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  writeString(block, 148, 8, '        '); // checksum placeholder
  block[156] = typeflag.charCodeAt(0);
  writeString(block, 257, 6, 'ustar');
  writeString(block, 263, 2, '00');

  let checksum = 0;
  for (let i = 0; i < BLOCK; i++) checksum += block[i]!;
  writeOctal(block, 148, 8, checksum);
  block[155] = 0x20;
  return block;
}

export interface TarFile {
  path: string;
  content: string | Uint8Array;
  /** '0' regular (default), '5' directory, '2' symlink, 'L' GNU long name */
  type?: string;
}

export function buildTar(files: TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const file of files) {
    const data = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
    parts.push(header(file.path, data.length, file.type ?? '0'));
    parts.push(data);
    const remainder = data.length % BLOCK;
    if (remainder !== 0) parts.push(new Uint8Array(BLOCK - remainder));
  }
  parts.push(new Uint8Array(BLOCK * 2)); // end-of-archive
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toStream(bytes: Uint8Array, chunkSize = 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = toStream(bytes).pipeThrough(new CompressionStream('gzip'));
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

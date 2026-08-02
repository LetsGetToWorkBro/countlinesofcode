/**
 * Streaming tar reader.
 *
 * Used for the tarball counting strategy: one HTTPS request gets the whole
 * repository at a pinned commit, instead of one subrequest per blob. Cloudflare
 * caps subrequests per request (50 on the free plan, 1000 on paid), so
 * blob-per-file only scales to small repos — see github.ts for the switch.
 *
 * Only what GitHub's archives actually emit is supported: ustar/GNU regular
 * files, directories, symlinks (skipped), GNU long names ('L'), and pax
 * extended headers ('x' with a `path=` record). Everything else is skipped.
 *
 * The reader never holds more than one file's bytes at a time: callers get a
 * `wanted()` predicate so uninteresting payloads are discarded as they stream
 * past.
 */

const BLOCK = 512;

export interface TarEntry {
  path: string;
  size: number;
  /** Present only when the caller's `wanted` predicate returned true. */
  data?: Uint8Array;
}

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end++;
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(block.subarray(offset, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const raw = readString(block, offset, length).trim();
  if (raw === '') return 0;
  // GNU base-256 encoding for large values: high bit of first byte set.
  if ((block[offset]! & 0x80) !== 0) {
    let value = 0;
    for (let i = offset + 1; i < offset + length; i++) value = value * 256 + block[i]!;
    return value;
  }
  const parsed = parseInt(raw.replace(/[^0-7]/g, ''), 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

/** Concatenating buffer that hands out exact-size chunks. */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private length = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  get size(): number {
    return this.length;
  }

  /** Take exactly n bytes, or null if not enough buffered yet. */
  take(n: number): Uint8Array | null {
    if (this.length < n) return null;
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0]!;
      const need = n - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.chunks[0] = head.subarray(need);
        filled = n;
      }
    }
    this.length -= n;
    return out;
  }

  /** Drop up to n bytes without copying them out. Returns bytes dropped. */
  drop(n: number): number {
    let dropped = 0;
    while (dropped < n && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const need = n - dropped;
      if (head.length <= need) {
        dropped += head.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(need);
        dropped += need;
      }
    }
    this.length -= dropped;
    return dropped;
  }
}

export interface TarOptions {
  /** Return true to receive the entry's bytes; false to stream past them. */
  wanted?: (path: string, size: number) => boolean;
}

/**
 * Iterate a (already decompressed) tar stream.
 */
export async function* readTar(
  stream: ReadableStream<Uint8Array>,
  options: TarOptions = {},
): AsyncGenerator<TarEntry> {
  const reader = stream.getReader();
  const queue = new ByteQueue();
  let done = false;
  let longName: string | null = null;
  let paxPath: string | null = null;
  let zeroBlocks = 0;

  async function fill(target: number): Promise<boolean> {
    while (queue.size < target && !done) {
      const { value, done: finished } = await reader.read();
      if (finished) {
        done = true;
        break;
      }
      if (value) queue.push(value);
    }
    return queue.size >= target;
  }

  async function readExact(n: number): Promise<Uint8Array | null> {
    if (!(await fill(n))) return null;
    return queue.take(n);
  }

  async function skipExact(n: number): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      if (queue.size === 0 && !(await fill(Math.min(remaining, 1 << 20)))) {
        if (queue.size === 0) return;
      }
      remaining -= queue.drop(Math.min(remaining, queue.size));
    }
  }

  try {
    for (;;) {
      const header = await readExact(BLOCK);
      if (!header) return;

      if (isZeroBlock(header)) {
        zeroBlocks++;
        if (zeroBlocks >= 2) return;
        continue;
      }
      zeroBlocks = 0;

      const name = readString(header, 0, 100);
      const size = readOctal(header, 124, 12);
      const typeflag = String.fromCharCode(header[156] || 0x30);
      const prefix = readString(header, 345, 155);
      const padded = size % BLOCK === 0 ? size : size + (BLOCK - (size % BLOCK));

      if (typeflag === 'L') {
        const payload = await readExact(padded);
        if (!payload) return;
        longName = readString(payload, 0, size).replace(/\0+$/, '');
        continue;
      }

      if (typeflag === 'x' || typeflag === 'X') {
        const payload = await readExact(padded);
        if (!payload) return;
        const text = new TextDecoder().decode(payload.subarray(0, size));
        const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
        paxPath = match ? match[1]! : null;
        continue;
      }

      let path = longName ?? paxPath ?? (prefix ? `${prefix}/${name}` : name);
      longName = null;
      paxPath = null;
      path = path.replace(/\0+$/, '');

      const isFile = typeflag === '0' || typeflag === '\0' || typeflag === '7' || header[156] === 0;
      if (!isFile) {
        await skipExact(padded);
        continue;
      }

      const want = options.wanted ? options.wanted(path, size) : true;
      if (!want) {
        await skipExact(padded);
        yield { path, size };
        continue;
      }

      const payload = await readExact(padded);
      if (!payload) return;
      yield { path, size, data: payload.subarray(0, size) };
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** gzip -> tar entries. */
export function gunzipStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return stream.pipeThrough(new DecompressionStream('gzip'));
}

/** Strip the `owner-repo-sha/` directory GitHub puts at the root of archives. */
export function stripArchiveRoot(path: string): string | null {
  const slash = path.indexOf('/');
  if (slash === -1) return null;
  const rest = path.slice(slash + 1);
  return rest.length > 0 ? rest : null;
}

import { describe, expect, it } from 'vitest';
import { gunzipStream, readTar, stripArchiveRoot } from '../src/lib/tar';
import { buildTar, gzip, toStream } from './fixtures/tar';

const decoder = new TextDecoder();

async function collect(
  bytes: Uint8Array,
  options: Parameters<typeof readTar>[1] = {},
  chunkSize = 1024,
): Promise<{ path: string; size: number; text?: string }[]> {
  const out: { path: string; size: number; text?: string }[] = [];
  for await (const entry of readTar(toStream(bytes, chunkSize), options)) {
    out.push({
      path: entry.path,
      size: entry.size,
      ...(entry.data ? { text: decoder.decode(entry.data) } : {}),
    });
  }
  return out;
}

describe('readTar', () => {
  it('reads regular files with their contents', async () => {
    const tar = buildTar([
      { path: 'repo-abc/a.txt', content: 'hello\n' },
      { path: 'repo-abc/b.txt', content: 'world\n' },
    ]);
    const entries = await collect(tar);
    expect(entries).toEqual([
      { path: 'repo-abc/a.txt', size: 6, text: 'hello\n' },
      { path: 'repo-abc/b.txt', size: 6, text: 'world\n' },
    ]);
  });

  it('handles files whose size is an exact multiple of the block size', async () => {
    const content = 'x'.repeat(512);
    const tar = buildTar([
      { path: 'r/a.txt', content },
      { path: 'r/b.txt', content: 'after\n' },
    ]);
    const entries = await collect(tar);
    expect(entries[0]!.text).toHaveLength(512);
    expect(entries[1]!.text).toBe('after\n');
  });

  it('handles empty files', async () => {
    const tar = buildTar([
      { path: 'r/empty', content: '' },
      { path: 'r/next', content: 'ok' },
    ]);
    const entries = await collect(tar);
    expect(entries).toEqual([
      { path: 'r/empty', size: 0, text: '' },
      { path: 'r/next', size: 2, text: 'ok' },
    ]);
  });

  it('skips directories and symlinks', async () => {
    const tar = buildTar([
      { path: 'r/dir/', content: '', type: '5' },
      { path: 'r/link', content: '', type: '2' },
      { path: 'r/real.txt', content: 'yes' },
    ]);
    const entries = await collect(tar);
    expect(entries.map((e) => e.path)).toEqual(['r/real.txt']);
  });

  it('honours the wanted predicate and still reports skipped paths', async () => {
    const tar = buildTar([
      { path: 'r/keep.ts', content: 'keep' },
      { path: 'r/drop.png', content: 'drop' },
    ]);
    const entries = await collect(tar, { wanted: (path) => path.endsWith('.ts') });
    expect(entries).toEqual([
      { path: 'r/keep.ts', size: 4, text: 'keep' },
      { path: 'r/drop.png', size: 4 },
    ]);
  });

  it('reads correctly across arbitrary chunk boundaries', async () => {
    const tar = buildTar([
      { path: 'r/a.txt', content: 'a'.repeat(1500) },
      { path: 'r/b.txt', content: 'b'.repeat(37) },
    ]);
    for (const chunkSize of [1, 7, 63, 512, 513, 4096]) {
      const entries = await collect(tar, {}, chunkSize);
      expect(entries.map((e) => e.text?.length)).toEqual([1500, 37]);
    }
  });

  it('supports GNU long names', async () => {
    const longPath = `r/${'nested/'.repeat(20)}file.ts`;
    const tar = buildTar([
      { path: '././@LongLink', content: `${longPath}\0`, type: 'L' },
      { path: longPath.slice(0, 99), content: 'body', type: '0' },
    ]);
    const entries = await collect(tar);
    expect(entries[0]!.path).toBe(longPath);
    expect(entries[0]!.text).toBe('body');
  });

  it('supports pax extended headers', async () => {
    const longPath = 'r/pax/very/long/path/name.ts';
    const record = `${String(`0 path=${longPath}\n`.length + 2)} path=${longPath}\n`;
    const tar = buildTar([
      { path: 'PaxHeader', content: record, type: 'x' },
      { path: 'r/short.ts', content: 'body' },
    ]);
    const entries = await collect(tar);
    expect(entries[0]!.path).toBe(longPath);
  });

  it('stops at the end-of-archive marker', async () => {
    const tar = buildTar([{ path: 'r/a', content: 'a' }]);
    const padded = new Uint8Array(tar.length + 4096);
    padded.set(tar);
    const entries = await collect(padded);
    expect(entries).toHaveLength(1);
  });

  it('round-trips through gzip', async () => {
    const tar = buildTar([{ path: 'r/a.ts', content: 'const a = 1;\n' }]);
    const compressed = await gzip(tar);
    const out: string[] = [];
    for await (const entry of readTar(gunzipStream(toStream(compressed, 64)))) {
      out.push(entry.data ? decoder.decode(entry.data) : '');
    }
    expect(out).toEqual(['const a = 1;\n']);
  });
});

describe('stripArchiveRoot', () => {
  it('removes the archive root directory', () => {
    expect(stripArchiveRoot('owner-repo-abc123/src/index.ts')).toBe('src/index.ts');
    expect(stripArchiveRoot('owner-repo-abc123/README.md')).toBe('README.md');
  });

  it('returns null for the root directory itself', () => {
    expect(stripArchiveRoot('owner-repo-abc123/')).toBeNull();
    expect(stripArchiveRoot('noroot')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { decidePath, isLockfile, isVendoredPath, looksBinary } from '../src/lib/ignore';

const size = 1000;

describe('decidePath - vendored', () => {
  const vendored = [
    'node_modules/left-pad/index.js',
    'web/node_modules/x/y.ts',
    'vendor/github.com/pkg/errors/errors.go',
    'third_party/zlib/zlib.c',
    'dist/bundle.js',
    'build/main.o.txt',
    'target/debug/build.rs',
    '.next/static/chunk.js',
    'app/__pycache__/mod.py',
    'ios/Pods/Firebase/Core.m',
    'coverage/lcov-report/index.html',
    '.git/config',
  ];
  for (const path of vendored) {
    it(`skips ${path}`, () => {
      const decision = decidePath(path, size);
      expect(decision).toMatchObject({ skip: true, reason: 'vendored' });
    });
  }

  it('keeps source files that merely mention a vendor word', () => {
    for (const path of ['src/vendor.ts', 'lib/build.ts', 'app/dist.py', 'src/node_modules.md']) {
      expect(decidePath(path, size).skip).toBe(false);
    }
  });

  it('can be told to include vendored paths', () => {
    expect(decidePath('node_modules/x/y.js', size, { includeVendored: true }).skip).toBe(false);
  });

  it('reports the directory that triggered the skip', () => {
    expect(isVendoredPath('a/b/node_modules/c/d.js')).toBe('node_modules');
    expect(isVendoredPath('a/b/c.js')).toBeNull();
  });
});

describe('decidePath - generated', () => {
  const generated = [
    'public/app.min.js',
    'public/app.min.css',
    'dist-src/index.js.map',
    'api/service.pb.go',
    'api/service_pb2.py',
    'models/user.g.dart',
    'src/__generated__/types.ts',
    'test/__snapshots__/a.test.js.snap',
  ];
  for (const path of generated) {
    it(`skips ${path}`, () => {
      expect(decidePath(path, size)).toMatchObject({ skip: true, reason: 'generated' });
    });
  }

  it('skips lockfiles by default and counts them on request', () => {
    for (const path of ['package-lock.json', 'app/yarn.lock', 'Cargo.lock', 'poetry.lock', 'go.sum']) {
      expect(isLockfile(path)).toBe(true);
      expect(decidePath(path, size)).toMatchObject({ skip: true, reason: 'generated', detail: 'lockfile' });
      expect(decidePath(path, size, { includeLockfiles: true }).skip).toBe(false);
    }
  });

  it('does not confuse a normal file with a minified one', () => {
    expect(decidePath('src/admin.js', size).skip).toBe(false);
    expect(decidePath('src/mapping.ts', size).skip).toBe(false);
  });
});

describe('decidePath - binary and size', () => {
  it('skips known binary extensions', () => {
    for (const path of ['logo.png', 'font.woff2', 'a.zip', 'model.safetensors', 'lib.so', 'x.wasm']) {
      expect(decidePath(path, size)).toMatchObject({ skip: true, reason: 'binary' });
    }
  });

  it('enforces the per-file cap', () => {
    expect(decidePath('big.txt', 10_000, { maxFileBytes: 5_000 })).toMatchObject({
      skip: true,
      reason: 'too_large',
    });
    expect(decidePath('small.txt', 10, { maxFileBytes: 5_000 }).skip).toBe(false);
  });
});

describe('looksBinary', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('detects NUL bytes', () => {
    expect(looksBinary(new Uint8Array([0x68, 0x00, 0x69]))).toBe(true);
  });

  it('accepts ordinary text', () => {
    expect(looksBinary(enc('hello\nworld\t!\r\n'))).toBe(false);
  });

  it('accepts an empty file', () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });

  it('accepts UTF-8 beyond ASCII', () => {
    expect(looksBinary(enc('日本語のコメント\n'))).toBe(false);
  });

  it('rejects control-byte soup', () => {
    expect(looksBinary(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 0x41, 0x42]))).toBe(true);
  });
});

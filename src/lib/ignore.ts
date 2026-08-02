/**
 * Path filtering: what gets counted and what gets skipped, and why.
 *
 * Everything is data-driven and additive so this stays easy to extend. The four
 * skip reasons are surfaced in the API response and in the UI:
 *
 *   vendored   third-party or build output checked into the repo
 *   generated  machine-written files (lockfiles, *.pb.go, snapshots, minified)
 *   binary     not text (by extension here, by content sniff in count.ts)
 *   too_large  above the per-file byte cap
 *
 * LOCKFILE POLICY: lockfiles are SKIPPED by default and reported under
 * `generated`. They are machine-generated dependency graphs, not code someone
 * wrote, and a single package-lock.json can outweigh an entire small project.
 * `?lockfiles=1` (API) / the checkbox in the UI counts them as data instead.
 */

export type SkipReason = 'vendored' | 'generated' | 'binary' | 'too_large' | 'other';

export interface IgnoreOptions {
  /** Count lockfiles instead of skipping them. Default false. */
  includeLockfiles?: boolean;
  /** Count vendored/build directories too. Default false. */
  includeVendored?: boolean;
  /** Per-file byte cap; above this a file is skipped as too_large. */
  maxFileBytes?: number;
}

/** Directory names that mean "not this repository's code". */
const VENDOR_DIRS = new Set([
  '.git', '.hg', '.svn', '.bzr',
  'node_modules', 'bower_components', 'jspm_packages',
  'vendor', 'vendors', 'third_party', 'thirdparty', '3rdparty', 'external', 'externals',
  'dist', 'build', 'out', 'output', 'bin', 'obj', 'target', 'release', 'debug',
  '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.netlify', '.wrangler',
  '.venv', 'venv', 'env', 'virtualenv', 'site-packages', '__pycache__', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.tox', 'eggs', '.eggs',
  '.gradle', '.mvn', '.idea', '.vscode-test', '.terraform',
  'coverage', 'htmlcov', '.nyc_output', '.coverage',
  'bundle', 'packages', 'pods', 'Pods', 'Carthage', 'DerivedData',
  '.cargo', '.bundle', '.yarn', '.pnpm-store', '.turbo', '.cache', '.parcel-cache',
  'cmake-build-debug', 'cmake-build-release',
  'testdata',
]);

/**
 * Directory names that are only vendored when they sit at the repo root or are
 * clearly build output. `bin/` and `env/` above are aggressive on purpose;
 * these keep obviously-source directories safe.
 */
const VENDOR_DIR_EXCEPTIONS = new Set(['src/bin', 'cmd/bin']);

/** Exact filenames that are machine-generated. */
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lockb', 'bun.lock', 'deno.lock',
  'composer.lock', 'Gemfile.lock', 'Podfile.lock', 'Cartfile.resolved',
  'poetry.lock', 'Pipfile.lock', 'pdm.lock', 'uv.lock', 'conda-lock.yml',
  'Cargo.lock', 'go.sum', 'mix.lock', 'pubspec.lock', 'flake.lock',
  'gradle.lockfile', 'packages.lock.json', 'paket.lock', 'cabal.project.freeze',
  'requirements.lock', 'terraform.lock.hcl', '.terraform.lock.hcl',
]);

const GENERATED_FILENAMES = new Set([
  'yarn-error.log', 'npm-debug.log', 'pnpm-debug.log',
]);

/** Path suffixes that indicate generated or minified content. */
const GENERATED_SUFFIXES = [
  '.min.js', '.min.css', '.min.mjs',
  '.map', '.js.map', '.css.map',
  '.bundle.js', '.chunk.js',
  '.pb.go', '.pb.cc', '.pb.h', '_pb2.py', '_pb2_grpc.py', '.pb.ts', '_pb.js', '_pb.d.ts',
  '.g.dart', '.freezed.dart', '.g.cs', '.designer.cs', '.generated.ts', '.generated.go',
  '_generated.go', '_generated.ts', '.gen.go', '.gen.ts',
  '.snap', '.d.ts.map',
  '-lock.json', '-lock.yaml',
];

/** Path substrings (normalised with slashes) that indicate generated content. */
const GENERATED_PATH_HINTS = [
  '/__generated__/', '/generated/', '/gen/pb/', '/.generated/',
  '/__snapshots__/', '/migrations/schema.rb',
];

/** Extensions that are never text. */
const BINARY_EXTS = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'webp', 'avif',
  'heic', 'psd', 'ai', 'eps', 'xcf',
  // video / audio
  'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'mpg', 'mpeg',
  'mp3', 'wav', 'flac', 'ogg', 'oga', 'aac', 'm4a', 'opus', 'wma', 'aiff', 'mid', 'midi',
  // fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // archives
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz4', '7z', 'rar', 'tar', 'jar', 'war',
  'ear', 'apk', 'aab', 'ipa', 'dmg', 'iso', 'deb', 'rpm', 'msi', 'cab', 'pkg', 'crx',
  // binaries / objects
  'exe', 'dll', 'so', 'dylib', 'a', 'lib', 'o', 'obj', 'pdb', 'class', 'pyc', 'pyo',
  'pyd', 'wasm', 'bin', 'elf', 'ko', 'rlib', 'rmeta', 'bc', 'nupkg', 'whl', 'egg',
  // documents / data blobs
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'db', 'sqlite', 'sqlite3', 'mdb', 'dat', 'pack', 'idx', 'bak', 'dump',
  'parquet', 'orc', 'avro', 'feather', 'arrow', 'npy', 'npz', 'pt', 'pth', 'onnx',
  'h5', 'hdf5', 'pkl', 'pickle', 'joblib', 'safetensors', 'ckpt', 'gguf', 'ggml',
  'model', 'tflite', 'pb',
  // misc
  'ds_store', 'lock~', 'swp', 'swo', 'iml', 'suo', 'ncb', 'sdf', 'unityasset',
  'blend', 'fbx', 'obj3d', 'glb', 'gltf', 'stl', 'dwg', 'skp',
]);

export interface SkipDecision {
  skip: true;
  reason: SkipReason;
  detail: string;
}
export interface CountDecision {
  skip: false;
}
export type Decision = SkipDecision | CountDecision;

const COUNT: CountDecision = { skip: false };

function segments(path: string): string[] {
  return path.split('/');
}

export function isVendoredPath(path: string, includeVendored = false): string | null {
  if (includeVendored) return null;
  const segs = segments(path);
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    if (!VENDOR_DIRS.has(seg)) continue;
    const joined = segs.slice(Math.max(0, i - 1), i + 1).join('/');
    if (VENDOR_DIR_EXCEPTIONS.has(joined)) continue;
    return seg;
  }
  return null;
}

export function isLockfile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return LOCKFILES.has(name);
}

export function isGeneratedPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (GENERATED_FILENAMES.has(name)) return name;
  const lower = path.toLowerCase();
  for (const suffix of GENERATED_SUFFIXES) {
    if (lower.endsWith(suffix)) return `*${suffix}`;
  }
  const padded = `/${lower}`;
  for (const hint of GENERATED_PATH_HINTS) {
    if (padded.includes(hint)) return hint;
  }
  return null;
}

export function isBinaryExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return BINARY_EXTS.has(name.slice(dot + 1));
}

/**
 * Decide what to do with a tree entry. Order matters: binary before vendored so
 * a PNG inside node_modules reports as vendored (the more useful signal is the
 * directory), hence vendored is checked first.
 */
export function decidePath(path: string, size: number, opts: IgnoreOptions = {}): Decision {
  const vendor = isVendoredPath(path, opts.includeVendored);
  if (vendor) return { skip: true, reason: 'vendored', detail: `${vendor}/` };

  if (isLockfile(path)) {
    if (!opts.includeLockfiles) return { skip: true, reason: 'generated', detail: 'lockfile' };
  } else {
    const generated = isGeneratedPath(path);
    if (generated) return { skip: true, reason: 'generated', detail: generated };
  }

  if (isBinaryExtension(path)) return { skip: true, reason: 'binary', detail: 'extension' };

  const cap = opts.maxFileBytes ?? Infinity;
  if (size > cap) return { skip: true, reason: 'too_large', detail: `${size} bytes` };

  return COUNT;
}

/**
 * Content sniff: a NUL byte in the first 8 KiB, or a very high proportion of
 * non-printable bytes, means binary. Runs after the extension check, so this
 * only catches extensionless or mislabelled files.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0) return true;
    // Allow tab, LF, CR, FF, ESC and everything >= 0x20.
    if (b < 0x20 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27) suspicious++;
  }
  return suspicious / n > 0.3;
}

/** Exposed for the "How we count" page so the docs cannot drift from the code. */
export const IGNORE_RULES_SUMMARY = {
  vendorDirs: [...VENDOR_DIRS].sort(),
  lockfiles: [...LOCKFILES].sort(),
  generatedSuffixes: [...GENERATED_SUFFIXES].sort(),
  binaryExtensions: [...BINARY_EXTS].sort(),
};

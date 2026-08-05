/**
 * Rewrites src/lib/vendor-hashes.ts from what is currently in public/vendor.
 *
 * Deliberately a separate command rather than something a test does for you:
 * a hash file that updates itself whenever it disagrees with reality is not a
 * check, it is a rubber stamp.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    statSync(full).isDirectory() ? walk(full, out) : out.push(full);
  }
  return out;
}

const files = walk('public/vendor').filter((f) => /\.(js|mjs|wasm)$/.test(f)).sort();
const existing = readFileSync('src/lib/vendor-hashes.ts', 'utf8');
const header = existing.slice(0, existing.indexOf('export const'));

const body = files
  .map((file) => {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    return `  '${file}':\n    '${hash}',`;
  })
  .join('\n');

writeFileSync('src/lib/vendor-hashes.ts', `${header}export const VENDORED_HASHES: Record<string, string> = {\n${body}\n};\n`);
console.log(`hashed ${files.length} vendored files`);

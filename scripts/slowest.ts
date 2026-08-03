/**
 * Find files that the classifier is pathologically slow on.
 *
 * Downloads a repository tarball and times countLines() per file, printing the
 * worst offenders. A healthy file classifies at roughly the measured 7 KB/ms;
 * anything orders of magnitude off that is a bug in the state machine rather
 * than a big file, and on Workers it is the difference between a result and a
 * CPU-killed isolate.
 *
 *   npx vite-node scripts/slowest.ts -- owner/repo [ref]
 */

import { countLines } from '../src/lib/count';
import { detectLanguage } from '../src/lib/languages';
import { decidePath } from '../src/lib/ignore';
import { readTar, gunzipStream, stripArchiveRoot } from '../src/lib/tar';

const [target, ref = 'HEAD'] = process.argv.slice(2).filter((a) => a !== '--');
if (!target) {
  console.error('usage: vite-node scripts/slowest.ts -- owner/repo [ref]');
  process.exit(1);
}
const [owner, repo] = target.split('/');

const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;
const response = await fetch(url, { headers: { 'user-agent': 'loc1999-profile' } });
if (!response.ok || !response.body) {
  console.error(`fetch failed: ${response.status}`);
  process.exit(1);
}

interface Timing {
  path: string;
  bytes: number;
  ms: number;
}

const timings: Timing[] = [];
let totalMs = 0;

const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });

for await (const entry of readTar(gunzipStream(response.body), {
  wanted: (path, size) => {
    const clean = stripArchiveRoot(path);
    if (!clean) return false;
    const decision = decidePath(clean, size);
    return decision.skip === false;
  },
})) {
  const clean = stripArchiveRoot(entry.path);
  if (!clean || !entry.data) continue;
  const language = detectLanguage(clean);
  if (!language) continue;

  const text = decoder.decode(entry.data);
  const started = performance.now();
  countLines(text, language);
  const ms = performance.now() - started;
  totalMs += ms;
  timings.push({ path: clean, bytes: entry.data.byteLength, ms });
}

timings.sort((a, b) => b.ms - a.ms);
console.log(`${timings.length} files classified in ${totalMs.toFixed(0)} ms\n`);
console.log('slowest:');
for (const t of timings.slice(0, 15)) {
  const kb = t.bytes / 1024;
  const perKb = t.ms / Math.max(0.001, kb);
  console.log(
    `  ${t.ms.toFixed(1).padStart(9)} ms  ${kb.toFixed(1).padStart(8)} KB  ` +
      `${perKb.toFixed(3).padStart(9)} ms/KB  ${t.path}`,
  );
}

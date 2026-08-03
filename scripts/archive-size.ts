/**
 * Compare a repository's compressed archive against the countable text inside.
 *
 * The pre-flight CPU guard bounds countable text, but every byte of the archive
 * has to be decompressed first whether it is counted or not. Where those two
 * numbers diverge badly, the guard is blind to most of the work.
 *
 *   npx vite-node scripts/archive-size.ts -- owner/repo [owner/repo ...]
 */

import { countLines } from '../src/lib/count';
import { detectLanguage } from '../src/lib/languages';
import { decidePath, looksBinary } from '../src/lib/ignore';
import { readTar, gunzipStream, stripArchiveRoot } from '../src/lib/tar';

const targets = process.argv.slice(2).filter((a) => a !== '--' && a.includes('/'));
if (targets.length === 0) {
  console.error('usage: vite-node scripts/archive-size.ts -- owner/repo [owner/repo ...]');
  process.exit(1);
}

/** Counts bytes flowing through, so the compressed size is measured, not guessed. */
function measured(stream: ReadableStream<Uint8Array>, onTotal: (n: number) => void) {
  let total = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        onTotal(total);
      },
    }),
  );
}

const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });

console.log(
  'repo'.padEnd(28) + 'archive'.padStart(10) + 'text'.padStart(10) +
    'ratio'.padStart(8) + '  classify',
);

for (const target of targets) {
  const response = await fetch(`https://codeload.github.com/${target}/tar.gz/HEAD`, {
    headers: { 'user-agent': 'loc1999-profile' },
    redirect: 'follow',
  });
  if (!response.ok || !response.body) {
    console.log(`${target.padEnd(28)} fetch failed ${response.status}`);
    continue;
  }

  let archiveBytes = 0;
  let textBytes = 0;
  let classifyMs = 0;

  const counted = measured(response.body, (n) => {
    archiveBytes = n;
  });

  for await (const entry of readTar(gunzipStream(counted), {
    wanted: (path, size) => {
      const clean = stripArchiveRoot(path);
      return clean ? decidePath(clean, size).skip === false : false;
    },
  })) {
    const clean = stripArchiveRoot(entry.path);
    if (!clean || !entry.data) continue;
    const language = detectLanguage(clean);
    if (!language || looksBinary(entry.data)) continue;
    const text = decoder.decode(entry.data);
    textBytes += entry.data.byteLength;
    const started = performance.now();
    countLines(text, language);
    classifyMs += performance.now() - started;
  }

  const mib = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
  console.log(
    target.padEnd(28) +
      mib(archiveBytes).padStart(10) +
      mib(textBytes).padStart(10) +
      `${(archiveBytes / Math.max(1, textBytes)).toFixed(1)}x`.padStart(8) +
      `  ${classifyMs.toFixed(0)} ms`,
  );
}

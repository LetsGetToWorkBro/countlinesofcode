/**
 * Check that what the live site serves is what this repository builds.
 *
 *   npm run verify:live
 *   npm run verify:live -- https://1999loc.com
 *
 * ## Why this exists
 *
 * Every other check on this site protects against being wrong. This one
 * protects against being *replaced*. The pages here are honest and the tests
 * prove it, and none of that helps if the bytes reaching a visitor's browser
 * are not the bytes in this repository. For a page that generates keys, that is
 * not a hypothetical: an altered script on a single day harvests everything
 * made that day, and it would look completely normal.
 *
 * So: fetch every asset from the live origin, hash it, and compare against the
 * working tree. A difference is either an ordinary deploy lag, in which case
 * checking out the commit the site reports makes it go away, or something that
 * needs explaining.
 *
 * ## The honest limit, which matters
 *
 * Run against a machine and network you already trust, this is a real check.
 * Run by the same party that could have altered the site, it proves nothing:
 * anyone able to change what is served could also change what this reports. It
 * is written to be run by *other people*, which is why it needs nothing but a
 * clone and node, and why its output is a list of hashes anyone can compare
 * with anyone else.
 *
 * The strongest version does not involve this script at all: two people who
 * have never spoken run it independently and get the same hashes.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const ORIGIN = (process.argv[2] ?? 'https://1999loc.com').replace(/\/$/, '');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    entry.isDirectory() ? walk(full, out) : out.push(full);
  }
  return out;
}

/* _headers is configuration for the edge, not an asset, and is never served. */
const SKIP = new Set(['public/_headers']);

const files = walk('public')
  .filter((f) => !SKIP.has(f.replace(/\\/g, '/')))
  .sort();

console.log(`Comparing ${files.length} assets against ${ORIGIN}\n`);

let same = 0;
const differences = [];
const missing = [];

for (const file of files) {
  const path = '/' + relative('public', file).replace(/\\/g, '/');
  const local = sha256(readFileSync(file));

  let response;
  try {
    response = await fetch(ORIGIN + path);
  } catch (error) {
    missing.push(`${path}  (could not fetch: ${error.message})`);
    continue;
  }
  if (!response.ok) {
    missing.push(`${path}  (HTTP ${response.status})`);
    continue;
  }

  const live = sha256(new Uint8Array(await response.arrayBuffer()));
  if (live === local) {
    same++;
  } else {
    differences.push({ path, local, live });
  }
}

for (const d of differences) {
  console.log(`DIFFERS ${d.path}`);
  console.log(`        repo ${d.local}`);
  console.log(`        live ${d.live}`);
}
for (const m of missing) console.log(`MISSING ${m}`);

console.log(`\n${same} identical, ${differences.length} different, ${missing.length} unreachable.`);

// The commit the running Worker says it was built from, so a difference can be
// told apart from simply having the wrong checkout.
try {
  const meta = await (await fetch(`${ORIGIN}/api/meta`)).json();
  console.log(`\nThe live site reports it was built from commit ${meta.source_commit ?? '(not set)'}.`);
  console.log('If anything differed above, check out that commit and run this again before drawing conclusions.');
} catch {
  console.log('\nCould not read /api/meta, so the deployed commit is unknown.');
}

if (differences.length) {
  console.log('\nA difference that survives checking out the reported commit is worth reporting.');
}
process.exit(differences.length || missing.length ? 1 : 0);

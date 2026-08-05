/**
 * Downloads the OCR language data into public/vendor/tesseract.
 *
 *   node scripts/fetch-tessdata.mjs
 *
 * Run once, by hand, and the result is committed like every other vendored
 * file. It is not part of `npm run check`, because a test suite that reaches
 * out to the network is a test suite that fails when the network does.
 *
 * The data is not in the npm package: tesseract.js fetches it from a CDN at
 * runtime by default, which `connect-src 'self'` forbids and which would mean
 * telling a third party that somebody is OCR'ing a document — the opposite of
 * the point of this site.
 *
 * `tessdata_fast` rather than the full model: about 4 MB instead of about 15,
 * for a small accuracy cost on clean scans. Anyone downloading this to read a
 * payslip does not want fifteen megabytes first.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const TESSDATA = {
  url: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/eng.traineddata',
  to: 'public/vendor/tesseract/eng.traineddata',
  /** Enough to catch an error page saved in its place. */
  minBytes: 1_000_000,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const response = await fetch(TESSDATA.url);
  if (!response.ok) throw new Error(`Could not download the language data: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < TESSDATA.minBytes) {
    throw new Error(`That download was only ${bytes.length} bytes — probably an error page, not the model.`);
  }
  writeFileSync(join(root, TESSDATA.to), bytes);
  console.log(`${TESSDATA.to} ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
}

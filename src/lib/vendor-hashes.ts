/**
 * What the vendored libraries are, byte for byte.
 *
 * Five third-party libraries are served from this origin, and between them they
 * are the largest thing here that nobody on this project wrote: pdf.js,
 * OpenPGP.js, mediabunny, Tesseract and libheif. The security policy forbids
 * loading a script from anywhere else precisely so that these are the only
 * outside code that runs, which makes them the place worth watching.
 *
 * These hashes are what `npm run vendor:pdfjs` produced from the published
 * packages. A changed hash means a library was updated, which is fine and
 * expected, or that a file in public/vendor was altered without going through
 * that script, which is not. Either way it should be a decision somebody made
 * rather than something that happened.
 *
 * Regenerate deliberately, after checking what changed:
 *   npm run hash:vendor
 */
export const VENDORED_HASHES: Record<string, string> = {
  'public/vendor/libheif/libheif-bundle.js':
    '793b36c913689784b2bfba60456fd87c14ed49e2d13f3b4d2611baaf05148f81',
  'public/vendor/mediabunny/mediabunny.min.mjs':
    '558a756ce3b08175145be6ffe5aaf3ec98ea2ae7302df8f8d958dbdca7744fb6',
  'public/vendor/openpgp/openpgp.min.mjs':
    '6bd32571c519dca96e7e2be6c7a578a12cd60d18f05a07af1a1475e1d34bbd03',
  'public/vendor/pdf.min.mjs':
    '9fab0c910bf1484835c5c2aeb68f7eb3dfce7f9eb435a004526c5af86d70890c',
  'public/vendor/pdf.worker.min.mjs':
    'bc0d1b88ea0b66196b1d36a58ac243c6d92adfe725624e2a9fdd381bdf8ef434',
  'public/vendor/tesseract/tesseract-core-simd-lstm.wasm.js':
    '9d7c43fb206dc9f48475228b46bf35f888fa9e6259da2e67d5a75c77049f2dc7',
  'public/vendor/tesseract/tesseract.min.js':
    '000c27d9cd0def655f77b36c72a389c0ab13793aa31cb4d7aab56d09c0afbc7e',
  'public/vendor/tesseract/worker.min.js':
    '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d',
};

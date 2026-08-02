/**
 * Generates public/favicon.ico and public/favicon.svg from one 16x16 pixel
 * grid, so the two can never drift. Run: node scripts/make-favicon.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 16;
const BG = [0xff, 0xff, 0xff]; // white
const BORDER = [0x00, 0x00, 0x00]; // black
const INK = [0x00, 0x00, 0x80]; // navy

// 3x5 bitmap font, just enough for L O C.
const GLYPHS = {
  L: ['100', '100', '100', '100', '111'],
  O: ['111', '101', '101', '101', '111'],
  C: ['111', '100', '100', '100', '111'],
};

/** 16x16 grid of colour triples. */
function buildGrid() {
  const grid = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => BG));

  for (let i = 0; i < SIZE; i++) {
    grid[0][i] = BORDER;
    grid[SIZE - 1][i] = BORDER;
    grid[i][0] = BORDER;
    grid[i][SIZE - 1] = BORDER;
  }

  const word = 'LOC';
  const originX = 2;
  const originY = 5;
  word.split('').forEach((letter, index) => {
    const rows = GLYPHS[letter];
    rows.forEach((row, y) => {
      row.split('').forEach((cell, x) => {
        if (cell === '1') grid[originY + y][originX + index * 4 + x] = INK;
      });
    });
  });

  return grid;
}

function writeIco(grid, path) {
  const xorRow = SIZE * 4;
  const xorSize = xorRow * SIZE;
  const andRow = 4; // ((16 + 31) / 32) * 4
  const andSize = andRow * SIZE;
  const dibSize = 40 + xorSize + andSize;

  const buffer = Buffer.alloc(6 + 16 + dibSize);
  let offset = 0;

  buffer.writeUInt16LE(0, offset); offset += 2;        // reserved
  buffer.writeUInt16LE(1, offset); offset += 2;        // type: icon
  buffer.writeUInt16LE(1, offset); offset += 2;        // image count

  buffer.writeUInt8(SIZE, offset); offset += 1;        // width
  buffer.writeUInt8(SIZE, offset); offset += 1;        // height
  buffer.writeUInt8(0, offset); offset += 1;           // palette size
  buffer.writeUInt8(0, offset); offset += 1;           // reserved
  buffer.writeUInt16LE(1, offset); offset += 2;        // colour planes
  buffer.writeUInt16LE(32, offset); offset += 2;       // bits per pixel
  buffer.writeUInt32LE(dibSize, offset); offset += 4;  // bytes in resource
  buffer.writeUInt32LE(22, offset); offset += 4;       // offset to data

  // BITMAPINFOHEADER
  buffer.writeUInt32LE(40, offset); offset += 4;
  buffer.writeInt32LE(SIZE, offset); offset += 4;
  buffer.writeInt32LE(SIZE * 2, offset); offset += 4;  // XOR + AND
  buffer.writeUInt16LE(1, offset); offset += 2;
  buffer.writeUInt16LE(32, offset); offset += 2;
  buffer.writeUInt32LE(0, offset); offset += 4;        // BI_RGB
  buffer.writeUInt32LE(xorSize + andSize, offset); offset += 4;
  buffer.writeInt32LE(2835, offset); offset += 4;
  buffer.writeInt32LE(2835, offset); offset += 4;
  buffer.writeUInt32LE(0, offset); offset += 4;
  buffer.writeUInt32LE(0, offset); offset += 4;

  // Pixels, bottom-up, BGRA.
  for (let y = SIZE - 1; y >= 0; y--) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = grid[y][x];
      buffer.writeUInt8(b, offset); offset += 1;
      buffer.writeUInt8(g, offset); offset += 1;
      buffer.writeUInt8(r, offset); offset += 1;
      buffer.writeUInt8(0xff, offset); offset += 1;
    }
  }
  // AND mask: fully opaque (all zero bits).
  offset += andSize;

  writeFileSync(path, buffer);
  return buffer.length;
}

function writeSvg(grid, path) {
  const rects = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = grid[y][x];
      if (r === BG[0] && g === BG[1] && b === BG[2]) continue;
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${hex}"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">
<rect width="16" height="16" fill="#ffffff"/>
${rects.join('\n')}
</svg>
`;
  writeFileSync(path, svg);
  return svg.length;
}

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');
const grid = buildGrid();
console.log('favicon.ico', writeIco(grid, join(publicDir, 'favicon.ico')), 'bytes');
console.log('favicon.svg', writeSvg(grid, join(publicDir, 'favicon.svg')), 'bytes');

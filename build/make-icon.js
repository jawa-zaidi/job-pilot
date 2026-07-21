// Generates build/icon.png (512x512, RGBA) with no external dependencies.
// electron-builder derives the Windows .ico and other sizes from this file at
// build time, so this is the single source of truth for the app icon.
//
// Design: indigo rounded-square background with a white paper-plane mark —
// the ✈️ from "JobPilot". Run with:  node build/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;

// --- CRC32 (for PNG chunks) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// --- geometry helpers ---
function sign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}
function inTriangle(px, py, a, b, c) {
  const d1 = sign(px, py, a[0], a[1], b[0], b[1]);
  const d2 = sign(px, py, b[0], b[1], c[0], c[1]);
  const d3 = sign(px, py, c[0], c[1], a[0], a[1]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// Colors
const BG_TOP = [79, 70, 229];    // indigo-600
const BG_BOT = [67, 56, 202];    // indigo-700
const WHITE = [255, 255, 255];
const WHITE_DIM = [214, 219, 245]; // shaded wing

// Paper-plane triangles (in a 512 space), roughly centered.
const body = [[120, 300], [400, 130], [270, 300]]; // main upper wing
const tail = [[270, 300], [400, 130], [300, 400]];  // lower fin
const wingShade = [[120, 300], [270, 300], [230, 360]]; // small shaded flap

const radius = 96; // rounded-corner radius
function inRoundedSquare(x, y) {
  const r = radius;
  if (x >= r && x <= SIZE - r) return y >= 0 && y <= SIZE;
  if (y >= r && y <= SIZE - r) return x >= 0 && x <= SIZE;
  // corners
  const cx = x < r ? r : SIZE - r;
  const cy = y < r ? r : SIZE - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Build raw RGBA scanlines with a filter byte per row.
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r, g, b, a;
    if (!inRoundedSquare(x + 0.5, y + 0.5)) {
      r = g = b = a = 0; // transparent outside rounded square
    } else {
      const t = y / SIZE;
      r = Math.round(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t);
      g = Math.round(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t);
      b = Math.round(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t);
      a = 255;
      const px = x + 0.5, py = y + 0.5;
      if (inTriangle(px, py, wingShade[0], wingShade[1], wingShade[2])) {
        [r, g, b] = WHITE_DIM;
      } else if (
        inTriangle(px, py, body[0], body[1], body[2]) ||
        inTriangle(px, py, tail[0], tail[1], tail[2])
      ) {
        [r, g, b] = WHITE;
      }
    }
    raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
  }
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
ihdr[10] = 0;  // compression
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // interlace
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log(`Wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);

#!/usr/bin/env node
// Generates every PWA icon in public/icons from scratch — no image libraries,
// no dependencies, just Node built-ins (zlib deflates the raw pixels into a
// real PNG). Re-run after changing the mark or the palette:
//
//   node scripts/generate-icons.js
//
// The mark is the "✈️ JobPilot" paper plane: a white dart with a shaded fold,
// on the same accent → accent2 gradient the app uses for .btn-primary.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

// ---------- palette (kept in sync with public/styles.css :root) ----------
const ACCENT = [0x4f, 0x8c, 0xff];   // --accent  #4f8cff
const ACCENT2 = [0x7c, 0x5c, 0xff];  // --accent2 #7c5cff
const WHITE = [0xff, 0xff, 0xff];
const FOLD = [0xc4, 0xd2, 0xf4];     // the folded-under wing, a cool shaded white

// ---------- the paper plane, drawn in a 24x24 design box ----------
// Silhouette is a single concave polygon (CREASE is the notch between the two
// wings); FIN is the smaller facet we shade so the fold reads at a glance.
const TIP = [22.2, 3.2], LWING = [2.0, 12.4], CREASE = [9.6, 14.6], TAIL = [12.9, 21.2];
const SILHOUETTE = [TIP, LWING, CREASE, TAIL];
const FIN = [TIP, CREASE, TAIL];
const BOX = { x: 2.0, y: 3.2, w: 20.2, h: 18.0 }; // bounding box of the mark

const SAMPLES = 4; // 4x4 supersampling per pixel → clean anti-aliased edges

// ---------- geometry ----------
function insidePolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Rounded-square mask: clamp the point into the inner rect, then a radius test.
function insideRoundRect(x, y, size, radius) {
  if (radius <= 0) return x >= 0 && y >= 0 && x <= size && y <= size;
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function gradientAt(x, y, size) {
  const t = Math.min(1, Math.max(0, (x + y) / (2 * size)));
  return [
    Math.round(ACCENT[0] + (ACCENT2[0] - ACCENT[0]) * t),
    Math.round(ACCENT[1] + (ACCENT2[1] - ACCENT[1]) * t),
    Math.round(ACCENT[2] + (ACCENT2[2] - ACCENT[2]) * t)
  ];
}

// ---------- rasteriser ----------
// opts: { size, radiusPct, planePct, fold }
//   radiusPct 0 → full-bleed square (what `maskable` and iOS want, since the
//   platform applies its own mask); > 0 → rounded square with alpha corners.
function renderRGBA({ size, radiusPct, planePct, fold }) {
  const radius = radiusPct * size;
  // Fit the mark's bounding box into planePct of the canvas and centre it.
  const scale = (planePct * size) / Math.max(BOX.w, BOX.h);
  const offX = (size - BOX.w * scale) / 2 - BOX.x * scale;
  const offY = (size - BOX.h * scale) / 2 - BOX.y * scale;
  const toDesign = (px, py) => [(px - offX) / scale, (py - offY) / scale];

  const px = Buffer.alloc(size * size * 4);
  const step = 1 / SAMPLES;
  const total = SAMPLES * SAMPLES;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const fx = x + (sx + 0.5) * step;
          const fy = y + (sy + 0.5) * step;
          if (!insideRoundRect(fx, fy, size, radius)) continue; // transparent corner
          hits++;
          const [dx, dy] = toDesign(fx, fy);
          let c;
          if (fold && insidePolygon(FIN, dx, dy)) c = FOLD;
          else if (insidePolygon(SILHOUETTE, dx, dy)) c = WHITE;
          else c = gradientAt(fx, fy, size);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const i = (y * size + x) * 4;
      if (hits === 0) continue; // stays 0,0,0,0
      px[i] = Math.round(r / hits);
      px[i + 1] = Math.round(g / hits);
      px[i + 2] = Math.round(b / hits);
      px[i + 3] = Math.round((hits / total) * 255);
    }
  }
  return px;
}

// ---------- PNG encoding ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Adaptive per-scanline filtering (None/Sub/Up), picked by the standard
// minimum-sum-of-absolute-differences heuristic — keeps the gradient small.
function filterScanlines(px, size) {
  const bpp = 4, stride = size * bpp;
  const out = Buffer.alloc((stride + 1) * size);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < size; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : px.subarray((y - 1) * stride, y * stride);
    const sums = [0, 0, 0];
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      cand[0][i] = row[i];
      cand[1][i] = (row[i] - a) & 0xff;
      cand[2][i] = (row[i] - up) & 0xff;
      for (let f = 0; f < 3; f++) {
        const v = cand[f][i];
        sums[f] += v < 128 ? v : 256 - v; // treat bytes as signed
      }
    }
    let best = 0;
    for (let f = 1; f < 3; f++) if (sums[f] < sums[best]) best = f;
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
  }
  return out;
}

function encodePNG(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: truecolour + alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  const idat = zlib.deflateSync(filterScanlines(px, size), { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// A .ico that simply wraps a PNG (the Vista+ form every current browser reads),
// so /favicon.ico isn't a 404 for clients that ask for it by convention.
function encodeICO(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset = 6 + 16
  return Buffer.concat([header, entry, png]);
}

// ---------- outputs ----------
// planePct is deliberately smaller on the maskable variants: platforms may crop
// everything outside the central 80% circle, so the mark has to sit well inside.
const TARGETS = [
  { file: 'icon-192.png',           size: 192, radiusPct: 0.22, planePct: 0.62, fold: true },
  { file: 'icon-512.png',           size: 512, radiusPct: 0.22, planePct: 0.62, fold: true },
  { file: 'icon-192-maskable.png',  size: 192, radiusPct: 0,    planePct: 0.56, fold: true },
  { file: 'icon-512-maskable.png',  size: 512, radiusPct: 0,    planePct: 0.56, fold: true },
  { file: 'apple-touch-icon.png',   size: 180, radiusPct: 0,    planePct: 0.58, fold: true },
  { file: 'favicon-32.png',         size: 32,  radiusPct: 0.22, planePct: 0.72, fold: false },
  { file: 'favicon-16.png',         size: 16,  radiusPct: 0.20, planePct: 0.78, fold: false }
];

fs.mkdirSync(OUT_DIR, { recursive: true });
let ico32 = null;
for (const t of TARGETS) {
  const png = encodePNG(renderRGBA(t), t.size);
  fs.writeFileSync(path.join(OUT_DIR, t.file), png);
  if (t.file === 'favicon-32.png') ico32 = png;
  console.log(`wrote icons/${t.file}  ${t.size}x${t.size}  ${png.length} bytes`);
}
const ico = encodeICO(ico32, 32);
fs.writeFileSync(path.join(__dirname, '..', 'public', 'favicon.ico'), ico);
console.log(`wrote favicon.ico  32x32  ${ico.length} bytes`);

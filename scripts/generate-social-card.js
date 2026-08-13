#!/usr/bin/env node
// Generates site/icons/social-card.png — the 1200x630 image that Twitter/X,
// Slack, LinkedIn, Discord and iMessage show when someone shares the landing
// page. Re-run after changing the mark, the wordmark or the palette:
//
//   node scripts/generate-social-card.js
//
// Same rules as its sibling scripts/generate-icons.js: pure Node built-ins, no
// image library, no fonts to load, no build step. zlib deflates raw pixels into
// a real PNG. The PNG encoder is deliberately a copy of the one in
// generate-icons.js rather than a shared import, so either script can be run,
// read or moved on its own.
//
// Why a bespoke image at all: the page used to hand the square 512px app icon
// to og:image, and a square in a 1.91:1 slot gets cropped to ribbons.
//
// COLOUR: every colour here is computed from the OKLCH tokens in site/styles.css
// (oklchToRgb below does the conversion the browser does), so the card cannot
// drift away from the site it advertises. Nothing is hand-picked in hex.
//
// TEXT: the wordmark is drawn from geometric primitives — circles, rings and
// rounded bars — not set in a font. Rasterising Instrument Sans would mean
// decoding a woff2 and interpreting glyf outlines, which is a great deal of
// machinery to render eight letters exactly once.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'site', 'icons', 'social-card.png');
const W = 1200;
const H = 630;
const SAMPLES = 3; // 3x3 supersampling per pixel

// ---------- colour: OKLCH -> sRGB ----------
// The same transform CSS Color 4 specifies, so oklch(0.55 0.14 250) here is the
// pixel a browser paints for --accent in site/styles.css.
function oklchToRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;

  const lin = [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ];
  return lin.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  });
}

// ---------- the palette, straight out of site/styles.css :root ----------
const BG = oklchToRgb(0.985, 0.008, 85);      // --bg
const SURFACE = oklchToRgb(1, 0, 0);          // --surface
const LINE = oklchToRgb(0.905, 0.012, 85);    // --line
const INK = oklchToRgb(0.26, 0.015, 60);      // --ink
const ACCENT = oklchToRgb(0.55, 0.14, 250);   // --accent
const ACCENT_SOFT = oklchToRgb(0.955, 0.03, 250); // --accentSoft

// The tile carries a shallow lightness ramp so it reads as an object rather
// than a flat swatch. It is --accent at both ends: only L moves, C and h are
// the token's own, so no new hue is invented.
const TILE_TOP = oklchToRgb(0.60, 0.14, 250);
const TILE_BOTTOM = oklchToRgb(0.50, 0.14, 250);
// The folded-under wing. --accentSoft is the palest blue the site owns, which
// is exactly what a white wing turned away from the light should be.
const FOLD = ACCENT_SOFT;

// ---------- geometry helpers ----------
function insidePolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideRoundRect(x, y, rx, ry, w, h, r) {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  if (r <= 0) return true;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Annulus (optionally a sector of one). Angles in degrees, 0 = +x, growing
// clockwise on screen because y points down.
function insideRing(x, y, cx, cy, ro, ri, a0, a1) {
  const dx = x - cx, dy = y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 > ro * ro || d2 < ri * ri) return false;
  if (a0 === undefined) return true;
  let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (ang < 0) ang += 360;
  return ang >= a0 && ang <= a1;
}

// ---------- the wordmark ----------
// A geometric sans built from bars and rings, drawn on a 100-unit cap height
// with the baseline at y = 100. Only the eight letters of "JobPilot" exist.
const CAP = 100;   // cap height (J, P, b, l)
const XH = 72;     // x-height (o, and the shoulder of b)
const STEM = 15;   // stroke weight

const GLYPHS = {
  // Stem down the right, then a half-turn left along the baseline.
  J: { adv: 63, parts: [
    { t: 'rect', x: 40.5, y: 0, w: STEM, h: 68.5, r: 0 },
    { t: 'ring', cx: 24, cy: 68.5, ro: 31.5, ri: 16.5, a0: 0, a1: 180 }
  ] },
  o: { adv: 72, parts: [
    { t: 'ring', cx: 36, cy: CAP - XH / 2, ro: XH / 2, ri: XH / 2 - STEM }
  ] },
  // Full-height stem with an x-height bowl; the bowl's left arc hides inside
  // the stem, which is what gives the join its weight.
  b: { adv: 72, parts: [
    { t: 'rect', x: 0, y: 0, w: STEM, h: CAP, r: 0 },
    { t: 'ring', cx: 36, cy: CAP - XH / 2, ro: XH / 2, ri: XH / 2 - STEM }
  ] },
  P: { adv: 62, parts: [
    { t: 'rect', x: 0, y: 0, w: STEM, h: CAP, r: 0 },
    { t: 'ring', cx: 30, cy: 30, ro: 30, ri: 15 }
  ] },
  i: { adv: 15, parts: [
    { t: 'rect', x: 0, y: CAP - XH, w: STEM, h: XH, r: 0 },
    { t: 'ring', cx: STEM / 2, cy: 13, ro: 8.5, ri: 0 }
  ] },
  l: { adv: 15, parts: [
    { t: 'rect', x: 0, y: 0, w: STEM, h: CAP, r: 0 }
  ] },
  // Futura-style: a plain stem through a crossbar, no tail.
  t: { adv: 48, parts: [
    { t: 'rect', x: 18, y: 12, w: STEM, h: CAP - 12, r: 0 },
    { t: 'rect', x: 5, y: 26, w: 38, h: 13, r: 0 }
  ] }
};

const WORD = 'JobPilot';

// Uniform letter spacing leaves visible holes either side of the two narrow
// letters, because tracking is added to an advance that is already only a stem
// wide. One kerning rule fixes the whole word.
const NARROW = new Set(['i', 'l']);
function track(a, b) {
  return NARROW.has(a) || NARROW.has(b) ? 8 : 13;
}

function wordWidth() {
  let w = 0;
  for (let i = 0; i < WORD.length; i++) {
    w += GLYPHS[WORD[i]].adv;
    if (i < WORD.length - 1) w += track(WORD[i], WORD[i + 1]);
  }
  return w;
}

// x0/baseline in card pixels, scale = pixels per cap-height unit.
function makeWordmark(x0, baseline, scale) {
  const parts = [];
  let pen = x0;
  for (let i = 0; i < WORD.length; i++) {
    const g = GLYPHS[WORD[i]];
    for (const p of g.parts) {
      if (p.t === 'rect') {
        parts.push({ t: 'rect', x: pen + p.x * scale, y: baseline + (p.y - CAP) * scale,
                     w: p.w * scale, h: p.h * scale, r: (p.r || 0) * scale });
      } else {
        parts.push({ t: 'ring', cx: pen + p.cx * scale, cy: baseline + (p.cy - CAP) * scale,
                     ro: p.ro * scale, ri: p.ri * scale, a0: p.a0, a1: p.a1 });
      }
    }
    if (i < WORD.length - 1) pen += (g.adv + track(WORD[i], WORD[i + 1])) * scale;
  }
  return (x, y) => parts.some((p) => p.t === 'rect'
    ? insideRoundRect(x, y, p.x, p.y, p.w, p.h, p.r)
    : insideRing(x, y, p.cx, p.cy, p.ro, p.ri, p.a0, p.a1));
}

// ---------- the mark ----------
// The same paper plane scripts/generate-icons.js draws, in the same 24x24
// design box, so the card and the app icon are the one mark.
const TIP = [22.2, 3.2], LWING = [2.0, 12.4], CREASE = [9.6, 14.6], TAIL = [12.9, 21.2];
const SILHOUETTE = [TIP, LWING, CREASE, TAIL];
const FIN = [TIP, CREASE, TAIL];
const BOX = { x: 2.0, y: 3.2, w: 20.2, h: 18.0 };

// ---------- layout ----------
// Everything sits in a centred group no wider than 630px, so the composition
// survives a square crop as well as the wide one. The card panel is inset far
// enough that a platform trimming the edges takes only background.
const PANEL = { x: 56, y: 44, w: W - 112, h: H - 88, r: 40 };

const TILE_SIZE = 152;
const GAP = 38;
const CAP_PX = 92;                       // wordmark cap height on the card
const WORD_PX = wordWidth() * (CAP_PX / CAP);
const GROUP_W = TILE_SIZE + GAP + WORD_PX;
const GROUP_X = Math.round((W - GROUP_W) / 2);
const GROUP_MID = Math.round(H / 2) - 14; // lifted slightly for the rule below

const TILE = { x: GROUP_X, y: GROUP_MID - TILE_SIZE / 2, size: TILE_SIZE, r: TILE_SIZE * 0.22 };
const WORD_X = GROUP_X + TILE_SIZE + GAP;
const BASELINE = GROUP_MID + CAP_PX / 2;
const inWord = makeWordmark(WORD_X, BASELINE, CAP_PX / CAP);

// A short accent rule under the group — the site's own hairline, in accent, so
// the card is not two objects floating in space.
const RULE = { x: Math.round((W - 132) / 2), y: GROUP_MID + TILE_SIZE / 2 + 46, w: 132, h: 7, r: 3.5 };

// Plane geometry mapped into the tile.
const planeScale = (0.60 * TILE.size) / Math.max(BOX.w, BOX.h);
const planeOffX = TILE.x + (TILE.size - BOX.w * planeScale) / 2 - BOX.x * planeScale;
const planeOffY = TILE.y + (TILE.size - BOX.h * planeScale) / 2 - BOX.y * planeScale;

function sampleColour(x, y) {
  // Front to back.
  if (insideRoundRect(x, y, TILE.x, TILE.y, TILE.size, TILE.size, TILE.r)) {
    const dx = (x - planeOffX) / planeScale, dy = (y - planeOffY) / planeScale;
    if (insidePolygon(FIN, dx, dy)) return FOLD;
    if (insidePolygon(SILHOUETTE, dx, dy)) return SURFACE;
    const t = Math.min(1, Math.max(0, (y - TILE.y) / TILE.size));
    return [0, 1, 2].map((i) => Math.round(TILE_TOP[i] + (TILE_BOTTOM[i] - TILE_TOP[i]) * t));
  }
  if (inWord(x, y)) return INK;
  if (insideRoundRect(x, y, RULE.x, RULE.y, RULE.w, RULE.h, RULE.r)) return ACCENT;

  // The panel: a white card with the site's hairline border, on --bg.
  const onPanel = insideRoundRect(x, y, PANEL.x, PANEL.y, PANEL.w, PANEL.h, PANEL.r);
  if (!onPanel) return BG;
  const inner = insideRoundRect(x, y, PANEL.x + 2, PANEL.y + 2, PANEL.w - 4, PANEL.h - 4, PANEL.r - 2);
  return inner ? SURFACE : LINE;
}

// ---------- raster ----------
function render() {
  const px = Buffer.alloc(W * H * 3);
  const step = 1 / SAMPLES;
  const total = SAMPLES * SAMPLES;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = sampleColour(x + (sx + 0.5) * step, y + (sy + 0.5) * step);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const i = (y * W + x) * 3;
      px[i] = Math.round(r / total);
      px[i + 1] = Math.round(g / total);
      px[i + 2] = Math.round(b / total);
    }
  }
  return px;
}

// ---------- PNG encoding (see the note at the top of the file) ----------
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

function filterScanlines(px, w, h, bpp) {
  const stride = w * bpp;
  const out = Buffer.alloc((stride + 1) * h);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < h; y++) {
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
        sums[f] += v < 128 ? v : 256 - v;
      }
    }
    let best = 0;
    for (let f = 1; f < 3; f++) if (sums[f] < sums[best]) best = f;
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
  }
  return out;
}

function encodePNG(px, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolour, no alpha — a social card is never transparent,
                // and some clients composite alpha onto black.
  const idat = zlib.deflateSync(filterScanlines(px, w, h, 3), { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const png = encodePNG(render(), W, H);
fs.writeFileSync(OUT, png);
console.log(`wrote site/icons/social-card.png  ${W}x${H}  ${png.length} bytes`);
console.log(`  group ${GROUP_W.toFixed(0)}px wide, centred — survives a square crop`);

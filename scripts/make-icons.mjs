/**
 * PWA のアイコンを作る（SPEC §12.4「アイコンは飛行機モチーフ」）。
 *
 *   node scripts/make-icons.mjs
 *
 * 出力: `web/public/icon-192.png` `icon-512.png` `icon-maskable-512.png` `apple-touch-icon.png`
 * と、ブラウザのタブ用の `web/public/icon.svg`。
 *
 * 画像変換の依存（sharp / rsvg）を足したくないので、Node の zlib だけで PNG を書く。
 * 飛行機は `web/src/components/Icons.tsx` の `PlaneIcon` と同じ形（紙飛行機）を、
 * 太さのある線分と三角形として置いてから 4x のスーパーサンプリングでならす。
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "web/public");

/** tokens.css の --ap（アクセント）と --paper。 */
const INK = [0xff, 0xff, 0xff];
const BG = [0x27, 0x48, 0xe8];

/* ── 形（24x24 の座標系。PlaneIcon と同じ） ─────────── */

// 紙飛行機の外形（塗り）と、折り目の線。PlaneIcon の path をなぞった多角形。
const BODY = [
  [21, 3],
  [12, 20],
  [9.5, 13],
];
const WING = [
  [21, 3],
  [9.5, 13],
  [3, 10.5],
];
const CREASE = [
  [9.5, 13],
  [21, 3],
];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 線分までの距離（折り目を白で抜くため）。 */
function distToSegment(x, y, [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/**
 * 図案の1点。戻り値は 0..1 の「インクの濃さ」。
 * `pad` は端の余白（maskable は安全域のぶん内側に描く）。
 */
function ink(u, v, pad) {
  // u,v は 0..1。24x24 の座標系に、pad ぶん縮めて置く
  const scale = 1 - pad * 2;
  const x = ((u - pad) / scale) * 24;
  const y = ((v - pad) / scale) * 24;
  if (x < 0 || x > 24 || y < 0 || y > 24) return 0;

  // 翼側は少し薄くして、折り目が読めるようにする
  if (distToSegment(x, y, CREASE[0], CREASE[1]) < 0.35) return 0;
  if (inPolygon(x, y, BODY)) return 1;
  if (inPolygon(x, y, WING)) return 0.72;
  return 0;
}

/* ── PNG（RGBA、フィルタなし） ───────────────────────── */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 4x のスーパーサンプリングで1枚描く。`round` は角丸の半径（0..0.5）。 */
function render(size, { pad, round }) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0; // 背景（角丸の内側か）
      let inkSum = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          if (!insideRounded(u, v, round)) continue;
          cover++;
          inkSum += ink(u, v, pad);
        }
      }
      const total = S * S;
      const a = cover / total;
      const t = cover === 0 ? 0 : inkSum / cover;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(BG[c] + (INK[c] - BG[c]) * t);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, px);
}

/** 角丸の四角の内側か（`r` は 0..0.5 の割合。0.5 で円）。 */
function insideRounded(u, v, r) {
  if (r <= 0) return true;
  const dx = Math.max(r - u, 0, u - (1 - r));
  const dy = Math.max(r - v, 0, v - (1 - r));
  return Math.hypot(dx, dy) <= r;
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <rect width="24" height="24" rx="5.5" fill="#2748e8"/>
  <g fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 4.6 4.6 11.1l5.6 2.2 2.2 5.6z"/>
    <path d="M10.2 13.3 20 4.6"/>
  </g>
</svg>
`;

mkdirSync(OUT, { recursive: true });
// 通常のアイコンは角丸つき。maskable は OS が丸めるので、全面を塗って安全域（10%）に収める
writeFileSync(join(OUT, "icon-192.png"), render(192, { pad: 0.22, round: 0.22 }));
writeFileSync(join(OUT, "icon-512.png"), render(512, { pad: 0.22, round: 0.22 }));
writeFileSync(join(OUT, "icon-maskable-512.png"), render(512, { pad: 0.3, round: 0 }));
// iOS のホーム画面は角丸を自分で付けるので、こちらも全面
writeFileSync(join(OUT, "apple-touch-icon.png"), render(180, { pad: 0.24, round: 0 }));
writeFileSync(join(OUT, "icon.svg"), SVG);
console.log("wrote icons to web/public/");

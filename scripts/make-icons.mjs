/**
 * PWA のアイコンを作る（ロゴ「スレメイト」の a マーク。DECISIONS 2026-10-26）。
 *
 *   node scripts/make-icons.mjs
 *
 * 出力: `web/public/icon-192.png` `icon-512.png` `icon-maskable-512.png` `apple-touch-icon.png`
 * `badge-96.png`（通知のバッジ。白1色）と、ブラウザのタブ用の `web/public/icon.svg`。
 *
 * ロゴの「a」は下半分が「ト」に隠れているので、同じ形の書体（Georgia Bold Italic）の
 * アウトラインをパスにして持つ。画像変換の依存（sharp / rsvg）を足したくないので、
 * Node の zlib だけで PNG を書き、パスは折れ線にしてからスキャンラインで塗る（4x のスーパーサンプリング）。
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "web/public");

/** ロゴの黒と白。 */
const INK = [0xff, 0xff, 0xff];
const BG = [0x0b, 0x0b, 0x0b];

/* ── 形（100x100 の座標系。高さ 66 で中央に置いた a） ─────────── */

const GLYPH =
  "M55.01 73.16H54.5Q52.29 75.05 50.31 76.63Q48.32 78.2 45.29 79.78Q42.64 81.17 39.71 82.09Q36.77 83 33.24 83Q22.26 83 16.71 76.53Q11.15 70.07 11.15 58.83Q11.15 50.19 14.25 42.62Q17.34 35.05 22.51 29.3Q27.75 23.63 34.75 20.31Q41.76 17 49.52 17Q55.2 17 59.46 18.33Q63.71 19.65 66.43 21.92L85.8 17.95L86.68 18.96L77.41 57.76Q76.9 59.72 76.33 62.65Q75.77 65.59 75.77 67.1Q75.77 70.7 77.41 72.05Q79.05 73.41 83.09 73.41Q84.85 73.41 87.34 72.72Q89.84 72.02 90.85 71.58L89.46 77.26Q83.21 79.72 79.46 81.01Q75.7 82.31 70.78 82.31Q64.28 82.31 60.4 79.75Q56.52 77.2 55.01 73.16Z" +
  "M62.52 33.15Q62.52 31.76 62.14 29.87Q61.76 27.98 60.81 26.65Q59.68 25.01 57.85 24.16Q56.02 23.31 53.3 23.31Q49.14 23.31 45.64 26.31Q42.13 29.3 39.42 34.29Q36.77 39.21 35.26 45.74Q33.74 52.27 33.74 59.09Q33.74 62.18 34.22 64.83Q34.69 67.48 35.76 69.31Q36.9 71.26 38.82 72.34Q40.75 73.41 43.65 73.41Q46.61 73.41 49.36 71.67Q52.1 69.94 54.44 67.41Z";

/** GLYPH（M / L / H / Q / Z だけ）を線分の列にする。曲線は 12 分割。 */
function toEdges(d) {
  const tokens = d.match(/[MLHQZ]|-?\d*\.?\d+/g);
  const edges = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const num = () => Number(tokens[i++]);
  const line = (nx, ny) => {
    edges.push([x, y, nx, ny]);
    x = nx;
    y = ny;
  };
  while (i < tokens.length) {
    if (/[MLHQZ]/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === "M") {
      x = sx = num();
      y = sy = num();
      cmd = "L";
    } else if (cmd === "L") line(num(), num());
    else if (cmd === "H") line(num(), y);
    else if (cmd === "Q") {
      const [cx, cy, ex, ey] = [num(), num(), num(), num()];
      const [x0, y0] = [x, y];
      for (let k = 1; k <= 12; k++) {
        const t = k / 12;
        const u = 1 - t;
        line(u * u * x0 + 2 * u * t * cx + t * t * ex, u * u * y0 + 2 * u * t * cy + t * t * ey);
      }
    } else if (cmd === "Z") {
      if (x !== sx || y !== sy) line(sx, sy);
    }
  }
  return edges;
}

const EDGES = toEdges(GLYPH);

/** 横線 y と交わる x の一覧（偶奇規則で塗るので、並べて2つずつ組にする）。 */
function crossings(y) {
  const xs = [];
  for (const [x1, y1, x2, y2] of EDGES) {
    if (y1 > y !== y2 > y) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
  }
  return xs.sort((a, b) => a - b);
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

/**
 * 4x のスーパーサンプリングで1枚描く。
 * `pad` は a を縮める余白の割合（maskable は安全域のぶん内側に描く）、`round` は角丸の半径（0..0.5）。
 * `badge` は背景なしで a だけを白く抜く（通知のバッジ用）。
 */
function render(size, { pad, round, badge = false }) {
  const S = 4;
  const N = size * S;
  const cover = new Float32Array(size * size); // 背景（角丸の内側）
  const ink = new Float32Array(size * size); // a
  for (let sy = 0; sy < N; sy++) {
    const v = (sy + 0.5) / N;
    const py = Math.floor(sy / S);
    // a は 100x100 の座標系を pad ぶん縮めて置く
    const gy = ((v - pad) / (1 - pad * 2)) * 100;
    const xs = gy >= 0 && gy <= 100 ? crossings(gy) : [];
    for (let sx = 0; sx < N; sx++) {
      const u = (sx + 0.5) / N;
      const i = py * size + Math.floor(sx / S);
      if (!badge && !insideRounded(u, v, round)) continue;
      cover[i]++;
      const gx = ((u - pad) / (1 - pad * 2)) * 100;
      let inside = false;
      for (const x of xs) {
        if (x > gx) break;
        inside = !inside;
      }
      if (inside) ink[i]++;
    }
  }
  const px = Buffer.alloc(size * size * 4);
  const total = S * S;
  for (let i = 0; i < size * size; i++) {
    if (badge) {
      px.fill(0xff, i * 4, i * 4 + 3);
      px[i * 4 + 3] = Math.round((ink[i] / total) * 255);
      continue;
    }
    const t = cover[i] === 0 ? 0 : ink[i] / cover[i];
    for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.round(BG[c] + (INK[c] - BG[c]) * t);
    px[i * 4 + 3] = Math.round((cover[i] / total) * 255);
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

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="32" height="32">
  <rect width="100" height="100" rx="22" fill="#0b0b0b"/>
  <path fill="#fff" fill-rule="evenodd" d="${GLYPH}"/>
</svg>
`;

mkdirSync(OUT, { recursive: true });
// 通常のアイコンは角丸つき。maskable は OS が丸めるので、全面を塗って安全域（中央 80%）に収める
writeFileSync(join(OUT, "icon-192.png"), render(192, { pad: 0, round: 0.22 }));
writeFileSync(join(OUT, "icon-512.png"), render(512, { pad: 0, round: 0.22 }));
writeFileSync(join(OUT, "icon-maskable-512.png"), render(512, { pad: 0.2, round: 0 }));
// iOS のホーム画面は角丸を自分で付けるので、こちらも全面
writeFileSync(join(OUT, "apple-touch-icon.png"), render(180, { pad: 0.12, round: 0 }));
// Android の通知バッジは不透明度だけを使うので、a を白で抜いた1枚
writeFileSync(join(OUT, "badge-96.png"), render(96, { pad: 0.04, round: 0, badge: true }));
writeFileSync(join(OUT, "icon.svg"), SVG);
console.log("wrote icons to web/public/");

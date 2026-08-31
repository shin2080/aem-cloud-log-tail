/**
 * PWA 아이콘을 만든다. `npm run icons` 로 다시 만들 수 있다.
 *
 * 이미지 라이브러리를 끌어오지 않는다 — 아이콘 하나 때문에 의존성을 늘릴 이유가 없고,
 * PNG 는 zlib 만 있으면 직접 쓸 수 있다.
 *
 * 그림은 로그 줄 몇 개다. 맨 위가 붉은 것이 ERROR —
 * 뷰어의 규칙(강조는 ERROR 한 곳에만)을 아이콘에서도 그대로 쓴다.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Rgb = [number, number, number];

const BG: Rgb = [0x1a, 0x1b, 0x1e]; // Mantine dark-7. 앱 배경과 같다
const ERROR: Rgb = [0xe0, 0x31, 0x31]; // Mantine red-7
const DIM: Rgb = [0x5c, 0x5f, 0x66];
const BRIGHT: Rgb = [0x90, 0x94, 0x9c];

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGBA 픽셀 배열을 PNG 바이트로. 필터는 전부 0(None) 이면 충분하다. */
function png(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }

  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  // 10~12 = 압축·필터·인터레이스 방식. 전부 0 이 표준값이다.

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 로그 줄 몇 개. maskable 로도 쓰이므로 안쪽 80% 안에만 그린다. */
function draw(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const set = (x: number, y: number, [r, g, b]: Rgb): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  };

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG);

  // 안전 영역(가운데 80%) 안에 줄 다섯 개를 고르게 놓는다.
  const pad = Math.round(size * 0.22);
  const inner = size - pad * 2;
  const rows = 5;
  const gap = inner / rows;
  const thickness = Math.max(2, Math.round(gap * 0.42));
  /** 줄마다 다른 길이. 진짜 로그처럼 보이게 한다 */
  const widths = [1.0, 0.72, 0.86, 0.55, 0.78];

  for (let r = 0; r < rows; r++) {
    const top = Math.round(pad + r * gap);
    const color = r === 0 ? ERROR : r % 2 === 0 ? DIM : BRIGHT;
    const len = Math.round(inner * widths[r]!);
    for (let y = top; y < top + thickness; y++) {
      for (let x = pad; x < pad + len; x++) set(x, y, color);
    }
  }

  return px;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'web', 'public');
mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, png(size, size, draw(size)));
  console.log(`${file} (${size}×${size})`);
}

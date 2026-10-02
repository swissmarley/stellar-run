/**
 * Generates the PWA icons (CC0) into public/icons: an SVG plus PNGs rendered by a tiny supersampling
 * rasteriser (no image libraries). Run with `npm run icons`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

type RGBA = [number, number, number, number];
type Shape = { inside(x: number, y: number): boolean; color: RGBA };

const OUT = 'public/icons';

function hex(c: string, a = 1): RGBA {
  const n = Number.parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

function circle(cx: number, cy: number, r: number, color: RGBA): Shape {
  return { color, inside: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r };
}

function ring(cx: number, cy: number, r0: number, r1: number, color: RGBA): Shape {
  return {
    color,
    inside: (x, y) => {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      return d >= r0 * r0 && d <= r1 * r1;
    },
  };
}

function polygon(pts: [number, number][], color: RGBA): Shape {
  return {
    color,
    inside: (x, y) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]!;
        const [xj, yj] = pts[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    },
  };
}

/** Icon geometry in a 0..1 unit square; `pad` shrinks it for maskable safe zones. */
function shapes(pad: number): Shape[] {
  const s = (v: number): number => pad + v * (1 - 2 * pad);
  const p = (x: number, y: number): [number, number] => [s(x), s(y)];
  return [
    ring(
      0.5,
      0.5,
      s(0.5) - 0.5 + 0.33 * (1 - 2 * pad),
      s(0.5) - 0.5 + 0.36 * (1 - 2 * pad),
      hex('#56b4e9', 0.9),
    ),
    polygon([p(0.5, 0.18), p(0.7, 0.72), p(0.5, 0.62), p(0.3, 0.72)], hex('#f2f6ff')),
    polygon([p(0.44, 0.66), p(0.56, 0.66), p(0.5, 0.86)], hex('#e69f00')),
    circle(s(0.78), s(0.26), 0.022 * (1 - 2 * pad), hex('#f0e442')),
    circle(s(0.2), s(0.7), 0.015 * (1 - 2 * pad), hex('#cc79a7')),
  ];
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size: number, pad: number, rounded: boolean): Buffer {
  const sh = shapes(pad);
  const SS = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const dx = u - 0.5;
          const dy = v - 0.5;
          const corner = rounded ? 0.22 : 0;
          const qx = Math.max(Math.abs(dx) - (0.5 - corner), 0);
          const qy = Math.max(Math.abs(dy) - (0.5 - corner), 0);
          if (rounded && qx * qx + qy * qy > corner * corner) continue;
          // Background: radial violet → near-black.
          const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.6);
          let cr = 42 * (1 - d) + 7 * d;
          let cg = 18 * (1 - d) + 6 * d;
          let cb = 70 * (1 - d) + 13 * d;
          for (const shp of sh) {
            if (shp.inside(u, v)) {
              const [r1, g1, b1, a1] = shp.color;
              cr = cr * (1 - a1) + r1 * a1;
              cg = cg * (1 - a1) + g1 * a1;
              cb = cb * (1 - a1) + b1 * a1;
            }
          }
          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }
      const n = SS * SS;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(r / n);
      raw[o + 1] = Math.round(g / n);
      raw[o + 2] = Math.round(b / n);
      raw[o + 3] = Math.round(a / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="STELLAR RUN"><title>STELLAR RUN</title>
<defs><radialGradient id="g" cx="50%" cy="50%" r="62%"><stop offset="0" stop-color="#2a1246"/><stop offset="1" stop-color="#07060d"/></radialGradient></defs>
<rect width="512" height="512" rx="112" fill="url(#g)"/>
<circle cx="256" cy="256" r="177" fill="none" stroke="#56b4e9" stroke-opacity=".9" stroke-width="15"/>
<path d="M256 92 L358 369 L256 317 L154 369 Z" fill="#f2f6ff"/>
<path d="M225 338 L287 338 L256 440 Z" fill="#e69f00"/>
<circle cx="399" cy="133" r="11" fill="#f0e442"/><circle cx="102" cy="358" r="8" fill="#cc79a7"/>
</svg>
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/icon.svg`, SVG);
writeFileSync(`${OUT}/icon-192.png`, png(192, 0, true));
writeFileSync(`${OUT}/icon-512.png`, png(512, 0, true));
writeFileSync(`${OUT}/icon-maskable-512.png`, png(512, 0.1, false));
writeFileSync(`${OUT}/apple-touch-icon.png`, png(180, 0.04, false));
console.log('icons written to', OUT);

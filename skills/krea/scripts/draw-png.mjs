// Dependency-free PNG writer for code-drawn placeholder art.
//
//   import { writePng, shade } from "./draw-png.mjs";
//   writePng("tile.png", 32, 32, (x, y) => [r, g, b, a]);   // each channel 0-255
//
// Run directly for a demo:  node draw-png.mjs out-folder
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encodes an RGBA PNG; `pixel(x, y)` returns [r, g, b, a] (0-255). */
export function encodePng(width, height, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = pixel(x, y);
      raw.set([r, g, b, a].map((v) => Math.max(0, Math.min(255, Math.round(v)))), y * stride + 1 + x * 4);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function writePng(file, width, height, pixel) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, encodePng(width, height, pixel));
  return file;
}

/** Multiplies a color's RGB by `factor` (keeps alpha). */
export function shade([r, g, b, a = 255], factor) {
  return [r * factor, g * factor, b * factor, a];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? ".";
  writePng(path.join(out, "grass.png"), 32, 32, (x, y) => shade([86, 158, 74, 255], (x * 7 + y * 13) % 5 === 0 ? 0.88 : 1));
  writePng(path.join(out, "tree.png"), 32, 32, (x, y) => {
    if (Math.hypot(x - 15.5, y - 12) < 11) return [45, 122, 60, 255];
    if (x >= 13 && x <= 18 && y >= 20 && y <= 30) return [110, 72, 40, 255];
    return [0, 0, 0, 0];
  });
  console.log(`Wrote grass.png and tree.png to ${path.resolve(out)}`);
}

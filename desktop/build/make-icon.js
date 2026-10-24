// Draws the app icon (a pixel-art handheld) and writes build/icon.png and build/icon.ico.
// Run with: node build/make-icon.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const C = {
  d: [0x9c, 0x45, 0x00], o: [0xff, 0x8c, 0x1a], k: [0x1b, 0x1b, 0x24], s: [0x2a, 0x9d, 0xf4],
  g: [0x6e, 0xe0, 0x4a], G: [0x3c, 0x9a, 0x2c], w: [0xff, 0xff, 0xff], p: [0x2b, 0x2b, 0x35],
  r: [0xe8, 0x42, 0x4b], y: [0xff, 0xd2, 0x3f]
};
const N = 32;
const grid = Array.from({ length: N }, () => Array(N).fill(null));
const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[y][x] = c; };
const art = (x0, y0, rows) => rows.forEach((r, y) => [...r].forEach((c, x) => { if (c !== ".") grid[y0 + y][x0 + x] = c; }));

// Body with a dark outline and cut corners.
rect(4, 1, 27, 30, "d"); rect(5, 2, 26, 29, "o");
for (const [x, y] of [[4, 1], [27, 1], [4, 30], [27, 30]]) grid[y][x] = null;
// Screen with a little sprite on the grass.
rect(7, 4, 24, 15, "k"); rect(8, 5, 23, 14, "s"); rect(8, 13, 23, 14, "G");
art(13, 7, ["..gg..", ".gggg.", "gwggwg", "gggggg", ".g..g."]);
// D-pad, A and B buttons, speaker grille.
rect(9, 19, 11, 25, "p"); rect(7, 21, 13, 23, "p");
art(20, 18, [".rr.", "rrrr", "rrrr", ".rr."]);
art(16, 22, [".yy.", "yyyy", "yyyy", ".yy."]);
for (const y of [27, 28]) for (const x of [19, 21, 23]) grid[y][x] = "d";

function png(size) {
  const scale = size / N, raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const c = grid[Math.floor(y / scale)][Math.floor(x / scale)], i = y * (size * 4 + 1) + 1 + x * 4;
    if (c) { raw.set(C[c], i); raw[i + 3] = 255; }
  }
  const crcT = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
  const crc = b => { let c = ~0; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (~c) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// .ico with PNG-compressed images (supported since Windows Vista).
const sizes = [16, 32, 48, 64, 128, 256], imgs = sizes.map(png);
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  head[e] = s % 256; head[e + 1] = s % 256; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(imgs[i].length, e + 8); head.writeUInt32LE(offset, e + 12); offset += imgs[i].length;
});
fs.writeFileSync(path.join(__dirname, "icon.ico"), Buffer.concat([head, ...imgs]));
fs.writeFileSync(path.join(__dirname, "icon.png"), png(256));

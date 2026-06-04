// Pack pre-rendered PNGs (assets/ico/g<size>.png) into a multi-size src/icon.ico.
// PNG-embedded ICO (Vista+). No external deps. Run: node scripts/make-ico.js
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'assets', 'ico');
const sizes = [256, 128, 64, 48, 32, 16];
const imgs = sizes.map((s) => ({ s, buf: fs.readFileSync(path.join(dir, `g${s}.png`)) }));
const N = imgs.length;

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = icon
header.writeUInt16LE(N, 4); // image count

const entries = Buffer.alloc(16 * N);
let offset = 6 + 16 * N;
imgs.forEach((im, i) => {
  const e = i * 16;
  const dim = im.s >= 256 ? 0 : im.s; // 0 encodes 256
  entries.writeUInt8(dim, e + 0); // width
  entries.writeUInt8(dim, e + 1); // height
  entries.writeUInt8(0, e + 2); // palette count
  entries.writeUInt8(0, e + 3); // reserved
  entries.writeUInt16LE(1, e + 4); // color planes
  entries.writeUInt16LE(32, e + 6); // bits per pixel
  entries.writeUInt32LE(im.buf.length, e + 8); // size of image data
  entries.writeUInt32LE(offset, e + 12); // offset of image data
  offset += im.buf.length;
});

const out = Buffer.concat([header, entries, ...imgs.map((i) => i.buf)]);
const dest = path.join(__dirname, '..', 'src', 'icon.ico');
fs.writeFileSync(dest, out);
console.log(`wrote ${dest} — ${out.length} bytes, ${N} sizes (${sizes.join(', ')})`);

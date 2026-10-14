// Reads MakeCode Arcade projects from local files into the same { filename: contents } map
// that the share API (/api/<id>/text) returns, so the official runner can play them.
//
// Supported:
//   - a project folder (pxt.json + main.ts ..., as used by VS Code / GitHub)
//   - a .zip / .arcade archive of a project folder (GitHub "Download ZIP" works too)
//   - a .png saved from the Arcade editor (project hidden in the image's pixels)
//   - a .uf2 / .elf / .hex downloaded for hardware (project embedded in the firmware)
//   - a .mkcd / .json project export
//   - a lone .ts file (e.g. main.ts copied out of the editor)
// Formats follow microsoft/pxt: pxtlib/util.ts (decodeBlobAsync) and pxtlib/cpp.ts (extractSource*).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const lzma = require("lzma");

const CONFIG = "pxt.json";
const SOURCE_EXT = /\.(ts|blocks|jres|md|json|py)$/i;

class ProjectError extends Error {}

// Returns { files, title, thumbnail?: Buffer }.
async function readLocalProject(p) {
  let stat;
  try { stat = fs.statSync(p); }
  catch (e) { throw new ProjectError(`Can't find ${p}.`); }
  if (stat.isDirectory()) return finish(readFolder(p), path.basename(p));

  const buf = fs.readFileSync(p);
  const ext = path.extname(p).toLowerCase();
  const name = path.basename(p, path.extname(p));

  if (ext === ".zip" || ext === ".arcade" || isZip(buf)) return finish(readZip(buf), name);
  if (ext === ".png" || isPng(buf)) {
    const blob = decodePngBlob(buf);
    const result = finish(await decodeProjectPayload(blob), name);
    result.thumbnail = buf;
    return result;
  }
  if (ext === ".uf2" || ext === ".elf" || ext === ".hex" || isUf2(buf) || buf[0] === 0x3a) {
    return finish(await extractFirmwareSource(buf), name);
  }
  if (ext === ".mkcd" || ext === ".json") return finish(await decodeProjectPayload(buf), name);
  if (ext === ".ts") return finish(synthesizeProject({ "main.ts": buf.toString("utf8") }, name), name);
  throw new ProjectError(`Can't open ${path.basename(p)}: expected a project folder, .zip, .png, .uf2 or .ts file.`);
}

// Make the file map self-consistent: a pxt.json whose file list matches what is present,
// and at least the core Arcade dependency.
function finish(files, fallbackName) {
  if (!files[CONFIG]) files = synthesizeProject(files, fallbackName);
  let cfg;
  try { cfg = JSON.parse(files[CONFIG]); }
  catch (e) { throw new ProjectError("pxt.json in this project isn't valid JSON."); }
  if (!cfg.dependencies || !Object.keys(cfg.dependencies).length) cfg.dependencies = { device: "*" };
  cfg.files = (cfg.files || []).filter(f => typeof files[f] === "string");
  if (!cfg.files.some(f => /\.(ts|blocks|py)$/.test(f))) throw new ProjectError("This project has no code files (main.ts or main.blocks).");
  files[CONFIG] = JSON.stringify(cfg, null, 4);
  return { files, title: cfg.name || fallbackName };
}

function synthesizeProject(files, name) {
  const out = Object.assign({}, files);
  // A single non-main .ts file becomes main.ts.
  const ts = Object.keys(out).filter(f => /\.ts$/.test(f) && !/\.g\.ts$/.test(f));
  if (!out["main.ts"] && ts.length === 1) { out["main.ts"] = out[ts[0]]; delete out[ts[0]]; }
  const listed = Object.keys(out).filter(f => /\.(ts|blocks|jres|py)$/i.test(f) || f === "README.md" || f === "assets.json");
  out[CONFIG] = JSON.stringify({ name, description: "", dependencies: { device: "*" }, files: listed }, null, 4);
  return out;
}

// ---------- folder / zip ----------

function readFolder(dir) {
  const files = {};
  const cfgPath = path.join(dir, CONFIG);
  if (fs.existsSync(cfgPath)) {
    files[CONFIG] = fs.readFileSync(cfgPath, "utf8");
    let cfg = {};
    try { cfg = JSON.parse(files[CONFIG]); } catch (e) { throw new ProjectError("pxt.json in this folder isn't valid JSON."); }
    for (const f of cfg.files || []) {
      const fp = path.join(dir, f);
      if (fs.existsSync(fp)) files[f] = fs.readFileSync(fp, "utf8");
    }
    return files;
  }
  // No pxt.json: take the source files that sit directly in the folder.
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (SOURCE_EXT.test(f) && fs.statSync(fp).isFile()) files[f] = fs.readFileSync(fp, "utf8");
  }
  if (!Object.keys(files).some(f => /\.(ts|blocks)$/.test(f))) {
    throw new ProjectError("No MakeCode project here: the folder has no pxt.json or main.ts.");
  }
  return files;
}

function readZip(buf) {
  const entries = unzip(buf);
  const names = Object.keys(entries);
  // The project root is the shallowest folder holding pxt.json (GitHub zips add a top folder).
  const configs = names.filter(n => n === CONFIG || n.endsWith("/" + CONFIG)).sort((a, b) => a.length - b.length);
  let root = "";
  if (configs.length) root = configs[0].slice(0, -CONFIG.length);
  else {
    const mains = names.filter(n => /(^|\/)main\.(ts|blocks)$/.test(n)).sort((a, b) => a.length - b.length);
    if (!mains.length) throw new ProjectError("No MakeCode project in this zip: no pxt.json or main.ts found.");
    root = mains[0].slice(0, mains[0].lastIndexOf("/") + 1);
  }
  const files = {};
  for (const n of names) {
    if (!n.startsWith(root)) continue;
    const rel = n.slice(root.length);
    if (rel && SOURCE_EXT.test(rel)) files[rel] = entries[n].toString("utf8");
  }
  return files;
}

// Minimal zip reader (central directory, stored or deflated entries).
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ProjectError("This file isn't a valid zip archive.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ProjectError("This zip archive is damaged.");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen).replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) out[name] = Buffer.from(data);
    else if (method === 8) out[name] = zlib.inflateRawSync(data);
    // other compression methods: skip the entry
  }
  return out;
}

// ---------- PNG saved from the editor ----------

// Minimal PNG decoder: 8-bit RGB/RGBA, not interlaced (what canvas.toDataURL produces).
// Returns RGBA bytes, exactly as canvas getImageData would.
function decodePng(buf) {
  if (!isPng(buf)) throw new ProjectError("Not a PNG file.");
  let p = 8, width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 8 || (colorType !== 6 && colorType !== 2) || interlace) {
    throw new ProjectError("This PNG doesn't contain a MakeCode project (unexpected image format).");
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: px };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) { rgba[j] = px[i]; rgba[j + 1] = px[i + 1]; rgba[j + 2] = px[i + 2]; rgba[j + 3] = 255; }
  return { width, height, rgba };
}

const IMAGE_MAGIC = 0x59347a7d;
const IMAGE_HEADER_SIZE = 36;

// Port of pxt.Util.decodeBlobAsync: the payload sits in the low bits of each pixel's RGB.
function decodePngBlob(buf) {
  const { width, height, rgba: d } = decodePng(buf);
  const bpp = (d[0] & 1) | ((d[1] & 1) << 1) | ((d[2] & 1) << 2);
  if (bpp > 5 || bpp === 0) throw new ProjectError("This PNG doesn't contain a MakeCode project.");

  function decode(ptr, bits, trg) {
    let shift = 0, i = 0, acc = 0;
    const mask = (1 << bits) - 1;
    while (i < trg.length) {
      acc |= (d[ptr++] & mask) << shift;
      if ((ptr & 3) === 3) ptr++; // skip alpha
      shift += bits;
      if (shift >= 8) { trg[i++] = acc & 0xff; acc >>= 8; shift -= 8; }
    }
    return ptr;
  }

  const hd = new Uint8Array(IMAGE_HEADER_SIZE);
  const ptr = decode(4, bpp, hd);
  const header = Buffer.from(hd.buffer);
  if (header.readUInt32LE(0) !== IMAGE_MAGIC) throw new ProjectError("This PNG doesn't contain a MakeCode project.");
  const res = new Uint8Array(header.readUInt32LE(4));
  const addedLines = header.readUInt32LE(8);
  if (addedLines > 0) {
    const origSize = (height - addedLines) * width;
    const imgCap = ((origSize - 1) * 3 * bpp) >> 3;
    const tmp = new Uint8Array(imgCap - IMAGE_HEADER_SIZE);
    decode(ptr, bpp, tmp);
    res.set(tmp);
    const added = new Uint8Array(res.length - tmp.length);
    decode(origSize * 4, 8, added);
    res.set(added, tmp.length);
  } else {
    decode(ptr, bpp, res);
  }
  return Buffer.from(res);
}

// PNG / .mkcd payload: JSON (or LZMA-compressed JSON) of { meta, source }, where
// source is the files map (as a JSON string or an object).
async function decodeProjectPayload(buf) {
  const text = buf[0] === 0x7b ? buf.toString("utf8") : await lzmaDecompress(buf);
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new ProjectError("Couldn't read the project inside this file."); }
  return filesFromHexFile(data);
}

function filesFromHexFile(data) {
  if (data && data[CONFIG]) return data; // already a plain files map
  let source = data && data.source;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch (e) { source = null; }
  }
  if (!source || typeof source !== "object") throw new ProjectError("Couldn't find project files inside this file.");
  if (data.meta && data.meta.name && source[CONFIG]) {
    try {
      const cfg = JSON.parse(source[CONFIG]);
      if (!cfg.name) { cfg.name = data.meta.name; source[CONFIG] = JSON.stringify(cfg, null, 4); }
    } catch (e) { /* finish() reports bad pxt.json */ }
  }
  return source;
}

function lzmaDecompress(buf) {
  return new Promise((resolve, reject) => {
    lzma.decompress(Uint8Array.from(buf), (res, err) => {
      if (err || res == null) reject(new ProjectError("Couldn't decompress the project inside this file."));
      else resolve(typeof res === "string" ? res : Buffer.from(res).toString("utf8"));
    });
  });
}

// ---------- firmware with embedded source (.uf2 / .elf / .hex) ----------

const SOURCE_MAGIC = Buffer.from([0x41, 0x14, 0x0e, 0x2f, 0xb8, 0x2f, 0xa2, 0xbb]);

async function extractFirmwareSource(buf) {
  let raw = null;
  if (isUf2(buf)) raw = findEmbed(uf2ToBin(buf));
  else if (buf.readUInt32LE(0) === 0x464c457f) raw = findEmbed(buf); // ELF
  else if (buf[0] === 0x3a) raw = findEmbed(hexToBin(buf.toString("latin1")));
  if (!raw) throw new ProjectError("This firmware file doesn't include the game's source code.");

  let hd;
  try { hd = JSON.parse(raw.meta); } catch (e) { throw new ProjectError("The source embedded in this file is damaged."); }
  if (hd.compression === "LZMA") {
    const res = await lzmaDecompress(raw.text);
    const headerSize = hd.headerSize || hd.metaSize || 0;
    let meta = {};
    try { meta = JSON.parse(res.slice(0, headerSize) || "{}"); } catch (e) { /* name is optional */ }
    return filesFromHexFile({ meta: Object.assign(hd, meta), source: res.slice(headerSize) });
  }
  if (hd.compression) throw new ProjectError(`Unsupported compression "${hd.compression}" in this file.`);
  return filesFromHexFile({ meta: hd, source: raw.text.toString("utf8") });
}

function findEmbed(bin) {
  if (!bin) return null;
  for (let p = bin.indexOf(SOURCE_MAGIC); p >= 0; p = bin.indexOf(SOURCE_MAGIC, p + 1)) {
    const metaLen = bin.readUInt16LE(p + 8);
    const textLen = bin.readUInt32LE(p + 10);
    const start = p + 16;
    const end = start + metaLen + textLen;
    if (end > bin.length) continue;
    return { meta: bin.toString("utf8", start, start + metaLen), text: bin.subarray(start + metaLen, end) };
  }
  return null;
}

// Concatenate UF2 block payloads in address order (as pxt's UF2.toBin does).
function uf2ToBin(buf) {
  const parts = [];
  let cur = -1;
  for (let p = 0; p + 512 <= buf.length; p += 512) {
    if (buf.readUInt32LE(p) !== 0x0a324655 || buf.readUInt32LE(p + 4) !== 0x9e5d5157 || buf.readUInt32LE(p + 508) !== 0x0ab16f30) continue;
    if (buf.readUInt32LE(p + 8) & 1) continue; // not-main-flash block
    const addr = buf.readUInt32LE(p + 12);
    const size = buf.readUInt32LE(p + 16);
    if (cur === -1) cur = addr;
    const padding = addr - cur;
    if (padding < 0 || padding % 4 || padding > 1024 * 1024) continue;
    if (padding) parts.push(Buffer.alloc(padding));
    parts.push(buf.subarray(p + 32, p + 32 + size));
    cur = addr + size;
  }
  return parts.length ? Buffer.concat(parts) : null;
}

// Intel HEX data records -> contiguous bytes (enough to find the 16-byte-aligned embed).
function hexToBin(text) {
  const bytes = [];
  for (const line of text.split(/\r?\n/)) {
    // Record type 00 (data) or 0E (pxt's custom source records).
    const m = /^:([0-9A-Fa-f]{2})[0-9A-Fa-f]{4}0[0Ee]([0-9A-Fa-f]*)[0-9A-Fa-f]{2}$/.exec(line);
    if (!m) continue;
    const n = parseInt(m[1], 16);
    for (let i = 0; i < n; i++) bytes.push(parseInt(m[2].substr(i * 2, 2), 16));
  }
  return bytes.length ? Buffer.from(bytes) : null;
}

// ---------- sniffing ----------

function isZip(buf) { return buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50; }
function isPng(buf) { return buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47; }
function isUf2(buf) { return buf.length >= 512 && buf.readUInt32LE(0) === 0x0a324655; }

module.exports = { readLocalProject, ProjectError, decodePngBlob, unzip };

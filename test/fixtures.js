'use strict';
// Builders for synthetic APK pieces (ZIP, binary XML, resources.arsc, PNG) used by the tests.
const zlib = require('zlib');

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
const chunk = (type, header, body) =>
  Buffer.concat([u16(type), u16(8 + header.length), u32(8 + header.length + body.length), header, body]);

function stringPool(strings, utf8) {
  const blobs = strings.map((s) => {
    if (utf8) {
      const bytes = Buffer.from(s, 'utf8');
      return Buffer.concat([Buffer.from([s.length, bytes.length]), bytes, Buffer.from([0])]);
    }
    return Buffer.concat([u16(s.length), Buffer.from(s, 'utf16le'), u16(0)]);
  });
  const offsets = [];
  let off = 0;
  for (const b of blobs) { offsets.push(u32(off)); off += b.length; }
  const data = pad4(Buffer.concat(blobs));
  const header = Buffer.concat([u32(strings.length), u32(0), u32(utf8 ? 0x100 : 0), u32(28 + 4 * strings.length), u32(0)]);
  return chunk(0x0001, header, Buffer.concat([...offsets, data]));
}

/** elements: [{ name, attrs: [{ name, type, data|string }], children: [] }] */
function axml(root, resNames = {}) {
  // resource-mapped attribute names must sit first in the pool
  const strings = Object.keys(resNames);
  const idx = (s) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const body = [];
  const emit = (el) => {
    const attrs = (el.attrs || []).map((a) => {
      const isStr = a.string !== undefined;
      const data = isStr ? idx(a.string) : a.data;
      return Buffer.concat([u32(0xffffffff), u32(idx(a.name)), u32(isStr ? data : 0xffffffff),
        u16(8), Buffer.from([0, isStr ? 0x03 : a.type]), u32(data)]);
    });
    body.push(chunk(0x0102, Buffer.concat([u32(1), u32(0xffffffff)]),
      Buffer.concat([u32(0xffffffff), u32(idx(el.name)), u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0), ...attrs])));
    (el.children || []).forEach(emit);
    body.push(chunk(0x0103, Buffer.concat([u32(1), u32(0xffffffff)]), Buffer.concat([u32(0xffffffff), u32(idx(el.name))])));
  };
  emit(root);
  const resMap = chunk(0x0180, Buffer.alloc(0), Buffer.concat(Object.values(resNames).map(u32)));
  const all = Buffer.concat([stringPool(strings, false), resMap, ...body]);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + all.length), all]);
}

/** types: { typeId: [ { density, lang, values: [{ type, data } | string | null] } ] } */
function arsc(types) {
  const global = [];
  const gidx = (s) => { let i = global.indexOf(s); if (i < 0) { global.push(s); i = global.length - 1; } return i; };
  const typeChunks = [];
  for (const [typeId, configs] of Object.entries(types)) {
    const count = Math.max(...configs.map((c) => c.values.length));
    typeChunks.push(chunk(0x0202, Buffer.concat([Buffer.from([+typeId, 0, 0, 0]), u32(count)]), Buffer.alloc(4 * count)));
    for (const c of configs) {
      const config = Buffer.alloc(64);
      config.writeUInt32LE(64, 0);
      if (c.lang) config.write(c.lang, 8, 'latin1');
      config.writeUInt16LE(c.density || 0, 14);
      const offsets = [];
      const entries = [];
      let off = 0;
      for (let i = 0; i < count; i++) {
        const v = c.values[i];
        if (v == null) { offsets.push(u32(0xffffffff)); continue; }
        const val = typeof v === 'string' ? { type: 0x03, data: gidx(v) } : v;
        offsets.push(u32(off));
        entries.push(Buffer.concat([u16(8), u16(0), u32(0), u16(8), Buffer.from([0, val.type]), u32(val.data)]));
        off += 16;
      }
      const header = Buffer.concat([Buffer.from([+typeId, 0, 0, 0]), u32(count), u32(84 + 4 * count), config]);
      typeChunks.push(chunk(0x0201, header, Buffer.concat([...offsets, ...entries])));
    }
  }
  const typePool = stringPool(['string', 'mipmap', 'drawable'], true);
  const keyPool = stringPool(['key'], true);
  const pkgHeader = Buffer.concat([u32(0x7f), Buffer.alloc(256), u32(288), u32(0), u32(288 + typePool.length), u32(0), u32(0)]);
  const pkg = chunk(0x0200, pkgHeader, Buffer.concat([typePool, keyPool, ...typeChunks]));
  const all = Buffer.concat([stringPool(global, true), pkg]);
  return Buffer.concat([u16(0x0002), u16(12), u32(12 + all.length), u32(1), all]);
}

function png(width, height, fill = 0x80) {
  const crcChunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height, fill);
  for (let y = 0; y < height; y++) raw[y * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    crcChunk('IHDR', ihdr), crcChunk('IDAT', zlib.deflateSync(raw)), crcChunk('IEND', Buffer.alloc(0))]);
}

/** files: { name: Buffer } - even entries are deflated, odd ones stored */
function zip(files) {
  const locals = [];
  const central = [];
  let off = 0;
  Object.entries(files).forEach(([name, data], n) => {
    const method = n % 2 === 0 ? 8 : 0;
    const body = method ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const common = Buffer.concat([u16(20), u16(0), u16(method), u16(0), u16(0), u32(zlib.crc32(data)), u32(body.length), u32(data.length), u16(nameBuf.length), u16(0)]);
    const local = Buffer.concat([u32(0x04034b50), common, nameBuf, body]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(off), nameBuf]));
    locals.push(local);
    off += local.length;
  });
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cd.length), u32(off), u16(0)]);
  return Buffer.concat([...locals, cd, eocd]);
}

module.exports = { axml, arsc, png, zip };

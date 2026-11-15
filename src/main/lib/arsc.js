'use strict';
// resources.arsc reader: resolves a resource id to its simple values per configuration.
const { StringPool } = require('./strpool');

class ResTable {
  constructor(buf) {
    if (buf.length < 12 || buf.readUInt16LE(0) !== 0x0002) throw new Error('Not a resource table');
    this.buf = buf;
    this.strings = null;
    this.types = []; // { pkgId, typeId, off }
    let p = buf.readUInt16LE(2);
    while (p + 8 <= buf.length) {
      const type = buf.readUInt16LE(p);
      const hs = buf.readUInt16LE(p + 2);
      const size = buf.readUInt32LE(p + 4);
      if (size < 8 || p + size > buf.length) break;
      if (type === 0x0001 && !this.strings) this.strings = new StringPool(buf, p);
      else if (type === 0x0200) this._package(p, hs, size);
      p += size;
    }
  }

  _package(off, hs, size) {
    const b = this.buf;
    const pkgId = b.readUInt32LE(off + 8);
    const end = off + size;
    let p = off + hs;
    while (p + 8 <= end) {
      const type = b.readUInt16LE(p);
      const csize = b.readUInt32LE(p + 4);
      if (csize < 8 || p + csize > end) break;
      if (type === 0x0201) this.types.push({ pkgId, typeId: b[p + 8], off: p });
      p += csize;
    }
  }

  _entry(o, idx) {
    const b = this.buf;
    const hs = b.readUInt16LE(o + 2);
    const flags = b[o + 9];
    const count = b.readUInt32LE(o + 12);
    const start = b.readUInt32LE(o + 16);
    let eo = -1;
    if (flags & 0x01) { // sparse
      for (let i = 0; i < count; i++) {
        const q = o + hs + i * 4;
        if (b.readUInt16LE(q) === idx) { eo = b.readUInt16LE(q + 2) * 4; break; }
      }
    } else if (flags & 0x02) { // 16-bit offsets
      if (idx >= count) return null;
      const v = b.readUInt16LE(o + hs + idx * 2);
      if (v === 0xffff) return null;
      eo = v * 4;
    } else {
      if (idx >= count) return null;
      const v = b.readUInt32LE(o + hs + idx * 4);
      if (v === 0xffffffff) return null;
      eo = v;
    }
    if (eo < 0) return null;
    const e = o + start + eo;
    const esize = b.readUInt16LE(e);
    const eflags = b.readUInt16LE(e + 2);
    if (eflags & 0x0008) return { type: eflags >> 8, data: b.readUInt32LE(e + 4) }; // compact
    if (eflags & 0x0001) return null; // complex (bag) entries are not needed here
    return { type: b[e + esize + 3], data: b.readUInt32LE(e + esize + 4) };
  }

  /** All simple values of a resource id: [{ density, lang, type, data }] */
  lookup(resId) {
    const pkgId = resId >>> 24;
    const typeId = (resId >>> 16) & 0xff;
    const idx = resId & 0xffff;
    const out = [];
    for (const t of this.types) {
      if (t.pkgId !== pkgId || t.typeId !== typeId) continue;
      let v;
      try { v = this._entry(t.off, idx); } catch (_) { v = null; }
      if (!v) continue;
      const c = t.off + 20;
      const l0 = this.buf[c + 8];
      const l1 = this.buf[c + 9];
      out.push({
        density: this.buf.readUInt16LE(c + 14),
        lang: l0 && !(l0 & 0x80) ? String.fromCharCode(l0, l1) : '',
        type: v.type,
        data: v.data,
      });
    }
    return out;
  }

  /** Follow references until strings: [{ density, lang, string }] */
  resolveStrings(resId, depth = 0) {
    const out = [];
    for (const v of this.lookup(resId)) {
      if (v.type === 0x03 && this.strings) {
        const s = this.strings.get(v.data);
        if (s != null) out.push({ density: v.density, lang: v.lang, string: s });
      } else if ((v.type === 0x01 || v.type === 0x07) && v.data && depth < 6) {
        for (const r of this.resolveStrings(v.data, depth + 1)) {
          out.push({ density: r.density || v.density, lang: r.lang || v.lang, string: r.string });
        }
      }
    }
    return out;
  }
}

module.exports = { ResTable };

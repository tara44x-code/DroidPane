'use strict';
// Minimal read-only ZIP reader (enough for APK files). No dependencies.
const fs = require('fs');
const zlib = require('zlib');

const MAX_ENTRY = 64 * 1024 * 1024; // refuse to inflate anything larger than 64 MB

class Zip {
  constructor(file) {
    this.fd = fs.openSync(file, 'r');
    try {
      this.size = fs.fstatSync(this.fd).size;
      this.entries = new Map();
      this._readDirectory();
    } catch (e) {
      this.close();
      throw e;
    }
  }

  _read(pos, len) {
    const b = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(this.fd, b, got, len - got, pos + got);
      if (!n) break;
      got += n;
    }
    if (got < len) throw new Error('Unexpected end of file');
    return b;
  }

  _readDirectory() {
    if (this.size < 22) throw new Error('Not a ZIP/APK file');
    const tailLen = Math.min(this.size, 65557);
    const tail = this._read(this.size - tailLen, tailLen);
    let i = tail.length - 22;
    for (; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) break;
    if (i < 0) throw new Error('Not a ZIP/APK file');
    const count = tail.readUInt16LE(i + 10);
    const cdSize = tail.readUInt32LE(i + 12);
    const cdOff = tail.readUInt32LE(i + 16);
    if (cdOff + cdSize > this.size) throw new Error('Corrupt ZIP directory');
    const cd = this._read(cdOff, cdSize);
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const nlen = cd.readUInt16LE(p + 28);
      const elen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      const name = cd.toString('utf8', p + 46, p + 46 + nlen);
      this.entries.set(name, {
        name,
        method: cd.readUInt16LE(p + 10),
        csize: cd.readUInt32LE(p + 20),
        usize: cd.readUInt32LE(p + 24),
        off: cd.readUInt32LE(p + 42),
      });
      p += 46 + nlen + elen + clen;
    }
  }

  has(name) { return this.entries.has(name); }
  names() { return [...this.entries.keys()]; }

  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.usize > MAX_ENTRY || e.csize > MAX_ENTRY) throw new Error('ZIP entry too large: ' + name);
    const lh = this._read(e.off, 30);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('Corrupt ZIP entry: ' + name);
    const start = e.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = this._read(start, e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
    throw new Error('Unsupported ZIP compression method ' + e.method);
  }

  close() {
    if (this.fd !== undefined) { try { fs.closeSync(this.fd); } catch (_) {} this.fd = undefined; }
  }
}

module.exports = { Zip };

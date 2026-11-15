'use strict';
// Android ResStringPool reader (shared by binary XML and resources.arsc).
class StringPool {
  constructor(buf, off) {
    this.buf = buf;
    this.off = off;
    this.headerSize = buf.readUInt16LE(off + 2);
    this.size = buf.readUInt32LE(off + 4);
    this.count = buf.readUInt32LE(off + 8);
    this.utf8 = (buf.readUInt32LE(off + 16) & 0x100) !== 0;
    this.stringsStart = buf.readUInt32LE(off + 20);
  }

  get(i) {
    if (!(i >= 0 && i < this.count)) return null;
    const b = this.buf;
    let p = this.off + this.stringsStart + b.readUInt32LE(this.off + this.headerSize + i * 4);
    if (this.utf8) {
      if (b[p++] & 0x80) p++; // UTF-16 length, unused
      let len = b[p++];
      if (len & 0x80) len = ((len & 0x7f) << 8) | b[p++];
      return b.toString('utf8', p, p + len);
    }
    let len = b.readUInt16LE(p); p += 2;
    if (len & 0x8000) { len = ((len & 0x7fff) << 16) | b.readUInt16LE(p); p += 2; }
    return b.toString('utf16le', p, p + len * 2);
  }
}

module.exports = { StringPool };

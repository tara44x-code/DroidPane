'use strict';
// Android binary XML (AXML) parser. Returns a flat list of start elements.
const { StringPool } = require('./strpool');

// Framework attribute resource ids -> names (attribute names can be stripped by obfuscators).
const RES_NAMES = {
  0x01010001: 'label',
  0x01010002: 'icon',
  0x01010003: 'name',
  0x01010199: 'drawable',
  0x0101020c: 'minSdkVersion',
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
  0x0101052c: 'roundIcon',
};

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_DYNAMIC_REFERENCE = 0x07;

function parseAxml(buf) {
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) throw new Error('Not an Android binary XML file');
  let p = buf.readUInt16LE(2);
  let pool = null;
  const resMap = [];
  const elements = [];
  let depth = 0;
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const hs = buf.readUInt16LE(p + 2);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > buf.length) break;
    if (type === 0x0001) {
      pool = new StringPool(buf, p);
    } else if (type === 0x0180) {
      for (let q = p + hs; q + 4 <= p + size; q += 4) resMap.push(buf.readUInt32LE(q));
    } else if (type === 0x0102 && pool) {
      const b = p + hs;
      const name = pool.get(buf.readUInt32LE(b + 4));
      const aStart = buf.readUInt16LE(b + 8);
      const aSize = buf.readUInt16LE(b + 10);
      const aCount = buf.readUInt16LE(b + 12);
      const attrs = {};
      for (let i = 0; i < aCount; i++) {
        const a = b + aStart + i * aSize;
        const nameIdx = buf.readUInt32LE(a + 4);
        const raw = buf.readInt32LE(a + 8);
        const dtype = buf[a + 15];
        const data = buf.readUInt32LE(a + 16);
        const key = RES_NAMES[resMap[nameIdx]] || pool.get(nameIdx) || 'attr' + nameIdx;
        attrs[key] = {
          type: dtype,
          data,
          string: dtype === TYPE_STRING ? pool.get(data) : raw >= 0 ? pool.get(raw) : null,
        };
      }
      elements.push({ name, depth, attrs });
      depth++;
    } else if (type === 0x0103) {
      depth--;
    }
    p += size;
  }
  return elements;
}

module.exports = { parseAxml, TYPE_REFERENCE, TYPE_STRING, TYPE_DYNAMIC_REFERENCE };

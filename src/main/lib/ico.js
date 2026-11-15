'use strict';
// Wrap a PNG in an .ico container (Windows Vista+ accepts PNG-compressed icons).
function pngSize(png) {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG image');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function pngToIco(png) {
  const { width, height } = pngSize(png);
  if (width > 256 || height > 256) throw new Error('Icon PNG must be 256x256 or smaller');
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // image count
  head[6] = width === 256 ? 0 : width;
  head[7] = height === 256 ? 0 : height;
  head[8] = 0; // palette
  head[9] = 0;
  head.writeUInt16LE(1, 10); // planes
  head.writeUInt16LE(32, 12); // bpp
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

module.exports = { pngToIco, pngSize };

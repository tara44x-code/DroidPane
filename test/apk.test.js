'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fx = require('./fixtures');
const { inspectApk } = require('../src/main/lib/apk');
const { Zip } = require('../src/main/lib/zip');
const { pngToIco } = require('../src/main/lib/ico');
const { parseDevices } = require('../src/main/lib/adb');
const { scrcpyArgs } = require('../src/main/lib/runtime');

const RES = { label: 0x01010001, icon: 0x01010002, name: 0x01010003, versionCode: 0x0101021b, versionName: 0x0101021c, drawable: 0x01010199 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'droidpane-'));
const write = (name, files) => { const f = path.join(tmp, name); fs.writeFileSync(f, fx.zip(files)); return f; };

function manifest(appAttrs, pkg = 'com.example.demo') {
  return fx.axml({
    name: 'manifest',
    attrs: [
      { name: 'versionCode', type: 0x10, data: 42 },
      { name: 'versionName', string: '1.2.3' },
      { name: 'package', string: pkg },
    ],
    children: [
      { name: 'uses-permission', attrs: [{ name: 'name', string: 'android.permission.INTERNET' }] },
      { name: 'uses-permission', attrs: [{ name: 'name', string: 'android.permission.CAMERA' }] },
      { name: 'application', attrs: appAttrs, children: [{ name: 'activity', attrs: [{ name: 'name', string: '.Main' }] }] },
    ],
  }, RES);
}

test('reads package, version, label, permissions and the densest raster icon', () => {
  const small = fx.png(4, 4);
  const big = fx.png(16, 16);
  const file = write('full.apk', {
    'AndroidManifest.xml': manifest([{ name: 'label', type: 0x01, data: 0x7f010000 }, { name: 'icon', type: 0x01, data: 0x7f020000 }]),
    'resources.arsc': fx.arsc({
      1: [{ values: ['Demo App'] }, { lang: 'ar', values: ['تطبيق تجريبي'] }],
      2: [
        { density: 160, values: ['res/mipmap-mdpi/ic_launcher.png'] },
        { density: 640, values: ['res/mipmap-xxxhdpi/ic_launcher.png'] },
        { density: 0xffff, values: ['res/mipmap-anydpi-v26/ic_launcher.xml'] },
      ],
    }),
    'res/mipmap-mdpi/ic_launcher.png': small,
    'res/mipmap-xxxhdpi/ic_launcher.png': big,
    'res/mipmap-anydpi-v26/ic_launcher.xml': fx.axml({ name: 'adaptive-icon' }, RES),
  });
  const info = inspectApk(file);
  assert.strictEqual(info.package, 'com.example.demo');
  assert.strictEqual(info.label, 'Demo App');
  assert.strictEqual(info.versionName, '1.2.3');
  assert.strictEqual(info.versionCode, 42);
  assert.deepStrictEqual(info.permissions, ['android.permission.INTERNET', 'android.permission.CAMERA']);
  assert.strictEqual(info.icon.source, 'res/mipmap-xxxhdpi/ic_launcher.png');
  assert.ok(info.icon.data.equals(big));
  assert.strictEqual(info.icon.adaptive, false);
});

test('falls back to the adaptive icon foreground layer', () => {
  const fg = fx.png(8, 8, 0x33);
  const file = write('adaptive.apk', {
    'AndroidManifest.xml': manifest([{ name: 'label', string: 'Literal Name' }, { name: 'icon', type: 0x01, data: 0x7f020000 }]),
    'resources.arsc': fx.arsc({
      2: [{ density: 0xffff, values: ['res/a1.xml'] }],
      3: [{ density: 480, values: ['res/b2.webp'] }],
    }),
    'res/a1.xml': fx.axml({ name: 'adaptive-icon', children: [{ name: 'foreground', attrs: [{ name: 'drawable', type: 0x01, data: 0x7f030000 }] }] }, RES),
    'res/b2.webp': fg,
  });
  const info = inspectApk(file);
  assert.strictEqual(info.label, 'Literal Name');
  assert.strictEqual(info.icon.source, 'res/b2.webp');
  assert.strictEqual(info.icon.mime, 'image/webp');
  assert.strictEqual(info.icon.adaptive, true);
});

test('still works with no resource table and no icon', () => {
  const file = write('my_cool-app.apk', {
    'AndroidManifest.xml': manifest([{ name: 'label', type: 0x01, data: 0x7f010000 }], 'org.sample.thing'),
  });
  const info = inspectApk(file);
  assert.strictEqual(info.package, 'org.sample.thing');
  assert.strictEqual(info.label, 'my cool app');
  assert.strictEqual(info.icon, null);
});

test('rejects files that are not APKs', () => {
  const junk = path.join(tmp, 'junk.apk');
  fs.writeFileSync(junk, Buffer.alloc(500, 7));
  assert.throws(() => inspectApk(junk), /Not a ZIP/);
  const noManifest = write('empty.apk', { 'hello.txt': Buffer.from('hi') });
  assert.throws(() => inspectApk(noManifest), /AndroidManifest/);
});

test('zip reader handles stored and deflated entries', () => {
  const a = Buffer.from('a'.repeat(5000));
  const b = Buffer.from('stored entry');
  const z = new Zip(write('plain.zip', { 'a.txt': a, 'b.txt': b }));
  assert.ok(z.read('a.txt').equals(a));
  assert.ok(z.read('b.txt').equals(b));
  assert.strictEqual(z.read('missing'), null);
  z.close();
});

test('pngToIco wraps a PNG in a valid single-image icon', () => {
  const p = fx.png(256, 256);
  const ico = pngToIco(p);
  assert.strictEqual(ico.readUInt16LE(2), 1);
  assert.strictEqual(ico.readUInt16LE(4), 1);
  assert.strictEqual(ico[6], 0); // 0 means 256
  assert.strictEqual(ico.readUInt32LE(14), p.length);
  assert.ok(ico.subarray(ico.readUInt32LE(18)).equals(p));
  assert.throws(() => pngToIco(Buffer.from('nope')), /Not a PNG/);
});

test('parses adb device listings', () => {
  const out = 'List of devices attached\nemulator-5554          device product:sdk_gphone64 model:sdk_gphone64_x86_64 transport_id:1\nR58M12ABCDE            unauthorized usb:1-1\n\n';
  assert.deepStrictEqual(parseDevices(out), [
    { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 x86 64', emulator: true },
    { serial: 'R58M12ABCDE', state: 'unauthorized', model: '', emulator: false },
  ]);
});

test('builds scrcpy arguments per mode', () => {
  const base = { serial: 'emulator-5554', pkg: 'com.example.demo', title: 'Demo', size: 'phone' };
  assert.deepStrictEqual(scrcpyArgs({ ...base, mode: 'window', emulator: true, version: { major: 3 } }),
    ['-s', 'emulator-5554', '--window-title=Demo', '--start-app=com.example.demo', '--new-display=720x1280/280', '--no-vd-system-decorations', '--no-audio']);
  assert.ok(scrcpyArgs({ ...base, mode: 'window', version: { major: 4 } }).includes('--flex-display'));
  assert.deepStrictEqual(scrcpyArgs({ ...base, mode: 'mirror', emulator: false, version: { major: 3 } }),
    ['-s', 'emulator-5554', '--window-title=Demo', '--start-app=com.example.demo']);
});

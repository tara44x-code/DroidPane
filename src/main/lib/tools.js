'use strict';
// Finds the external tools DroidPane drives: adb, scrcpy and (optionally) the Android Emulator.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';
const isFile = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch (_) { return false; } };

function sdkRoots() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  roots.push(path.join(os.homedir(), 'Android', 'Sdk'), path.join(os.homedir(), 'Library', 'Android', 'sdk'));
  return roots.filter(Boolean);
}

function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name + EXE);
    if (isFile(p)) return p;
  }
  return null;
}

function scrcpyDirs(extraDir) {
  const dirs = [];
  const scan = (base) => {
    try {
      for (const d of fs.readdirSync(base)) if (/^scrcpy/i.test(d)) dirs.push(path.join(base, d));
    } catch (_) {}
  };
  if (extraDir) { dirs.push(extraDir); scan(extraDir); }
  if (process.env.LOCALAPPDATA) scan(path.join(process.env.LOCALAPPDATA, 'Programs'));
  if (process.env.ProgramFiles) scan(process.env.ProgramFiles);
  if (process.env.USERPROFILE) scan(path.join(process.env.USERPROFILE, 'scoop', 'apps'));
  return dirs;
}

/** @returns {{adb: string|null, scrcpy: string|null, emulator: string|null}} */
function locate(settings, toolsDir) {
  const custom = (settings && settings.toolPaths) || {};
  const first = (list) => list.find(isFile) || null;

  const scrcpy = first([
    custom.scrcpy,
    ...scrcpyDirs(toolsDir).map((d) => path.join(d, 'scrcpy' + EXE)),
    ...scrcpyDirs(toolsDir).map((d) => path.join(d, 'current', 'scrcpy' + EXE)),
  ]) || onPath('scrcpy');

  const adb = first([
    custom.adb,
    ...sdkRoots().map((r) => path.join(r, 'platform-tools', 'adb' + EXE)),
    scrcpy && path.join(path.dirname(scrcpy), 'adb' + EXE), // the scrcpy Windows zip ships adb
  ]) || onPath('adb');

  const emulator = first([
    custom.emulator,
    ...sdkRoots().map((r) => path.join(r, 'emulator', 'emulator' + EXE)),
  ]) || onPath('emulator');

  return { adb, scrcpy, emulator };
}

function scrcpyVersion(scrcpyPath) {
  return new Promise((resolve) => {
    if (!scrcpyPath) return resolve(null);
    execFile(scrcpyPath, ['--version'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      const m = /scrcpy\s+v?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(String(stdout || ''));
      resolve(m ? { major: +m[1], minor: +m[2], patch: +(m[3] || 0), text: `${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''}` } : null);
    });
  });
}

module.exports = { locate, scrcpyVersion, EXE };

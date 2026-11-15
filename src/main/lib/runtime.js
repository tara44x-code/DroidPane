'use strict';
// Starts/stops a headless Android Emulator (AVD) and opens app windows through scrcpy.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const adb = require('./adb');

const SIZES = {
  phone: '720x1280/280',
  phoneHD: '1080x1920/420',
  tablet: '1920x1200/240',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listAvds(emulatorPath) {
  return new Promise((resolve) => {
    if (!emulatorPath) return resolve([]);
    execFile(emulatorPath, ['-list-avds'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      resolve(String(stdout || '').split(/\r?\n/).map((s) => s.trim())
        .filter((s) => /^[\w.-]+$/.test(s)));
    });
  });
}

function openLog(logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  return fs.openSync(logFile, 'w');
}

function startEmulator(emulatorPath, avd, logFile) {
  const fd = openLog(logFile);
  const child = spawn(emulatorPath, ['-avd', avd, '-no-window', '-no-boot-anim'], {
    detached: true, stdio: ['ignore', fd, fd], cwd: path.dirname(emulatorPath),
  });
  child.on('error', () => {});
  child.unref();
  fs.closeSync(fd);
}

async function waitForBoot(adbPath, timeoutMs = 240000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    let list = [];
    try { list = await adb.devices(adbPath); } catch (_) {}
    for (const d of list) {
      if (d.emulator && d.state === 'device' && await adb.bootCompleted(adbPath, d.serial)) return d.serial;
    }
    await sleep(2000);
  }
  const e = new Error('The Android runtime did not finish booting in time');
  e.code = 'BOOT_TIMEOUT';
  throw e;
}

async function stopEmulators(adbPath) {
  const list = await adb.devices(adbPath);
  for (const d of list.filter((x) => x.emulator)) {
    try { await adb.run(adbPath, ['emu', 'kill'], { serial: d.serial, timeout: 10000 }); } catch (_) {}
  }
}

function scrcpyArgs({ serial, pkg, title, mode, size, emulator, version }) {
  const args = ['-s', serial, '--window-title=' + title, '--start-app=' + pkg];
  if (mode !== 'mirror') {
    args.push('--new-display=' + (SIZES[size] || SIZES.phone), '--no-vd-system-decorations');
    if (version && version.major >= 4) args.push('--flex-display'); // resizable virtual display
  }
  if (emulator) args.push('--no-audio'); // the emulator already plays audio on the host
  return args;
}

/** Opens the app window. Resolves once scrcpy is up, rejects if it dies right away. */
function openAppWindow(scrcpyPath, opts, { iconPng, logFile }) {
  return new Promise((resolve, reject) => {
    const fd = openLog(logFile);
    const env = Object.assign({}, process.env);
    if (iconPng && fs.existsSync(iconPng)) env.SCRCPY_ICON_PATH = iconPng;
    const child = spawn(scrcpyPath, scrcpyArgs(opts), {
      detached: true, stdio: ['ignore', fd, fd], env, cwd: path.dirname(scrcpyPath),
    });
    fs.closeSync(fd);
    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      let tail = '';
      try { tail = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).filter((l) => /error|fail|exception/i.test(l)).slice(-2).join(' '); } catch (_) {}
      const e = new Error(tail || msg);
      e.code = 'SCRCPY_FAILED';
      reject(e);
    };
    child.on('error', (err) => fail(err.message));
    child.on('exit', (code) => { if (code) fail('scrcpy exited with code ' + code); });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    }, 4000);
  });
}

module.exports = { SIZES, listAvds, startEmulator, waitForBoot, stopEmulators, scrcpyArgs, openAppWindow };

'use strict';
const { execFile } = require('child_process');

function run(adbPath, args, { serial, timeout = 20000 } = {}) {
  const full = serial ? ['-s', serial, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(adbPath, full, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const errText = String(stderr || '');
      if (err) {
        const e = new Error((errText || out || err.message).trim().split(/\r?\n/).slice(-3).join(' '));
        e.code = err.killed ? 'ADB_TIMEOUT' : 'ADB_FAILED';
        return reject(e);
      }
      resolve(out);
    });
  });
}

function parseDevices(text) {
  const out = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const m = /^(\S+)\s+(device|offline|unauthorized|authorizing|no permissions)\b(.*)$/.exec(line.trim());
    if (!m) continue;
    const model = /model:(\S+)/.exec(m[3]);
    out.push({
      serial: m[1],
      state: m[2],
      model: model ? model[1].replace(/_/g, ' ') : '',
      emulator: /^emulator-\d+$/.test(m[1]),
    });
  }
  return out;
}

async function devices(adbPath) {
  return parseDevices(await run(adbPath, ['devices', '-l'], { timeout: 15000 }));
}

async function install(adbPath, serial, apkFile) {
  const out = await run(adbPath, ['install', '-r', apkFile], { serial, timeout: 10 * 60 * 1000 });
  if (!/Success/i.test(out)) {
    const e = new Error(out.trim().split(/\r?\n/).pop() || 'Install failed');
    e.code = 'INSTALL_FAILED';
    throw e;
  }
}

async function uninstall(adbPath, serial, pkg) {
  return run(adbPath, ['uninstall', pkg], { serial, timeout: 60000 });
}

async function bootCompleted(adbPath, serial) {
  try {
    return (await run(adbPath, ['shell', 'getprop', 'sys.boot_completed'], { serial, timeout: 8000 })).trim() === '1';
  } catch (_) {
    return false;
  }
}

module.exports = { run, devices, parseDevices, install, uninstall, bootCompleted };

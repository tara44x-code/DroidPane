'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { inspectApk } = require('./lib/apk');
const { pngToIco, pngSize } = require('./lib/ico');
const tools = require('./lib/tools');
const adb = require('./lib/adb');
const runtime = require('./lib/runtime');
const { Store } = require('./lib/store');

const PKG_RE = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/;
const ALLOWED_LINKS = ['https://github.com/', 'https://developer.android.com/'];

let win = null;
let store = null;
let dirs = null;
let pendingApk = null;

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// Errors cross IPC as plain objects so the UI can translate them by code.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, code: err.code || 'ERROR', message: String(err.message || err) };
    }
  });
}

const progress = (key) => { if (win && !win.isDestroyed()) win.webContents.send('progress', key); };
const located = () => tools.locate(store.data.settings, dirs.tools);

function parseArgs(argv) {
  const out = { launch: null, apk: null };
  const i = argv.indexOf('--launch');
  if (i >= 0 && PKG_RE.test(argv[i + 1] || '')) out.launch = argv[i + 1];
  out.apk = argv.find((a, n) => n > 0 && /\.apk$/i.test(a) && fs.existsSync(a)) || null;
  return out;
}

// ---------- state ----------

function iconPaths(pkg) {
  return { png: path.join(dirs.icons, pkg + '.png'), ico: path.join(dirs.icons, pkg + '.ico') };
}

async function getState() {
  const t = located();
  let devices = [];
  let avds = [];
  if (t.adb) { try { devices = await adb.devices(t.adb); } catch (_) {} }
  if (t.emulator) avds = await runtime.listAvds(t.emulator);
  const version = await tools.scrcpyVersion(t.scrcpy);
  const apps = Object.values(store.data.apps)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((a) => {
      const { png } = iconPaths(a.package);
      return Object.assign({}, a, {
        iconUrl: fs.existsSync(png) ? pathToFileURL(png).href + '?t=' + (a.installedAt || 0) : null,
      });
    });
  return {
    settings: store.data.settings,
    apps,
    tools: {
      adb: t.adb ? { path: t.adb } : null,
      scrcpy: t.scrcpy ? { path: t.scrcpy, version: version ? version.text : '' } : null,
      emulator: t.emulator ? { path: t.emulator } : null,
    },
    devices,
    avds,
    sizes: Object.keys(runtime.SIZES),
    version: app.getVersion(),
  };
}

async function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', await getState());
}

// ---------- device ----------

async function ensureDevice() {
  const t = located();
  if (!t.adb) throw fail('NO_ADB');
  const s = store.data.settings;
  const ready = (await adb.devices(t.adb)).filter((d) => d.state === 'device');
  const preferred = ready.find((d) => d.serial === s.serial);
  if (preferred) return preferred;
  if (ready.length) return ready[0];
  if (!t.emulator) throw fail('NO_DEVICE');
  const avds = await runtime.listAvds(t.emulator);
  const avd = avds.includes(s.avd) ? s.avd : avds[0];
  if (!avd) throw fail('NO_AVD');
  progress('startingRuntime');
  runtime.startEmulator(t.emulator, avd, path.join(dirs.logs, 'emulator.log'));
  const serial = await runtime.waitForBoot(t.adb);
  return { serial, state: 'device', emulator: true, model: avd };
}

// ---------- shortcuts ----------

function shortcutFiles(app_) {
  const safe = app_.label.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 60) || app_.package;
  return {
    desktop: path.join(app.getPath('desktop'), safe + '.lnk'),
    startMenu: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DroidPane Apps', safe + '.lnk'),
  };
}

function writeShortcuts(app_, { desktop, startMenu }) {
  if (process.platform !== 'win32') return [];
  const files = shortcutFiles(app_);
  const { ico } = iconPaths(app_.package);
  const options = {
    target: process.execPath,
    // In development the executable is electron.exe, so the app folder must come first.
    args: (app.isPackaged ? '' : `"${app.getAppPath()}" `) + '--launch ' + app_.package,
    description: app_.label,
    cwd: path.dirname(process.execPath),
  };
  if (fs.existsSync(ico)) { options.icon = ico; options.iconIndex = 0; }
  const made = [];
  for (const [kind, file] of [['desktop', files.desktop], ['startMenu', files.startMenu]]) {
    if (!(kind === 'desktop' ? desktop : startMenu)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', options)) made.push(file);
  }
  return made;
}

function removeShortcuts(app_) {
  const files = shortcutFiles(app_);
  for (const f of [files.desktop, files.startMenu]) { try { fs.unlinkSync(f); } catch (_) {} }
}

// ---------- actions ----------

function inspect(file) {
  if (typeof file !== 'string' || !/\.apk$/i.test(file) || !fs.existsSync(file)) throw fail('BAD_APK');
  let info;
  try { info = inspectApk(file); } catch (e) { throw fail('BAD_APK', e.message); }
  const icon = info.icon;
  return {
    path: file,
    fileName: path.basename(file),
    sizeBytes: fs.statSync(file).size,
    package: info.package,
    label: info.label,
    versionName: info.versionName,
    permissions: info.permissions,
    iconDataUrl: icon ? `data:${icon.mime};base64,${icon.data.toString('base64')}` : null,
    iconAdaptive: icon ? icon.adaptive : false,
    installed: !!store.data.apps[info.package],
  };
}

async function install({ path: file, iconPng }) {
  const meta = inspect(file);
  const t = located();
  progress('findingDevice');
  const device = await ensureDevice();
  progress('installing');
  await adb.install(t.adb, device.serial, file);

  const { png, ico } = iconPaths(meta.package);
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(iconPng || '');
  if (m) {
    const buf = Buffer.from(m[1], 'base64');
    try {
      pngSize(buf);
      fs.writeFileSync(png, buf);
      fs.writeFileSync(ico, pngToIco(buf));
    } catch (_) { /* keep going without a custom icon */ }
  }
  const entry = {
    package: meta.package,
    label: meta.label,
    versionName: meta.versionName,
    installedAt: Date.now(),
  };
  store.data.apps[meta.package] = entry;
  store.save();
  progress('shortcuts');
  const s = store.data.settings;
  try { writeShortcuts(entry, { desktop: s.desktopShortcut, startMenu: s.startMenuShortcut }); } catch (_) {}
  await pushState();
  return entry;
}

async function launch(pkg) {
  const entry = store.data.apps[pkg];
  if (!PKG_RE.test(pkg || '')) throw fail('BAD_PACKAGE');
  const t = located();
  if (!t.scrcpy) throw fail('NO_SCRCPY');
  const version = await tools.scrcpyVersion(t.scrcpy);
  if (!version || version.major < 3) throw fail('SCRCPY_OLD');
  progress('findingDevice');
  const device = await ensureDevice();
  progress('opening');
  const s = store.data.settings;
  await runtime.openAppWindow(t.scrcpy, {
    serial: device.serial,
    pkg,
    title: entry ? entry.label : pkg,
    mode: s.displayMode,
    size: s.size,
    emulator: device.emulator,
    version,
  }, { iconPng: iconPaths(pkg).png, logFile: path.join(dirs.logs, pkg + '.log') });
  return true;
}

async function uninstall(pkg) {
  const entry = store.data.apps[pkg];
  if (!entry) throw fail('BAD_PACKAGE');
  const t = located();
  if (t.adb) {
    const ready = (await adb.devices(t.adb).catch(() => [])).filter((d) => d.state === 'device');
    for (const d of ready) { try { await adb.uninstall(t.adb, d.serial, pkg); } catch (_) {} }
  }
  removeShortcuts(entry);
  const { png, ico } = iconPaths(pkg);
  for (const f of [png, ico]) { try { fs.unlinkSync(f); } catch (_) {} }
  delete store.data.apps[pkg];
  store.save();
  await pushState();
  return true;
}

function setSettings(patch) {
  const s = store.data.settings;
  const allowed = {
    lang: ['en', 'ar'], displayMode: ['window', 'mirror'], size: Object.keys(runtime.SIZES),
  };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k in allowed) { if (allowed[k].includes(v)) s[k] = v; }
    else if (k === 'desktopShortcut' || k === 'startMenuShortcut') s[k] = !!v;
    else if (k === 'avd' || k === 'serial') s[k] = String(v || '').slice(0, 120);
  }
  store.save();
  return getState();
}

async function browseTool(name) {
  if (!['adb', 'scrcpy', 'emulator'].includes(name)) throw fail('ERROR');
  const res = await dialog.showOpenDialog(win, {
    title: name + tools.EXE,
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [],
  });
  if (res.canceled || !res.filePaths[0]) return getState();
  store.data.settings.toolPaths[name] = res.filePaths[0];
  store.save();
  return getState();
}

// ---------- window ----------

function createWindow(show) {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b0d18',
    title: 'DroidPane',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#aab0d0', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('did-finish-load', () => {
    if (pendingApk) { win.webContents.send('open-apk', pendingApk); pendingApk = null; }
  });
  if (show) win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) return createWindow(true);
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

async function handleArgs(args, firstRun) {
  if (args.launch) {
    try {
      await launch(args.launch);
      if (firstRun && (!win || !win.isVisible())) app.quit(); // shortcut launch: nothing else to show
    } catch (err) {
      showWindow();
      dialog.showErrorBox('DroidPane', `${err.code || ''} ${err.message || ''}`.trim());
    }
    return;
  }
  if (args.apk) {
    if (win && !win.webContents.isLoading()) win.webContents.send('open-apk', args.apk);
    else pendingApk = args.apk;
  }
  showWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => handleArgs(parseArgs(argv), false));

  app.whenReady().then(() => {
    const base = app.getPath('userData');
    dirs = {
      icons: path.join(base, 'icons'),
      logs: path.join(base, 'logs'),
      tools: path.join(base, 'tools'),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    store = new Store(path.join(base, 'droidpane.json'));
    if (store.fresh && /^ar\b/i.test(app.getLocale())) store.data.settings.lang = 'ar';

    handle('state:get', getState);
    handle('apk:pick', async () => {
      const res = await dialog.showOpenDialog(win, {
        properties: ['openFile'], filters: [{ name: 'Android apps', extensions: ['apk'] }],
      });
      return res.canceled ? null : res.filePaths[0];
    });
    handle('apk:inspect', inspect);
    handle('apk:install', install);
    handle('app:launch', launch);
    handle('app:uninstall', uninstall);
    handle('app:shortcut', (pkg) => {
      const entry = store.data.apps[pkg];
      if (!entry) throw fail('BAD_PACKAGE');
      return writeShortcuts(entry, { desktop: true, startMenu: true }).length;
    });
    handle('runtime:start', async () => { await ensureDevice(); return getState(); });
    handle('runtime:stop', async () => {
      const t = located();
      if (t.adb) await runtime.stopEmulators(t.adb);
      return getState();
    });
    handle('settings:set', setSettings);
    handle('tools:browse', browseTool);
    handle('open:external', (url) => {
      if (typeof url === 'string' && ALLOWED_LINKS.some((p) => url.startsWith(p))) shell.openExternal(url);
      return true;
    });

    const args = parseArgs(process.argv);
    if (args.launch) {
      createWindow(false);
      handleArgs(args, true);
    } else {
      if (args.apk) pendingApk = args.apk;
      createWindow(true);
    }
  });

  app.on('window-all-closed', () => app.quit());
}

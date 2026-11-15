'use strict';
/* DroidPane renderer. Runs sandboxed; everything privileged goes through window.api (see preload.js).
   Opened in a plain browser (no window.api) it falls back to demo data so the UI can be previewed. */

const $ = (id) => document.getElementById(id);
const HOT = ['CAMERA', 'RECORD_AUDIO', 'ACCESS_FINE_LOCATION', 'READ_CONTACTS', 'READ_SMS', 'SEND_SMS', 'CALL_PHONE',
  'READ_CALL_LOG', 'SYSTEM_ALERT_WINDOW', 'REQUEST_INSTALL_PACKAGES', 'BIND_ACCESSIBILITY_SERVICE', 'MANAGE_EXTERNAL_STORAGE'];
const LINKS = {
  scrcpy: 'https://github.com/Genymobile/scrcpy/releases',
  adb: 'https://developer.android.com/tools/releases/platform-tools',
  emulator: 'https://developer.android.com/studio',
};

let state = null;
let query = '';

// ---------- helpers ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

function t(key, ...args) {
  const dict = window.I18N[(state && state.settings.lang) || 'en'] || window.I18N.en;
  const v = key in dict ? dict[key] : window.I18N.en[key];
  return typeof v === 'function' ? v(...args) : v == null ? key : v;
}

function errText(e) {
  const dict = window.I18N[(state && state.settings.lang) || 'en'].err;
  return dict[e.code] || dict.ERROR;
}

async function call(fn, ...args) {
  const res = await fn(...args);
  if (res && res.ok) return res.value;
  const e = new Error((res && res.message) || 'Error');
  e.code = (res && res.code) || 'ERROR';
  throw e;
}

function toast(text, detail, isError) {
  const el = h('div', { class: 'toast' + (isError ? ' error' : '') }, h('div', { text }), detail ? h('small', { text: detail }) : null);
  $('toasts').append(el);
  setTimeout(() => el.remove(), isError ? 8000 : 3500);
}

function showError(e) {
  const known = !!window.I18N.en.err[e.code] && e.code !== 'ERROR';
  toast(errText(e), known && e.message === e.code ? '' : String(e.message || '').slice(0, 220), true);
}

function busy(key) {
  $('busy').hidden = !key;
  if (key) $('busyText').textContent = t('p_' + key);
}

function hue(str) {
  let n = 0;
  for (const c of str) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return n % 360;
}

function letterIcon(app, cls) {
  const el = h('div', { class: cls || 'ico', text: (app.label || '?').trim().charAt(0).toUpperCase() });
  const a = hue(app.package);
  el.style.background = `linear-gradient(135deg, hsl(${a} 75% 58%), hsl(${(a + 60) % 360} 70% 45%))`;
  return el;
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Renders the icon that will be saved for shortcuts and the app window: always a 256x256 PNG. */
async function renderIconPng(meta) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = meta.iconDataUrl ? await loadImage(meta.iconDataUrl) : null;
  if (img && !meta.iconAdaptive) {
    g.drawImage(img, 0, 0, S, S);
    return c.toDataURL('image/png');
  }
  const a = hue(meta.package);
  const grad = g.createLinearGradient(0, 0, S, S);
  grad.addColorStop(0, `hsl(${a} 75% 58%)`);
  grad.addColorStop(1, `hsl(${(a + 60) % 360} 70% 45%)`);
  g.beginPath();
  g.roundRect(8, 8, S - 16, S - 16, 58);
  g.fillStyle = grad;
  g.fill();
  g.clip();
  if (img) {
    const d = S * 1.5; // adaptive foregrounds keep their artwork in the middle two thirds
    g.drawImage(img, (S - d) / 2, (S - d) / 2, d, d);
  } else {
    g.fillStyle = '#fff';
    g.font = '700 128px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText((meta.label || '?').trim().charAt(0).toUpperCase(), S / 2, S / 2 + 8);
  }
  return c.toDataURL('image/png');
}

// ---------- rendering ----------

function applyStaticText() {
  const lang = state.settings.lang;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $('search').placeholder = t('searchPh');
}

function renderPill() {
  const ready = state.devices.filter((d) => d.state === 'device');
  const pill = $('pill');
  if (!state.tools.adb || !state.tools.scrcpy) {
    pill.className = 'pill warn';
    $('pillTitle').textContent = t('pillSetup');
    $('pillSub').textContent = t('pillSetupSub');
  } else if (ready.length) {
    const d = ready.find((x) => x.serial === state.settings.serial) || ready[0];
    pill.className = 'pill ok';
    $('pillTitle').textContent = t('pillReady');
    $('pillSub').textContent = d.model || d.serial;
  } else {
    pill.className = 'pill';
    $('pillTitle').textContent = t('pillNone');
    $('pillSub').textContent = t('pillNoneSub');
  }
}

function renderApps() {
  const grid = $('grid');
  const apps = state.apps;
  $('appsCount').textContent = t('appsCount', apps.length);
  $('empty').hidden = apps.length > 0;
  grid.hidden = apps.length === 0;
  const q = query.trim().toLowerCase();
  const shown = apps.filter((a) => !q || a.label.toLowerCase().includes(q) || a.package.toLowerCase().includes(q));
  grid.replaceChildren(...shown.map((app) => {
    const icon = app.iconUrl
      ? h('div', { class: 'ico' }, h('img', { src: app.iconUrl, alt: '' }))
      : letterIcon(app);
    return h('div', { class: 'tile' },
      icon,
      h('div', { class: 'info' }, h('b', { text: app.label, title: app.label }), h('small', { text: app.versionName ? 'v' + app.versionName : app.package })),
      h('button', { class: 'open', 'aria-label': t('open') + ' ' + app.label, onclick: () => launch(app) }),
      h('button', { class: 'more', 'aria-label': app.label, onclick: (e) => openMenu(e, app), text: '⋯' }));
  }));
  if (apps.length && !shown.length) grid.append(h('div', { class: 'note', text: t('noMatch') }));
}

function toolCard(name, desc, optional) {
  const tool = state.tools[name];
  const badge = tool
    ? h('span', { class: 'badge ok', text: t('found') + (tool.version ? ' · ' + tool.version : '') })
    : h('span', { class: 'badge ' + (optional ? 'dim' : 'bad'), text: optional ? t('optional') : t('missing') });
  return h('div', { class: 'card' },
    h('div', { class: 'top' }, h('b', { text: name }), badge),
    h('p', { text: desc }),
    tool ? h('code', { text: tool.path }) : null,
    h('div', { class: 'foot' },
      h('button', { class: 'btn small', text: t('locate'), onclick: () => update(window.api.browseTool, name) }),
      tool ? null : h('button', { class: 'btn small', text: t('download'), onclick: () => window.api.openExternal(LINKS[name]) })));
}

function renderRuntime() {
  const s = state.settings;
  const ready = state.devices.filter((d) => d.state === 'device');
  const current = ready.find((d) => d.serial === s.serial) || ready[0];

  const devices = state.devices.length
    ? state.devices.map((d) => h('div', { class: 'row' },
      h('div', null, h('b', { text: d.model || d.serial }), h('span', { class: 'sub', text: d.serial })),
      h('div', { class: 'end' },
        h('span', { class: 'badge ' + (d.state === 'device' ? 'ok' : 'warn'), text: t('state_' + d.state) }),
        d.state !== 'device' ? null
          : current && current.serial === d.serial
            ? h('span', { class: 'badge dim', text: t('inUse') })
            : h('button', { class: 'btn small', text: t('use'), onclick: () => update(window.api.setSettings, { serial: d.serial }) }))))
    : [h('div', { class: 'hint', text: t('noDevices') })];

  let emulator;
  if (!state.tools.emulator) emulator = h('div', { class: 'hint', text: t('emulatorMissing') });
  else if (!state.avds.length) emulator = h('div', { class: 'hint', text: t('emulatorNone') });
  else {
    const running = state.devices.some((d) => d.emulator);
    const select = h('select', { 'aria-label': t('avd'), onchange: (e) => update(window.api.setSettings, { avd: e.target.value }) },
      state.avds.map((a) => h('option', { value: a, text: a, selected: a === s.avd })));
    emulator = h('div', { class: 'row' },
      h('div', null, h('b', { text: t('avd') }), h('span', { class: 'sub', text: running ? t('state_device') : t('pillNoneSub') })),
      h('div', { class: 'end' }, select,
        running
          ? h('button', { class: 'btn small danger', text: t('stop'), onclick: () => update(window.api.stopRuntime) })
          : h('button', { class: 'btn small primary', text: t('start'), onclick: startRuntime })));
  }

  $('runtimeBody').replaceChildren(
    h('div', { class: 'block' }, h('h3', { text: t('tools') }), h('div', { class: 'cards' },
      toolCard('scrcpy', t('scrcpyDesc')), toolCard('adb', t('adbDesc')), toolCard('emulator', t('emulatorDesc'), true))),
    h('div', { class: 'block' }, h('h3', { text: t('devices') }), devices),
    h('div', { class: 'block' }, h('h3', { text: t('emulator') }), emulator));
}

function renderSettings() {
  const s = state.settings;
  const set = (patch) => update(window.api.setSettings, patch);
  const toggle = (key) => h('div', { class: 'row' },
    h('b', { text: t(key) }),
    h('button', { class: 'switch' + (s[key] ? ' on' : ''), role: 'switch', 'aria-checked': String(!!s[key]), 'aria-label': t(key), onclick: () => set({ [key]: !s[key] }) }));
  const mode = (value, title, sub) => h('button', { class: s.displayMode === value ? 'on' : '', onclick: () => set({ displayMode: value }) },
    h('b', { text: t(title) }), h('span', { text: t(sub) }));

  $('settingsBody').replaceChildren(
    h('div', { class: 'block' }, h('h3', { text: t('language') }),
      h('div', { class: 'seg' },
        h('button', { class: s.lang === 'en' ? 'on' : '', text: 'English', onclick: () => set({ lang: 'en' }) }),
        h('button', { class: s.lang === 'ar' ? 'on' : '', text: 'العربية', onclick: () => set({ lang: 'ar' }) }))),
    h('div', { class: 'block' }, h('h3', { text: t('displayMode') }),
      h('div', { class: 'choice' }, mode('window', 'modeWindow', 'modeWindowSub'), mode('mirror', 'modeMirror', 'modeMirrorSub'))),
    h('div', { class: 'block' }, h('h3', { text: t('size') }),
      h('div', { class: 'row' }, h('b', { text: t('size') }),
        h('select', { 'aria-label': t('size'), onchange: (e) => set({ size: e.target.value }) },
          state.sizes.map((k) => h('option', { value: k, text: t('size_' + k), selected: k === s.size }))))),
    h('div', { class: 'block' }, h('h3', { text: t('shortcuts') }), toggle('desktopShortcut'), toggle('startMenuShortcut')),
    h('div', { class: 'block' }, h('h3', { text: t('about') }),
      h('div', { class: 'hint' }, h('b', { text: 'DroidPane ' + state.version }), h('p', { text: t('aboutText') }))));
}

function render() {
  applyStaticText();
  renderPill();
  renderApps();
  renderRuntime();
  renderSettings();
}

function setState(next) { state = next; render(); }

async function update(fn, ...args) {
  try { setState(await call(fn, ...args)); } catch (e) { showError(e); }
}

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + name));
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
}

// ---------- actions ----------

async function launch(app) {
  closeMenu();
  busy('opening');
  try {
    await call(window.api.launch, app.package);
    toast(t('t_opened', app.label));
  } catch (e) { showError(e); }
  busy(null);
  refresh();
}

async function startRuntime() {
  busy('startingRuntime');
  try { setState(await call(window.api.startRuntime)); } catch (e) { showError(e); }
  busy(null);
}

async function refresh() {
  try { setState(await call(window.api.getState)); } catch (e) { showError(e); }
}

function closeSheet() { $('sheet').hidden = true; $('sheet').replaceChildren(); }
function closeMenu() { $('menu').hidden = true; }

function openMenu(ev, app) {
  ev.stopPropagation();
  const menu = $('menu');
  menu.replaceChildren(
    h('button', { text: t('open'), onclick: () => launch(app) }),
    h('button', { text: t('shortcut'), onclick: async () => {
      closeMenu();
      try { toast((await call(window.api.makeShortcut, app.package)) ? t('t_shortcut') : t('t_shortcutNone')); } catch (e) { showError(e); }
    } }),
    h('button', { class: 'danger', text: t('uninstall'), onclick: () => confirmUninstall(app) }));
  menu.hidden = false;
  const r = ev.currentTarget.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 10) + 'px';
  menu.style.left = Math.max(10, Math.min(r.right - w, window.innerWidth - w - 10)) + 'px';
}

function confirmUninstall(app) {
  closeMenu();
  const sheet = $('sheet');
  sheet.replaceChildren(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    h('h2', { text: t('confirmUninstall', app.label) }),
    h('p', { text: t('confirmUninstallSub') }),
    h('div', { class: 'foot' },
      h('button', { class: 'btn', text: t('cancel'), onclick: closeSheet }),
      h('button', { class: 'btn danger', text: t('uninstall'), onclick: async () => {
        closeSheet();
        try { await call(window.api.uninstall, app.package); toast(t('t_uninstalled', app.label)); } catch (e) { showError(e); }
        refresh();
      } }))));
  sheet.hidden = false;
}

async function openApk(file) {
  if (!file) return;
  showView('apps');
  busy('reading');
  let meta;
  try { meta = await call(window.api.inspectApk, file); } catch (e) { busy(null); return showError(e); }
  busy(null);

  const iconPng = await renderIconPng(meta);
  const perms = meta.permissions.map((p) => p.replace(/^android\.permission\./, ''));
  perms.sort((a, b) => HOT.includes(b) - HOT.includes(a));
  const shown = perms.slice(0, 10);
  const mb = (meta.sizeBytes / 1048576).toFixed(1) + ' MB';

  const sheet = $('sheet');
  sheet.replaceChildren(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'head' },
      h('img', { src: iconPng, alt: '' }),
      h('div', null, h('h2', { text: meta.label }), h('small', { text: meta.package }),
        h('small', { text: [meta.versionName && 'v' + meta.versionName, mb].filter(Boolean).join(' · ') }))),
    h('h3', { text: t('permissions') }),
    perms.length
      ? h('div', { class: 'perms' }, shown.map((p) => h('span', { class: HOT.includes(p) ? 'hot' : '', text: p })),
        perms.length > shown.length ? h('span', { text: t('more', perms.length - shown.length) }) : null)
      : h('p', { class: 'tip', text: t('noPermissions') }),
    h('p', { class: 'tip', text: meta.installed ? t('alreadyInstalled') : t('trustNote') }),
    h('div', { class: 'foot' },
      h('button', { class: 'btn', text: t('cancel'), onclick: closeSheet }),
      h('button', { class: 'btn primary', text: meta.installed ? t('update') : t('install'), onclick: async () => {
        closeSheet();
        busy('findingDevice');
        try {
          const entry = await call(window.api.installApk, { path: meta.path, iconPng });
          toast(t('t_installed', entry.label));
        } catch (e) { showError(e); }
        busy(null);
        refresh();
      } }))));
  sheet.hidden = false;
}

// ---------- wiring ----------

function wire() {
  $('nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) showView(b.dataset.view);
  });
  $('pill').addEventListener('click', () => showView('runtime'));
  $('search').addEventListener('input', (e) => { query = e.target.value; renderApps(); });
  const pick = async () => { try { openApk(await call(window.api.pickApk)); } catch (e) { showError(e); } };
  $('add').addEventListener('click', pick);
  $('add2').addEventListener('click', pick);
  $('refresh').addEventListener('click', refresh);
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
  document.addEventListener('click', (e) => { if (!$('menu').contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); closeSheet(); } });

  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; $('drop').hidden = false; } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('drop').hidden = true; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    $('drop').hidden = true;
    const file = [...e.dataTransfer.files].find((f) => /\.apk$/i.test(f.name));
    if (!file) return showError({ code: 'BAD_APK', message: '' });
    openApk(window.api.pathForFile(file));
  });

  window.api.on('progress', (key) => { if (!$('busy').hidden) busy(key); });
  window.api.on('state', setState);
  window.api.on('open-apk', openApk);
}

// ---------- demo data (browser preview only) ----------

function demoApi() {
  const ok = (value) => Promise.resolve({ ok: true, value });
  const names = [['Pocket Notes', 'app.pocket.notes', '4.2.0'], ['Skyline Weather', 'io.skyline.weather', '2.8.1'], ['Loop Player', 'org.loop.player', '1.14'],
    ['Paper Reader', 'com.paper.reader', '7.0.3'], ['Tiny Chess', 'dev.tiny.chess', '0.9.5'], ['Orbit Camera', 'app.orbit.camera', '3.3'],
    ['Mint Budget', 'co.mint.budget', '5.1.2'], ['Trail Maps', 'org.trail.maps', '12.4']];
  const demo = {
    settings: { lang: location.hash.includes('ar') ? 'ar' : 'en', displayMode: 'window', size: 'phone', desktopShortcut: true, startMenuShortcut: true, avd: 'Pixel_8_API_34', serial: '', toolPaths: {} },
    apps: location.hash.includes('empty') ? [] : names.map(([label, pkg, versionName]) => ({ label, package: pkg, versionName, iconUrl: null })),
    tools: { adb: { path: 'C:\\Tools\\scrcpy-win64\\adb.exe' }, scrcpy: { path: 'C:\\Tools\\scrcpy-win64\\scrcpy.exe', version: '3.3.4' }, emulator: null },
    devices: [{ serial: 'emulator-5554', state: 'device', model: 'Pixel 8', emulator: true }, { serial: 'R58M12ABCDE', state: 'unauthorized', model: '', emulator: false }],
    avds: ['Pixel_8_API_34'], sizes: ['phone', 'phoneHD', 'tablet'], version: '0.1.0',
  };
  const meta = { path: 'demo.apk', package: 'app.orbit.camera', label: 'Orbit Camera', versionName: '3.3', sizeBytes: 18874368, iconDataUrl: null, iconAdaptive: false, installed: false,
    permissions: ['android.permission.INTERNET', 'android.permission.CAMERA', 'android.permission.RECORD_AUDIO', 'android.permission.VIBRATE', 'android.permission.WAKE_LOCK'] };
  return {
    getState: () => ok(demo), pickApk: () => ok('demo.apk'), inspectApk: () => ok(meta), installApk: () => ok(meta), launch: () => ok(true),
    uninstall: () => ok(true), makeShortcut: () => ok(0), startRuntime: () => ok(demo), stopRuntime: () => ok(demo),
    setSettings: (patch) => { Object.assign(demo.settings, patch); return ok(demo); }, browseTool: () => ok(demo),
    openExternal: () => ok(true), pathForFile: () => 'demo.apk', on: () => {},
  };
}

(async function init() {
  const preview = !window.api;
  if (preview) window.api = demoApi();
  wire();
  await refresh();
  if (preview) {
    const view = /runtime|settings/.exec(location.hash);
    if (view) showView(view[0]);
    if (location.hash.includes('sheet')) openApk('demo.apk');
  }
})();

'use strict';
// Reads what we need from an APK without any Android tooling:
// package name, version, label, requested permissions and the launcher icon.
const path = require('path');
const { Zip } = require('./zip');
const { parseAxml, TYPE_REFERENCE, TYPE_STRING, TYPE_DYNAMIC_REFERENCE } = require('./axml');
const { ResTable } = require('./arsc');

const RASTER = /\.(png|webp|jpe?g)$/i;
const MIME = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const isRef = (a) => a && (a.type === TYPE_REFERENCE || a.type === TYPE_DYNAMIC_REFERENCE) && a.data;

function densityRank(d) {
  if (d === 0xffff || d === 0xfffe) return 1; // anydpi / nodpi: after real densities
  return d || 160;
}

function pickLabel(values) {
  if (!values.length) return null;
  const pick = values.find((v) => !v.lang) || values.find((v) => v.lang === 'en') || values[0];
  return pick.string;
}

function prettyName(pkg, file) {
  const base = file ? path.basename(file).replace(/\.apk$/i, '') : '';
  if (base && !/^base$/i.test(base)) return base.replace(/[_-]+/g, ' ').trim();
  const last = (pkg || 'app').split('.').pop();
  return last.charAt(0).toUpperCase() + last.slice(1);
}

function readImage(zip, name, adaptive) {
  const data = zip.read(name);
  if (!data || !data.length) return null;
  const ext = name.split('.').pop().toLowerCase();
  return { data, mime: MIME[ext] || 'image/png', adaptive: !!adaptive, source: name };
}

function findIcon(zip, table, iconAttr) {
  const candidates = [];
  if (table && isRef(iconAttr)) {
    for (const v of table.resolveStrings(iconAttr.data)) candidates.push(v);
  } else if (iconAttr && iconAttr.string) {
    candidates.push({ density: 0, string: iconAttr.string });
  }
  candidates.sort((a, b) => densityRank(b.density) - densityRank(a.density));

  // 1) a plain raster icon, highest density first
  for (const c of candidates) {
    if (RASTER.test(c.string) && zip.has(c.string)) {
      const img = readImage(zip, c.string, false);
      if (img) return img;
    }
  }
  // 2) adaptive icon XML -> its foreground layer, if that is a raster image
  for (const c of candidates) {
    if (!/\.xml$/i.test(c.string) || !zip.has(c.string) || !table) continue;
    try {
      const els = parseAxml(zip.read(c.string));
      const fg = els.find((e) => e.name === 'foreground');
      const ref = fg && fg.attrs.drawable;
      if (!isRef(ref)) continue;
      const layers = table.resolveStrings(ref.data)
        .sort((a, b) => densityRank(b.density) - densityRank(a.density));
      for (const l of layers) {
        if (RASTER.test(l.string) && zip.has(l.string)) {
          const img = readImage(zip, l.string, true);
          if (img) return img;
        }
      }
    } catch (_) { /* fall through */ }
  }
  // 3) heuristic: the biggest file that looks like a launcher icon
  let best = null;
  for (const e of zip.entries.values()) {
    if (!/^res\/.*(ic_launcher|app_icon|icon)[^/]*\.(png|webp)$/i.test(e.name)) continue;
    if (/foreground|background|monochrome/i.test(e.name)) continue;
    if (!best || e.usize > best.usize) best = e;
  }
  return best ? readImage(zip, best.name, false) : null;
}

function inspectApk(file) {
  const zip = new Zip(file);
  try {
    const manifestBuf = zip.read('AndroidManifest.xml');
    if (!manifestBuf) throw new Error('AndroidManifest.xml not found - this is not a valid APK');
    const els = parseAxml(manifestBuf);
    const manifest = els.find((e) => e.name === 'manifest');
    if (!manifest || !manifest.attrs.package || !manifest.attrs.package.string) {
      throw new Error('Could not read the package name from this APK');
    }
    const pkg = manifest.attrs.package.string;
    if (!/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(pkg)) throw new Error('Invalid package name in APK');
    const application = els.find((e) => e.name === 'application') || { attrs: {} };

    let table = null;
    try {
      const arsc = zip.read('resources.arsc');
      if (arsc) table = new ResTable(arsc);
    } catch (_) { table = null; }

    const str = (a) => {
      if (!a) return null;
      if (a.type === TYPE_STRING) return a.string;
      if (isRef(a) && table) return pickLabel(table.resolveStrings(a.data));
      return a.string || null;
    };

    const vc = manifest.attrs.versionCode;
    const permissions = [...new Set(els
      .filter((e) => /^uses-permission/.test(e.name) && e.attrs.name && e.attrs.name.string)
      .map((e) => e.attrs.name.string))];

    let icon = null;
    try { icon = findIcon(zip, table, application.attrs.icon || application.attrs.roundIcon); } catch (_) { icon = null; }

    return {
      package: pkg,
      label: (str(application.attrs.label) || '').trim() || prettyName(pkg, file),
      versionName: str(manifest.attrs.versionName) || '',
      versionCode: vc ? vc.data : 0,
      permissions,
      icon, // { data: Buffer, mime, adaptive } | null
    };
  } finally {
    zip.close();
  }
}

module.exports = { inspectApk };

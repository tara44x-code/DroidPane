'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  settings: {
    lang: 'en',
    displayMode: 'window', // 'window' = own virtual display per app, 'mirror' = whole device screen
    size: 'phone',
    desktopShortcut: true,
    startMenuShortcut: true,
    avd: '',
    serial: '',
    toolPaths: { adb: '', scrcpy: '', emulator: '' },
  },
  apps: {}, // package -> { package, label, versionName, installedAt }
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data.apps = raw.apps && typeof raw.apps === 'object' ? raw.apps : {};
      Object.assign(this.data.settings, raw.settings || {});
      this.data.settings.toolPaths = Object.assign({}, DEFAULTS.settings.toolPaths, (raw.settings || {}).toolPaths);
      this.fresh = false;
    } catch (_) {
      this.fresh = true;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, DEFAULTS };

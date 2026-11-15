'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getState: call('state:get'),
  pickApk: call('apk:pick'),
  inspectApk: call('apk:inspect'),
  installApk: call('apk:install'),
  launch: call('app:launch'),
  uninstall: call('app:uninstall'),
  makeShortcut: call('app:shortcut'),
  startRuntime: call('runtime:start'),
  stopRuntime: call('runtime:stop'),
  setSettings: call('settings:set'),
  browseTool: call('tools:browse'),
  openExternal: call('open:external'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (_) { return file.path || ''; }
  },
  on: (event, cb) => {
    if (!['progress', 'open-apk', 'state'].includes(event)) return;
    ipcRenderer.on(event, (_e, payload) => cb(payload));
  },
});

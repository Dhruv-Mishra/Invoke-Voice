const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceSupervisorPreferences', Object.freeze({
  getItem: (key) => ipcRenderer.sendSync('preferences:get', key),
  setItem: (key, value) => {
    if (ipcRenderer.sendSync('preferences:set', key, value) !== true) throw new Error('Could not save the application preference.');
  },
}));

contextBridge.exposeInMainWorld('voiceSupervisorWindow', Object.freeze({
  setTheme: (colors) => ipcRenderer.send('window:theme', colors),
}));

contextBridge.exposeInMainWorld('voiceSupervisorData', Object.freeze({
  info: () => ipcRenderer.invoke('data-reset:info'),
  clear: (confirmation) => ipcRenderer.invoke('data-reset:clear', confirmation),
}));

contextBridge.exposeInMainWorld('voiceSupervisorUpdates', Object.freeze({
  check: () => ipcRenderer.invoke('updates:check'),
  install: () => ipcRenderer.invoke('updates:install'),
}));
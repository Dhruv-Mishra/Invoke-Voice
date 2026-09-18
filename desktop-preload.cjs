const { contextBridge, ipcRenderer } = require('electron');

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
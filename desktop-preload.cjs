const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voiceSupervisorUpdates', Object.freeze({
  check: () => ipcRenderer.invoke('updates:check'),
  install: () => ipcRenderer.invoke('updates:install'),
}));
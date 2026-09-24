// Small, explicit bridge between the page and the desktop app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voxmorphNative', {
  platform: process.platform,
  createVirtualMic: () => ipcRenderer.invoke('virtual-mic:create'),
});

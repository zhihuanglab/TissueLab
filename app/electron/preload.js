// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  send: (channel, ...args) => {
    ipcRenderer.send(channel, ...args);
  },
  on: (channel, callback) => {
    ipcRenderer.on(channel, (event, ...ipcArgs) => callback(...ipcArgs));
  },
  off: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  },
  invoke: (channel, ...args) => {
    return ipcRenderer.invoke(channel, ...args);
  },
  listLocalFiles: (dirPath) => ipcRenderer.invoke('list-local-files', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (options) => ipcRenderer.invoke('write-file', options),
})

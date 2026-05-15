// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// ipcRenderer.on() must be paired with removeListener using the *same* function reference.
// We wrap callbacks so renderer code never sees `event`; off() must remove that wrapper, not `callback`.
const ipcListenerWrappers = new WeakMap(); // callback -> Map(channel -> wrapper)

contextBridge.exposeInMainWorld('electron', {
  send: (channel, ...args) => {
    ipcRenderer.send(channel, ...args);
  },
  on: (channel, callback) => {
    const wrapper = (event, ...ipcArgs) => callback(...ipcArgs);
    let byChannel = ipcListenerWrappers.get(callback);
    if (!byChannel) {
      byChannel = new Map();
      ipcListenerWrappers.set(callback, byChannel);
    }
    const prev = byChannel.get(channel);
    if (prev) {
      ipcRenderer.removeListener(channel, prev);
    }
    byChannel.set(channel, wrapper);
    ipcRenderer.on(channel, wrapper);
  },
  off: (channel, callback) => {
    const byChannel = ipcListenerWrappers.get(callback);
    const wrapper = byChannel?.get(channel);
    if (!wrapper) return;
    ipcRenderer.removeListener(channel, wrapper);
    byChannel.delete(channel);
    if (byChannel.size === 0) {
      ipcListenerWrappers.delete(callback);
    }
  },
  invoke: (channel, ...args) => {
    return ipcRenderer.invoke(channel, ...args);
  },
  listLocalFiles: (dirPath) => ipcRenderer.invoke('list-local-files', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (options) => ipcRenderer.invoke('write-file', options),
  // OAuth methods
  googleOAuth: (credentials) => ipcRenderer.invoke('google-oauth', credentials),
  googleRefreshToken: (params) => ipcRenderer.invoke('google-refresh-token', params),
  // Refresh token storage methods
  saveRefreshToken: (params) => ipcRenderer.invoke('save-refresh-token', params),
  getRefreshToken: () => ipcRenderer.invoke('get-refresh-token'),
  deleteRefreshToken: () => ipcRenderer.invoke('delete-refresh-token'),
  // Backend port
  getBackendPort: () => ipcRenderer.invoke('get-backend-port'),
})
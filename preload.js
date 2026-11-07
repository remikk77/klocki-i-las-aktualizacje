const { contextBridge, ipcRenderer } = require('electron');
const listeners = {};
for (const ch of ['net:msg', 'net:conn', 'net:disc', 'net:closed', 'net:relayLost', 'net:found', 'app:closing', 'update:progress']) {
  ipcRenderer.on(ch, (e, data) => { (listeners[ch] || []).forEach((cb) => cb(data)); });
}
contextBridge.exposeInMainWorld('api', {
  saveDir: () => ipcRenderer.invoke('save:dir'),
  read: (n) => ipcRenderer.invoke('save:read', n),
  write: (n, t) => ipcRenderer.invoke('save:write', n, t),
  list: (p) => ipcRenderer.invoke('save:list', p),
  remove: (n) => ipcRenderer.invoke('save:delete', n),
  openSaves: () => ipcRenderer.send('save:openDir'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: () => ipcRenderer.invoke('update:apply'),
  loadTasks: () => ipcRenderer.invoke('tasks:load'),
  syncTasks: () => ipcRenderer.invoke('tasks:sync'),
  copyText: (s) => ipcRenderer.send('sys:copy', String(s)),
  openTasksDir: () => ipcRenderer.send('tasks:openDir'),
  info: () => ipcRenderer.invoke('sys:info'),
  quit: () => ipcRenderer.send('sys:quit'),
  closeReady: () => ipcRenderer.send('app:closeReady'),
  host: (info) => ipcRenderer.invoke('net:host', info),
  setInfo: (info) => ipcRenderer.send('net:setInfo', info),
  join: (ip, port) => ipcRenderer.invoke('net:join', ip, port),
  joinCode: (code) => ipcRenderer.invoke('net:joinCode', code),
  send: (msg, to, except) => ipcRenderer.send('net:send', msg, to, except),
  leave: () => ipcRenderer.send('net:leave'),
  scan: () => ipcRenderer.invoke('net:scan'),
  stopScan: () => ipcRenderer.send('net:stopScan'),
  on: (ch, cb) => { (listeners[ch] = listeners[ch] || []).push(cb); },
});

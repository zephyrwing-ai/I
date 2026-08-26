"use strict";
const electron = require("electron");
const IPC = {
  run: "agent:run",
  stop: "agent:stop",
  event: "agent:event",
  selectDirectory: "app:select-directory",
  openPath: "app:open-path"
};
const api = {
  run: (req) => electron.ipcRenderer.invoke(IPC.run, req),
  stop: () => electron.ipcRenderer.send(IPC.stop),
  selectDirectory: () => electron.ipcRenderer.invoke(IPC.selectDirectory),
  openPath: (path) => electron.ipcRenderer.send(IPC.openPath, path),
  onEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    electron.ipcRenderer.on(IPC.event, listener);
    return () => electron.ipcRenderer.removeListener(IPC.event, listener);
  }
};
electron.contextBridge.exposeInMainWorld("agentAPI", api);

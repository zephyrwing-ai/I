"use strict";
const electron = require("electron");
const IPC = {
  run: "agent:run",
  stop: "agent:stop",
  event: "agent:event",
  listProviderProfiles: "providers:list",
  discoverProviderModels: "providers:discover-models",
  cancelProviderModelDiscovery: "providers:cancel-discovery",
  refreshProviderModels: "providers:refresh-models",
  saveProvider: "providers:save",
  deleteProvider: "providers:delete",
  selectAttachments: "attachments:select",
  previewOutputFile: "output-files:preview",
  openOutputFile: "output-files:open"
};
const api = {
  run: (req) => electron.ipcRenderer.invoke(IPC.run, req),
  stop: () => electron.ipcRenderer.send(IPC.stop),
  listProviderProfiles: () => electron.ipcRenderer.invoke(IPC.listProviderProfiles),
  discoverProviderModels: (input) => electron.ipcRenderer.invoke(IPC.discoverProviderModels, input),
  cancelProviderModelDiscovery: (requestId) => {
    electron.ipcRenderer.send(IPC.cancelProviderModelDiscovery, requestId);
  },
  refreshProviderModels: (providerProfileId) => electron.ipcRenderer.invoke(IPC.refreshProviderModels, providerProfileId),
  saveProvider: (input) => electron.ipcRenderer.invoke(IPC.saveProvider, input),
  deleteProvider: (providerProfileId) => electron.ipcRenderer.invoke(IPC.deleteProvider, providerProfileId),
  selectAttachments: () => electron.ipcRenderer.invoke(IPC.selectAttachments),
  previewOutputFile: (runId, fileId) => electron.ipcRenderer.invoke(IPC.previewOutputFile, runId, fileId),
  openOutputFile: (runId, fileId) => electron.ipcRenderer.invoke(IPC.openOutputFile, runId, fileId),
  onEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    electron.ipcRenderer.on(IPC.event, listener);
    return () => electron.ipcRenderer.removeListener(IPC.event, listener);
  }
};
electron.contextBridge.exposeInMainWorld("agentAPI", api);

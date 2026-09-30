"use strict";
const electron = require("electron");
const IPC = {
  run: "agent:run",
  steer: "agent:steer",
  stop: "agent:stop",
  event: "agent:event",
  loadHistoryPage: "history:load-page",
  getActiveProject: "projects:active",
  selectProject: "projects:select",
  clearProject: "projects:clear",
  listProviderProfiles: "providers:list",
  discoverProviderModels: "providers:discover-models",
  cancelProviderModelDiscovery: "providers:cancel-discovery",
  refreshProviderModels: "providers:refresh-models",
  saveProvider: "providers:save",
  deleteProvider: "providers:delete",
  selectAttachments: "attachments:select",
  loadCanvasDocument: "canvas:load-document",
  saveCanvasDocument: "canvas:save-document",
  prepareCanvasContext: "canvas:prepare-context",
  canvasEditRequest: "canvas:edit-request",
  canvasEditCancel: "canvas:edit-cancel",
  canvasEditResult: "canvas:edit-result",
  previewOutputFile: "output-files:preview",
  openOutputFile: "output-files:open"
};
const api = {
  run: (req) => electron.ipcRenderer.invoke(IPC.run, req),
  steer: (req) => electron.ipcRenderer.invoke(IPC.steer, req),
  stop: () => electron.ipcRenderer.send(IPC.stop),
  loadHistoryPage: (request) => electron.ipcRenderer.invoke(IPC.loadHistoryPage, request),
  getActiveProject: () => electron.ipcRenderer.invoke(IPC.getActiveProject),
  selectProject: () => electron.ipcRenderer.invoke(IPC.selectProject),
  clearProject: () => electron.ipcRenderer.invoke(IPC.clearProject),
  listProviderProfiles: () => electron.ipcRenderer.invoke(IPC.listProviderProfiles),
  discoverProviderModels: (input) => electron.ipcRenderer.invoke(IPC.discoverProviderModels, input),
  cancelProviderModelDiscovery: (requestId) => {
    electron.ipcRenderer.send(IPC.cancelProviderModelDiscovery, requestId);
  },
  refreshProviderModels: (providerProfileId) => electron.ipcRenderer.invoke(IPC.refreshProviderModels, providerProfileId),
  saveProvider: (input) => electron.ipcRenderer.invoke(IPC.saveProvider, input),
  deleteProvider: (providerProfileId) => electron.ipcRenderer.invoke(IPC.deleteProvider, providerProfileId),
  selectAttachments: () => electron.ipcRenderer.invoke(IPC.selectAttachments),
  loadCanvasDocument: (projectId) => electron.ipcRenderer.invoke(IPC.loadCanvasDocument, projectId),
  saveCanvasDocument: (request) => electron.ipcRenderer.invoke(IPC.saveCanvasDocument, request),
  prepareCanvasContext: (input) => electron.ipcRenderer.invoke(IPC.prepareCanvasContext, input),
  onCanvasEditRequest: (cb) => {
    const listener = (_event, request) => cb(request);
    electron.ipcRenderer.on(IPC.canvasEditRequest, listener);
    return () => electron.ipcRenderer.removeListener(IPC.canvasEditRequest, listener);
  },
  onCanvasEditCancel: (cb) => {
    const listener = (_event, cancel) => cb(cancel);
    electron.ipcRenderer.on(IPC.canvasEditCancel, listener);
    return () => electron.ipcRenderer.removeListener(IPC.canvasEditCancel, listener);
  },
  completeCanvasEdit: (result) => {
    electron.ipcRenderer.send(IPC.canvasEditResult, result);
  },
  previewOutputFile: (runId, fileId) => electron.ipcRenderer.invoke(IPC.previewOutputFile, runId, fileId),
  openOutputFile: (runId, fileId) => electron.ipcRenderer.invoke(IPC.openOutputFile, runId, fileId),
  onEvent: (cb) => {
    const listener = (_event, payload) => cb(payload);
    electron.ipcRenderer.on(IPC.event, listener);
    return () => electron.ipcRenderer.removeListener(IPC.event, listener);
  }
};
electron.contextBridge.exposeInMainWorld("agentAPI", api);

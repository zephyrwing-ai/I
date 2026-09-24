/**
 * Preload — 通过 contextBridge 暴露一个最小、带类型的 API 给渲染进程。
 * 渲染进程无法直接拿 Node；所有能力都从这里显式透出。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC,
  type AgentAPI,
  type AgentEvent,
  type DeleteProviderResult,
  type CanvasContextDescriptor,
  type CanvasContextInput,
  type CanvasDocumentResult,
  type CanvasSaveResult,
  type CanvasSaveRequest,
  type InputAttachmentDescriptor,
  type OpenOutputFileResult,
  type OutputFilePreviewResult,
  type ProviderModelDiscoveryInput,
  type ProviderModelDiscoveryResult,
  type ProviderProfileInput,
  type ProviderProfileSummary,
  type RefreshProviderModelsResult,
  type ProjectDescriptor,
  type RunRequest,
  type RunStartAck,
  type SaveProviderResult,
  type HistoryPageRequest,
  type HistoryPageResult,
} from "../shared/ipc.js";

const api: AgentAPI = {
  run: (req: RunRequest): Promise<RunStartAck> => ipcRenderer.invoke(IPC.run, req),

  stop: (): void => ipcRenderer.send(IPC.stop),

  loadHistoryPage: (request: HistoryPageRequest): Promise<HistoryPageResult> => (
    ipcRenderer.invoke(IPC.loadHistoryPage, request)
  ),

  getActiveProject: (): Promise<ProjectDescriptor> => ipcRenderer.invoke(IPC.getActiveProject),

  selectProject: (): Promise<ProjectDescriptor | null> => ipcRenderer.invoke(IPC.selectProject),

  clearProject: (): Promise<ProjectDescriptor> => ipcRenderer.invoke(IPC.clearProject),

  listProviderProfiles: (): Promise<ProviderProfileSummary[]> => ipcRenderer.invoke(IPC.listProviderProfiles),

  discoverProviderModels: (input: ProviderModelDiscoveryInput): Promise<ProviderModelDiscoveryResult> => (
    ipcRenderer.invoke(IPC.discoverProviderModels, input)
  ),

  cancelProviderModelDiscovery: (requestId: string): void => {
    ipcRenderer.send(IPC.cancelProviderModelDiscovery, requestId);
  },

  refreshProviderModels: (providerProfileId: string): Promise<RefreshProviderModelsResult> => (
    ipcRenderer.invoke(IPC.refreshProviderModels, providerProfileId)
  ),

  saveProvider: (input: ProviderProfileInput): Promise<SaveProviderResult> => ipcRenderer.invoke(IPC.saveProvider, input),

  deleteProvider: (providerProfileId: string): Promise<DeleteProviderResult> => ipcRenderer.invoke(IPC.deleteProvider, providerProfileId),

  selectAttachments: (): Promise<InputAttachmentDescriptor[]> => ipcRenderer.invoke(IPC.selectAttachments),

  loadCanvasDocument: (projectId: string | null): Promise<CanvasDocumentResult> => ipcRenderer.invoke(IPC.loadCanvasDocument, projectId),

  saveCanvasDocument: (request: CanvasSaveRequest): Promise<CanvasSaveResult> => (
    ipcRenderer.invoke(IPC.saveCanvasDocument, request)
  ),

  prepareCanvasContext: (input: CanvasContextInput): Promise<CanvasContextDescriptor> => (
    ipcRenderer.invoke(IPC.prepareCanvasContext, input)
  ),

  previewOutputFile: (runId: string, fileId: string): Promise<OutputFilePreviewResult> => (
    ipcRenderer.invoke(IPC.previewOutputFile, runId, fileId)
  ),

  openOutputFile: (runId: string, fileId: string): Promise<OpenOutputFileResult> => (
    ipcRenderer.invoke(IPC.openOutputFile, runId, fileId)
  ),

  onEvent: (cb: (e: AgentEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: AgentEvent): void => cb(payload);
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.removeListener(IPC.event, listener);
  },
};

contextBridge.exposeInMainWorld("agentAPI", api);

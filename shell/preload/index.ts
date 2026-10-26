/**
 * Preload — 通过 contextBridge 暴露一个最小、带类型的 API 给渲染进程。
 * 渲染进程无法直接拿 Node；所有能力都从这里显式透出。
 */

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import {
  IPC,
  MAX_INPUT_ATTACHMENT_COUNT,
  MAX_INPUT_ATTACHMENT_BYTES,
  type AgentAPI,
  type AgentEvent,
  type DeleteProviderResult,
  type CanvasContextDescriptor,
  type CanvasContextInput,
  type CanvasEditCancel,
  type CanvasEditRequest,
  type CanvasEditResult,
  type CanvasDocumentResult,
  type CanvasSaveResult,
  type CanvasSaveRequest,
  type AttachmentImportResult,
  type AttachmentProcessingSettings,
  type AttachmentUpload,
  type OpenOutputFileResult,
  type OutputFilePreviewResult,
  type ProviderModelDiscoveryInput,
  type ProviderModelDiscoveryResult,
  type ProviderProfileInput,
  type ProviderProfileSummary,
  type RefreshProviderModelsResult,
  type ProjectDescriptor,
  type ProjectDirectoryRequest,
  type ProjectDirectoryResult,
  type ProjectActionRequest,
  type ProjectActionResult,
  type QuitPreparationRequest,
  type QuitPreparationResult,
  type RunRequest,
  type RunStartAck,
  type SteerRequest,
  type SteerAck,
  type VoiceTranscriptionRequest,
  type VoiceTranscriptionResult,
  type VoiceModelActionResult,
  type VoiceModelEvent,
  type VoiceModelSummary,
  type SaveProviderResult,
  type HistoryPageRequest,
  type HistoryPageResult,
} from "../shared/ipc.js";

const api: AgentAPI = {
  getUiPreferences: (legacyPreferences) => ipcRenderer.invoke(IPC.getUiPreferences, legacyPreferences),
  updateUiPreferences: (patch) => ipcRenderer.invoke(IPC.updateUiPreferences, patch),
  onPrepareToQuit: (cb: (request: QuitPreparationRequest) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, request: QuitPreparationRequest): void => cb(request);
    ipcRenderer.on(IPC.prepareToQuit, listener);
    ipcRenderer.send(IPC.quitPreparationReady, true);
    return () => {
      ipcRenderer.removeListener(IPC.prepareToQuit, listener);
      ipcRenderer.send(IPC.quitPreparationReady, false);
    };
  },

  completeQuitPreparation: (result: QuitPreparationResult): void => {
    ipcRenderer.send(IPC.quitPreparationResult, result);
  },

  run: (req: RunRequest): Promise<RunStartAck> => ipcRenderer.invoke(IPC.run, req),

  steer: (req: SteerRequest): Promise<SteerAck> => ipcRenderer.invoke(IPC.steer, req),

  stop: (): void => ipcRenderer.send(IPC.stop),

  transcribeVoice: (request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> => (
    ipcRenderer.invoke(IPC.transcribeVoice, request)
  ),

  cancelVoiceTranscription: (requestId: string): void => {
    ipcRenderer.send(IPC.cancelVoiceTranscription, requestId);
  },

  listVoiceModels: (): Promise<VoiceModelSummary[]> => ipcRenderer.invoke(IPC.listVoiceModels),

  scanVoiceModels: (): Promise<VoiceModelActionResult> => ipcRenderer.invoke(IPC.scanVoiceModels),

  downloadVoiceModel: (modelId: string): Promise<VoiceModelActionResult> => (
    ipcRenderer.invoke(IPC.downloadVoiceModel, modelId)
  ),

  cancelVoiceModelDownload: (modelId: string): void => {
    ipcRenderer.send(IPC.cancelVoiceModelDownload, modelId);
  },

  selectVoiceModel: (modelId: string): Promise<VoiceModelActionResult> => (
    ipcRenderer.invoke(IPC.selectVoiceModel, modelId)
  ),

  onVoiceModelEvent: (cb: (event: VoiceModelEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, event: VoiceModelEvent): void => cb(event);
    ipcRenderer.on(IPC.voiceModelEvent, listener);
    return () => ipcRenderer.removeListener(IPC.voiceModelEvent, listener);
  },

  loadHistoryPage: (request: HistoryPageRequest): Promise<HistoryPageResult> => (
    ipcRenderer.invoke(IPC.loadHistoryPage, request)
  ),

  getActiveProject: (): Promise<ProjectDescriptor> => ipcRenderer.invoke(IPC.getActiveProject),

  listProjects: (): Promise<ProjectDescriptor[]> => ipcRenderer.invoke(IPC.listProjects),

  listProjectDirectory: (request: ProjectDirectoryRequest): Promise<ProjectDirectoryResult> => (
    ipcRenderer.invoke(IPC.listProjectDirectory, request)
  ),

  activateProject: (projectId: string): Promise<ProjectDescriptor> => ipcRenderer.invoke(IPC.activateProject, projectId),

  performProjectAction: (request: ProjectActionRequest): Promise<ProjectActionResult> => ipcRenderer.invoke(IPC.performProjectAction, request),

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

  selectAttachments: (): Promise<AttachmentImportResult> => ipcRenderer.invoke(IPC.selectAttachments),

  importAttachments: async (files: File[]): Promise<AttachmentImportResult> => {
    if (!Array.isArray(files) || files.length > MAX_INPUT_ATTACHMENT_COUNT) throw new Error(`Add up to ${MAX_INPUT_ATTACHMENT_COUNT} files at a time.`);
    const uploads: AttachmentUpload[] = [];
    let memoryBytes = 0;
    for (const file of files) {
      const path = webUtils.getPathForFile(file);
      if (path) uploads.push({ path });
      else {
        memoryBytes += file.size;
        if (memoryBytes > MAX_INPUT_ATTACHMENT_BYTES) throw new Error("In-memory file uploads must total at most 100 MB.");
        uploads.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      }
    }
    return ipcRenderer.invoke(IPC.importAttachments, uploads);
  },

  openAttachment: (attachmentId: string): Promise<OpenOutputFileResult> => (
    ipcRenderer.invoke(IPC.openAttachment, attachmentId)
  ),

  openAttachmentsDirectory: (): Promise<OpenOutputFileResult> => (
    ipcRenderer.invoke(IPC.openAttachmentsDirectory)
  ),

  getAttachmentProcessingSettings: (): Promise<AttachmentProcessingSettings> => (
    ipcRenderer.invoke(IPC.getAttachmentProcessingSettings)
  ),

  setDocumentParser: (parserId: string): Promise<AttachmentProcessingSettings> => (
    ipcRenderer.invoke(IPC.setDocumentParser, parserId)
  ),

  installDocumentParser: (parserId: string): Promise<AttachmentProcessingSettings> => (
    ipcRenderer.invoke(IPC.installDocumentParser, parserId)
  ),

  loadCanvasDocument: (projectId: string | null): Promise<CanvasDocumentResult> => ipcRenderer.invoke(IPC.loadCanvasDocument, projectId),

  saveCanvasDocument: (request: CanvasSaveRequest): Promise<CanvasSaveResult> => (
    ipcRenderer.invoke(IPC.saveCanvasDocument, request)
  ),

  prepareCanvasContext: (input: CanvasContextInput): Promise<CanvasContextDescriptor> => (
    ipcRenderer.invoke(IPC.prepareCanvasContext, input)
  ),

  onCanvasEditRequest: (cb: (request: CanvasEditRequest) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, request: CanvasEditRequest): void => cb(request);
    ipcRenderer.on(IPC.canvasEditRequest, listener);
    return () => ipcRenderer.removeListener(IPC.canvasEditRequest, listener);
  },

  onCanvasEditCancel: (cb: (cancel: CanvasEditCancel) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, cancel: CanvasEditCancel): void => cb(cancel);
    ipcRenderer.on(IPC.canvasEditCancel, listener);
    return () => ipcRenderer.removeListener(IPC.canvasEditCancel, listener);
  },

  completeCanvasEdit: (result: CanvasEditResult): void => {
    ipcRenderer.send(IPC.canvasEditResult, result);
  },

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

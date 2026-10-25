import type { ModelCapabilities, ModelMessage } from "../../agent/model/types.js";
import type { UiPreferences } from "./ui-preferences.js";
export type { ModelCapabilities } from "../../agent/model/types.js";
import type { CanvasEditCancel, CanvasEditRequest, CanvasEditResult } from "../../canvas/commands/types.js";
export type { CanvasEditCancel, CanvasEditRequest, CanvasEditResult } from "../../canvas/commands/types.js";

export type Provider = "openai" | "anthropic" | "google";
export type RunStatus = "completed" | "cancelled" | "failed";
export type ProviderModelState = "saved" | "new" | "unavailable";

export interface DiscoveredModel {
  id: string;
  displayName: string;
  capabilities?: ModelCapabilities;
}

export interface ModelOption {
  modelOptionId: string;
  providerProfileId: string;
  providerName: string;
  modelId: string;
  displayName: string;
  available: boolean;
  imported: boolean;
  state: ProviderModelState;
  capabilities?: ModelCapabilities;
}

export interface ProviderProfileSummary {
  providerProfileId: string;
  name: string;
  baseURL: string;
  credentialConfigured: boolean;
  models: ModelOption[];
}

export interface ProviderProfileInput {
  providerProfileId?: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  models: DiscoveredModel[];
}

export interface ProviderModelDiscoveryInput {
  requestId: string;
  providerProfileId?: string;
  providerName: string;
  baseURL: string;
  apiKey?: string;
}

export type ProviderModelDiscoveryErrorKind =
  | "authentication"
  | "cancelled"
  | "empty"
  | "invalid_response"
  | "network"
  | "timeout"
  | "unsupported";

export type ProviderModelDiscoveryResult =
  | { ok: true; models: DiscoveredModel[] }
  | { ok: false; error: ProviderModelDiscoveryErrorKind; message: string };

export const MAX_INPUT_ATTACHMENT_COUNT = 10;
export const MAX_INPUT_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface InputAttachmentDescriptor {
  attachmentId: string;
  name: string;
  mediaType: string;
  byteSize: number;
  previewUrl?: string;
  mediaUrl?: string;
  durationSeconds?: number;
}

export interface AttachmentImportResult {
  attachments: InputAttachmentDescriptor[];
  errors: Array<{ name: string; message: string }>;
}

export interface DocumentParserDescriptor {
  parserId: string;
  displayName: string;
  version: string;
  advanced: boolean;
  available: boolean;
  installing: boolean;
  canInstall: boolean;
  unavailableReason?: string;
}

export interface AttachmentProcessingSettings {
  documentParserId: string;
  parsers: DocumentParserDescriptor[];
}

/** Preload resolves disk-backed File objects; memory files use a bounded byte payload. */
export type AttachmentUpload = { path: string } | { name: string; bytes: Uint8Array };

/** Serializable CanvasEditor state kept outside the model conversation history. */
export interface CanvasElementRecord {
  [key: string]: unknown;
}

export interface CanvasBinaryFile {
  id: string;
  mimeType: string;
  dataURL?: string;
  created: number;
  lastRetrieved?: number;
  version?: number;
}

export interface CanvasDocument {
  elements: CanvasElementRecord[];
  appState: Record<string, unknown>;
  files: Record<string, CanvasBinaryFile>;
}

export type CanvasContextScope = "selection";

export interface CanvasSelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasContextInput {
  projectId: string | null;
  scope: CanvasContextScope;
  selectedElementIds: string[];
  serializedJSON: string;
  coordinateSpace: "scene";
  selectionBounds: CanvasSelectionBounds;
  visual?: {
    mediaType: "image/png";
    dataURL: string;
  };
}

export interface CanvasContextDescriptor {
  contextId: string;
  projectId: string | null;
  label: string;
  scope: CanvasContextScope;
  elementCount: number;
  imageCount: number;
  hasVisual: boolean;
}

export interface CanvasPersistenceVersion {
  revision: number;
  fingerprint: string;
}

export interface CanvasDocumentResult {
  document: CanvasDocument;
  version: CanvasPersistenceVersion;
}

export type CanvasSaveResult =
  | { status: "saved"; version: CanvasPersistenceVersion }
  | { status: "conflict"; version: CanvasPersistenceVersion };

export interface CanvasSaveRequest {
  projectId: string | null;
  document: CanvasDocument;
  expectedVersion: CanvasPersistenceVersion;
}

export interface RunRequest {
  task: string;
  modelOptionId: string;
  attachmentIds: string[];
  canvasContextIds?: string[];
  /** 当前项目范围；null 表示无项目历史。 */
  projectId?: string | null;
}

export interface SteerRequest {
  runId: string;
  projectId: string | null;
  inputId: string;
  task: string;
}

export const VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export interface VoiceTranscriptionRequest {
  requestId: string;
  audio: ArrayBuffer;
}

export type VoiceTranscriptionError =
  | "cancelled"
  | "invalid_audio"
  | "invalid_request"
  | "model_missing"
  | "engine_missing"
  | "no_speech"
  | "timeout"
  | "transcription_failed";

export type VoiceTranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; error: VoiceTranscriptionError; message: string };

export type VoiceModelStatus = "not_downloaded" | "downloading" | "installed";

export interface VoiceModelSummary {
  id: string;
  name: string;
  tag: string;
  sizeLabel: string;
  ramLabel: string;
  speedLevel: number;
  wer: string;
  recommended: boolean;
  status: VoiceModelStatus;
  progress: number | null;
  selected: boolean;
}

export interface VoiceModelEvent {
  modelId: string;
  status: VoiceModelStatus;
  progress: number | null;
  error?: string;
}

export type VoiceModelActionResult = { ok: true } | { ok: false; error: string };

export type SteerAck =
  | { ok: true; runId: string; projectId: string | null; inputId: string; acceptOrder: number; acceptedAt: number }
  | { ok: false; error: string };

export interface ProjectDescriptor {
  projectId: string | null;
  displayName: string;
  canonicalPath: string | null;
  pinned?: boolean;
}

export interface ProjectDirectoryRequest {
  projectId: string;
  /** Empty string selects the project root; descendants use slash-separated paths. */
  relativePath: string;
  cursor?: string;
}

export interface ProjectDirectoryEntry {
  name: string;
  relativePath: string;
  kind: "file" | "directory" | "symlink";
}

export type ProjectDirectoryResult =
  | {
      ok: true;
      projectId: string;
      relativePath: string;
      entries: ProjectDirectoryEntry[];
      nextCursor: string | null;
    }
  | {
      ok: false;
      error: "invalid_request" | "not_found" | "not_directory" | "outside_project" | "symlink_not_allowed"
        | "project_changed" | "stale_cursor" | "directory_changed" | "permission_denied" | "read_failed";
      message: string;
    };

export interface ProjectActionRequest {
  projectId: string;
  action: "pin" | "unpin" | "reveal" | "rename" | "delete";
  name?: string;
}

export interface ProjectActionResult {
  status: "completed" | "cancelled";
  projects?: ProjectDescriptor[];
  activeProject: ProjectDescriptor;
}

export interface QuitPreparationRequest { requestId: string }
export interface QuitPreparationResult { requestId: string; error?: string }

export interface OutputFileDescriptor {
  runId: string;
  fileId: string;
  name: string;
  displayPath: string;
  operation: "created" | "updated";
  mediaType: string;
  byteSize: number;
  updatedAt: string;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  returncode: number;
  truncated: boolean;
  error?: string;
}

export type ToolCall = { id: string; name: string; input: Record<string, unknown>; inputComplete: boolean };
export type RunError = {
  kind: "config" | "network" | "provider" | "model_protocol" | "context_overflow" | "tool" | "runtime";
  message: string;
  retryable?: boolean;
};

export type RunStartAck = { ok: true; runId: string; inputId: string; createdAt: number; attachments?: InputAttachmentDescriptor[] } | { ok: false; error: string };

export interface HistoryPageRequest {
  cursor: string | null;
  limit: number;
}

export interface HistoryPageEntry {
  entryId: string;
  entryOrder: number;
  projectId: string | null;
  type: "user_message" | "assistant_message" | "tool_result";
  status: "streaming" | "completed" | "interrupted" | "failed";
  runId: string;
  turnId: string | null;
  toolCallId: string | null;
  revision: number;
  payload: ModelMessage;
  createdAt: number;
  completedAt: number | null;
  durationMs: number | null;
  /** Public projection of the invocation outcome associated with this result entry. */
  toolResult?: ToolResult;
}

export interface HistoryPageResult {
  projectId: string | null;
  entries: HistoryPageEntry[];
  nextCursor: string | null;
  hasMore: boolean;
  snapshotOrder: number;
}

export type SaveProviderResult = { ok: true; profile: ProviderProfileSummary } | { ok: false; error: string };
export type DeleteProviderResult = { ok: true } | { ok: false; error: string };
export type RefreshProviderModelsResult =
  | { ok: true; profile: ProviderProfileSummary }
  | { ok: false; error: ProviderModelDiscoveryErrorKind; message: string };
export type OpenOutputFileResult = { ok: true } | { ok: false; error: string };

export type OutputFilePreviewResult =
  | {
      ok: true;
      kind: "text";
      mediaType: string;
      content: string;
      truncated: boolean;
      byteSize: number;
      updatedAt: string;
    }
  | {
      ok: true;
      kind: "image";
      mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      dataUrl: string;
      byteSize: number;
      updatedAt: string;
    }
  | {
      ok: true;
      kind: "unsupported";
      mediaType: string;
      byteSize: number;
      updatedAt: string;
    }
  | {
      ok: false;
      error: "invalid_request" | "not_found" | "unsupported" | "too_large" | "read_failed";
      message: string;
      mediaType?: string;
      byteSize?: number;
    };

export type AgentEvent =
  | { type: "runStarted"; runId: string; startedAt: string }
  | { type: "turnStarted"; runId: string; turnId: string; turnOrdinal: number; attempt?: number }
  | { type: "assistantDelta"; runId: string; turnId: string; delta: string; attempt?: number }
  | { type: "progressDelta"; runId: string; turnId: string; delta: string; attempt?: number }
  | { type: "reasoningDelta"; runId: string; turnId: string; delta: string; attempt?: number }
  | { type: "assistantCompleted"; runId: string; turnId: string; content: string; progress?: string; toolCalls: ToolCall[]; stopReason: string; completedAt: number }
  | { type: "toolStarted"; runId: string; turnId: string; toolCallId: string; name: string; input: Record<string, unknown> }
  | { type: "toolCompleted"; runId: string; turnId: string; toolCallId: string; name: string; result: ToolResult }
  | { type: "outputFileRegistered"; runId: string; file: OutputFileDescriptor }
  | { type: "turnRetrying"; runId: string; turnId: string; attempt: number; nextAttempt: number; reason: string; delayMs: number; maxAttempts: number }
  | { type: "turnCompleted"; runId: string; turnId: string }
  | { type: "inputsApplied"; runId: string; inputIds: string[]; startedAt: number }
  | { type: "runCompleted"; runId: string; status: RunStatus; error?: RunError; turnCount: number; unappliedInputIds?: string[]; finalTurnId?: string; finalDurationMs?: number };

export interface AgentAPI {
  getUiPreferences(legacyPreferences?: UiPreferences): Promise<UiPreferences>;
  updateUiPreferences(patch: Partial<UiPreferences>): Promise<UiPreferences>;
  onPrepareToQuit(cb: (request: QuitPreparationRequest) => void): () => void;
  completeQuitPreparation(result: QuitPreparationResult): void;
  run(req: RunRequest): Promise<RunStartAck>;
  steer(req: SteerRequest): Promise<SteerAck>;
  stop(): void;
  transcribeVoice(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult>;
  cancelVoiceTranscription(requestId: string): void;
  listVoiceModels(): Promise<VoiceModelSummary[]>;
  downloadVoiceModel(modelId: string): Promise<VoiceModelActionResult>;
  cancelVoiceModelDownload(modelId: string): void;
  selectVoiceModel(modelId: string): Promise<VoiceModelActionResult>;
  onVoiceModelEvent(cb: (event: VoiceModelEvent) => void): () => void;
  loadHistoryPage(request: HistoryPageRequest): Promise<HistoryPageResult>;
  getActiveProject(): Promise<ProjectDescriptor>;
  listProjects(): Promise<ProjectDescriptor[]>;
  listProjectDirectory(request: ProjectDirectoryRequest): Promise<ProjectDirectoryResult>;
  activateProject(projectId: string): Promise<ProjectDescriptor>;
  performProjectAction(request: ProjectActionRequest): Promise<ProjectActionResult>;
  selectProject(): Promise<ProjectDescriptor | null>;
  clearProject(): Promise<ProjectDescriptor>;
  listProviderProfiles(): Promise<ProviderProfileSummary[]>;
  discoverProviderModels(input: ProviderModelDiscoveryInput): Promise<ProviderModelDiscoveryResult>;
  cancelProviderModelDiscovery(requestId: string): void;
  refreshProviderModels(providerProfileId: string): Promise<RefreshProviderModelsResult>;
  saveProvider(input: ProviderProfileInput): Promise<SaveProviderResult>;
  deleteProvider(providerProfileId: string): Promise<DeleteProviderResult>;
  selectAttachments(): Promise<AttachmentImportResult>;
  importAttachments(files: File[]): Promise<AttachmentImportResult>;
  openAttachment(attachmentId: string): Promise<OpenOutputFileResult>;
  openAttachmentsDirectory(): Promise<OpenOutputFileResult>;
  getAttachmentProcessingSettings(): Promise<AttachmentProcessingSettings>;
  setDocumentParser(parserId: string): Promise<AttachmentProcessingSettings>;
  installDocumentParser(parserId: string): Promise<AttachmentProcessingSettings>;
  loadCanvasDocument(projectId: string | null): Promise<CanvasDocumentResult>;
  saveCanvasDocument(request: CanvasSaveRequest): Promise<CanvasSaveResult>;
  prepareCanvasContext(input: CanvasContextInput): Promise<CanvasContextDescriptor>;
  onCanvasEditRequest(cb: (request: CanvasEditRequest) => void): () => void;
  onCanvasEditCancel(cb: (cancel: CanvasEditCancel) => void): () => void;
  completeCanvasEdit(result: CanvasEditResult): void;
  previewOutputFile(runId: string, fileId: string): Promise<OutputFilePreviewResult>;
  openOutputFile(runId: string, fileId: string): Promise<OpenOutputFileResult>;
  onEvent(cb: (e: AgentEvent) => void): () => void;
}

export const IPC = {
  getUiPreferences: "preferences:get",
  updateUiPreferences: "preferences:update",
  prepareToQuit: "app:prepare-to-quit",
  quitPreparationReady: "app:quit-preparation-ready",
  quitPreparationResult: "app:quit-preparation-result",
  run: "agent:run",
  steer: "agent:steer",
  stop: "agent:stop",
  event: "agent:event",
  transcribeVoice: "voice:transcribe",
  cancelVoiceTranscription: "voice:cancel-transcription",
  listVoiceModels: "voice-models:list",
  downloadVoiceModel: "voice-models:download",
  cancelVoiceModelDownload: "voice-models:cancel",
  selectVoiceModel: "voice-models:select",
  voiceModelEvent: "voice-models:event",
  loadHistoryPage: "history:load-page",
  getActiveProject: "projects:active",
  listProjects: "projects:list",
  listProjectDirectory: "projects:list-directory",
  activateProject: "projects:activate",
  performProjectAction: "projects:action",
  selectProject: "projects:select",
  clearProject: "projects:clear",
  listProviderProfiles: "providers:list",
  discoverProviderModels: "providers:discover-models",
  cancelProviderModelDiscovery: "providers:cancel-discovery",
  refreshProviderModels: "providers:refresh-models",
  saveProvider: "providers:save",
  deleteProvider: "providers:delete",
  selectAttachments: "attachments:select",
  importAttachments: "attachments:import",
  openAttachment: "attachments:open",
  openAttachmentsDirectory: "attachments:open-directory",
  getAttachmentProcessingSettings: "attachments:processing-settings",
  setDocumentParser: "attachments:set-document-parser",
  installDocumentParser: "attachments:install-document-parser",
  loadCanvasDocument: "canvas:load-document",
  saveCanvasDocument: "canvas:save-document",
  prepareCanvasContext: "canvas:prepare-context",
  canvasEditRequest: "canvas:edit-request",
  canvasEditCancel: "canvas:edit-cancel",
  canvasEditResult: "canvas:edit-result",
  previewOutputFile: "output-files:preview",
  openOutputFile: "output-files:open",
} as const;

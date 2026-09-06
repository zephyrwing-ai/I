export type Provider = "openai" | "anthropic" | "google";
export type RunStatus = "completed" | "cancelled" | "failed";
export type ProviderModelState = "saved" | "new" | "unavailable";

export interface DiscoveredModel {
  id: string;
  displayName: string;
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
  models: Array<DiscoveredModel & { available?: boolean }>;
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

export interface InputAttachmentDescriptor {
  attachmentId: string;
  name: string;
  mediaType: string;
  byteSize: number;
}

export interface RunRequest {
  task: string;
  modelOptionId: string;
  attachmentIds: string[];
  /** 由宿主任务上下文注入；Composer 不展示或编辑该字段。 */
  cwd?: string;
}

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
  kind: "config" | "network" | "provider" | "model_protocol" | "tool" | "runtime";
  message: string;
  retryable?: boolean;
};

export type RunStartAck = { ok: true; runId: string } | { ok: false; error: string };
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
  | { type: "turnStarted"; runId: string; turnId: string; turnOrdinal: number }
  | { type: "assistantDelta"; runId: string; turnId: string; delta: string }
  | { type: "reasoningDelta"; runId: string; turnId: string; delta: string }
  | { type: "assistantCompleted"; runId: string; turnId: string; content: string; toolCalls: ToolCall[]; stopReason: string }
  | { type: "toolStarted"; runId: string; turnId: string; toolCallId: string; name: string; input: Record<string, unknown> }
  | { type: "toolCompleted"; runId: string; turnId: string; toolCallId: string; name: string; result: ToolResult }
  | { type: "outputFileRegistered"; runId: string; file: OutputFileDescriptor }
  | { type: "turnCompleted"; runId: string; turnId: string }
  | { type: "runCompleted"; runId: string; status: RunStatus; error?: RunError; turnCount: number };

export interface AgentAPI {
  run(req: RunRequest): Promise<RunStartAck>;
  stop(): void;
  listProviderProfiles(): Promise<ProviderProfileSummary[]>;
  discoverProviderModels(input: ProviderModelDiscoveryInput): Promise<ProviderModelDiscoveryResult>;
  cancelProviderModelDiscovery(requestId: string): void;
  refreshProviderModels(providerProfileId: string): Promise<RefreshProviderModelsResult>;
  saveProvider(input: ProviderProfileInput): Promise<SaveProviderResult>;
  deleteProvider(providerProfileId: string): Promise<DeleteProviderResult>;
  selectAttachments(): Promise<InputAttachmentDescriptor[]>;
  previewOutputFile(runId: string, fileId: string): Promise<OutputFilePreviewResult>;
  openOutputFile(runId: string, fileId: string): Promise<OpenOutputFileResult>;
  onEvent(cb: (e: AgentEvent) => void): () => void;
}

export const IPC = {
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
  openOutputFile: "output-files:open",
} as const;

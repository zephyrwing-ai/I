import type { ModelMessage } from "../model/types.js";

export type { ModelMessage } from "../model/types.js";

export type HistoryScope = string | null;
export type EntryType = "user_message" | "assistant_message" | "tool_result";
export type EntryStatus = "streaming" | "completed" | "interrupted" | "failed";
export type RecordedRunStatus = "completed" | "cancelled" | "failed";
export type AssistantDeltaKind = "text" | "reasoning";
export type ToolInvocationPhase = "planned" | "effect_pending" | "outcome_ready" | "completed";
export type ToolOutcomeStatus = "succeeded" | "failed" | "cancelled" | "interrupted";
export type ToolRecoveryMode = "safe" | "reconcile" | "never";

export interface Project {
  id: string;
  canonicalPath: string;
  displayName: string;
  createdAt: number;
  lastOpenedAt: number;
}

export interface CreateProjectInput {
  id?: string;
  canonicalPath: string;
  displayName: string;
  createdAt?: number;
  lastOpenedAt?: number;
}

export interface ProjectContextRecord {
  projectId: string;
  treeJson: string;
  treeHash: string;
  capturedAt: number;
  scanPolicyVersion: string;
  complete: boolean;
  dirty: boolean;
}

export interface ProjectContextInput {
  treeJson: string;
  treeHash: string;
  capturedAt?: number;
  scanPolicyVersion: string;
  complete: boolean;
  dirty?: boolean;
}

export interface HistoryEntry {
  id: string;
  projectId: HistoryScope;
  entryOrder: number;
  type: EntryType;
  status: EntryStatus;
  runId: string;
  turnId: string | null;
  toolCallId: string | null;
  revision: number;
  payloadVersion: number;
  payload: ModelMessage;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface AppendEntryInput {
  id: string;
  type: EntryType;
  status: EntryStatus;
  runId: string;
  turnId?: string | null;
  toolCallId?: string | null;
  revision?: number;
  payloadVersion?: number;
  payload: ModelMessage;
  createdAt?: number;
  updatedAt?: number;
  completedAt?: number | null;
}

export interface EntryPatch {
  status?: EntryStatus;
  payload?: ModelMessage;
  payloadVersion?: number;
  turnId?: string | null;
  toolCallId?: string | null;
  updatedAt?: number;
  completedAt?: number | null;
}

export interface MessageCommitContext {
  runId: string;
}

export interface TurnCommitContext extends MessageCommitContext {
  turnId: string;
  turnOrdinal: number;
  attempt?: number;
}

export interface ToolCommitContext extends TurnCommitContext {
  toolCallId: string;
  entryId?: string;
}

export interface RegisterToolInvocationInput {
  runId: string;
  turnId: string;
  cwd: string;
  assistantEntryId: string;
  toolCallId: string;
  ordinal: number;
  toolName: string;
  toolVersion: string;
  inputJson: string;
  inputHash: string;
  recoveryModeSnapshot: ToolRecoveryMode;
  resultEntryId?: string;
  checkpoint?: unknown;
  createdAt?: number;
  updatedAt?: number;
}

export interface CreateToolInvocationInput extends RegisterToolInvocationInput {
  projectId: HistoryScope;
  id?: string;
}

export interface ToolInvocationRecord {
  id: string;
  projectId: HistoryScope;
  runId: string;
  turnId: string;
  cwd: string;
  assistantEntryId: string;
  toolCallId: string;
  ordinal: number;
  toolName: string;
  toolVersion: string;
  inputJson: string;
  inputHash: string;
  phase: ToolInvocationPhase;
  outcomeStatus: ToolOutcomeStatus | null;
  outcomeJson: unknown | null;
  recoveryModeSnapshot: ToolRecoveryMode;
  attemptCount: number;
  checkpoint: unknown | null;
  resultEntryId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ToolOutcomeInput {
  status: ToolOutcomeStatus;
  outcome: unknown;
  checkpoint?: unknown;
  updatedAt?: number;
}

export interface HistoryRepository {
  createProject(input: CreateProjectInput): Promise<Project>;
  getProject(projectId: string): Promise<Project | null>;
  getProjectByPath(canonicalPath: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;
  touchProject(projectId: string, lastOpenedAt?: number): Promise<Project>;
  getProjectContext(projectId: string): Promise<ProjectContextRecord | null>;
  saveProjectContext(projectId: string, input: ProjectContextInput): Promise<ProjectContextRecord>;
  markProjectContextDirty(projectId: string): Promise<void>;
  appendEntry(projectId: HistoryScope, entry: AppendEntryInput): Promise<HistoryEntry>;
  updateEntry(entryId: string, expectedRevision: number, patch: EntryPatch): Promise<HistoryEntry>;
  getEntry(entryId: string): Promise<HistoryEntry | null>;
  listEntries(projectId: HistoryScope, cursor?: number, limit?: number): Promise<HistoryEntry[]>;
  listLatestEntries(projectId: HistoryScope, limit: number): Promise<HistoryEntry[]>;
  listEntriesBefore(projectId: HistoryScope, beforeOrder: number, limit: number): Promise<HistoryEntry[]>;
  registerToolInvocation(input: CreateToolInvocationInput): Promise<ToolInvocationRecord>;
  beginToolAttempt(invocationId: string): Promise<ToolInvocationRecord>;
  saveToolOutcome(invocationId: string, outcome: ToolOutcomeInput): Promise<ToolInvocationRecord>;
  completeToolInvocation(invocationId: string, resultEntryId: string): Promise<ToolInvocationRecord>;
  getToolInvocation(projectId: HistoryScope, runId: string, toolCallId: string): Promise<ToolInvocationRecord | null>;
  listOpenToolInvocations(projectId: HistoryScope, runId?: string): Promise<ToolInvocationRecord[]>;
  close?(): Promise<void> | void;
}

export class RepositoryError extends Error {
  constructor(message: string, readonly code: "not_found" | "conflict" | "invalid" | "storage") {
    super(message);
    this.name = "RepositoryError";
  }
}

export interface HistoryRecorder {
  readonly projectId: HistoryScope;
  snapshot(): ModelMessage[];
  getAssistantEntryId?(turnId: string): Promise<string | null>;
  commitUser(message: ModelMessage, context: MessageCommitContext): Promise<void>;
  recordAssistantDelta(kind: AssistantDeltaKind, delta: string, context: TurnCommitContext): void;
  finishAssistantAttempt(
    context: TurnCommitContext,
    status: "completed" | "interrupted" | "failed",
    message?: ModelMessage,
  ): Promise<void>;
  commitAssistant(message: ModelMessage, context: TurnCommitContext): Promise<void>;
  commitToolResult(message: ModelMessage, context: ToolCommitContext): Promise<void>;
  registerToolInvocation(input: RegisterToolInvocationInput): Promise<ToolInvocationRecord>;
  beginToolAttempt(invocationId: string): Promise<ToolInvocationRecord>;
  saveToolOutcome(invocationId: string, outcome: ToolOutcomeInput): Promise<ToolInvocationRecord>;
  completeToolInvocation(invocationId: string, resultEntryId: string): Promise<ToolInvocationRecord>;
  getToolInvocation(runId: string, toolCallId: string): Promise<ToolInvocationRecord | null>;
  listOpenToolInvocations(runId?: string): Promise<ToolInvocationRecord[]>;
  finishRun(result: { runId: string; status: RecordedRunStatus }): Promise<void>;
  close(): Promise<void>;
}

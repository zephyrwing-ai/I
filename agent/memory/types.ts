import type { ModelMessage } from "../model/types.js";

export type { ModelMessage } from "../model/types.js";

export type SessionStatus = "active" | "waiting" | "closed";
export type EntryType = "user_message" | "assistant_message" | "tool_result";
export type EntryStatus = "streaming" | "completed" | "interrupted" | "failed";
export type RecordedRunStatus = "completed" | "cancelled" | "failed";
export type AssistantDeltaKind = "text" | "reasoning";
export type ToolInvocationPhase = "planned" | "effect_pending" | "outcome_ready" | "completed";
export type ToolOutcomeStatus = "succeeded" | "failed" | "cancelled" | "interrupted";
export type ToolRecoveryMode = "safe" | "reconcile" | "never";

export interface Session {
  id: string;
  scopeKey: string;
  objective: string | null;
  status: SessionStatus;
  nextEntrySeq: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionEntry {
  id: string;
  sessionId: string;
  sessionSeq: number;
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
}

export interface CreateSessionInput {
  id?: string;
  scopeKey: string;
  objective?: string | null;
  status?: SessionStatus;
  createdAt?: number;
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
}

export interface EntryPatch {
  status?: EntryStatus;
  payload?: ModelMessage;
  payloadVersion?: number;
  turnId?: string | null;
  toolCallId?: string | null;
  updatedAt?: number;
}

export interface SessionPatch {
  objective?: string | null;
  status?: SessionStatus;
  updatedAt?: number;
}

export interface MessageCommitContext {
  runId: string;
}

export interface TurnCommitContext extends MessageCommitContext {
  turnId: string;
  turnOrdinal: number;
  /** 同一逻辑 turn 的第几次模型尝试；旧调用默认使用 1。 */
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
  sessionId: string;
  id?: string;
}

export interface ToolInvocationRecord {
  id: string;
  sessionId: string;
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

export interface SessionRepository {
  createSession(input: CreateSessionInput): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  getLatestOpenSession(scopeKey: string): Promise<Session | null>;
  appendEntry(sessionId: string, entry: AppendEntryInput): Promise<SessionEntry>;
  updateEntry(entryId: string, expectedRevision: number, patch: EntryPatch): Promise<SessionEntry>;
  getEntry(entryId: string): Promise<SessionEntry | null>;
  /** 正向扫描，供 Recorder 从已知 sessionSeq 之后恢复完整模型上下文。 */
  listEntries(sessionId: string, cursor?: number, limit?: number): Promise<SessionEntry[]>;
  /** 读取会话尾部最新的一页，结果按 sessionSeq 从新到旧返回。 */
  listLatestEntries(sessionId: string, limit: number): Promise<SessionEntry[]>;
  /** 读取 beforeSeq 之前的一页，结果按 sessionSeq 从新到旧返回。 */
  listEntriesBefore(sessionId: string, beforeSeq: number, limit: number): Promise<SessionEntry[]>;
  registerToolInvocation(input: CreateToolInvocationInput): Promise<ToolInvocationRecord>;
  beginToolAttempt(invocationId: string): Promise<ToolInvocationRecord>;
  saveToolOutcome(invocationId: string, outcome: ToolOutcomeInput): Promise<ToolInvocationRecord>;
  completeToolInvocation(invocationId: string, resultEntryId: string): Promise<ToolInvocationRecord>;
  getToolInvocation(sessionId: string, toolCallId: string): Promise<ToolInvocationRecord | null>;
  listOpenToolInvocations(sessionId: string): Promise<ToolInvocationRecord[]>;
  updateSession(sessionId: string, expectedRevision: number, patch: SessionPatch): Promise<Session>;
  close?(): Promise<void> | void;
}

export class RepositoryError extends Error {
  constructor(message: string, readonly code: "not_found" | "conflict" | "invalid" | "storage") {
    super(message);
    this.name = "RepositoryError";
  }
}

export interface SessionRecorder {
  readonly sessionId: string;
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
  getToolInvocation(sessionId: string, toolCallId: string): Promise<ToolInvocationRecord | null>;
  listOpenToolInvocations(sessionId: string): Promise<ToolInvocationRecord[]>;
  finishRun(result: { runId: string; status: RecordedRunStatus }): Promise<void>;
  close(): Promise<void>;
}

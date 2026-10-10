import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { SqliteHistoryRepository } from "./sqlite-repository.js";
import { readModelMessage, type ModelMessage, type ToolCall } from "../model/types.js";
import { jsonEqual } from "../json.js";
import {
  RepositoryError,
  type AcceptRunInputInput,
  type AssistantDeltaKind,
  type MessageCommitContext,
  type RecordedRunStatus,
  type HistoryEntry,
  type HistoryRecorder,
  type HistoryRepository,
  type HistoryScope,
  type PendingRunInput,
  type RegisterToolInvocationInput,
  type ToolCommitContext,
  type ToolInvocationRecord,
  type ToolInvocationPlan,
  type ToolOutcomeInput,
  type TurnCommitContext,
} from "./types.js";

type Timer = ReturnType<typeof setTimeout>;

interface DraftState {
  key: string;
  entryId: string;
  runId: string;
  turnId: string;
  turnOrdinal: number;
  attempt: number;
  message: ModelMessage;
  revision: number | null;
  pendingBytes: number;
  dirty: boolean;
  timer: Timer | undefined;
  terminal: boolean;
  finalStatus?: "completed" | "interrupted" | "failed";
  completedAt?: number;
  createdAt: number;
  contextEntryId?: string;
  plans: ToolInvocationPlan[];
}

export const DRAFT_FLUSH_INTERVAL_MS = 500;
export const DRAFT_FLUSH_BYTES = 4096;

function cloneMessage(message: ModelMessage): ModelMessage {
  let normalized: unknown;
  try {
    normalized = JSON.parse(JSON.stringify(message));
  } catch (cause) {
    throw new RepositoryError("History message must be JSON serializable.", "storage", { cause });
  }
  const copy = readModelMessage(normalized);
  if (!copy) throw new RepositoryError("History message must be a valid ModelMessage.", "storage");
  return copy;
}

function freezeSnapshot(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => Object.freeze(cloneMessage(message)));
}

function validateMessage(message: ModelMessage, role: ModelMessage["role"]): void {
  if (message.role !== role) throw new RepositoryError(`Expected a ${role} message.`, "invalid");
}

function draftKey(context: TurnCommitContext): string {
  return JSON.stringify([context.turnId, context.attempt ?? 1]);
}

function toolEntryKey(runId: string, toolCallId: string): string {
  return JSON.stringify([runId, toolCallId]);
}

export class DefaultHistoryRecorder implements HistoryRecorder {
  readonly projectId: HistoryScope;
  private readonly repository: HistoryRepository;
  private readonly completedMessages: ModelMessage[] = [];
  private readonly completedEntryIds = new Set<string>();
  private readonly activeDrafts = new Map<string, DraftState>();
  private readonly initialUserEntries = new Map<string, { entryId: string; message: ModelMessage }>();
  private readonly toolEntries = new Map<string, HistoryEntry>();
  private readonly assistantEntries = new Map<string, string>();
  private readonly assistantAttempts = new Map<string, DraftState>();
  private writeChain: Promise<void> = Promise.resolve();
  private readonly draftErrors = new Map<string, unknown>();
  private closed = false;

  constructor(projectId: HistoryScope, repository: HistoryRepository, entries: HistoryEntry[] = []) {
    this.projectId = projectId;
    this.repository = repository;
    for (const entry of [...entries].sort((left, right) => left.entryOrder - right.entryOrder)) {
      if (entry.projectId !== projectId) throw new RepositoryError("History entry belongs to a different scope.", "conflict");
      if (entry.type === "user_message") {
        if (!this.initialUserEntries.has(entry.runId)) {
          this.initialUserEntries.set(entry.runId, { entryId: entry.id, message: cloneMessage(entry.payload) });
        }
      }
      if (entry.type === "tool_result" && entry.toolCallId && entry.status === "completed") {
        this.toolEntries.set(toolEntryKey(entry.runId, entry.toolCallId), { ...entry, payload: cloneMessage(entry.payload) });
      }
      if (entry.type === "assistant_message" && entry.turnId) this.assistantEntries.set(entry.turnId, entry.id);
      this.appendCompletedEntry(entry);
    }
  }

  snapshot(): ModelMessage[] {
    return freezeSnapshot(this.completedMessages);
  }

  getAssistantEntryId(turnId: string): Promise<string | null> {
    return Promise.resolve(this.assistantEntries.get(turnId) ?? null);
  }

  commitUser(message: ModelMessage, context: MessageCommitContext): Promise<void> {
    return this.persistInitialUser(message, context, "completed");
  }

  archiveUnappliedUser(message: ModelMessage, context: MessageCommitContext): Promise<void> {
    return this.persistInitialUser(message, context, "interrupted");
  }

  private persistInitialUser(message: ModelMessage, context: MessageCommitContext, status: "completed" | "interrupted"): Promise<void> {
    validateMessage(message, "user");
    this.ensureOpen();
    const copy = cloneMessage(message);
    return this.enqueueResult(async () => {
      const previous = this.initialUserEntries.get(context.runId);
      if (previous) {
        if (context.entryId && previous.entryId !== context.entryId) {
          throw new RepositoryError(`The initial user entry ID changed for run ${context.runId}.`, "conflict");
        }
        if (!jsonEqual(previous.message, copy)) {
          throw new RepositoryError(`A different initial user message already belongs to run ${context.runId}.`, "conflict");
        }
        return;
      }
      const entryId = context.entryId ?? randomUUID();
      const entry = await this.repository.appendEntry(this.projectId, {
        id: entryId,
        type: "user_message",
        status,
        runId: context.runId,
        payload: copy,
        createdAt: context.createdAt,
      });
      this.initialUserEntries.set(context.runId, { entryId, message: copy });
      this.appendCompletedEntry(entry);
    });
  }

  acceptRunInput(input: AcceptRunInputInput): Promise<PendingRunInput> {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.acceptRunInput(this.projectId, input));
  }

  listAcceptedRunInputs(runId: string): Promise<PendingRunInput[]> {
    this.ensureOpen();
    return this.waitForWrites().then(() => this.repository.listAcceptedRunInputs(this.projectId, runId));
  }

  applyRunInputs(runId: string, inputIds: string[]): Promise<HistoryEntry[]> {
    this.ensureOpen();
    return this.enqueueResult(async () => {
      const entries = await this.repository.applyRunInputs(this.projectId, runId, inputIds);
      for (const entry of entries) this.appendCompletedEntry(entry);
      return entries;
    });
  }

  abandonRunInputs(runId: string, reason: string): Promise<HistoryEntry[]> {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.abandonRunInputs(this.projectId, runId, reason));
  }

  finalizeAnswerDuration(turnId: string, durationMs: number): Promise<void> {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.finalizeAnswerDuration(this.projectId, turnId, durationMs));
  }

  recordAssistantDelta(kind: AssistantDeltaKind, delta: string, context: TurnCommitContext): void {
    this.ensureOpen();
    if (!delta) return;
    if (this.assistantAttempts.has(draftKey(context))) throw new RepositoryError("Assistant attempt is already terminal.", "conflict");
    const draft = this.prepareDraft(context);
    if (draft.terminal) throw new RepositoryError("Assistant attempt is already terminal.", "conflict");
    if (kind === "text") draft.message.content += delta;
    else draft.message.reasoning = (draft.message.reasoning ?? "") + delta;
    draft.pendingBytes += Buffer.byteLength(delta, "utf8");
    draft.dirty = true;
    if (draft.pendingBytes >= DRAFT_FLUSH_BYTES) {
      this.scheduleFlush(draft, true);
    } else if (draft.timer === undefined) {
      draft.timer = setTimeout(() => {
        draft.timer = undefined;
        void this.enqueueResult(() => this.flushDraft(draft)).catch(() => undefined);
      }, DRAFT_FLUSH_INTERVAL_MS);
    }
  }

  async finishAssistantAttempt(
    context: TurnCommitContext,
    status: "completed" | "interrupted" | "failed",
    message?: ModelMessage,
    plans: ToolInvocationPlan[] = [],
  ): Promise<ToolInvocationRecord[]> {
    this.ensureOpen();
    if (message) validateMessage(message, "assistant");
    const pending = this.activeDrafts.get(draftKey(context)) ?? this.assistantAttempts.get(draftKey(context));
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    if (pending) pending.timer = undefined;
    const frozenContext = { ...context, createdAt: context.createdAt ?? pending?.createdAt ?? Date.now(), completedAt: context.completedAt ?? Date.now() };
    const copy = cloneMessage(message ?? pending?.message ?? { role: "assistant", content: "" });
    const planCopy = JSON.parse(JSON.stringify(plans)) as ToolInvocationPlan[];
    return this.enqueueResult(() => {
      const draft = this.prepareDraft(frozenContext);
      if (draft.terminal && (draft.finalStatus !== status || !jsonEqual(draft.message, copy) || !jsonEqual(draft.plans, planCopy))) {
        throw new RepositoryError(`Assistant terminal content changed for attempt ${draft.key}.`, "conflict");
      }
      this.prepareTerminal(draft, status, copy, planCopy, frozenContext.completedAt);
      return this.commitDraft(draft);
    });
  }

  commitToolResult(message: ModelMessage, context: ToolCommitContext): Promise<void> {
    validateMessage(message, "tool");
    this.ensureOpen();
    if (!message.toolCallId || message.toolCallId !== context.toolCallId) {
      return Promise.reject(new RepositoryError(`Tool result does not match ${context.toolCallId}.`, "invalid"));
    }
    const key = toolEntryKey(context.runId, context.toolCallId);
    const copy = cloneMessage(message);
    return this.enqueueResult(async () => {
      const previous = this.toolEntries.get(key);
      if (previous) {
        if (context.entryId !== undefined && previous.id !== context.entryId) {
          throw new RepositoryError(`Tool result entry ID changed for run ${context.runId}, call ${context.toolCallId}.`, "conflict");
        }
        if (previous.turnId !== context.turnId || !jsonEqual(previous.payload, copy)) {
          throw new RepositoryError(`Tool result already exists with different content for run ${context.runId}, call ${context.toolCallId}.`, "conflict");
        }
        if (context.invocationId === undefined) return;
      }
      const entryId = previous?.id ?? context.entryId ?? randomUUID();
      const entry = await this.repository.commitToolResult(this.projectId, {
        id: entryId,
        type: "tool_result",
        status: "completed",
        runId: context.runId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        payload: copy,
        createdAt: previous?.createdAt ?? context.createdAt,
        completedAt: previous?.completedAt ?? context.completedAt,
      }, context.invocationId);
      this.toolEntries.set(key, entry);
      this.appendCompletedEntry(entry);
    });
  }

  registerToolInvocation(input: RegisterToolInvocationInput): Promise<ToolInvocationRecord> {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.registerToolInvocation({ ...input, projectId: this.projectId }));
  }

  requestRunCancellation(runId: string): Promise<void> {
    this.ensureOpen();
    // Stop is an admission barrier, so it must not wait behind draft writes.
    // The synchronous SQLite transaction completes before this call returns.
    return this.repository.requestRunCancellation(this.projectId, runId);
  }

  isRunCancelled(runId: string): Promise<boolean> {
    this.ensureOpen();
    return this.repository.isRunCancelled(this.projectId, runId);
  }

  isToolInvocationBlocked(invocationId: string): Promise<boolean> {
    this.ensureOpen();
    return this.writeChain.then(() => this.repository.isToolInvocationBlocked(invocationId));
  }

  getToolInvocationCall(invocationId: string): Promise<ToolCall> {
    this.ensureOpen();
    return this.writeChain.then(() => this.repository.getToolInvocationCall(invocationId));
  }

  beginToolAttempt(invocationId: string, checkpoint?: unknown): Promise<ToolInvocationRecord> {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.beginToolAttempt(invocationId, checkpoint));
  }

  saveToolOutcome(invocationId: string, outcome: ToolOutcomeInput): Promise<ToolInvocationRecord> {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.saveToolOutcome(invocationId, outcome));
  }

  settleUnstartedToolInvocation(invocationId: string, outcome: ToolOutcomeInput): Promise<ToolInvocationRecord> {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.settleUnstartedToolInvocation(invocationId, outcome));
  }

  getToolInvocation(runId: string, toolCallId: string): Promise<ToolInvocationRecord | null> {
    this.ensureOpen();
    return this.waitForWrites().then(() => this.repository.getToolInvocation(this.projectId, runId, toolCallId));
  }

  listOpenToolInvocations(runId?: string): Promise<ToolInvocationRecord[]> {
    this.ensureOpen();
    // A failed assistant draft does not invalidate the separately committed tool ledger.
    // Cancellation must still settle that ledger before finishRun flushes the draft.
    return this.writeChain.then(() => this.repository.listOpenToolInvocations(this.projectId, runId));
  }

  async finishRun(result: { runId: string; status: RecordedRunStatus }): Promise<void> {
    this.ensureOpen();
    for (const draft of this.activeDrafts.values()) {
      if (draft.runId !== result.runId) continue;
      if (draft.timer !== undefined) clearTimeout(draft.timer);
      draft.timer = undefined;
      await this.enqueueResult(() => {
        if (this.activeDrafts.get(draft.key) !== draft) return Promise.resolve([]);
        this.prepareTerminal(draft, result.status === "completed" ? "completed" : result.status === "cancelled" ? "interrupted" : "failed", draft.message, result.status === "completed" ? draft.plans : []);
        return this.commitDraft(draft);
      });
    }
    await this.waitForWrites();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const draft of this.activeDrafts.values()) {
      if (draft.timer !== undefined) clearTimeout(draft.timer);
      draft.timer = undefined;
      await this.enqueueResult(() => {
        if (this.activeDrafts.get(draft.key) !== draft) return Promise.resolve([]);
        this.prepareTerminal(draft, "interrupted", draft.message, []);
        return this.commitDraft(draft);
      });
    }
    await this.waitForWrites();
    this.closed = true;
  }

  private scheduleFlush(draft: DraftState, immediate: boolean): void {
    if (draft.timer !== undefined) {
      clearTimeout(draft.timer);
      draft.timer = undefined;
    }
    if (immediate) void this.enqueueResult(() => this.flushDraft(draft)).catch(() => undefined);
  }

  private prepareDraft(context: TurnCommitContext): DraftState {
    const key = draftKey(context);
    const existing = this.activeDrafts.get(key) ?? this.assistantAttempts.get(key);
    if (existing) {
      if (existing.runId !== context.runId || existing.turnOrdinal !== context.turnOrdinal
        || (existing.contextEntryId !== undefined && context.entryId !== undefined && existing.contextEntryId !== context.entryId)) {
        throw new RepositoryError(`Assistant attempt identity changed: ${key}.`, "conflict");
      }
      existing.contextEntryId ??= context.entryId;
      return existing;
    }
    const draft: DraftState = {
      key, entryId: context.entryId ?? randomUUID(), contextEntryId: context.entryId,
      runId: context.runId, turnId: context.turnId, turnOrdinal: context.turnOrdinal,
      attempt: context.attempt ?? 1, createdAt: context.createdAt ?? Date.now(),
      message: { role: "assistant", content: "" }, revision: null, pendingBytes: 0,
      dirty: false, timer: undefined, terminal: false, plans: [],
    };
    this.activeDrafts.set(key, draft);
    return draft;
  }

  private async commitDraft(draft: DraftState): Promise<ToolInvocationRecord[]> {
    const savedAttempt = this.assistantAttempts.has(draft.key);
    let committedEntry: HistoryEntry | undefined;
    try {
      const previousId = this.assistantEntries.get(draft.turnId);
      const previous = draft.revision === null && previousId ? await this.repository.getEntry(previousId) : null;
      if (previous?.status === "completed") committedEntry = previous;
      if (previous) {
        if (previous.projectId !== this.projectId || previous.runId !== draft.runId || previous.turnId !== draft.turnId) {
          throw new RepositoryError(`Assistant attempt belongs to a different identity: ${draft.key}.`, "conflict");
        }
        if (previous.status === "completed") {
          if (previous.status !== draft.finalStatus || !jsonEqual(previous.payload, draft.message)) {
            throw new RepositoryError(`Assistant attempt already exists with different content: ${draft.key}.`, "conflict");
          }
          draft.entryId = previous.id;
          draft.revision = null;
          draft.createdAt = previous.createdAt;
          draft.completedAt = previous.completedAt ?? undefined;
        }
      }
      const result = await this.repository.commitAssistantAttempt(this.projectId, {
        entry: {
          id: draft.entryId, type: "assistant_message", status: draft.finalStatus!,
          runId: draft.runId, turnId: draft.turnId, payload: cloneMessage(draft.message),
          createdAt: draft.createdAt, completedAt: draft.finalStatus === "completed" ? draft.completedAt : null,
        },
        expectedRevision: draft.revision,
      }, draft.plans);
      draft.entryId = result.assistant.id;
      draft.revision = result.assistant.revision;
      draft.dirty = false;
      this.assistantEntries.set(draft.turnId, result.assistant.id);
      this.assistantAttempts.set(draft.key, draft);
      this.appendCompletedEntry(result.assistant);
      this.activeDrafts.delete(draft.key);
      this.draftErrors.delete(draft.key);
      return result.invocations;
    } catch (error) {
      if (savedAttempt || committedEntry) {
        this.activeDrafts.delete(draft.key);
        this.draftErrors.delete(draft.key);
      } else this.draftErrors.set(draft.key, error);
      throw error;
    }
  }

  private prepareTerminal(draft: DraftState, status: "completed" | "interrupted" | "failed", message: ModelMessage, plans: ToolInvocationPlan[], completedAt = Date.now()): void {
    if (draft.timer !== undefined) clearTimeout(draft.timer);
    draft.timer = undefined;
    draft.message = message;
    draft.plans = plans;
    draft.terminal = true;
    draft.dirty = true;
    draft.finalStatus = status;
    if (status === "completed") draft.completedAt ??= completedAt;
  }

  private async flushDraft(draft: DraftState): Promise<void> {
    if (draft.terminal || !draft.dirty) return;
    const message = cloneMessage(draft.message);
    const pendingBytes = draft.pendingBytes;
    let entry: HistoryEntry;
    try {
      if (draft.revision === null) {
        entry = await this.repository.appendEntry(this.projectId, {
          id: draft.entryId,
          type: "assistant_message",
          status: "streaming",
          runId: draft.runId,
          turnId: draft.turnId,
          payload: message,
          createdAt: draft.createdAt,
        });
      } else {
        entry = await this.repository.updateEntry(draft.entryId, draft.revision, {
          status: "streaming",
          payload: message,
        });
      }
    } catch (error) {
      this.draftErrors.set(draft.key, error);
      throw error;
    }
    this.draftErrors.delete(draft.key);
    draft.revision = entry.revision;
    this.assistantEntries.set(draft.turnId, entry.id);
    draft.pendingBytes -= pendingBytes;
    draft.dirty = draft.terminal || !jsonEqual(draft.message, message);
  }

  private appendCompletedEntry(entry: HistoryEntry): void {
    if (entry.status !== "completed" || this.completedEntryIds.has(entry.id)) return;
    this.completedEntryIds.add(entry.id);
    this.completedMessages.push(cloneMessage(entry.payload));
  }

  private enqueueResult<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation);
    // The queue always drains; callers get their operation's error, while draft
    // failures are retained per attempt by flushDraft until that draft is saved.
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async waitForWrites(): Promise<void> {
    await this.writeChain;
    if (this.draftErrors.size > 0) throw this.draftErrors.values().next().value;
  }

  private ensureOpen(): void {
    if (this.closed) throw new RepositoryError("History recorder is closed.", "storage");
  }
}

async function readAllEntries(repository: HistoryRepository, projectId: HistoryScope): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  let cursor = 0;
  while (true) {
    const batch = await repository.listEntries(projectId, cursor, 500);
    entries.push(...batch);
    if (batch.length < 500) return entries;
    cursor = batch[batch.length - 1]!.entryOrder;
  }
}

const recoveryByRepository = new WeakMap<HistoryRepository, Promise<void>>();

async function recoverAcceptedInputsOnce(repository: HistoryRepository): Promise<void> {
  let recovery = recoveryByRepository.get(repository);
  if (!recovery) {
    recovery = repository.recoverAcceptedRunInputs("startup_recovery").then(() => undefined);
    recoveryByRepository.set(repository, recovery);
  }
  try {
    await recovery;
  } catch (error) {
    if (recoveryByRepository.get(repository) === recovery) recoveryByRepository.delete(repository);
    throw error;
  }
}

export async function createHistoryRecorder(repository: HistoryRepository, projectId: HistoryScope): Promise<DefaultHistoryRecorder> {
  await recoverAcceptedInputsOnce(repository);
  const entries = await readAllEntries(repository, projectId);
  for (const entry of entries) {
    if (entry.status !== "streaming") continue;
    await repository.updateEntry(entry.id, entry.revision, { status: "interrupted" });
    entry.status = "interrupted";
    entry.revision += 1;
  }
  return new DefaultHistoryRecorder(projectId, repository, entries);
}

export async function createTransientHistoryRecorder(initialMessages: ModelMessage[] = []): Promise<DefaultHistoryRecorder> {
  const repository = new SqliteHistoryRepository(":memory:");
  const entries: HistoryEntry[] = [];
  for (const [index, message] of initialMessages.entries()) {
    entries.push(await repository.appendEntry(null, {
      id: randomUUID(), runId: `initial-${index}`, turnId: message.role === "user" ? null : `initial-turn-${index}`,
      type: message.role === "user" ? "user_message" : message.role === "assistant" ? "assistant_message" : "tool_result",
      status: "completed", payload: cloneMessage(message), toolCallId: message.toolCallId,
    }));
  }
  return new DefaultHistoryRecorder(null, repository, entries);
}

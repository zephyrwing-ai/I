import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { SqliteSessionRepository } from "./sqlite-repository.js";
import type { ModelMessage } from "../model/types.js";
import {
  RepositoryError,
  type AssistantDeltaKind,
  type MessageCommitContext,
  type RecordedRunStatus,
  type SessionEntry,
  type SessionRecorder,
  type SessionRepository,
  type RegisterToolInvocationInput,
  type ToolCommitContext,
  type ToolInvocationRecord,
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
}

export const DRAFT_FLUSH_INTERVAL_MS = 500;
export const DRAFT_FLUSH_BYTES = 4096;

function cloneMessage(message: ModelMessage): ModelMessage {
  return JSON.parse(JSON.stringify(message)) as ModelMessage;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isSameMessage(left: ModelMessage, right: ModelMessage): boolean {
  return canonical(left) === canonical(right);
}

function freezeSnapshot(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => Object.freeze(cloneMessage(message)) as ModelMessage);
}

function validateMessage(message: ModelMessage, role: ModelMessage["role"]): void {
  if (message.role !== role) throw new RepositoryError(`Expected a ${role} message.`, "invalid");
}

function draftKey(context: TurnCommitContext): string {
  return `${context.turnId}:${context.attempt ?? 1}`;
}

export class DefaultSessionRecorder implements SessionRecorder {
  readonly sessionId: string;
  private readonly repository: SessionRepository;
  private readonly completedMessages: ModelMessage[] = [];
  private readonly activeDrafts = new Map<string, DraftState>();
  private readonly userEntries = new Map<string, { entryId: string; message: ModelMessage }>();
  private readonly toolEntries = new Map<string, { entryId: string; message: ModelMessage }>();
  private readonly assistantEntries = new Map<string, string>();
  private writeChain: Promise<void> = Promise.resolve();
  private backgroundError: unknown;
  private closed = false;

  constructor(sessionId: string, repository: SessionRepository, entries: SessionEntry[] = []) {
    this.sessionId = sessionId;
    this.repository = repository;
    for (const entry of [...entries].sort((left, right) => left.sessionSeq - right.sessionSeq)) {
      if (entry.type === "user_message") this.userEntries.set(entry.runId, { entryId: entry.id, message: cloneMessage(entry.payload) });
      if (entry.type === "tool_result" && entry.toolCallId) this.toolEntries.set(entry.toolCallId, { entryId: entry.id, message: cloneMessage(entry.payload) });
      if (entry.type === "assistant_message" && entry.turnId) this.assistantEntries.set(entry.turnId, entry.id);
      if (entry.status === "completed") this.completedMessages.push(cloneMessage(entry.payload));
    }
  }

  snapshot(): ModelMessage[] {
    return freezeSnapshot(this.completedMessages);
  }

  getAssistantEntryId(turnId: string): Promise<string | null> {
    return Promise.resolve(this.assistantEntries.get(turnId) ?? null);
  }

  commitUser(message: ModelMessage, context: MessageCommitContext): Promise<void> {
    validateMessage(message, "user");
    this.ensureOpen();
    const previous = this.userEntries.get(context.runId);
    if (previous) {
      if (!isSameMessage(previous.message, message)) {
        return Promise.reject(new RepositoryError(`A different user message already belongs to run ${context.runId}.`, "conflict"));
      }
      return this.waitForWrites();
    }
    const entryId = randomUUID();
    const copy = cloneMessage(message);
    this.userEntries.set(context.runId, { entryId, message: copy });
    return this.enqueueAndCheck(async () => {
      const entry = await this.repository.appendEntry(this.sessionId, {
        id: entryId,
        type: "user_message",
        status: "completed",
        runId: context.runId,
        payload: copy,
      });
      this.completedMessages.push(cloneMessage(entry.payload));
    });
  }

  recordAssistantDelta(kind: AssistantDeltaKind, delta: string, context: TurnCommitContext): void {
    this.ensureOpen();
    if (!delta) return;
    const key = draftKey(context);
    let draft = this.activeDrafts.get(key);
    if (!draft) {
      draft = {
        key,
        entryId: randomUUID(),
        runId: context.runId,
        turnId: context.turnId,
        turnOrdinal: context.turnOrdinal,
        attempt: context.attempt ?? 1,
        message: { role: "assistant", content: "" },
        revision: null,
        pendingBytes: 0,
        dirty: false,
        timer: undefined,
        terminal: false,
      };
      this.activeDrafts.set(key, draft);
    }
    if (kind === "text") draft.message.content += delta;
    else draft.message.reasoning = (draft.message.reasoning ?? "") + delta;
    draft.pendingBytes += Buffer.byteLength(delta, "utf8");
    draft.dirty = true;
    if (draft.pendingBytes >= DRAFT_FLUSH_BYTES) {
      this.scheduleFlush(draft, true);
    } else if (draft.timer === undefined) {
      draft.timer = setTimeout(() => {
        draft!.timer = undefined;
        void this.enqueue(() => this.flushDraft(draft!));
      }, DRAFT_FLUSH_INTERVAL_MS);
    }
  }

  finishAssistantAttempt(
    context: TurnCommitContext,
    status: "completed" | "interrupted" | "failed",
    message?: ModelMessage,
  ): Promise<void> {
    this.ensureOpen();
    const key = draftKey(context);
    let draft = this.activeDrafts.get(key);
    if (message) validateMessage(message, "assistant");
    if (!draft) {
      draft = {
        key,
        entryId: randomUUID(),
        runId: context.runId,
        turnId: context.turnId,
        turnOrdinal: context.turnOrdinal,
        attempt: context.attempt ?? 1,
        message: cloneMessage(message ?? { role: "assistant", content: "" }),
        revision: null,
        pendingBytes: 0,
        dirty: true,
        timer: undefined,
        terminal: true,
      };
      this.activeDrafts.set(key, draft);
    } else {
      if (draft.terminal && message && !isSameMessage(draft.message, message)) {
        return Promise.reject(new RepositoryError(`Assistant message already committed for attempt ${key}.`, "conflict"));
      }
      if (draft.terminal) return this.waitForWrites();
      if (message) draft.message = cloneMessage(message);
      draft.dirty = true;
      draft.terminal = true;
      if (draft.timer !== undefined) clearTimeout(draft.timer);
      draft.timer = undefined;
    }
    draft.finalStatus = status;
    return this.enqueueAndCheck(async () => {
      await this.flushDraft(draft!);
    });
  }

  commitAssistant(message: ModelMessage, context: TurnCommitContext): Promise<void> {
    return this.finishAssistantAttempt(context, "completed", message);
  }

  commitToolResult(message: ModelMessage, context: ToolCommitContext): Promise<void> {
    validateMessage(message, "tool");
    this.ensureOpen();
    if (!message.toolCallId || message.toolCallId !== context.toolCallId) {
      return Promise.reject(new RepositoryError(`Tool result does not match ${context.toolCallId}.`, "invalid"));
    }
    const previous = this.toolEntries.get(context.toolCallId);
    if (previous) {
      if (!isSameMessage(previous.message, message)) return Promise.reject(new RepositoryError(`Tool result already exists with different content: ${context.toolCallId}`, "conflict"));
      return this.waitForWrites();
    }
    const entryId = context.entryId ?? randomUUID();
    const copy = cloneMessage(message);
    this.toolEntries.set(context.toolCallId, { entryId, message: copy });
    return this.enqueueAndCheck(async () => {
      const entry = await this.repository.appendEntry(this.sessionId, {
        id: entryId,
        type: "tool_result",
        status: "completed",
        runId: context.runId,
        turnId: context.turnId,
        toolCallId: context.toolCallId,
        payload: copy,
      });
      this.completedMessages.push(cloneMessage(entry.payload));
    });
  }

  registerToolInvocation(input: RegisterToolInvocationInput): Promise<ToolInvocationRecord> {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.registerToolInvocation({ ...input, sessionId: this.sessionId }));
  }

  beginToolAttempt(invocationId: string): Promise<ToolInvocationRecord> {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.beginToolAttempt(invocationId));
  }

  saveToolOutcome(invocationId: string, outcome: ToolOutcomeInput): Promise<ToolInvocationRecord> {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.saveToolOutcome(invocationId, outcome));
  }

  completeToolInvocation(invocationId: string, resultEntryId: string): Promise<ToolInvocationRecord> {
    this.ensureOpen();
    return this.enqueueResult(() => this.repository.completeToolInvocation(invocationId, resultEntryId));
  }

  getToolInvocation(sessionId: string, toolCallId: string): Promise<ToolInvocationRecord | null> {
    this.ensureOpen();
    if (sessionId !== this.sessionId) return Promise.reject(new RepositoryError(`Session recorder is bound to ${this.sessionId}.`, "invalid"));
    return this.waitForWrites().then(() => this.repository.getToolInvocation(sessionId, toolCallId));
  }

  listOpenToolInvocations(sessionId: string): Promise<ToolInvocationRecord[]> {
    this.ensureOpen();
    if (sessionId !== this.sessionId) return Promise.reject(new RepositoryError(`Session recorder is bound to ${this.sessionId}.`, "invalid"));
    return this.waitForWrites().then(() => this.repository.listOpenToolInvocations(sessionId));
  }

  async finishRun(result: { runId: string; status: RecordedRunStatus }): Promise<void> {
    this.ensureOpen();
    for (const draft of this.activeDrafts.values()) {
      if (draft.runId !== result.runId) continue;
      if (draft.timer !== undefined) clearTimeout(draft.timer);
      draft.timer = undefined;
      draft.terminal = true;
      draft.dirty = true;
      draft.finalStatus = result.status === "completed" ? "completed" : result.status === "cancelled" ? "interrupted" : "failed";
      await this.enqueue(() => this.flushDraft(draft));
    }
    await this.waitForWrites();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const draft of this.activeDrafts.values()) {
      if (draft.timer !== undefined) clearTimeout(draft.timer);
      draft.timer = undefined;
      draft.terminal = true;
      draft.dirty = true;
      draft.finalStatus = "interrupted";
      await this.enqueue(() => this.flushDraft(draft));
    }
    await this.waitForWrites();
    this.closed = true;
  }

  private scheduleFlush(draft: DraftState, immediate: boolean): void {
    if (draft.timer !== undefined) {
      clearTimeout(draft.timer);
      draft.timer = undefined;
    }
    if (immediate) void this.enqueue(() => this.flushDraft(draft));
  }

  private async flushDraft(draft: DraftState): Promise<void> {
    if (!draft.dirty && draft.revision !== null) return;
    const finalStatus = draft.finalStatus;
    const status = finalStatus ?? (draft.terminal ? "completed" : "streaming");
    let entry: SessionEntry;
    if (draft.revision === null) {
      entry = await this.repository.appendEntry(this.sessionId, {
        id: draft.entryId,
        type: "assistant_message",
        status,
        runId: draft.runId,
        turnId: draft.turnId,
        payload: cloneMessage(draft.message),
      });
    } else {
      entry = await this.repository.updateEntry(draft.entryId, draft.revision, {
        status,
        payload: cloneMessage(draft.message),
      });
    }
    draft.revision = entry.revision;
    this.assistantEntries.set(draft.turnId, entry.id);
    draft.pendingBytes = 0;
    draft.dirty = false;
    if (status === "completed") this.completedMessages.push(cloneMessage(entry.payload));
    if (draft.terminal) this.activeDrafts.delete(draft.key);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.catch((error) => {
      this.backgroundError = error;
    });
    return next;
  }

  private enqueueResult<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.then(
      () => undefined,
      (error) => {
        this.backgroundError = error;
      },
    );
    return next;
  }

  private async enqueueAndCheck(operation: () => Promise<void>): Promise<void> {
    await this.enqueue(operation);
    await this.waitForWrites();
  }

  private async waitForWrites(): Promise<void> {
    await this.writeChain;
    if (this.backgroundError) throw this.backgroundError;
  }

  private ensureOpen(): void {
    if (this.closed) throw new RepositoryError("Session recorder is closed.", "storage");
  }
}

async function readAllEntries(repository: SessionRepository, sessionId: string): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  let cursor = 0;
  while (true) {
    const batch = await repository.listEntries(sessionId, cursor, 500);
    entries.push(...batch);
    if (batch.length < 500) return entries;
    cursor = batch[batch.length - 1]!.sessionSeq;
  }
}

export async function createSessionRecorder(repository: SessionRepository, sessionId: string): Promise<DefaultSessionRecorder> {
  const session = await repository.getSession(sessionId);
  if (!session) throw new RepositoryError(`Session not found: ${sessionId}`, "not_found");
  const entries = await readAllEntries(repository, sessionId);
  for (const entry of entries) {
    if (entry.status !== "streaming") continue;
    await repository.updateEntry(entry.id, entry.revision, { status: "interrupted" });
    entry.status = "interrupted";
    entry.revision += 1;
  }
  return new DefaultSessionRecorder(sessionId, repository, entries);
}

export async function createTransientSessionRecorder(initialMessages: ModelMessage[] = []): Promise<DefaultSessionRecorder> {
  const repository = new SqliteSessionRepository(":memory:");
  const session = await repository.createSession({ scopeKey: "transient" });
  const recorder = new DefaultSessionRecorder(session.id, repository);
  for (const [index, message] of initialMessages.entries()) {
    if (message.role === "user") await recorder.commitUser(message, { runId: `initial-${index}` });
    else if (message.role === "assistant") await recorder.commitAssistant(message, { runId: `initial-${index}`, turnId: `initial-turn-${index}`, turnOrdinal: index + 1 });
    else if (message.role === "tool" && message.toolCallId) await recorder.commitToolResult(message, { runId: `initial-${index}`, turnId: `initial-turn-${index}`, turnOrdinal: index + 1, toolCallId: message.toolCallId });
  }
  return recorder;
}

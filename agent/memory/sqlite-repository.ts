import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema } from "./schema.js";
import {
  RepositoryError,
  type AppendEntryInput,
  type CreateSessionInput,
  type EntryPatch,
  type Session,
  type SessionEntry,
  type SessionPatch,
  type SessionRepository,
  type EntryStatus,
  type EntryType,
  type CreateToolInvocationInput,
  type SessionStatus,
  type ToolInvocationPhase,
  type ToolInvocationRecord,
  type ToolOutcomeInput,
  type ToolOutcomeStatus,
  type ToolRecoveryMode,
} from "./types.js";

type Row = Record<string, unknown>;

function now(): number {
  return Date.now();
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

function serializeJson(value: unknown, field: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new RepositoryError(`${field} must be JSON serializable.`, "invalid");
  return serialized;
}

function parseJson(value: unknown, field: string): unknown | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new RepositoryError(`Stored ${field} is not text.`, "storage");
  try {
    return JSON.parse(value);
  } catch {
    throw new RepositoryError(`Stored ${field} is invalid JSON.`, "storage");
  }
}

function parsePayload(value: unknown): SessionEntry["payload"] {
  if (typeof value !== "string") throw new RepositoryError("Stored entry payload is not text.", "storage");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new RepositoryError("Stored entry payload is invalid JSON.", "storage");
  }
  if (!parsed || typeof parsed !== "object" || !["user", "assistant", "tool"].includes((parsed as { role?: unknown }).role as string) || typeof (parsed as { content?: unknown }).content !== "string") {
    throw new RepositoryError("Stored entry payload is not a ModelMessage.", "storage");
  }
  return parsed as SessionEntry["payload"];
}

function validatePayloadForType(type: EntryType, payload: SessionEntry["payload"], toolCallId: string | null | undefined): void {
  const expectedRole = type === "user_message" ? "user" : type === "assistant_message" ? "assistant" : "tool";
  if (payload.role !== expectedRole) throw new RepositoryError(`${type} payload must use role ${expectedRole}.`, "invalid");
  if (type === "tool_result" && !toolCallId) throw new RepositoryError("tool_result requires toolCallId.", "invalid");
}

function rowToSession(row: Row): Session {
  return {
    id: String(row.id),
    scopeKey: String(row.scope_key),
    objective: row.objective === null || row.objective === undefined ? null : String(row.objective),
    status: String(row.status) as SessionStatus,
    nextEntrySeq: Number(row.next_entry_seq),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToEntry(row: Row): SessionEntry {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sessionSeq: Number(row.session_seq),
    type: String(row.type) as EntryType,
    status: String(row.status) as EntryStatus,
    runId: String(row.run_id),
    turnId: row.turn_id === null || row.turn_id === undefined ? null : String(row.turn_id),
    toolCallId: row.tool_call_id === null || row.tool_call_id === undefined ? null : String(row.tool_call_id),
    revision: Number(row.revision),
    payloadVersion: Number(row.payload_version),
    payload: parsePayload(row.payload_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToToolInvocation(row: Row): ToolInvocationRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    turnId: String(row.turn_id),
    cwd: String(row.cwd),
    assistantEntryId: String(row.assistant_entry_id),
    toolCallId: String(row.tool_call_id),
    ordinal: Number(row.ordinal),
    toolName: String(row.tool_name),
    toolVersion: String(row.tool_version),
    inputJson: String(row.input_json),
    inputHash: String(row.input_hash),
    phase: String(row.phase) as ToolInvocationPhase,
    outcomeStatus: row.outcome_status === null || row.outcome_status === undefined ? null : String(row.outcome_status) as ToolOutcomeStatus,
    outcomeJson: parseJson(row.outcome_json, "tool outcome"),
    recoveryModeSnapshot: String(row.recovery_mode_snapshot) as ToolRecoveryMode,
    attemptCount: Number(row.attempt_count),
    checkpoint: parseJson(row.checkpoint_json, "tool checkpoint"),
    resultEntryId: row.result_entry_id === null || row.result_entry_id === undefined ? null : String(row.result_entry_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class SqliteSessionRepository implements SessionRepository {
  readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    initializeSchema(this.database);
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? now();
    const status = input.status ?? "active";
    const session: Session = {
      id,
      scopeKey: input.scopeKey,
      objective: input.objective ?? null,
      status,
      nextEntrySeq: 1,
      revision: 0,
      createdAt,
      updatedAt: createdAt,
    };
    try {
      this.database.prepare(`
        INSERT INTO sessions
          (id, scope_key, objective, status, next_entry_seq, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 0, ?, ?)
      `).run(session.id, session.scopeKey, session.objective, session.status, session.createdAt, session.updatedAt);
    } catch (error) {
      throw new RepositoryError(`Failed to create session: ${error instanceof Error ? error.message : String(error)}`, "storage");
    }
    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Row | undefined;
    return row ? rowToSession(row) : null;
  }

  async getLatestOpenSession(scopeKey: string): Promise<Session | null> {
    const row = this.database.prepare(`
      SELECT * FROM sessions
      WHERE scope_key = ? AND status != 'closed'
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(scopeKey) as Row | undefined;
    return row ? rowToSession(row) : null;
  }

  async appendEntry(sessionId: string, entry: AppendEntryInput): Promise<SessionEntry> {
    validatePayloadForType(entry.type, entry.payload, entry.toolCallId);
    const result = this.transaction(() => {
      const sessionRow = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Row | undefined;
      if (!sessionRow) throw new RepositoryError(`Session not found: ${sessionId}`, "not_found");

      const existingRow = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entry.id) as Row | undefined;
      if (existingRow) {
        const existing = rowToEntry(existingRow);
        const same = existing.sessionId === sessionId
          && existing.type === entry.type
          && existing.status === entry.status
          && existing.runId === entry.runId
          && existing.turnId === (entry.turnId ?? null)
          && existing.toolCallId === (entry.toolCallId ?? null)
          && existing.payloadVersion === (entry.payloadVersion ?? 1)
          && canonical(existing.payload) === canonical(entry.payload);
        if (same) return existing;
        throw new RepositoryError(`Entry already exists with different content: ${entry.id}`, "conflict");
      }

      const timestamp = entry.createdAt ?? now();
      const updatedAt = entry.updatedAt ?? timestamp;
      const sessionSeq = Number(sessionRow.next_entry_seq);
      this.database.prepare(`
        INSERT INTO entries
          (id, session_id, session_seq, type, status, run_id, turn_id, tool_call_id,
           revision, payload_version, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        sessionId,
        sessionSeq,
        entry.type,
        entry.status,
        entry.runId,
        entry.turnId ?? null,
        entry.toolCallId ?? null,
        entry.revision ?? 0,
        entry.payloadVersion ?? 1,
        JSON.stringify(entry.payload),
        timestamp,
        updatedAt,
      );
      this.database.prepare(`
        UPDATE sessions
        SET next_entry_seq = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(sessionSeq + 1, updatedAt, sessionId);
      const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entry.id) as Row;
      return rowToEntry(row);
    });
    return result;
  }

  async updateEntry(entryId: string, expectedRevision: number, patch: EntryPatch): Promise<SessionEntry> {
    const result = this.transaction(() => {
      const existingRow = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId) as Row | undefined;
      if (!existingRow) throw new RepositoryError(`Entry not found: ${entryId}`, "not_found");
      const existing = rowToEntry(existingRow);
      if (existing.revision !== expectedRevision) {
        throw new RepositoryError(`Entry revision conflict: ${entryId}`, "conflict");
      }
      const updatedAt = patch.updatedAt ?? now();
      const nextStatus = patch.status ?? existing.status;
      const nextPayload = patch.payload ?? existing.payload;
      const nextPayloadVersion = patch.payloadVersion ?? existing.payloadVersion;
      const nextTurnId = patch.turnId === undefined ? existing.turnId : patch.turnId;
      const nextToolCallId = patch.toolCallId === undefined ? existing.toolCallId : patch.toolCallId;
      validatePayloadForType(existing.type, nextPayload, nextToolCallId);
      this.database.prepare(`
        UPDATE entries
        SET status = ?, turn_id = ?, tool_call_id = ?, revision = revision + 1,
            payload_version = ?, payload_json = ?, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        nextStatus,
        nextTurnId,
        nextToolCallId,
        nextPayloadVersion,
        JSON.stringify(nextPayload),
        updatedAt,
        entryId,
        expectedRevision,
      );
      this.database.prepare(`
        UPDATE sessions
        SET revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(updatedAt, existing.sessionId);
      const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId) as Row;
      return rowToEntry(row);
    });
    return result;
  }

  async getEntry(entryId: string): Promise<SessionEntry | null> {
    const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId) as Row | undefined;
    return row ? rowToEntry(row) : null;
  }

  async listEntries(sessionId: string, cursor = 0, limit = 100): Promise<SessionEntry[]> {
    if (!Number.isInteger(cursor) || cursor < 0) throw new RepositoryError("Entry cursor must be a non-negative integer.", "invalid");
    if (!Number.isInteger(limit) || limit <= 0) throw new RepositoryError("Entry limit must be a positive integer.", "invalid");
    const rows = this.database.prepare(`
      SELECT * FROM entries
      WHERE session_id = ? AND session_seq > ?
      ORDER BY session_seq ASC
      LIMIT ?
    `).all(sessionId, cursor, limit) as Row[];
    return rows.map(rowToEntry);
  }

  async listLatestEntries(sessionId: string, limit: number): Promise<SessionEntry[]> {
    this.validateHistoryLimit(limit);
    const rows = this.database.prepare(`
      SELECT * FROM entries
      WHERE session_id = ?
      ORDER BY session_seq DESC
      LIMIT ?
    `).all(sessionId, limit) as Row[];
    return rows.map(rowToEntry);
  }

  async listEntriesBefore(sessionId: string, beforeSeq: number, limit: number): Promise<SessionEntry[]> {
    if (!Number.isSafeInteger(beforeSeq) || beforeSeq <= 0) {
      throw new RepositoryError("History cursor must be a positive safe integer.", "invalid");
    }
    this.validateHistoryLimit(limit);
    const rows = this.database.prepare(`
      SELECT * FROM entries
      WHERE session_id = ? AND session_seq < ?
      ORDER BY session_seq DESC
      LIMIT ?
    `).all(sessionId, beforeSeq, limit) as Row[];
    return rows.map(rowToEntry);
  }

  async registerToolInvocation(input: CreateToolInvocationInput): Promise<ToolInvocationRecord> {
    this.validateToolInvocationInput(input);
    const id = input.id ?? randomUUID();
    const resultEntryId = input.resultEntryId ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    const updatedAt = input.updatedAt ?? timestamp;
    const checkpointJson = input.checkpoint === undefined ? null : serializeJson(input.checkpoint, "checkpoint");
    return this.transaction(() => {
      const session = this.database.prepare("SELECT id FROM sessions WHERE id = ?").get(input.sessionId) as Row | undefined;
      if (!session) throw new RepositoryError(`Session not found: ${input.sessionId}`, "not_found");
      try {
        this.database.prepare(`
          INSERT INTO tool_invocations
            (id, session_id, run_id, turn_id, cwd, assistant_entry_id, tool_call_id, ordinal,
             tool_name, tool_version, input_json, input_hash, phase, outcome_status,
             outcome_json, recovery_mode_snapshot, attempt_count, checkpoint_json,
             result_entry_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, NULL, ?, 0, ?, ?, ?, ?)
        `).run(
          id, input.sessionId, input.runId, input.turnId, input.cwd, input.assistantEntryId,
          input.toolCallId, input.ordinal, input.toolName, input.toolVersion,
          input.inputJson, input.inputHash, input.recoveryModeSnapshot,
          checkpointJson, resultEntryId, timestamp, updatedAt,
        );
      } catch (error) {
        throw new RepositoryError(`Failed to register tool invocation: ${error instanceof Error ? error.message : String(error)}`, "conflict");
      }
      this.bumpSession(input.sessionId, updatedAt);
      return this.getToolInvocationById(id)!;
    });
  }

  async beginToolAttempt(invocationId: string): Promise<ToolInvocationRecord> {
    return this.transaction(() => {
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (existing.phase === "effect_pending") {
        const updatedAt = now();
        this.database.prepare(`
          UPDATE tool_invocations
          SET attempt_count = attempt_count + 1, updated_at = ?
          WHERE id = ? AND phase = 'effect_pending'
        `).run(updatedAt, invocationId);
        this.bumpSession(existing.sessionId, updatedAt);
        return this.getToolInvocationById(invocationId)!;
      }
      if (existing.phase !== "planned") {
        throw new RepositoryError(`Tool invocation cannot begin from phase ${existing.phase}: ${invocationId}`, "conflict");
      }
      const updatedAt = now();
      this.database.prepare(`
        UPDATE tool_invocations
        SET phase = 'effect_pending', attempt_count = attempt_count + 1, updated_at = ?
        WHERE id = ? AND phase = 'planned'
      `).run(updatedAt, invocationId);
      this.bumpSession(existing.sessionId, updatedAt);
      return this.getToolInvocationById(invocationId)!;
    });
  }

  async saveToolOutcome(invocationId: string, outcome: ToolOutcomeInput): Promise<ToolInvocationRecord> {
    const outcomeJson = serializeJson(outcome.outcome, "tool outcome");
    const checkpointJson = outcome.checkpoint === undefined ? null : serializeJson(outcome.checkpoint, "checkpoint");
    return this.transaction(() => {
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (existing.phase === "outcome_ready" || existing.phase === "completed") {
        if (existing.outcomeStatus !== outcome.status || canonical(existing.outcomeJson) !== canonical(outcome.outcome)) {
          throw new RepositoryError(`Tool outcome already exists with different content: ${invocationId}`, "conflict");
        }
        return existing;
      }
      if (existing.phase !== "effect_pending") {
        throw new RepositoryError(`Tool invocation cannot save outcome from phase ${existing.phase}: ${invocationId}`, "conflict");
      }
      const updatedAt = outcome.updatedAt ?? now();
      this.database.prepare(`
        UPDATE tool_invocations
        SET phase = 'outcome_ready', outcome_status = ?, outcome_json = ?,
            checkpoint_json = COALESCE(?, checkpoint_json), updated_at = ?
        WHERE id = ? AND phase = 'effect_pending'
      `).run(outcome.status, outcomeJson, checkpointJson, updatedAt, invocationId);
      this.bumpSession(existing.sessionId, updatedAt);
      return this.getToolInvocationById(invocationId)!;
    });
  }

  async completeToolInvocation(invocationId: string, resultEntryId: string): Promise<ToolInvocationRecord> {
    if (!resultEntryId) throw new RepositoryError("resultEntryId is required.", "invalid");
    return this.transaction(() => {
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (existing.phase === "completed") {
        if (existing.resultEntryId !== resultEntryId) throw new RepositoryError(`Tool invocation already completed with a different result: ${invocationId}`, "conflict");
        return existing;
      }
      if (existing.phase !== "outcome_ready") {
        throw new RepositoryError(`Tool invocation cannot complete from phase ${existing.phase}: ${invocationId}`, "conflict");
      }
      const updatedAt = now();
      this.database.prepare(`
        UPDATE tool_invocations
        SET phase = 'completed', result_entry_id = ?, updated_at = ?
        WHERE id = ? AND phase = 'outcome_ready'
      `).run(resultEntryId, updatedAt, invocationId);
      this.bumpSession(existing.sessionId, updatedAt);
      return this.getToolInvocationById(invocationId)!;
    });
  }

  async getToolInvocation(sessionId: string, toolCallId: string): Promise<ToolInvocationRecord | null> {
    const row = this.database.prepare(`
      SELECT * FROM tool_invocations WHERE session_id = ? AND tool_call_id = ?
    `).get(sessionId, toolCallId) as Row | undefined;
    return row ? rowToToolInvocation(row) : null;
  }

  async listOpenToolInvocations(sessionId: string): Promise<ToolInvocationRecord[]> {
    const rows = this.database.prepare(`
      SELECT * FROM tool_invocations
      WHERE session_id = ? AND phase != 'completed'
      ORDER BY ordinal ASC, created_at ASC, id ASC
    `).all(sessionId) as Row[];
    return rows.map(rowToToolInvocation);
  }

  async updateSession(sessionId: string, expectedRevision: number, patch: SessionPatch): Promise<Session> {
    const result = this.transaction(() => {
      const existingRow = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Row | undefined;
      if (!existingRow) throw new RepositoryError(`Session not found: ${sessionId}`, "not_found");
      const existing = rowToSession(existingRow);
      if (existing.revision !== expectedRevision) throw new RepositoryError(`Session revision conflict: ${sessionId}`, "conflict");
      const updatedAt = patch.updatedAt ?? now();
      this.database.prepare(`
        UPDATE sessions
        SET objective = ?, status = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(
        patch.objective === undefined ? existing.objective : patch.objective,
        patch.status ?? existing.status,
        updatedAt,
        sessionId,
        expectedRevision,
      );
      return rowToSession(this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as Row);
    });
    return result;
  }

  close(): void {
    this.database.close();
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  private validateHistoryLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RepositoryError("History limit must be a positive safe integer.", "invalid");
    }
  }

  private validateToolInvocationInput(input: CreateToolInvocationInput): void {
    if (!input.runId || !input.turnId || !input.cwd || !input.assistantEntryId || !input.toolCallId || !input.toolName || !input.toolVersion || !input.inputHash) {
      throw new RepositoryError("Tool invocation identity and tool metadata are required.", "invalid");
    }
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
      throw new RepositoryError("Tool invocation ordinal must be a non-negative safe integer.", "invalid");
    }
    try {
      JSON.parse(input.inputJson);
    } catch {
      throw new RepositoryError("Tool invocation inputJson must be valid JSON.", "invalid");
    }
  }

  private getToolInvocationById(invocationId: string): ToolInvocationRecord | null {
    const row = this.database.prepare("SELECT * FROM tool_invocations WHERE id = ?").get(invocationId) as Row | undefined;
    return row ? rowToToolInvocation(row) : null;
  }

  private bumpSession(sessionId: string, updatedAt: number): void {
    this.database.prepare("UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE id = ?").run(updatedAt, sessionId);
  }
}

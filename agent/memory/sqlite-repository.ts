import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema } from "./schema.js";
import {
  RepositoryError,
  type AcceptRunInputInput,
  type AppendEntryInput,
  type CreateProjectInput,
  type CreateToolInvocationInput,
  type EntryPatch,
  type EntryStatus,
  type EntryType,
  type HistoryEntry,
  type HistoryRepository,
  type HistoryScope,
  type PendingRunInput,
  type Project,
  type ProjectContextInput,
  type ProjectContextRecord,
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

function parsePayload(value: unknown): HistoryEntry["payload"] {
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
  return parsed as HistoryEntry["payload"];
}

function validatePayloadForType(type: EntryType, payload: HistoryEntry["payload"], toolCallId: string | null | undefined): void {
  const expectedRole = type === "user_message" ? "user" : type === "assistant_message" ? "assistant" : "tool";
  if (payload.role !== expectedRole) throw new RepositoryError(`${type} payload must use role ${expectedRole}.`, "invalid");
  if (type === "tool_result" && !toolCallId) throw new RepositoryError("tool_result requires toolCallId.", "invalid");
}

function rowToProject(row: Row): Project {
  return {
    id: String(row.id),
    canonicalPath: String(row.canonical_path),
    displayName: String(row.display_name),
    createdAt: Number(row.created_at),
    lastOpenedAt: Number(row.last_opened_at),
  };
}

function rowToProjectContext(row: Row): ProjectContextRecord {
  return {
    projectId: String(row.project_id),
    treeJson: String(row.tree_json),
    treeHash: String(row.tree_hash),
    capturedAt: Number(row.captured_at),
    scanPolicyVersion: String(row.scan_policy_version),
    complete: Number(row.complete) === 1,
    dirty: Number(row.dirty) === 1,
  };
}

function rowToEntry(row: Row): HistoryEntry {
  return {
    id: String(row.id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    entryOrder: Number(row.entry_order),
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
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
  };
}

function rowToPendingRunInput(row: Row): PendingRunInput {
  return {
    inputId: String(row.input_id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    runId: String(row.run_id),
    content: String(row.content),
    acceptOrder: Number(row.accept_order),
    state: String(row.state) as PendingRunInput["state"],
    acceptedAt: Number(row.accepted_at),
    appliedAt: row.applied_at === null || row.applied_at === undefined ? null : Number(row.applied_at),
    terminalReason: row.terminal_reason === null || row.terminal_reason === undefined ? null : String(row.terminal_reason),
  };
}

function rowToToolInvocation(row: Row): ToolInvocationRecord {
  return {
    id: String(row.id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
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

export class SqliteHistoryRepository implements HistoryRepository {
  readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    initializeSchema(this.database);
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? now();
    const lastOpenedAt = input.lastOpenedAt ?? createdAt;
    const project: Project = { id, canonicalPath: input.canonicalPath, displayName: input.displayName, createdAt, lastOpenedAt };
    try {
      this.database.prepare(`
        INSERT INTO projects (id, canonical_path, display_name, created_at, last_opened_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(project.id, project.canonicalPath, project.displayName, project.createdAt, project.lastOpenedAt);
    } catch (error) {
      throw new RepositoryError(`Failed to create project: ${error instanceof Error ? error.message : String(error)}`, "conflict");
    }
    return project;
  }

  async getProject(projectId: string): Promise<Project | null> {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Row | undefined;
    return row ? rowToProject(row) : null;
  }

  async getProjectByPath(canonicalPath: string): Promise<Project | null> {
    const row = this.database.prepare("SELECT * FROM projects WHERE canonical_path = ?").get(canonicalPath) as Row | undefined;
    return row ? rowToProject(row) : null;
  }

  async listProjects(): Promise<Project[]> {
    const rows = this.database.prepare("SELECT * FROM projects ORDER BY last_opened_at DESC, display_name ASC, id ASC").all() as Row[];
    return rows.map(rowToProject);
  }

  async touchProject(projectId: string, lastOpenedAt = now()): Promise<Project> {
    const result = this.database.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?").run(lastOpenedAt, projectId);
    if (Number(result.changes) !== 1) throw new RepositoryError(`Project not found: ${projectId}`, "not_found");
    return (await this.getProject(projectId))!;
  }

  async getProjectContext(projectId: string): Promise<ProjectContextRecord | null> {
    const row = this.database.prepare("SELECT * FROM project_context WHERE project_id = ?").get(projectId) as Row | undefined;
    return row ? rowToProjectContext(row) : null;
  }

  async saveProjectContext(projectId: string, input: ProjectContextInput): Promise<ProjectContextRecord> {
    if (!(await this.getProject(projectId))) throw new RepositoryError(`Project not found: ${projectId}`, "not_found");
    const capturedAt = input.capturedAt ?? now();
    this.database.prepare(`
      INSERT INTO project_context
        (project_id, tree_json, tree_hash, captured_at, scan_policy_version, complete, dirty)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        tree_json = excluded.tree_json,
        tree_hash = excluded.tree_hash,
        captured_at = excluded.captured_at,
        scan_policy_version = excluded.scan_policy_version,
        complete = excluded.complete,
        dirty = excluded.dirty
    `).run(projectId, input.treeJson, input.treeHash, capturedAt, input.scanPolicyVersion, input.complete ? 1 : 0, input.dirty ? 1 : 0);
    return (await this.getProjectContext(projectId))!;
  }

  async markProjectContextDirty(projectId: string): Promise<void> {
    this.database.prepare("UPDATE project_context SET dirty = 1 WHERE project_id = ?").run(projectId);
  }

  async appendEntry(projectId: HistoryScope, entry: AppendEntryInput): Promise<HistoryEntry> {
    validatePayloadForType(entry.type, entry.payload, entry.toolCallId);
    return this.transaction(() => {
      if (projectId !== null && !this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new RepositoryError(`Project not found: ${projectId}`, "not_found");
      }
      const existingRow = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entry.id) as Row | undefined;
      if (existingRow) {
        const existing = rowToEntry(existingRow);
        const same = existing.projectId === projectId
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
      const nextOrder = Number((this.database.prepare("SELECT COALESCE(MAX(entry_order), 0) + 1 AS next_order FROM entries").get() as { next_order: number }).next_order);
      this.database.prepare(`
        INSERT INTO entries
          (id, project_id, entry_order, type, status, run_id, turn_id, tool_call_id,
           revision, payload_version, payload_json, created_at, updated_at, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id, projectId, nextOrder, entry.type, entry.status, entry.runId,
        entry.turnId ?? null, entry.toolCallId ?? null, entry.revision ?? 0,
        entry.payloadVersion ?? 1, JSON.stringify(entry.payload), timestamp, updatedAt,
        entry.durationMs ?? null,
      );
      return rowToEntry(this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entry.id) as Row);
    });
  }

  async updateEntry(entryId: string, expectedRevision: number, patch: EntryPatch): Promise<HistoryEntry> {
    return this.transaction(() => {
      const existingRow = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId) as Row | undefined;
      if (!existingRow) throw new RepositoryError(`Entry not found: ${entryId}`, "not_found");
      const existing = rowToEntry(existingRow);
      if (existing.revision !== expectedRevision) throw new RepositoryError(`Entry revision conflict: ${entryId}`, "conflict");
      const updatedAt = patch.updatedAt ?? now();
      const nextStatus = patch.status ?? existing.status;
      const nextPayload = patch.payload ?? existing.payload;
      const nextPayloadVersion = patch.payloadVersion ?? existing.payloadVersion;
      const nextTurnId = patch.turnId === undefined ? existing.turnId : patch.turnId;
      const nextToolCallId = patch.toolCallId === undefined ? existing.toolCallId : patch.toolCallId;
      const nextDurationMs = patch.durationMs === undefined ? existing.durationMs : patch.durationMs;
      validatePayloadForType(existing.type, nextPayload, nextToolCallId);
      this.database.prepare(`
        UPDATE entries
        SET status = ?, turn_id = ?, tool_call_id = ?, revision = revision + 1,
            payload_version = ?, payload_json = ?, updated_at = ?, duration_ms = ?
        WHERE id = ? AND revision = ?
      `).run(nextStatus, nextTurnId, nextToolCallId, nextPayloadVersion, JSON.stringify(nextPayload), updatedAt, nextDurationMs, entryId, expectedRevision);
      return rowToEntry(this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId) as Row);
    });
  }

  async getEntry(entryId: string): Promise<HistoryEntry | null> {
    const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId) as Row | undefined;
    return row ? rowToEntry(row) : null;
  }

  async listEntries(projectId: HistoryScope, cursor = 0, limit = 100): Promise<HistoryEntry[]> {
    if (!Number.isInteger(cursor) || cursor < 0) throw new RepositoryError("Entry cursor must be a non-negative integer.", "invalid");
    this.validateHistoryLimit(limit);
    const rows = this.database.prepare(`
      SELECT * FROM entries
      WHERE project_id IS ? AND entry_order > ?
      ORDER BY entry_order ASC
      LIMIT ?
    `).all(projectId, cursor, limit) as Row[];
    return rows.map(rowToEntry);
  }

  async listLatestEntries(projectId: HistoryScope, limit: number): Promise<HistoryEntry[]> {
    this.validateHistoryLimit(limit);
    const rows = this.database.prepare(`
      SELECT * FROM entries
      WHERE project_id IS ?
      ORDER BY entry_order DESC
      LIMIT ?
    `).all(projectId, limit) as Row[];
    return rows.map(rowToEntry);
  }

  async listEntriesBefore(projectId: HistoryScope, beforeOrder: number, limit: number): Promise<HistoryEntry[]> {
    if (!Number.isSafeInteger(beforeOrder) || beforeOrder <= 0) throw new RepositoryError("History cursor must be a positive safe integer.", "invalid");
    this.validateHistoryLimit(limit);
    const rows = this.database.prepare(`
      SELECT * FROM entries
      WHERE project_id IS ? AND entry_order < ?
      ORDER BY entry_order DESC
      LIMIT ?
    `).all(projectId, beforeOrder, limit) as Row[];
    return rows.map(rowToEntry);
  }

  async acceptRunInput(projectId: HistoryScope, input: AcceptRunInputInput): Promise<PendingRunInput> {
    if (!input.inputId || !input.runId || typeof input.content !== "string" || !input.content.trim()) {
      throw new RepositoryError("Run input identity and non-empty content are required.", "invalid");
    }
    return this.transaction(() => {
      const existing = this.getPendingRunInputById(input.inputId);
      if (existing) {
        if (existing.projectId !== projectId || existing.runId !== input.runId || existing.content !== input.content) {
          throw new RepositoryError(`Run input already exists with different content or scope: ${input.inputId}`, "conflict");
        }
        return existing;
      }
      if (projectId !== null && !this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new RepositoryError(`Project not found: ${projectId}`, "not_found");
      }
      this.database.prepare(`
        INSERT INTO pending_run_inputs
          (input_id, project_id, run_id, content, state, accepted_at, applied_at, terminal_reason)
        VALUES (?, ?, ?, ?, 'accepted', ?, NULL, NULL)
      `).run(input.inputId, projectId, input.runId, input.content, now());
      return this.getPendingRunInputById(input.inputId)!;
    });
  }

  async listAcceptedRunInputs(projectId: HistoryScope, runId: string): Promise<PendingRunInput[]> {
    if (!runId) throw new RepositoryError("runId is required.", "invalid");
    const rows = this.database.prepare(`
      SELECT * FROM pending_run_inputs
      WHERE project_id IS ? AND run_id = ? AND state = 'accepted'
      ORDER BY accept_order ASC
    `).all(projectId, runId) as Row[];
    return rows.map(rowToPendingRunInput);
  }

  async applyRunInputs(projectId: HistoryScope, runId: string, inputIds: string[]): Promise<HistoryEntry[]> {
    if (!runId || !Array.isArray(inputIds) || inputIds.some((id) => typeof id !== "string" || !id)) {
      throw new RepositoryError("runId and inputIds are required.", "invalid");
    }
    if (new Set(inputIds).size !== inputIds.length) throw new RepositoryError("inputIds must be unique.", "invalid");
    if (inputIds.length === 0) return [];
    return this.transaction(() => {
      const selected = inputIds.map((id) => {
        const item = this.getPendingRunInputById(id);
        if (!item) throw new RepositoryError(`Run input not found: ${id}`, "not_found");
        if (item.projectId !== projectId || item.runId !== runId) {
          throw new RepositoryError(`Run input belongs to another scope or run: ${id}`, "conflict");
        }
        if (item.state === "unapplied") throw new RepositoryError(`Run input was abandoned: ${id}`, "conflict");
        return item;
      });
      if (selected.some((item, index) => index > 0 && item.acceptOrder <= selected[index - 1]!.acceptOrder)) {
        throw new RepositoryError(`Run inputs must be supplied in acceptance order: ${runId}`, "conflict");
      }

      const accepted = selected.filter((item) => item.state === "accepted");
      if (accepted.length > 0) {
        const nextRows = this.database.prepare(`
          SELECT input_id FROM pending_run_inputs
          WHERE project_id IS ? AND run_id = ? AND state = 'accepted'
          ORDER BY accept_order ASC LIMIT ?
        `).all(projectId, runId, accepted.length) as Row[];
        if (nextRows.length !== accepted.length || nextRows.some((row, index) => row.input_id !== accepted[index]!.inputId)) {
          throw new RepositoryError(`Run inputs must be applied in acceptance order: ${runId}`, "conflict");
        }
      }

      const timestamp = now();
      let nextOrder = this.nextEntryOrder();
      return selected.map((item) => {
        if (item.state === "applied") return this.getSettledRunInputEntry(item);
        const entry = this.settleRunInput(item, "applied", timestamp, null, nextOrder);
        nextOrder += 1;
        return entry;
      });
    });
  }

  async abandonRunInputs(projectId: HistoryScope, runId: string, reason: string): Promise<HistoryEntry[]> {
    if (!runId || !reason.trim()) throw new RepositoryError("runId and terminal reason are required.", "invalid");
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT * FROM pending_run_inputs
        WHERE project_id IS ? AND run_id = ? AND state = 'accepted'
        ORDER BY accept_order ASC
      `).all(projectId, runId) as Row[];
      return this.settleRunInputBatch(rows.map(rowToPendingRunInput), "unapplied", reason);
    });
  }

  async recoverAcceptedRunInputs(reason: string): Promise<HistoryEntry[]> {
    if (!reason.trim()) throw new RepositoryError("Terminal reason is required.", "invalid");
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT * FROM pending_run_inputs WHERE state = 'accepted' ORDER BY accept_order ASC
      `).all() as Row[];
      return this.settleRunInputBatch(rows.map(rowToPendingRunInput), "unapplied", reason);
    });
  }

  async finalizeAnswerDuration(projectId: HistoryScope, turnId: string, durationMs: number): Promise<void> {
    if (!turnId || !Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw new RepositoryError("turnId and a non-negative integer durationMs are required.", "invalid");
    }
    this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT * FROM entries
        WHERE project_id IS ? AND turn_id = ? AND type = 'assistant_message' AND status = 'completed'
      `).all(projectId, turnId) as Row[];
      if (rows.length === 0) throw new RepositoryError(`Completed assistant entry not found for turn: ${turnId}`, "not_found");
      if (rows.length !== 1) throw new RepositoryError(`Multiple completed assistant entries for turn: ${turnId}`, "conflict");
      const entry = rowToEntry(rows[0]!);
      if (entry.payload.toolCalls?.length) throw new RepositoryError(`Turn is a tool-call response, not a final answer: ${turnId}`, "conflict");
      if (entry.durationMs !== null) {
        if (entry.durationMs !== durationMs) throw new RepositoryError(`Answer duration already finalized for turn: ${turnId}`, "conflict");
        return;
      }
      this.database.prepare("UPDATE entries SET duration_ms = ?, revision = revision + 1 WHERE id = ? AND duration_ms IS NULL")
        .run(durationMs, entry.id);
    });
  }

  async registerToolInvocation(input: CreateToolInvocationInput): Promise<ToolInvocationRecord> {
    this.validateToolInvocationInput(input);
    const id = input.id ?? randomUUID();
    const resultEntryId = input.resultEntryId ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    const updatedAt = input.updatedAt ?? timestamp;
    const checkpointJson = input.checkpoint === undefined ? null : serializeJson(input.checkpoint, "checkpoint");
    return this.transaction(() => {
      if (input.projectId !== null && !this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) {
        throw new RepositoryError(`Project not found: ${input.projectId}`, "not_found");
      }
      try {
        this.database.prepare(`
          INSERT INTO tool_invocations
            (id, project_id, run_id, turn_id, cwd, assistant_entry_id, tool_call_id, ordinal,
             tool_name, tool_version, input_json, input_hash, phase, outcome_status,
             outcome_json, recovery_mode_snapshot, attempt_count, checkpoint_json,
             result_entry_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, NULL, ?, 0, ?, ?, ?, ?)
        `).run(
          id, input.projectId, input.runId, input.turnId, input.cwd, input.assistantEntryId,
          input.toolCallId, input.ordinal, input.toolName, input.toolVersion,
          input.inputJson, input.inputHash, input.recoveryModeSnapshot,
          checkpointJson, resultEntryId, timestamp, updatedAt,
        );
      } catch (error) {
        throw new RepositoryError(`Failed to register tool invocation: ${error instanceof Error ? error.message : String(error)}`, "conflict");
      }
      return this.getToolInvocationById(id)!;
    });
  }

  async beginToolAttempt(invocationId: string): Promise<ToolInvocationRecord> {
    return this.transaction(() => {
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (existing.phase === "effect_pending") {
        this.database.prepare("UPDATE tool_invocations SET attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND phase = 'effect_pending'").run(now(), invocationId);
        return this.getToolInvocationById(invocationId)!;
      }
      if (existing.phase !== "planned") throw new RepositoryError(`Tool invocation cannot begin from phase ${existing.phase}: ${invocationId}`, "conflict");
      this.database.prepare("UPDATE tool_invocations SET phase = 'effect_pending', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND phase = 'planned'").run(now(), invocationId);
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
        if (existing.outcomeStatus !== outcome.status || canonical(existing.outcomeJson) !== canonical(outcome.outcome)) throw new RepositoryError(`Tool outcome already exists with different content: ${invocationId}`, "conflict");
        return existing;
      }
      if (existing.phase !== "effect_pending") throw new RepositoryError(`Tool invocation cannot save outcome from phase ${existing.phase}: ${invocationId}`, "conflict");
      this.database.prepare(`
        UPDATE tool_invocations
        SET phase = 'outcome_ready', outcome_status = ?, outcome_json = ?,
            checkpoint_json = COALESCE(?, checkpoint_json), updated_at = ?
        WHERE id = ? AND phase = 'effect_pending'
      `).run(outcome.status, outcomeJson, checkpointJson, outcome.updatedAt ?? now(), invocationId);
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
      if (existing.phase !== "outcome_ready") throw new RepositoryError(`Tool invocation cannot complete from phase ${existing.phase}: ${invocationId}`, "conflict");
      this.database.prepare("UPDATE tool_invocations SET phase = 'completed', result_entry_id = ?, updated_at = ? WHERE id = ? AND phase = 'outcome_ready'").run(resultEntryId, now(), invocationId);
      return this.getToolInvocationById(invocationId)!;
    });
  }

  async getToolInvocation(projectId: HistoryScope, runId: string, toolCallId: string): Promise<ToolInvocationRecord | null> {
    const row = this.database.prepare("SELECT * FROM tool_invocations WHERE project_id IS ? AND run_id = ? AND tool_call_id = ?").get(projectId, runId, toolCallId) as Row | undefined;
    return row ? rowToToolInvocation(row) : null;
  }

  async listOpenToolInvocations(projectId: HistoryScope, runId?: string): Promise<ToolInvocationRecord[]> {
    const rows = runId
      ? this.database.prepare("SELECT * FROM tool_invocations WHERE project_id IS ? AND run_id = ? AND phase != 'completed' ORDER BY ordinal ASC, created_at ASC, id ASC").all(projectId, runId) as Row[]
      : this.database.prepare("SELECT * FROM tool_invocations WHERE project_id IS ? AND phase != 'completed' ORDER BY ordinal ASC, created_at ASC, id ASC").all(projectId) as Row[];
    return rows.map(rowToToolInvocation);
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
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RepositoryError("History limit must be a positive safe integer.", "invalid");
  }

  private getPendingRunInputById(inputId: string): PendingRunInput | null {
    const row = this.database.prepare("SELECT * FROM pending_run_inputs WHERE input_id = ?").get(inputId) as Row | undefined;
    return row ? rowToPendingRunInput(row) : null;
  }

  private getSettledRunInputEntry(item: PendingRunInput): HistoryEntry {
    const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(item.inputId) as Row | undefined;
    if (!row) throw new RepositoryError(`Settled run input has no history entry: ${item.inputId}`, "storage");
    const entry = rowToEntry(row);
    if (entry.projectId !== item.projectId || entry.runId !== item.runId || entry.type !== "user_message") {
      throw new RepositoryError(`Settled run input entry has a different scope: ${item.inputId}`, "storage");
    }
    return entry;
  }

  private nextEntryOrder(): number {
    return Number((this.database.prepare("SELECT COALESCE(MAX(entry_order), 0) + 1 AS next_order FROM entries").get() as { next_order: number }).next_order);
  }

  private settleRunInputBatch(items: PendingRunInput[], state: "unapplied", reason: string): HistoryEntry[] {
    const timestamp = now();
    let nextOrder = this.nextEntryOrder();
    return items.map((item) => {
      const entry = this.settleRunInput(item, state, timestamp, reason, nextOrder);
      nextOrder += 1;
      return entry;
    });
  }

  private settleRunInput(
    item: PendingRunInput,
    state: "applied" | "unapplied",
    timestamp: number,
    reason: string | null,
    entryOrder: number,
  ): HistoryEntry {
    const existing = this.database.prepare("SELECT 1 FROM entries WHERE id = ?").get(item.inputId);
    if (existing) throw new RepositoryError(`Run input entry ID already exists: ${item.inputId}`, "conflict");
    this.database.prepare(`
      INSERT INTO entries
        (id, project_id, entry_order, type, status, run_id, turn_id, tool_call_id,
         revision, payload_version, payload_json, created_at, updated_at, duration_ms)
      VALUES (?, ?, ?, 'user_message', ?, ?, NULL, NULL, 0, 1, ?, ?, ?, NULL)
    `).run(
      item.inputId, item.projectId, entryOrder, state === "applied" ? "completed" : "interrupted",
      item.runId, JSON.stringify({ role: "user", content: item.content }), item.acceptedAt, timestamp,
    );
    const changed = this.database.prepare(`
      UPDATE pending_run_inputs
      SET state = ?, applied_at = ?, terminal_reason = ?
      WHERE input_id = ? AND state = 'accepted'
    `).run(state, state === "applied" ? timestamp : null, reason, item.inputId);
    if (Number(changed.changes) !== 1) throw new RepositoryError(`Run input state changed during settlement: ${item.inputId}`, "conflict");
    return rowToEntry(this.database.prepare("SELECT * FROM entries WHERE id = ?").get(item.inputId) as Row);
  }

  private validateToolInvocationInput(input: CreateToolInvocationInput): void {
    if (!input.runId || !input.turnId || !input.cwd || !input.assistantEntryId || !input.toolCallId || !input.toolName || !input.toolVersion || !input.inputHash) {
      throw new RepositoryError("Tool invocation identity and tool metadata are required.", "invalid");
    }
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) throw new RepositoryError("Tool invocation ordinal must be a non-negative safe integer.", "invalid");
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
}

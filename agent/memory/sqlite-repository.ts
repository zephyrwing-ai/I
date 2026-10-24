import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema } from "./schema.js";
import { canonicalJson as canonical, jsonEqual } from "../json.js";
import { readModelMessage, type ModelUsage, type ToolCall } from "../model/types.js";
import { toolInputHash, toolInputHashFromJson } from "../tools/identity.js";
import { readToolCheckpoint, readToolResult, toolOutcomeStatus, toolResultMessage } from "../tools/result.js";
import {
  RepositoryError,
  ToolAttemptBlockedError,
  type AcceptRunInputInput,
  type AppendEntryInput,
  type AssistantCommitInput,
  type AssistantCommitResult,
  type ContextSnapshot,
  type ContextSourceVersion,
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
  type SaveContextSnapshotInput,
  type ToolInvocationPlan,
  type ToolInvocationPhase,
  type ToolInvocationRecord,
  type ToolOutcomeInput,
  type ToolOutcomeStatus,
  type ToolRecoveryMode,
} from "./types.js";

type Row = Record<string, unknown>;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sqliteRepositoryError(error: unknown, prefix = ""): RepositoryError {
  const errcode = error !== null && typeof error === "object" && "errcode" in error ? error.errcode : undefined;
  const primaryCode = typeof errcode === "number" ? errcode & 0xff : undefined;
  return new RepositoryError(`${prefix}${error instanceof Error ? error.message : String(error)}`, primaryCode === 19 ? "conflict" : "storage", {
    cause: error,
    // Only lock contention is known to be transient; IO, corruption and full disks are not retried.
    retryable: primaryCode === 5 || primaryCode === 6,
  });
}

function now(): number {
  return Date.now();
}

function serializeJson(value: unknown, field: string): string {
  try {
    return canonical(value);
  } catch (cause) {
    throw new RepositoryError(`${field} must be JSON serializable.`, "invalid", { cause });
  }
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
  const message = readModelMessage(parsed);
  if (!message) throw new RepositoryError("Stored entry payload is not a ModelMessage.", "storage");
  return message;
}

function validatePayloadForType(type: EntryType, payload: HistoryEntry["payload"], toolCallId: string | null | undefined): void {
  if (!readModelMessage(payload)) throw new RepositoryError("Entry payload must be a valid ModelMessage.", "invalid");
  const expectedRole = type === "user_message" ? "user" : type === "assistant_message" ? "assistant" : "tool";
  if (payload.role !== expectedRole) throw new RepositoryError(`${type} payload must use role ${expectedRole}.`, "invalid");
  if (type === "tool_result" && (!toolCallId || payload.toolCallId !== toolCallId)) throw new RepositoryError("tool_result requires a matching toolCallId.", "invalid");
}

function rowToProject(row: Row): Project {
  return {
    id: String(row.id),
    canonicalPath: String(row.canonical_path),
    displayName: String(row.display_name),
    createdAt: Number(row.created_at),
    lastOpenedAt: Number(row.last_opened_at),
    pinned: row.pinned === 1,
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

function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validContextUsage(value: unknown): value is ModelUsage {
  return isJsonObject(value)
    && ["inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"].every((field) => value[field] === undefined || validTokenCount(value[field]));
}

function rowToContextSnapshot(row: Row): ContextSnapshot {
  const usage = parseJson(row.usage_json, "context snapshot usage");
  if (Number(row.format_version) !== 1 || (usage !== null && !validContextUsage(usage))) {
    throw new RepositoryError("Stored context snapshot format or usage is invalid.", "storage");
  }
  return {
    id: String(row.id),
    projectId: row.project_id === null ? null : String(row.project_id),
    version: Number(row.version),
    formatVersion: 1,
    summary: String(row.summary),
    coveredThroughOrder: Number(row.covered_through_order),
    baselineThroughOrder: Number(row.baseline_through_order),
    sourceVersion: { entryCount: Number(row.source_entry_count), revisionHash: String(row.source_revision_hash) },
    policyVersion: String(row.policy_version),
    modelId: String(row.model_id),
    baselineTokens: Number(row.baseline_tokens),
    ...(usage ? { usage } : {}),
    createdAt: Number(row.created_at),
  };
}

function rowToEntry(row: Row): HistoryEntry {
  if (Number(row.payload_version) !== 1) throw new RepositoryError(`Unsupported stored payload version: ${row.payload_version}`, "storage");
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
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
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
    const project: Project = { id, canonicalPath: input.canonicalPath, displayName: input.displayName, createdAt, lastOpenedAt, pinned: input.pinned ?? false };
    try {
      this.database.prepare(`
        INSERT INTO projects (id, canonical_path, display_name, created_at, last_opened_at, pinned)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(project.id, project.canonicalPath, project.displayName, project.createdAt, project.lastOpenedAt, project.pinned ? 1 : 0);
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
    const rows = this.database.prepare("SELECT * FROM projects ORDER BY pinned DESC, created_at ASC, id ASC").all() as Row[];
    return rows.map(rowToProject);
  }

  async touchProject(projectId: string, lastOpenedAt = now()): Promise<Project> {
    const result = this.database.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?").run(lastOpenedAt, projectId);
    if (Number(result.changes) !== 1) throw new RepositoryError(`Project not found: ${projectId}`, "not_found");
    return (await this.getProject(projectId))!;
  }

  async updateProject(projectId: string, patch: Partial<Pick<Project, "displayName" | "pinned">>): Promise<Project> {
    if (patch.displayName !== undefined && (typeof patch.displayName !== "string" || !patch.displayName.trim() || patch.displayName.trim().length > 200)) {
      throw new RepositoryError("Project display name must contain 1 to 200 characters.", "invalid");
    }
    if (patch.pinned !== undefined && typeof patch.pinned !== "boolean") {
      throw new RepositoryError("Project pin state must be a boolean.", "invalid");
    }
    const result = this.database.prepare(`
      UPDATE projects SET display_name = COALESCE(?, display_name), pinned = COALESCE(?, pinned)
      WHERE id = ?
    `).run(patch.displayName?.trim() ?? null, patch.pinned === undefined ? null : patch.pinned ? 1 : 0, projectId);
    if (Number(result.changes) !== 1) throw new RepositoryError(`Project not found: ${projectId}`, "not_found");
    return (await this.getProject(projectId))!;
  }

  async deleteProject(projectId: string): Promise<void> {
    this.transaction(() => {
      if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new RepositoryError(`Project not found: ${projectId}`, "not_found");
      }
      // Remove scoped facts before their SET NULL foreign keys can expose them as ordinary history.
      for (const table of ["tool_invocations", "pending_run_inputs", "run_cancellations", "context_snapshots", "entries", "project_context"]) {
        this.database.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
      }
      this.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    });
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

  async getContextSourceVersion(projectId: HistoryScope, throughOrder: number): Promise<ContextSourceVersion> {
    if (!validTokenCount(throughOrder)) throw new RepositoryError("Context source order must be a non-negative safe integer.", "invalid");
    return this.contextSourceVersion(projectId, throughOrder);
  }

  async getLatestContextSnapshot(projectId: HistoryScope): Promise<ContextSnapshot | null> {
    return this.transaction(() => {
      const snapshot = this.latestContextSnapshot(projectId);
      return snapshot && this.contextSnapshotIsCurrent(snapshot) ? snapshot : null;
    }, "read");
  }

  async saveContextSnapshot(input: SaveContextSnapshotInput): Promise<ContextSnapshot> {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? now();
    if (typeof id !== "string" || !id || typeof input.summary !== "string" || !input.summary.trim()
      || typeof input.policyVersion !== "string" || !input.policyVersion.trim()
      || typeof input.modelId !== "string" || !input.modelId.trim()
      || (input.projectId !== null && (typeof input.projectId !== "string" || !input.projectId))
      || !validTokenCount(createdAt) || !validTokenCount(input.baselineTokens)
      || !validTokenCount(input.coveredThroughOrder) || input.coveredThroughOrder === 0
      || !validTokenCount(input.baselineThroughOrder) || input.baselineThroughOrder < input.coveredThroughOrder
      || (input.expectedVersion !== null && (!validTokenCount(input.expectedVersion) || input.expectedVersion === 0))
      || !input.sourceVersion || !validTokenCount(input.sourceVersion.entryCount) || input.sourceVersion.entryCount === 0
      || !/^[a-f0-9]{64}$/.test(input.sourceVersion.revisionHash)
      || (input.usage !== undefined && !validContextUsage(input.usage))) {
      throw new RepositoryError("Context snapshot metadata, source version and non-empty summary are required.", "invalid");
    }
    return this.transaction(() => {
      if (input.projectId !== null && !this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) {
        throw new RepositoryError(`Project not found: ${input.projectId}`, "not_found");
      }
      const duplicate = this.database.prepare("SELECT * FROM context_snapshots WHERE id = ?").get(id) as Row | undefined;
      if (duplicate) {
        const existing = rowToContextSnapshot(duplicate);
        const { expectedVersion: _expectedVersion, id: _id, createdAt: _createdAt, ...content } = input;
        if (!jsonEqual({ ...content, id, createdAt: input.createdAt ?? existing.createdAt, version: existing.version, formatVersion: 1 }, existing)) {
          throw new RepositoryError(`Context snapshot identity conflict: ${id}`, "conflict");
        }
        if (!this.contextSnapshotIsCurrent(existing)) throw new RepositoryError("Context snapshot sources have changed.", "conflict");
        return existing;
      }
      const previous = this.latestContextSnapshot(input.projectId);
      const currentVersion = previous && this.contextSnapshotIsCurrent(previous) ? previous.version : null;
      if (currentVersion !== input.expectedVersion) throw new RepositoryError("Context snapshot version conflict.", "conflict");
      const sourceVersion = this.contextSourceVersion(input.projectId, input.baselineThroughOrder);
      if (!jsonEqual(sourceVersion, input.sourceVersion)) throw new RepositoryError("Context snapshot sources have changed.", "conflict");
      const validatedThroughOrder = currentVersion !== null && previous && input.coveredThroughOrder >= previous.coveredThroughOrder
        ? previous.coveredThroughOrder : 0;
      this.validateContextBoundaries(input.projectId, input.coveredThroughOrder, input.baselineThroughOrder, validatedThroughOrder);
      const version = (previous?.version ?? 0) + 1;
      this.database.prepare(`
        INSERT INTO context_snapshots
          (id, project_id, version, format_version, summary, covered_through_order, baseline_through_order,
           source_entry_count, source_revision_hash, policy_version, model_id, baseline_tokens, usage_json, created_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.projectId, version, input.summary, input.coveredThroughOrder, input.baselineThroughOrder,
        sourceVersion.entryCount, sourceVersion.revisionHash, input.policyVersion, input.modelId, input.baselineTokens,
        input.usage === undefined ? null : serializeJson(input.usage, "context snapshot usage"), createdAt);
      return rowToContextSnapshot(this.database.prepare("SELECT * FROM context_snapshots WHERE id = ?").get(id) as Row);
    });
  }

  private latestContextSnapshot(projectId: HistoryScope): ContextSnapshot | null {
    const row = this.database.prepare("SELECT * FROM context_snapshots WHERE project_id IS ? ORDER BY version DESC LIMIT 1").get(projectId) as Row | undefined;
    return row ? rowToContextSnapshot(row) : null;
  }

  private contextSourceVersion(projectId: HistoryScope, throughOrder: number): ContextSourceVersion {
    const rows = this.database.prepare(`
      SELECT id, entry_order, revision, payload_version FROM entries
      WHERE project_id IS ? AND status = 'completed' AND entry_order <= ? ORDER BY entry_order ASC
    `).iterate(projectId, throughOrder);
    const hash = createHash("sha256");
    let entryCount = 0;
    for (const row of rows) {
      hash.update(JSON.stringify([row.id, row.entry_order, row.revision, row.payload_version]) + "\n");
      entryCount += 1;
    }
    return { entryCount, revisionHash: hash.digest("hex") };
  }

  private contextSnapshotIsCurrent(snapshot: ContextSnapshot): boolean {
    return jsonEqual(snapshot.sourceVersion, this.contextSourceVersion(snapshot.projectId, snapshot.baselineThroughOrder));
  }

  private validateContextBoundaries(projectId: HistoryScope, coveredOrder: number, baselineOrder: number, afterOrder: number): void {
    for (const order of new Set([coveredOrder, baselineOrder])) {
      if (!this.database.prepare("SELECT 1 FROM entries WHERE project_id IS ? AND entry_order = ? AND status = 'completed'").get(projectId, order)) {
        throw new RepositoryError("Context snapshot boundary must name a completed entry in its scope.", "conflict");
      }
    }
    const rows = this.database.prepare(`
      SELECT run_id, type, tool_call_id, entry_order, json_extract(payload_json, '$.toolCalls') AS tool_calls
      FROM entries WHERE project_id IS ? AND status = 'completed' AND entry_order > ? AND entry_order <= ?
        AND (type = 'tool_result' OR (type = 'assistant_message' AND json_array_length(payload_json, '$.toolCalls') > 0))
      ORDER BY entry_order ASC
    `).iterate(projectId, afterOrder, baselineOrder);
    const pending = new Set<string>();
    const seen = new Set<string>();
    let coveredChecked = false;
    for (const row of rows) {
      if (!coveredChecked && Number(row.entry_order) > coveredOrder) {
        if (pending.size > 0) throw new RepositoryError("Context snapshot boundary must preserve complete tool exchanges.", "conflict");
        coveredChecked = true;
      }
      const calls = parseJson(row.tool_calls, "context source tool calls");
      if (calls !== null) {
        if (row.type !== "assistant_message" || !Array.isArray(calls)) {
          throw new RepositoryError("Context source tool calls must belong to an assistant message.", "conflict");
        }
        for (const call of calls) {
          if (!isJsonObject(call) || typeof call.id !== "string" || !call.id) {
            throw new RepositoryError("Context source tool call identity is invalid.", "conflict");
          }
          const key = JSON.stringify([row.run_id, call.id]);
          if (seen.has(key)) throw new RepositoryError("Context source tool call identities must be unique within a run.", "conflict");
          seen.add(key);
          pending.add(key);
        }
      }
      if (row.type === "tool_result" && !pending.delete(JSON.stringify([row.run_id, row.tool_call_id]))) {
        throw new RepositoryError("Context source tool result requires its preceding assistant call.", "conflict");
      }
    }
    if (pending.size > 0) throw new RepositoryError("Context snapshot boundary must preserve complete tool exchanges.", "conflict");
  }

  async appendEntry(projectId: HistoryScope, entry: AppendEntryInput): Promise<HistoryEntry> {
    return this.transaction(() => this.appendEntryInTransaction(projectId, entry));
  }

  private appendEntryInTransaction(projectId: HistoryScope, entry: AppendEntryInput): HistoryEntry {
    validatePayloadForType(entry.type, entry.payload, entry.toolCallId);
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
    const completedAt = entry.type === "assistant_message" && entry.status === "completed"
      ? entry.completedAt ?? now()
      : null;
    const timestamp = entry.createdAt ?? completedAt ?? now();
    const nextOrder = Number((this.database.prepare("SELECT COALESCE(MAX(entry_order), 0) + 1 AS next_order FROM entries").get() as { next_order: number }).next_order);
    this.database.prepare(`
      INSERT INTO entries
        (id, project_id, entry_order, type, status, run_id, turn_id, tool_call_id,
         revision, payload_version, payload_json, created_at, completed_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, projectId, nextOrder, entry.type, entry.status, entry.runId,
      entry.turnId ?? null, entry.toolCallId ?? null, entry.revision ?? 0,
      entry.payloadVersion ?? 1, JSON.stringify(entry.payload), timestamp, completedAt,
      entry.durationMs ?? null,
    );
    return rowToEntry(this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entry.id) as Row);
  }

  async updateEntry(entryId: string, expectedRevision: number, patch: EntryPatch): Promise<HistoryEntry> {
    return this.transaction(() => this.updateEntryInTransaction(entryId, expectedRevision, patch));
  }

  private updateEntryInTransaction(entryId: string, expectedRevision: number, patch: EntryPatch): HistoryEntry {
    const existingRow = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId) as Row | undefined;
    if (!existingRow) throw new RepositoryError(`Entry not found: ${entryId}`, "not_found");
    const existing = rowToEntry(existingRow);
    if (existing.revision !== expectedRevision) throw new RepositoryError(`Entry revision conflict: ${entryId}`, "conflict");
    const nextStatus = patch.status ?? existing.status;
    const completedAt = existing.type === "assistant_message" && nextStatus === "completed"
      ? existing.completedAt ?? patch.completedAt ?? now()
      : null;
    const nextPayload = patch.payload ?? existing.payload;
    const nextPayloadVersion = patch.payloadVersion ?? existing.payloadVersion;
    const nextTurnId = patch.turnId === undefined ? existing.turnId : patch.turnId;
    const nextToolCallId = patch.toolCallId === undefined ? existing.toolCallId : patch.toolCallId;
    const nextDurationMs = patch.durationMs === undefined ? existing.durationMs : patch.durationMs;
    validatePayloadForType(existing.type, nextPayload, nextToolCallId);
    this.database.prepare(`
      UPDATE entries
      SET status = ?, turn_id = ?, tool_call_id = ?, revision = revision + 1,
          payload_version = ?, payload_json = ?, completed_at = ?, duration_ms = ?
      WHERE id = ? AND revision = ?
    `).run(nextStatus, nextTurnId, nextToolCallId, nextPayloadVersion, JSON.stringify(nextPayload), completedAt, nextDurationMs, entryId, expectedRevision);
    return rowToEntry(this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entryId) as Row);
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

  async listStreamingEntries(projectId: HistoryScope): Promise<HistoryEntry[]> {
    const rows = this.database.prepare("SELECT * FROM entries WHERE project_id IS ? AND status = 'streaming' ORDER BY entry_order ASC").all(projectId) as Row[];
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

  async getToolOutcomesForEntries(projectId: HistoryScope, entryIds: string[]): Promise<Map<string, unknown>> {
    const ids = [...new Set(entryIds)];
    if (ids.length === 0) return new Map();
    const rows = this.database.prepare(`
      SELECT e.id AS entry_id, t.outcome_json
      FROM entries e
      JOIN tool_invocations t ON t.result_entry_id = e.id
        AND t.project_id IS e.project_id
        AND t.run_id = e.run_id
        AND t.turn_id = e.turn_id
        AND t.tool_call_id = e.tool_call_id
      WHERE e.project_id IS ? AND e.type = 'tool_result'
        AND t.phase IN ('outcome_ready', 'completed')
        AND t.outcome_json IS NOT NULL
        AND e.id IN (${ids.map(() => "?").join(", ")})
    `).all(projectId, ...ids) as Row[];
    return new Map(rows.map((row) => [String(row.entry_id), parseJson(row.outcome_json, "tool outcome")]));
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
    return (await this.registerToolBatch([input]))[0]!;
  }

  async registerToolBatch(inputs: CreateToolInvocationInput[]): Promise<ToolInvocationRecord[]> {
    if (inputs.length === 0) throw new RepositoryError("A tool batch cannot be empty.", "invalid");
    this.validateToolBatchInputs(inputs);
    const first = inputs[0]!;
    return this.transaction(() => {
      if (first.projectId !== null && !this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(first.projectId)) {
        throw new RepositoryError(`Project not found: ${first.projectId}`, "not_found");
      }
      return inputs.map((input) => this.registerToolInvocationInTransaction(input));
    });
  }

  async commitAssistantAttempt(projectId: HistoryScope, assistant: AssistantCommitInput, plans: ToolInvocationPlan[]): Promise<AssistantCommitResult> {
    const entry = assistant.entry;
    validatePayloadForType(entry.type, entry.payload, entry.toolCallId);
    if (entry.type !== "assistant_message" || entry.status === "streaming" || !entry.turnId) {
      throw new RepositoryError("Assistant completion requires a terminal assistant entry and turn identity.", "invalid");
    }
    const inputs = plans.map((plan) => ({ ...plan, projectId, assistantEntryId: entry.id }));
    this.validateToolBatchInputs(inputs);
    const calls = entry.status === "completed" ? entry.payload.toolCalls ?? [] : [];
    if (calls.length !== plans.length || plans.some((plan, index) => {
      const call = calls[index]!;
      return plan.runId !== entry.runId || plan.turnId !== entry.turnId || plan.ordinal !== index
        || call.id !== plan.toolCallId || call.name !== plan.toolName || !call.inputComplete
        || !jsonEqual(call.input, JSON.parse(plan.inputJson));
    })) throw new RepositoryError("The assistant response must match its entire tool plan.", "invalid");
    return this.transaction(() => {
      const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(entry.id) as Row | undefined;
      const previous = row ? rowToEntry(row) : undefined;
      if (previous && (previous.projectId !== projectId || previous.type !== entry.type || previous.runId !== entry.runId || previous.turnId !== entry.turnId)) {
        throw new RepositoryError("The assistant entry belongs to a different scope or attempt.", "conflict");
      }
      let committed: HistoryEntry;
      if (previous && previous.status !== "streaming") {
        if (previous.status !== entry.status || !jsonEqual(previous.payload, entry.payload)) {
          throw new RepositoryError(`Assistant entry already exists with different content: ${entry.id}`, "conflict");
        }
        committed = previous;
      } else if (assistant.expectedRevision === null) {
        committed = this.appendEntryInTransaction(projectId, entry);
      } else {
        if (!previous) throw new RepositoryError(`Assistant draft not found: ${entry.id}`, "not_found");
        committed = this.updateEntryInTransaction(entry.id, assistant.expectedRevision, {
          status: entry.status, payload: entry.payload, completedAt: entry.completedAt,
        });
      }
      const invocations = inputs.map((input) => this.registerToolInvocationInTransaction(input));
      return { assistant: committed, invocations };
    });
  }

  private validateToolBatchInputs(inputs: CreateToolInvocationInput[]): void {
    const first = inputs[0];
    if (!first) return;
    const callIds = new Set<string>();
    for (const [index, input] of inputs.entries()) {
      this.validateToolInvocationInput(input);
      if (input.projectId !== first.projectId || input.runId !== first.runId || input.turnId !== first.turnId || input.assistantEntryId !== first.assistantEntryId
        || callIds.has(input.toolCallId) || (inputs.length > 1 && input.ordinal !== index)) {
        throw new RepositoryError("Tool batch scope, call identities and ordinal order must be consistent.", "invalid");
      }
      callIds.add(input.toolCallId);
    }
  }

  private registerToolInvocationInTransaction(input: CreateToolInvocationInput): ToolInvocationRecord {
    const id = input.id ?? randomUUID();
    const resultEntryId = input.resultEntryId ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    const checkpointJson = input.checkpoint === undefined ? null : serializeJson(input.checkpoint, "checkpoint");
    const previous = this.database.prepare("SELECT * FROM tool_invocations WHERE run_id = ? AND tool_call_id = ?").get(input.runId, input.toolCallId) as Row | undefined;
    if (previous) {
      const existing = rowToToolInvocation(previous);
      if (existing.projectId !== input.projectId || existing.turnId !== input.turnId || existing.assistantEntryId !== input.assistantEntryId
        || existing.cwd !== input.cwd || existing.toolName !== input.toolName || existing.toolVersion !== input.toolVersion
        || existing.ordinal !== input.ordinal || existing.inputHash !== input.inputHash || canonical(JSON.parse(existing.inputJson)) !== canonical(JSON.parse(input.inputJson))
        || existing.recoveryModeSnapshot !== input.recoveryModeSnapshot
        || (input.resultEntryId !== undefined && input.resultEntryId !== existing.resultEntryId)) {
        throw new RepositoryError(`Tool call identity conflict: ${input.toolCallId}`, "conflict");
      }
      return existing;
    }
    try {
      this.database.prepare(`
        INSERT INTO tool_invocations
          (id, project_id, run_id, turn_id, cwd, assistant_entry_id, tool_call_id, ordinal,
           tool_name, tool_version, input_json, input_hash, phase, outcome_status,
           outcome_json, recovery_mode_snapshot, attempt_count, checkpoint_json,
           result_entry_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, NULL, ?, 0, ?, ?, ?)
      `).run(
        id, input.projectId, input.runId, input.turnId, input.cwd, input.assistantEntryId,
        input.toolCallId, input.ordinal, input.toolName, input.toolVersion,
        input.inputJson, input.inputHash, input.recoveryModeSnapshot,
        checkpointJson, resultEntryId, timestamp,
      );
    } catch (error) {
      throw sqliteRepositoryError(error, "Failed to register tool invocation: ");
    }
    return this.getToolInvocationById(id)!;
  }

  async requestRunCancellation(projectId: HistoryScope, runId: string): Promise<void> {
    if (!runId) throw new RepositoryError("runId is required for cancellation.", "invalid");
    this.transaction(() => {
      const existing = this.database.prepare("SELECT project_id FROM run_cancellations WHERE run_id = ?").get(runId) as Row | undefined;
      if (existing && existing.project_id !== projectId) throw new RepositoryError(`Run cancellation scope conflict: ${runId}`, "conflict");
      this.database.prepare("INSERT INTO run_cancellations (run_id, project_id, cancelled_at) VALUES (?, ?, ?) ON CONFLICT(run_id) DO NOTHING").run(runId, projectId, now());
    });
  }

  async isRunCancelled(projectId: HistoryScope, runId: string): Promise<boolean> {
    return Boolean(this.database.prepare("SELECT 1 FROM run_cancellations WHERE run_id = ? AND project_id IS ?").get(runId, projectId));
  }

  async isToolInvocationBlocked(invocationId: string): Promise<boolean> {
    const invocation = this.getToolInvocationById(invocationId);
    if (!invocation) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
    return this.hasPriorInterruptedInvocation(invocation);
  }

  async getToolInvocationCall(invocationId: string): Promise<ToolCall> {
    return this.transaction(() => {
      const invocation = this.getToolInvocationById(invocationId);
      if (!invocation) throw new RepositoryError(`Stored tool invocation not found: ${invocationId}`, "storage");
      const input = parseJson(invocation.inputJson, "tool input");
      if (!isJsonObject(input)) throw new RepositoryError(`Stored tool input must be an object: ${invocationId}`, "storage");
      const hash = toolInputHash(invocation.toolName, invocation.toolVersion, input);
      const legacyHash = toolInputHashFromJson(invocation.toolName, invocation.toolVersion, invocation.inputJson);
      if (invocation.inputHash !== hash && invocation.inputHash !== legacyHash) {
        throw new RepositoryError(`Stored tool input hash does not match: ${invocationId}`, "storage");
      }
      const row = this.database.prepare("SELECT * FROM entries WHERE id = ?").get(invocation.assistantEntryId) as Row | undefined;
      if (!row) throw new RepositoryError(`Stored tool invocation has no source Assistant: ${invocationId}`, "storage");
      const assistant = rowToEntry(row);
      const call = assistant.payload.toolCalls?.[invocation.ordinal];
      if (assistant.type !== "assistant_message" || assistant.status !== "completed" || assistant.payload.role !== "assistant"
        || assistant.projectId !== invocation.projectId || assistant.runId !== invocation.runId || assistant.turnId !== invocation.turnId
        || !call || call.id !== invocation.toolCallId || call.name !== invocation.toolName || !call.inputComplete || !jsonEqual(call.input, input)) {
        throw new RepositoryError(`Stored tool invocation differs from its source Assistant: ${invocationId}`, "storage");
      }
      return call;
    });
  }

  private hasPriorInterruptedInvocation(invocation: ToolInvocationRecord): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM tool_invocations
      WHERE project_id IS ? AND run_id = ? AND assistant_entry_id = ? AND ordinal < ? AND outcome_status = 'interrupted'
      LIMIT 1
    `).get(invocation.projectId, invocation.runId, invocation.assistantEntryId, invocation.ordinal));
  }

  async beginToolAttempt(invocationId: string, checkpoint?: unknown): Promise<ToolInvocationRecord> {
    if (checkpoint !== undefined && !readToolCheckpoint(checkpoint)) throw new RepositoryError("Tool checkpoint must contain a version, kind and data object.", "invalid");
    const checkpointJson = checkpoint === undefined ? null : serializeJson(checkpoint, "checkpoint");
    return this.transaction(() => {
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (this.database.prepare("SELECT 1 FROM run_cancellations WHERE run_id = ? AND project_id IS ?").get(existing.runId, existing.projectId)) {
        throw new ToolAttemptBlockedError("cancelled", `Cancelled run cannot start a tool attempt: ${existing.runId}`);
      }
      if (existing.phase !== "planned" && existing.phase !== "effect_pending") throw new RepositoryError(`Tool invocation cannot begin from phase ${existing.phase}: ${invocationId}`, "conflict");
      if (existing.phase === "planned" && this.hasPriorInterruptedInvocation(existing)) {
        throw new ToolAttemptBlockedError("prior_interrupted", `A prior tool invocation was interrupted: ${invocationId}`);
      }
      this.database.prepare("UPDATE tool_invocations SET phase = 'effect_pending', attempt_count = attempt_count + 1, checkpoint_json = ? WHERE id = ? AND phase = ?")
        .run(checkpointJson, invocationId, existing.phase);
      return this.getToolInvocationById(invocationId)!;
    });
  }

  async saveToolOutcome(invocationId: string, outcome: ToolOutcomeInput): Promise<ToolInvocationRecord> {
    return this.persistToolOutcome(invocationId, outcome, "effect_pending");
  }

  async settleUnstartedToolInvocation(invocationId: string, outcome: ToolOutcomeInput): Promise<ToolInvocationRecord> {
    if (outcome.status === "succeeded") {
      throw new RepositoryError("An unstarted invocation can only be failed, cancelled or interrupted.", "invalid");
    }
    return this.persistToolOutcome(invocationId, outcome, "planned");
  }

  private persistToolOutcome(invocationId: string, outcome: ToolOutcomeInput, expectedPhase: "planned" | "effect_pending"): ToolInvocationRecord {
    const result = readToolResult(outcome.outcome);
    if (!result || toolOutcomeStatus(result) !== outcome.status) throw new RepositoryError("Tool outcome must contain a valid result with matching status.", "invalid");
    if (outcome.checkpoint !== undefined && !readToolCheckpoint(outcome.checkpoint)) throw new RepositoryError("Tool checkpoint must contain a version, kind and data object.", "invalid");
    const outcomeJson = serializeJson(outcome.outcome, "tool outcome");
    const checkpointJson = outcome.checkpoint === undefined ? null : serializeJson(outcome.checkpoint, "checkpoint");
    return this.transaction(() => {
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (existing.phase === "outcome_ready" || existing.phase === "completed") {
        if (existing.outcomeStatus !== outcome.status || canonical(existing.outcomeJson) !== canonical(outcome.outcome)) throw new RepositoryError(`Tool outcome already exists with different content: ${invocationId}`, "conflict");
        return existing;
      }
      if (existing.phase !== expectedPhase) throw new RepositoryError(`Tool invocation cannot save outcome from phase ${existing.phase}: ${invocationId}`, "conflict");
      this.database.prepare(`
        UPDATE tool_invocations
        SET phase = 'outcome_ready', outcome_status = ?, outcome_json = ?,
            checkpoint_json = COALESCE(?, checkpoint_json)
        WHERE id = ? AND phase = ?
      `).run(outcome.status, outcomeJson, checkpointJson, invocationId, expectedPhase);
      return this.getToolInvocationById(invocationId)!;
    });
  }

  async commitToolResult(projectId: HistoryScope, entry: AppendEntryInput, invocationId?: string): Promise<HistoryEntry> {
    validatePayloadForType(entry.type, entry.payload, entry.toolCallId);
    if (entry.type !== "tool_result" || entry.status !== "completed") throw new RepositoryError("Tool result materialization requires a completed tool message.", "invalid");
    return this.transaction(() => {
      if (!invocationId) return this.appendEntryInTransaction(projectId, entry);
      const existing = this.getToolInvocationById(invocationId);
      if (!existing) throw new RepositoryError(`Tool invocation not found: ${invocationId}`, "not_found");
      if (existing.projectId !== projectId || existing.runId !== entry.runId || existing.turnId !== entry.turnId
        || existing.toolCallId !== entry.toolCallId || (existing.resultEntryId !== null && existing.resultEntryId !== entry.id)) {
        throw new RepositoryError(`Tool result identity conflict: ${invocationId}`, "conflict");
      }
      if (existing.phase !== "outcome_ready" && existing.phase !== "completed") throw new RepositoryError(`Tool invocation cannot materialize from phase ${existing.phase}: ${invocationId}`, "conflict");
      if (existing.phase === "completed" && !this.database.prepare("SELECT 1 FROM entries WHERE id = ?").get(entry.id)) {
        throw new RepositoryError(`Completed invocation has no persisted result message: ${invocationId}`, "storage");
      }
      const result = readToolResult(existing.outcomeJson);
      if (!result || toolOutcomeStatus(result) !== existing.outcomeStatus) throw new RepositoryError(`Stored tool outcome is invalid: ${invocationId}`, "storage");
      const expectedMessage = toolResultMessage({ id: existing.toolCallId, name: existing.toolName }, result);
      if (!jsonEqual(expectedMessage, entry.payload)) throw new RepositoryError(`Tool message differs from its persisted outcome: ${invocationId}`, "conflict");
      const committed = this.appendEntryInTransaction(projectId, entry);
      if (existing.phase !== "completed") {
        this.database.prepare("UPDATE tool_invocations SET phase = 'completed', result_entry_id = ? WHERE id = ? AND phase = 'outcome_ready'").run(committed.id, invocationId);
      }
      return committed;
    });
  }

  async getToolInvocation(projectId: HistoryScope, runId: string, toolCallId: string): Promise<ToolInvocationRecord | null> {
    const row = this.database.prepare("SELECT * FROM tool_invocations WHERE project_id IS ? AND run_id = ? AND tool_call_id = ?").get(projectId, runId, toolCallId) as Row | undefined;
    return row ? rowToToolInvocation(row) : null;
  }

  async listOpenToolInvocations(projectId: HistoryScope, runId?: string): Promise<ToolInvocationRecord[]> {
    const rows = runId
      ? this.database.prepare("SELECT t.* FROM tool_invocations t LEFT JOIN entries e ON e.id = t.assistant_entry_id WHERE t.project_id IS ? AND t.run_id = ? AND t.phase != 'completed' ORDER BY COALESCE(e.entry_order, t.created_at), t.ordinal ASC, t.id ASC").all(projectId, runId) as Row[]
      : this.database.prepare("SELECT t.* FROM tool_invocations t LEFT JOIN entries e ON e.id = t.assistant_entry_id WHERE t.project_id IS ? AND t.phase != 'completed' ORDER BY COALESCE(e.entry_order, t.created_at), t.ordinal ASC, t.id ASC").all(projectId) as Row[];
    return rows.map(rowToToolInvocation);
  }

  close(): void {
    this.database.close();
  }

  private transaction<T>(operation: () => T, mode: "read" | "write" = "write"): T {
    let began = false;
    try {
      this.database.exec(mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
      began = true;
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      let safeToRetry = !began;
      if (began) {
        try {
          this.database.exec("ROLLBACK");
          safeToRetry = true;
        } catch {
          // An uncertain transaction must not be automatically replayed.
        }
      }
      const failure = error instanceof RepositoryError ? error : sqliteRepositoryError(error);
      if (failure.retryable && !safeToRetry) throw new RepositoryError(failure.message, failure.code, { cause: failure });
      throw failure;
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
         revision, payload_version, payload_json, created_at, completed_at, duration_ms)
      VALUES (?, ?, ?, 'user_message', ?, ?, NULL, NULL, 0, 1, ?, ?, NULL, NULL)
    `).run(
      item.inputId, item.projectId, entryOrder, state === "applied" ? "completed" : "interrupted",
      item.runId, JSON.stringify({ role: "user", content: item.content }), item.acceptedAt,
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

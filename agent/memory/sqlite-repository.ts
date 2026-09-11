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
  type SessionStatus,
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
}

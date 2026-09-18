import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 3;

export function initializeSchema(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA busy_timeout = 5000");

  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      objective TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'waiting', 'closed')),
      next_entry_seq INTEGER NOT NULL DEFAULT 1,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      session_seq INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('user_message', 'assistant_message', 'tool_result')),
      status TEXT NOT NULL CHECK (status IN ('streaming', 'completed', 'interrupted', 'failed')),
      run_id TEXT NOT NULL,
      turn_id TEXT,
      tool_call_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      payload_version INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (session_id, session_seq)
    );

    CREATE INDEX IF NOT EXISTS entries_session_order_idx
      ON entries (session_id, session_seq ASC);
    CREATE INDEX IF NOT EXISTS entries_tool_call_idx
      ON entries (session_id, tool_call_id);

    CREATE TABLE IF NOT EXISTS tool_invocations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      assistant_entry_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      tool_name TEXT NOT NULL,
      tool_version TEXT NOT NULL,
      input_json TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('planned', 'effect_pending', 'outcome_ready', 'completed')),
      outcome_status TEXT CHECK (outcome_status IS NULL OR outcome_status IN ('succeeded', 'failed', 'cancelled', 'interrupted')),
      outcome_json TEXT,
      recovery_mode_snapshot TEXT NOT NULL CHECK (recovery_mode_snapshot IN ('safe', 'reconcile', 'never')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      checkpoint_json TEXT,
      result_entry_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (session_id, tool_call_id)
    );

    CREATE INDEX IF NOT EXISTS tool_invocations_session_phase_idx
      ON tool_invocations (session_id, phase, ordinal ASC);
  `);

  const current = database.prepare("PRAGMA user_version").get() as { user_version?: number };
  if (Number(current.user_version) === 0 || Number(current.user_version) === 1) {
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }
  if (Number(current.user_version) === 2) {
    database.exec("ALTER TABLE tool_invocations ADD COLUMN cwd TEXT NOT NULL DEFAULT ''");
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return;
  }
  if (Number(current.user_version) !== SCHEMA_VERSION) {
    throw new Error(`Unsupported session storage schema version: ${current.user_version}`);
  }
}

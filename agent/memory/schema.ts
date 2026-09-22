import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 6;

function hasTable(database: DatabaseSync, name: string): boolean {
  const row = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { present?: number } | undefined;
  return row?.present === 1;
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === column);
}

function createProjectSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_context (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      tree_json TEXT NOT NULL,
      tree_hash TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      scan_policy_version TEXT NOT NULL,
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      entry_order INTEGER NOT NULL UNIQUE,
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
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS entries_project_order_idx
      ON entries (project_id, entry_order ASC);
    CREATE INDEX IF NOT EXISTS entries_tool_call_idx
      ON entries (project_id, tool_call_id);

    CREATE TABLE IF NOT EXISTS tool_invocations (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
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
      UNIQUE (run_id, tool_call_id)
    );

    CREATE INDEX IF NOT EXISTS tool_invocations_project_phase_idx
      ON tool_invocations (project_id, phase, ordinal ASC);
  `);
}

function migrateLegacySessionSchema(database: DatabaseSync): void {
  const legacyCompletedAt = hasColumn(database, "entries", "completed_at") ? "completed_at" : "NULL";
  const legacyCwd = hasColumn(database, "tool_invocations", "cwd") ? "cwd" : "''";
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
      );

      CREATE TABLE project_context (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        tree_json TEXT NOT NULL,
        tree_hash TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        scan_policy_version TEXT NOT NULL,
        complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
        dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1))
      );

      CREATE TABLE entries_project_new (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        entry_order INTEGER NOT NULL UNIQUE,
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
        completed_at INTEGER
      );

      INSERT INTO entries_project_new
        (id, project_id, entry_order, type, status, run_id, turn_id, tool_call_id,
         revision, payload_version, payload_json, created_at, updated_at, completed_at)
      SELECT id, NULL,
        ROW_NUMBER() OVER (ORDER BY created_at ASC, session_id ASC, session_seq ASC, id ASC),
        type, status, run_id, turn_id, tool_call_id, revision, payload_version,
        payload_json, created_at, updated_at, ${legacyCompletedAt}
      FROM entries;

      DROP TABLE entries;
      ALTER TABLE entries_project_new RENAME TO entries;

      CREATE TABLE tool_invocations_project_new (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
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
        UNIQUE (run_id, tool_call_id)
      );

      INSERT INTO tool_invocations_project_new
        (id, project_id, run_id, turn_id, cwd, assistant_entry_id, tool_call_id, ordinal,
         tool_name, tool_version, input_json, input_hash, phase, outcome_status, outcome_json,
         recovery_mode_snapshot, attempt_count, checkpoint_json, result_entry_id, created_at, updated_at)
      SELECT id, NULL, run_id, turn_id, ${legacyCwd}, assistant_entry_id, tool_call_id, ordinal,
        tool_name, tool_version, input_json, input_hash, phase, outcome_status, outcome_json,
        recovery_mode_snapshot, attempt_count, checkpoint_json, result_entry_id, created_at, updated_at
      FROM tool_invocations;

      DROP TABLE tool_invocations;
      ALTER TABLE tool_invocations_project_new RENAME TO tool_invocations;
      DROP TABLE sessions;

      CREATE INDEX entries_project_order_idx ON entries (project_id, entry_order ASC);
      CREATE INDEX entries_tool_call_idx ON entries (project_id, tool_call_id);
      CREATE INDEX tool_invocations_project_phase_idx
        ON tool_invocations (project_id, phase, ordinal ASC);
    `);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } finally {
      database.exec("PRAGMA foreign_keys = ON");
    }
    throw error;
  }
  database.exec("PRAGMA foreign_keys = ON");
}

export function initializeSchema(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA busy_timeout = 5000");

  const current = database.prepare("PRAGMA user_version").get() as { user_version?: number };
  const version = Number(current.user_version);
  if (version > SCHEMA_VERSION) throw new Error(`Unsupported future history storage schema version: ${version}`);

  if (hasTable(database, "sessions")) {
    if (version < SCHEMA_VERSION) migrateLegacySessionSchema(database);
    return;
  }

  createProjectSchema(database);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

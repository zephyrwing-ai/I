import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 13;

function createContextSnapshotSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS context_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK (version > 0),
      format_version INTEGER NOT NULL CHECK (format_version = 1),
      summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
      covered_through_order INTEGER NOT NULL CHECK (covered_through_order > 0),
      baseline_through_order INTEGER NOT NULL CHECK (baseline_through_order >= covered_through_order),
      source_entry_count INTEGER NOT NULL CHECK (source_entry_count > 0),
      source_revision_hash TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      model_id TEXT NOT NULL,
      baseline_tokens INTEGER NOT NULL CHECK (baseline_tokens >= 0),
      usage_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS context_snapshots_scope_version_idx
      ON context_snapshots (project_id, version DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS context_snapshots_general_version_idx
      ON context_snapshots (version) WHERE project_id IS NULL;
  `);
}

function hasTable(database: DatabaseSync, name: string): boolean {
  const row = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { present?: number } | undefined;
  return row?.present === 1;
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === column);
}

function migrateProjectNavigation(database: DatabaseSync): void {
  if (!hasColumn(database, "projects", "pinned")) {
    database.exec("ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))");
  }
}

function migrateToolInvocationTimes(database: DatabaseSync): void {
  if (hasColumn(database, "tool_invocations", "updated_at")) {
    database.exec("ALTER TABLE tool_invocations DROP COLUMN updated_at");
  }
}

function migrateMessageTimes(database: DatabaseSync, preserveLegacyDuration: boolean): void {
  if (!hasColumn(database, "entries", "duration_ms")) {
    database.exec("ALTER TABLE entries ADD COLUMN duration_ms INTEGER");
  }
  if (preserveLegacyDuration && hasColumn(database, "entries", "completed_at")) database.exec(`
    UPDATE entries AS assistant
    SET duration_ms = MAX(0, assistant.completed_at - (
      SELECT user_entry.created_at
      FROM entries AS user_entry
      WHERE user_entry.project_id IS assistant.project_id
        AND user_entry.run_id = assistant.run_id
        AND user_entry.type = 'user_message'
      ORDER BY user_entry.entry_order ASC
      LIMIT 1
    ))
    WHERE assistant.type = 'assistant_message'
      AND assistant.status = 'completed'
      AND assistant.completed_at IS NOT NULL
      AND assistant.duration_ms IS NULL
      AND EXISTS (
        SELECT 1
        FROM entries AS user_entry
        WHERE user_entry.project_id IS assistant.project_id
          AND user_entry.run_id = assistant.run_id
          AND user_entry.type = 'user_message'
      )
  `);
  if (!hasColumn(database, "entries", "completed_at")) {
    database.exec("ALTER TABLE entries ADD COLUMN completed_at INTEGER");
  }
  if (hasColumn(database, "entries", "updated_at")) {
    database.exec(`
      UPDATE entries SET completed_at = COALESCE(completed_at, updated_at)
      WHERE type = 'assistant_message' AND status = 'completed';
      ALTER TABLE entries DROP COLUMN updated_at;
    `);
  }
  database.exec("UPDATE entries SET completed_at = NULL WHERE type != 'assistant_message' OR status != 'completed'");
}

function createProjectSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
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
      completed_at INTEGER,
      duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS entries_project_order_idx
      ON entries (project_id, entry_order ASC);
    CREATE INDEX IF NOT EXISTS entries_tool_call_idx
      ON entries (project_id, tool_call_id);
    CREATE INDEX IF NOT EXISTS entries_streaming_scope_idx
      ON entries (project_id, entry_order) WHERE status = 'streaming';

    CREATE TABLE IF NOT EXISTS pending_run_inputs (
      accept_order INTEGER PRIMARY KEY AUTOINCREMENT,
      input_id TEXT NOT NULL UNIQUE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      run_id TEXT NOT NULL,
      content TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('accepted', 'applied', 'unapplied')),
      accepted_at INTEGER NOT NULL,
      applied_at INTEGER,
      terminal_reason TEXT,
      CHECK (
        (state = 'accepted' AND applied_at IS NULL AND terminal_reason IS NULL)
        OR (state = 'applied' AND applied_at IS NOT NULL AND terminal_reason IS NULL)
        OR (state = 'unapplied' AND applied_at IS NULL AND terminal_reason IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS pending_run_inputs_scope_idx
      ON pending_run_inputs (project_id, run_id, state, accept_order);
    CREATE INDEX IF NOT EXISTS pending_run_inputs_recovery_idx
      ON pending_run_inputs (state, accept_order);

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
      UNIQUE (run_id, tool_call_id)
    );

    CREATE INDEX IF NOT EXISTS tool_invocations_project_phase_idx
      ON tool_invocations (project_id, phase, ordinal ASC);

    CREATE TABLE IF NOT EXISTS run_cancellations (
      run_id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      cancelled_at INTEGER NOT NULL
    );
  `);
}

function migrateLegacySessionSchema(database: DatabaseSync): void {
  const legacyCompletedAt = hasColumn(database, "entries", "completed_at") ? "completed_at" : "NULL";
  const legacyDurationMs = hasColumn(database, "entries", "duration_ms") ? "duration_ms" : "NULL";
  const legacyCwd = hasColumn(database, "tool_invocations", "cwd") ? "cwd" : "''";
  const legacyToolInvocations = hasTable(database, "tool_invocations");
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
        completed_at INTEGER,
        duration_ms INTEGER
      );

      INSERT INTO entries_project_new
        (id, project_id, entry_order, type, status, run_id, turn_id, tool_call_id,
         revision, payload_version, payload_json, created_at, updated_at, completed_at, duration_ms)
      SELECT id, NULL,
        ROW_NUMBER() OVER (ORDER BY created_at ASC, session_id ASC, session_seq ASC, id ASC),
        type, status, run_id, turn_id, tool_call_id, revision, payload_version,
        payload_json, created_at, updated_at, ${legacyCompletedAt}, ${legacyDurationMs}
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
        UNIQUE (run_id, tool_call_id)
      );

      ${legacyToolInvocations ? `INSERT INTO tool_invocations_project_new
        (id, project_id, run_id, turn_id, cwd, assistant_entry_id, tool_call_id, ordinal,
         tool_name, tool_version, input_json, input_hash, phase, outcome_status, outcome_json,
         recovery_mode_snapshot, attempt_count, checkpoint_json, result_entry_id, created_at)
      SELECT id, NULL, run_id, turn_id, ${legacyCwd}, assistant_entry_id, tool_call_id, ordinal,
        tool_name, tool_version, input_json, input_hash, phase, outcome_status, outcome_json,
        recovery_mode_snapshot, attempt_count, checkpoint_json, result_entry_id, created_at
      FROM tool_invocations;

      DROP TABLE tool_invocations;` : ""}
      ALTER TABLE tool_invocations_project_new RENAME TO tool_invocations;
      DROP TABLE sessions;

      CREATE INDEX entries_project_order_idx ON entries (project_id, entry_order ASC);
      CREATE INDEX entries_tool_call_idx ON entries (project_id, tool_call_id);
      CREATE INDEX tool_invocations_project_phase_idx
        ON tool_invocations (project_id, phase, ordinal ASC);

      CREATE TABLE pending_run_inputs (
        accept_order INTEGER PRIMARY KEY AUTOINCREMENT,
        input_id TEXT NOT NULL UNIQUE,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        run_id TEXT NOT NULL,
        content TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted', 'applied', 'unapplied')),
        accepted_at INTEGER NOT NULL,
        applied_at INTEGER,
        terminal_reason TEXT,
        CHECK (
          (state = 'accepted' AND applied_at IS NULL AND terminal_reason IS NULL)
          OR (state = 'applied' AND applied_at IS NOT NULL AND terminal_reason IS NULL)
          OR (state = 'unapplied' AND applied_at IS NULL AND terminal_reason IS NOT NULL)
        )
      );
      CREATE INDEX pending_run_inputs_scope_idx
        ON pending_run_inputs (project_id, run_id, state, accept_order);
      CREATE INDEX pending_run_inputs_recovery_idx
        ON pending_run_inputs (state, accept_order);
    `);
    createProjectSchema(database);
    migrateProjectNavigation(database);
    migrateMessageTimes(database, true);
    createContextSnapshotSchema(database);
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
  if (version < SCHEMA_VERSION) {
    database.exec("BEGIN IMMEDIATE");
    try {
      migrateProjectNavigation(database);
      migrateMessageTimes(database, version < 9);
      migrateToolInvocationTimes(database);
      createContextSnapshotSchema(database);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

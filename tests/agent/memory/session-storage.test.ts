import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RepositoryError,
  SqliteHistoryRepository,
  createHistoryRecorder,
} from "../../../agent/memory/index.js";

test("SQLite history stores project and unprojected entries in one ordered stream", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const project = await repository.createProject({ canonicalPath: "/tmp/project-a", displayName: "project-a" });
  const user = await repository.appendEntry(project.id, {
    id: "user-1",
    type: "user_message",
    status: "completed",
    runId: "run-1",
    payload: { role: "user", content: "hello" },
  });
  const assistant = await repository.appendEntry(project.id, {
    id: "assistant-1",
    type: "assistant_message",
    status: "streaming",
    runId: "run-1",
    turnId: "turn-1",
    payload: { role: "assistant", content: "hel" },
  });
  const unprojected = await repository.appendEntry(null, {
    id: "user-2",
    type: "user_message",
    status: "completed",
    runId: "run-2",
    payload: { role: "user", content: "general" },
  });
  assert.deepEqual([user.entryOrder, assistant.entryOrder, unprojected.entryOrder], [1, 2, 3]);
  assert.deepEqual((await repository.listEntries(project.id)).map((entry) => entry.entryOrder), [1, 2]);
  assert.deepEqual((await repository.listEntries(null)).map((entry) => entry.entryOrder), [3]);
  assert.equal(assistant.durationMs, null);

  const completed = await repository.updateEntry(assistant.id, assistant.revision, {
    status: "completed",
    payload: { role: "assistant", content: "hello" },
    durationMs: 2_345,
  });
  assert.equal(completed.revision, assistant.revision + 1);
  assert.equal(completed.durationMs, 2_345);
  await assert.rejects(
    repository.updateEntry(assistant.id, assistant.revision, { status: "failed" }),
    (error: unknown) => error instanceof RepositoryError && error.code === "conflict",
  );
  repository.close();
});

test("HistoryRecorder coalesces deltas and restores a project history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-"));
  const databasePath = join(directory, "history.sqlite");
  try {
    const firstRepository = new SqliteHistoryRepository(databasePath);
    const project = await firstRepository.createProject({ canonicalPath: "/tmp/project-a", displayName: "project-a" });
    const first = await createHistoryRecorder(firstRepository, project.id);
    await first.commitUser({ role: "user", content: "hello" }, { runId: "run-1" });
    first.recordAssistantDelta("text", "hel", { runId: "run-1", turnId: "turn-1", turnOrdinal: 1 });
    first.recordAssistantDelta("text", "lo", { runId: "run-1", turnId: "turn-1", turnOrdinal: 1 });
    first.recordAssistantDelta("reasoning", "thinking", { runId: "run-1", turnId: "turn-1", turnOrdinal: 1 });
    await first.commitAssistant({ role: "assistant", content: "hello", reasoning: "thinking" }, { runId: "run-1", turnId: "turn-1", turnOrdinal: 1 });
    await first.commitToolResult({ role: "tool", content: "result", toolCallId: "call-1", toolName: "read" }, { runId: "run-1", turnId: "turn-1", turnOrdinal: 1, toolCallId: "call-1" });
    assert.deepEqual(first.snapshot().map((message) => message.role), ["user", "assistant", "tool"]);
    await first.close();
    firstRepository.close();

    const secondRepository = new SqliteHistoryRepository(databasePath);
    const second = await createHistoryRecorder(secondRepository, project.id);
    const entries = await secondRepository.listEntries(project.id);
    assert.deepEqual(entries.map((entry) => [entry.type, entry.status, entry.entryOrder]), [
      ["user_message", "completed", 1],
      ["assistant_message", "completed", 2],
      ["tool_result", "completed", 3],
    ]);
    assert.equal(second.snapshot()[1]?.content, "hello");
    await second.close();
    secondRepository.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite history queries page backward with a strict entryOrder cursor", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const project = await repository.createProject({ canonicalPath: "/tmp/project-a", displayName: "project-a" });
  for (let index = 1; index <= 5; index += 1) {
    await repository.appendEntry(project.id, {
      id: `entry-${index}`,
      type: "user_message",
      status: "completed",
      runId: `run-${index}`,
      payload: { role: "user", content: `message-${index}` },
    });
  }

  assert.deepEqual((await repository.listLatestEntries(project.id, 2)).map((entry) => entry.entryOrder), [5, 4]);
  assert.deepEqual((await repository.listEntriesBefore(project.id, 4, 2)).map((entry) => entry.entryOrder), [3, 2]);
  await assert.rejects(
    repository.listEntriesBefore(project.id, 0, 2),
    (error: unknown) => error instanceof RepositoryError && error.code === "invalid",
  );
  repository.close();
});

test("tool invocation ledger uses project scope and run/tool identity", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const project = await repository.createProject({ canonicalPath: "/tmp/project-a", displayName: "project-a" });
  const invocation = await repository.registerToolInvocation({
    projectId: project.id,
    runId: "run-tool",
    turnId: "turn-tool",
    cwd: process.cwd(),
    assistantEntryId: "assistant-tool",
    toolCallId: "call-tool",
    ordinal: 0,
    toolName: "read",
    toolVersion: "1",
    inputJson: '{"path":"a.txt"}',
    inputHash: "hash-a",
    recoveryModeSnapshot: "safe",
    resultEntryId: "entry-tool",
  });
  assert.equal(invocation.phase, "planned");
  const pending = await repository.beginToolAttempt(invocation.id);
  assert.equal(pending.phase, "effect_pending");
  assert.equal(pending.attemptCount, 1);
  const outcome = await repository.saveToolOutcome(invocation.id, {
    status: "failed",
    outcome: { ok: false, output: "missing", returncode: -1, truncated: false, error: "not_found" },
  });
  assert.equal(outcome.phase, "outcome_ready");
  const completed = await repository.completeToolInvocation(invocation.id, "entry-tool");
  assert.equal(completed.phase, "completed");
  assert.equal((await repository.getToolInvocation(project.id, "run-tool", "call-tool"))?.phase, "completed");
  assert.deepEqual(await repository.listOpenToolInvocations(project.id), []);
  repository.close();
});

test("legacy session storage migrates entries and tool records into the unprojected scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-history-migration-"));
  const databasePath = join(directory, "legacy.sqlite");
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        objective TEXT,
        status TEXT NOT NULL,
        next_entry_seq INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT NOT NULL,
        turn_id TEXT,
        tool_call_id TEXT,
        revision INTEGER NOT NULL,
        payload_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE tool_invocations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        assistant_entry_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        tool_version TEXT NOT NULL,
        input_json TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        phase TEXT NOT NULL,
        outcome_status TEXT,
        outcome_json TEXT,
        recovery_mode_snapshot TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        checkpoint_json TEXT,
        result_entry_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO sessions VALUES ('legacy-session', 'desktop:test', NULL, 'waiting', 2, 0, 1, 1);
      INSERT INTO entries VALUES ('legacy-entry', 'legacy-session', 1, 'user_message', 'completed', 'legacy-run', NULL, NULL, 0, 1, '{"role":"user","content":"legacy"}', 1, 1, NULL);
      INSERT INTO tool_invocations VALUES ('legacy-tool', 'legacy-session', 'legacy-run', 'legacy-turn', '/tmp', 'legacy-assistant', 'legacy-call', 0, 'read', '1', '{}', 'hash', 'planned', NULL, NULL, 'safe', 0, NULL, NULL, 1, 1);
      PRAGMA user_version = 5;
    `);
    legacy.close();

    const repository = new SqliteHistoryRepository(databasePath);
    const entries = await repository.listEntries(null);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.payload.content, "legacy");
    assert.equal((await repository.listOpenToolInvocations(null, "legacy-run")).length, 1);
    repository.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

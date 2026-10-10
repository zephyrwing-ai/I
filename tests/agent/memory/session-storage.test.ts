import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { toolResultMessage } from "../../../agent/tools/result.js";
import {
  RepositoryError,
  SCHEMA_VERSION,
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
    await first.finishAssistantAttempt({ runId: "run-1", turnId: "turn-1", turnOrdinal: 1 }, "completed", { role: "assistant", content: "hello", reasoning: "thinking" });
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
  await repository.commitToolResult(project.id, {
    id: "entry-tool", type: "tool_result", status: "completed", runId: invocation.runId,
    turnId: invocation.turnId, toolCallId: invocation.toolCallId,
    payload: toolResultMessage({ id: invocation.toolCallId, name: invocation.toolName }, { ok: false, output: "missing", returncode: -1, truncated: false, error: "not_found" }),
  }, invocation.id);
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
    const queued = await repository.acceptRunInput(null, { inputId: "legacy-input", runId: "legacy-run", content: "more" });
    assert.equal(queued.state, "accepted");
    assert.equal(Number((repository.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), SCHEMA_VERSION);
    repository.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("run inputs are durable, scoped, idempotent and applied in caller order", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const project = await repository.createProject({ canonicalPath: "/tmp/steering-project", displayName: "steering-project" });
    const first = await repository.acceptRunInput(project.id, { inputId: "input-1", runId: "run-1", content: "first" });
    const second = await repository.acceptRunInput(project.id, { inputId: "input-2", runId: "run-1", content: "second" });
    assert.equal(first.projectId, project.id);
    assert.equal(first.content, "first");
    assert.equal(first.state, "accepted");
    assert.ok(first.acceptedAt > 0);
    assert.ok(second.acceptOrder > first.acceptOrder);
    assert.deepEqual(await repository.acceptRunInput(project.id, { inputId: "input-1", runId: "run-1", content: "first" }), first);
    assert.deepEqual((await repository.listAcceptedRunInputs(project.id, "run-1")).map((item) => item.inputId), ["input-1", "input-2"]);

    await assert.rejects(
      repository.acceptRunInput(project.id, { inputId: "input-1", runId: "run-1", content: "changed" }),
      (error: unknown) => error instanceof RepositoryError && error.code === "conflict",
    );
    await assert.rejects(
      repository.applyRunInputs(project.id, "run-1", ["input-2", "input-1"]),
      (error: unknown) => error instanceof RepositoryError && error.code === "conflict",
    );
    await assert.rejects(
      repository.applyRunInputs(project.id, "run-1", ["input-2"]),
      (error: unknown) => error instanceof RepositoryError && error.code === "conflict",
    );
    assert.deepEqual(await repository.listEntries(project.id), []);

    const applied = await repository.applyRunInputs(project.id, "run-1", ["input-1", "input-2"]);
    assert.deepEqual(applied.map((entry) => entry.id), ["input-1", "input-2"]);
    assert.deepEqual(applied.map((entry) => entry.payload.content), ["first", "second"]);
    assert.deepEqual(applied.map((entry) => entry.status), ["completed", "completed"]);
    assert.deepEqual(applied.map((entry) => entry.createdAt), [first.acceptedAt, second.acceptedAt]);
    const settled = await repository.acceptRunInput(project.id, { inputId: "input-1", runId: "run-1", content: "first" });
    assert.equal(settled.state, "applied");
    assert.ok(settled.appliedAt !== null && settled.appliedAt >= first.acceptedAt);
    assert.equal(applied[0]!.completedAt, null);
    assert.deepEqual((await repository.applyRunInputs(project.id, "run-1", ["input-1", "input-2"])).map((entry) => entry.id), ["input-1", "input-2"]);
    assert.equal((await repository.listEntries(project.id)).length, 2);
  } finally {
    repository.close();
  }
});

test("applying a batch rolls back every entry and queue transition on conflict", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    await repository.acceptRunInput(null, { inputId: "atomic-1", runId: "run-atomic", content: "one" });
    await repository.acceptRunInput(null, { inputId: "atomic-2", runId: "run-atomic", content: "two" });
    await repository.appendEntry(null, {
      id: "atomic-2", type: "user_message", status: "completed", runId: "other-run",
      payload: { role: "user", content: "already used" },
    });
    await assert.rejects(
      repository.applyRunInputs(null, "run-atomic", ["atomic-1", "atomic-2"]),
      (error: unknown) => error instanceof RepositoryError && error.code === "conflict",
    );
    assert.equal(await repository.getEntry("atomic-1"), null);
    assert.deepEqual((await repository.listAcceptedRunInputs(null, "run-atomic")).map((item) => item.inputId), ["atomic-1", "atomic-2"]);
  } finally {
    repository.close();
  }
});

test("Recorder keeps initial commit idempotent and models multiple applied messages per run", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const recorder = await createHistoryRecorder(repository, null);
    await recorder.commitUser({ role: "user", content: "initial" }, { runId: "run-multi" });
    await recorder.commitUser({ role: "user", content: "initial" }, { runId: "run-multi" });
    await recorder.finishAssistantAttempt({ runId: "run-multi", turnId: "turn-before", turnOrdinal: 1 }, "completed", { role: "assistant", content: "before" });
    const a = await recorder.acceptRunInput({ inputId: "multi-a", runId: "run-multi", content: "question A" });
    const b = await recorder.acceptRunInput({ inputId: "multi-b", runId: "run-multi", content: "question B" });
    assert.equal(a.inputId, "multi-a");
    assert.equal(b.content, "question B");
    assert.deepEqual((await recorder.listAcceptedRunInputs("run-multi")).map((item) => item.inputId), ["multi-a", "multi-b"]);
    const entries = await recorder.applyRunInputs("run-multi", ["multi-a", "multi-b"]);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((entry) => entry.id), ["multi-a", "multi-b"]);
    await recorder.applyRunInputs("run-multi", ["multi-a", "multi-b"]);
    await recorder.finishAssistantAttempt({ runId: "run-multi", turnId: "turn-after", turnOrdinal: 2 }, "completed", { role: "assistant", content: "after" });
    assert.deepEqual(recorder.snapshot().map((message) => message.content), ["initial", "before", "question A", "question B", "after"]);
    assert.equal((await repository.listEntries(null)).filter((entry) => entry.type === "user_message").length, 3);
    await assert.rejects(
      recorder.commitUser({ role: "user", content: "different" }, { runId: "run-multi" }),
      (error: unknown) => error instanceof RepositoryError && error.code === "conflict",
    );

    const before = (await repository.listEntries(null)).find((entry) => entry.turnId === "turn-before");
    assert.equal(before?.durationMs, null);
    await recorder.finalizeAnswerDuration("turn-after", 320);
    await recorder.finalizeAnswerDuration("turn-after", 320);
    const after = (await repository.listEntries(null)).find((entry) => entry.turnId === "turn-after");
    assert.equal(after?.durationMs, 320);
    assert.equal((await repository.getEntry(before!.id))?.durationMs, null);
    await assert.rejects(
      recorder.finalizeAnswerDuration("turn-after", 321),
      (error: unknown) => error instanceof RepositoryError && error.code === "conflict",
    );
    await recorder.close();
  } finally {
    repository.close();
  }
});

test("cancel and startup recovery archive accepted inputs without exposing them to model snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-steering-recovery-"));
  const databasePath = join(directory, "history.sqlite");
  try {
    const firstRepository = new SqliteHistoryRepository(databasePath);
    const project = await firstRepository.createProject({ canonicalPath: "/tmp/steering-recovery", displayName: "steering-recovery" });
    const recorder = await createHistoryRecorder(firstRepository, project.id);
    await recorder.commitUser({ role: "user", content: "start" }, { runId: "run-cancel" });
    await recorder.acceptRunInput({ inputId: "cancelled-input", runId: "run-cancel", content: "cancel me" });
    await recorder.finishRun({ runId: "run-cancel", status: "cancelled" });
    assert.equal(await firstRepository.getEntry("cancelled-input"), null);
    const cancelled = await recorder.abandonRunInputs("run-cancel", "cancelled");
    assert.deepEqual(cancelled.map((entry) => [entry.id, entry.status]), [["cancelled-input", "interrupted"]]);
    assert.deepEqual(recorder.snapshot().map((message) => message.content), ["start"]);
    assert.equal((await firstRepository.getEntry("cancelled-input"))?.status, "interrupted");
    assert.equal((await firstRepository.acceptRunInput(project.id, { inputId: "cancelled-input", runId: "run-cancel", content: "cancel me" })).terminalReason, "cancelled");
    await firstRepository.acceptRunInput(project.id, { inputId: "orphan-project", runId: "run-orphan", content: "project orphan" });
    await firstRepository.acceptRunInput(null, { inputId: "orphan-general", runId: "run-general", content: "general orphan" });
    await recorder.close();
    firstRepository.close();

    const secondRepository = new SqliteHistoryRepository(databasePath);
    const general = await createHistoryRecorder(secondRepository, null);
    assert.equal((await secondRepository.getEntry("orphan-project"))?.status, "interrupted");
    assert.equal((await secondRepository.getEntry("orphan-general"))?.status, "interrupted");
    assert.equal((await secondRepository.acceptRunInput(null, { inputId: "orphan-general", runId: "run-general", content: "general orphan" })).terminalReason, "startup_recovery");
    assert.deepEqual(general.snapshot(), []);
    const projectRecorder = await createHistoryRecorder(secondRepository, project.id);
    assert.deepEqual(projectRecorder.snapshot().map((message) => message.content), ["start"]);
    await projectRecorder.acceptRunInput({ inputId: "active-input", runId: "run-active", content: "still active" });
    await createHistoryRecorder(secondRepository, null);
    assert.equal((await secondRepository.listAcceptedRunInputs(project.id, "run-active")).length, 1);
    const abandoned = await projectRecorder.abandonRunInputs("run-active", "stopped");
    assert.deepEqual(abandoned.map((entry) => [entry.id, entry.status]), [["active-input", "interrupted"]]);
    assert.deepEqual(projectRecorder.snapshot().map((message) => message.content), ["start"]);
    await general.close();
    await projectRecorder.close();
    secondRepository.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("project schema version 7 upgrades its queue without changing existing history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-steering-migration-"));
  const databasePath = join(directory, "history.sqlite");
  try {
    const first = new SqliteHistoryRepository(databasePath);
    const project = await first.createProject({ canonicalPath: "/tmp/steering-v7", displayName: "steering-v7" });
    await first.appendEntry(project.id, {
      id: "old-entry", type: "user_message", status: "completed", runId: "old-run",
      payload: { role: "user", content: "old history" },
    });
    first.close();
    const oldSchema = new DatabaseSync(databasePath);
    oldSchema.exec("DROP TABLE pending_run_inputs; PRAGMA user_version = 7");
    oldSchema.close();

    const upgraded = new SqliteHistoryRepository(databasePath);
    assert.equal((await upgraded.listEntries(project.id))[0]?.payload.content, "old history");
    assert.equal(Number((upgraded.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), SCHEMA_VERSION);
    assert.equal((await upgraded.acceptRunInput(project.id, { inputId: "new-input", runId: "old-run", content: "new" })).state, "accepted");
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";
import { RepositoryError, SCHEMA_VERSION, SqliteHistoryRepository, createHistoryRecorder } from "../../../agent/memory/index.js";
import type { CreateToolInvocationInput } from "../../../agent/memory/types.js";

function inputs(): CreateToolInvocationInput[] {
  return [0, 1].map((ordinal) => ({
    projectId: null, id: `invocation-${ordinal}`, runId: "run", turnId: "turn", cwd: "/tmp", assistantEntryId: "assistant",
    toolCallId: `call-${ordinal}`, ordinal, toolName: "read", toolVersion: "1", inputJson: "{}", inputHash: `hash-${ordinal}`,
    recoveryModeSnapshot: "safe", resultEntryId: `result-${ordinal}`,
  }));
}

function plans() {
  return inputs().map(({ assistantEntryId: _assistantEntryId, projectId: _projectId, id: _id, ...input }) => input);
}

const assistant = {
  entry: {
    id: "assistant", type: "assistant_message" as const, status: "completed" as const, runId: "run", turnId: "turn",
    payload: { role: "assistant" as const, content: "", toolCalls: inputs().map((input) => ({ id: input.toolCallId, name: input.toolName, input: {}, inputComplete: true })) },
  },
  expectedRevision: null,
};

test("one conflicting invocation rolls back the whole batch and its completed assistant", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  repository.database.exec("CREATE TRIGGER reject_second_plan BEFORE INSERT ON tool_invocations WHEN NEW.tool_call_id = 'call-1' BEGIN SELECT RAISE(ABORT, 'second plan rejected'); END");
  await assert.rejects(repository.commitAssistantAttempt(null, assistant, plans()), (error: unknown) => error instanceof RepositoryError && error.code === "conflict" && !error.retryable);
  assert.deepEqual(await repository.listOpenToolInvocations(null), []);
  assert.equal(await repository.getEntry("assistant"), null);
  repository.database.exec("DROP TRIGGER reject_second_plan");
  const registered = await repository.commitAssistantAttempt(null, assistant, plans());
  assert.equal(registered.invocations.length, 2);
  assert.deepEqual(registered.invocations.map((record) => record.ordinal), [0, 1]);
  repository.close();
});

test("a failed plan insertion restores the entire existing Assistant draft and revision", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const draft = await repository.appendEntry(null, {
      ...assistant.entry, status: "streaming", payload: { role: "assistant", content: "partial" }, createdAt: 1_000,
    });
    repository.database.exec("CREATE TRIGGER reject_second_plan BEFORE INSERT ON tool_invocations WHEN NEW.tool_call_id = 'call-1' BEGIN SELECT RAISE(ABORT, 'second plan rejected'); END");
    const terminal = { entry: { ...assistant.entry, createdAt: 1_000, completedAt: 2_000 }, expectedRevision: draft.revision };
    await assert.rejects(repository.commitAssistantAttempt(null, terminal, plans()), (error: unknown) => error instanceof RepositoryError && error.code === "conflict");
    assert.deepEqual(await repository.getEntry("assistant"), draft);
    assert.deepEqual(await repository.listOpenToolInvocations(null), []);
    repository.database.exec("DROP TRIGGER reject_second_plan");
    const saved = await repository.commitAssistantAttempt(null, terminal, plans());
    assert.deepEqual([saved.assistant.status, saved.assistant.revision, saved.assistant.createdAt, saved.assistant.completedAt], ["completed", draft.revision + 1, 1_000, 2_000]);
    assert.equal(saved.invocations.length, 2);
  } finally { repository.close(); }
});

test("standalone tool batches return records without producing an Assistant entry", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const records = await repository.registerToolBatch(inputs());
    assert.ok(Array.isArray(records));
    assert.deepEqual(records.map((record) => [record.ordinal, record.phase]), [[0, "planned"], [1, "planned"]]);
    assert.deepEqual(await repository.listEntries(null), []);
    assert.deepEqual(await repository.registerToolBatch(inputs()), records);
  } finally { repository.close(); }
});

for (const status of ["completed", "interrupted", "failed"] as const) {
  test(`a ${status} Assistant with an empty plan commits and retries one original entry`, async () => {
    const repository = new SqliteHistoryRepository(":memory:");
    try {
      const input = {
        entry: { ...assistant.entry, status, payload: { role: "assistant" as const, content: "plain", reasoning: undefined }, createdAt: 1_000, completedAt: status === "completed" ? 2_000 : null },
        expectedRevision: null,
      };
      const first = await repository.commitAssistantAttempt(null, input, []);
      const second = await repository.commitAssistantAttempt(null, { ...input, entry: { ...input.entry, createdAt: 8_000, completedAt: status === "completed" ? 9_000 : null, payload: { content: "plain", role: "assistant" } } }, []);
      assert.deepEqual(second, first);
      assert.equal(first.assistant.createdAt, 1_000);
      assert.equal(first.assistant.completedAt, status === "completed" ? 2_000 : null);
      assert.deepEqual(first.invocations, []);
      assert.equal((await repository.listEntries(null)).length, 1);
    } finally { repository.close(); }
  });
}

test("Assistant commits reject scope, attempt and incomplete-plan conflicts while preserving the draft", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const project = await repository.createProject({ canonicalPath: "/tmp/assistant-scope", displayName: "assistant-scope" });
    const draft = await repository.appendEntry(null, { ...assistant.entry, status: "streaming", payload: { role: "assistant", content: "partial" } });
    const commit = { ...assistant, expectedRevision: draft.revision };
    const otherPlans = plans().map((plan) => ({ ...plan, runId: "other-run" }));
    const otherTurns = plans().map((plan) => ({ ...plan, turnId: "other-turn" }));
    for (const [scope, entry, toolPlans, code] of [
      [project.id, assistant.entry, plans(), "conflict"],
      [null, { ...assistant.entry, runId: "other-run" }, otherPlans, "conflict"],
      [null, { ...assistant.entry, turnId: "other-turn" }, otherTurns, "conflict"],
      [null, assistant.entry, plans().slice(0, 1), "invalid"],
      [null, assistant.entry, plans().reverse(), "invalid"],
    ] as const) {
      await assert.rejects(repository.commitAssistantAttempt(scope, { ...commit, entry }, [...toolPlans]), (error: unknown) => error instanceof RepositoryError && error.code === code);
      assert.deepEqual(await repository.getEntry("assistant"), draft);
      assert.deepEqual(await repository.listOpenToolInvocations(null), []);
    }
  } finally { repository.close(); }
});

test("SQLite BEGIN and COMMIT contention preserve retryable errors and roll back the whole batch", async () => {
  for (const phase of ["BEGIN", "COMMIT"]) {
    const directory = mkdtempSync(join(tmpdir(), "history-lock-"));
    const repository = new SqliteHistoryRepository(join(directory, "history.sqlite"));
    repository.database.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE");
    const blocker = new DatabaseSync(join(directory, "history.sqlite"));
    let locked = false;
    try {
      if (phase === "BEGIN") blocker.exec("BEGIN IMMEDIATE");
      else blocker.exec("BEGIN; SELECT COUNT(*) FROM entries");
      locked = true;
      await assert.rejects(repository.commitAssistantAttempt(null, assistant, plans()), (error: unknown) => error instanceof RepositoryError && error.code === "storage" && error.retryable && error.cause instanceof Error);
      assert.deepEqual(await repository.listOpenToolInvocations(null), []);
      assert.equal(await repository.getEntry("assistant"), null);
      blocker.exec("ROLLBACK");
      locked = false;
      const result = await repository.commitAssistantAttempt(null, assistant, plans());
      assert.equal(result.invocations.length, 2);
      assert.equal((await repository.listEntries(null)).length, 1);
    } finally {
      if (locked) blocker.exec("ROLLBACK");
      blocker.close();
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("a streaming draft and its whole tool plan commit atomically and remain idempotent", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const context = { runId: "run", turnId: "turn", turnOrdinal: 1, attempt: 1 };
  recorder.recordAssistantDelta("text", "stream".repeat(800), context);
  await nextTick();
  const plan = plans();
  const first = await recorder.finishAssistantAttempt(context, "completed", assistant.entry.payload, plan);
  const second = await recorder.finishAssistantAttempt(context, "completed", assistant.entry.payload, plan);
  assert.deepEqual(second.map((record) => record.id), first.map((record) => record.id));
  const entries = await repository.listEntries(null);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.status, "completed");
  assert.equal(entries[0]!.revision, 1);
  assert.deepEqual(entries[0]!.payload, assistant.entry.payload);
  assert.equal(recorder.snapshot().length, 1);
  await assert.rejects(recorder.finishAssistantAttempt(context, "completed", { ...assistant.entry.payload, content: "different" }, plan), (error: unknown) => error instanceof RepositoryError && error.code === "conflict");
  assert.deepEqual((await repository.listEntries(null))[0]!.payload, assistant.entry.payload);
  await recorder.close();
  repository.close();
});

test("unstarted settlement is explicit and cannot create a successful execution", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const record = await repository.registerToolInvocation(inputs()[0]!);
  const cancelled = { ok: false, output: "user stopped", returncode: -1, truncated: false, error: "cancelled" };
  await assert.rejects(repository.saveToolOutcome(record.id, { status: "cancelled", outcome: cancelled }), /cannot save outcome from phase planned/);
  await assert.rejects(repository.settleUnstartedToolInvocation(record.id, { status: "succeeded", outcome: { ok: true, output: "done", returncode: 0, truncated: false } }), /only be failed, cancelled or interrupted/);
  const settled = await repository.settleUnstartedToolInvocation(record.id, { status: "cancelled", outcome: cancelled });
  assert.deepEqual([settled.phase, settled.outcomeStatus, settled.attemptCount], ["outcome_ready", "cancelled", 0]);
  repository.close();
});

test("unstarted validation failure stores an outcome with zero effect attempts", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const record = await repository.registerToolInvocation(inputs()[0]!);
    const outcome = { ok: false, output: "invalid input", returncode: -1, truncated: false, error: "invalid_input" };
    const settled = await repository.settleUnstartedToolInvocation(record.id, { status: "failed", outcome });
    assert.deepEqual([settled.phase, settled.outcomeStatus, settled.attemptCount], ["outcome_ready", "failed", 0]);
    assert.deepEqual(settled.outcomeJson, outcome);
  } finally { repository.close(); }
});

test("a durable cancellation is checked inside the tool attempt transaction", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const record = await repository.registerToolInvocation(inputs()[0]!);
  await repository.requestRunCancellation(null, "run");
  await assert.rejects(repository.beginToolAttempt(record.id), /Cancelled run cannot start/);
  assert.deepEqual([(await repository.getToolInvocation(null, "run", record.toolCallId))!.phase, (await repository.getToolInvocation(null, "run", record.toolCallId))!.attemptCount], ["planned", 0]);
  repository.close();
});

for (const version of [1, 2]) {
  test(`historical schema v${version} upgrades directly with entries and any available tool ledger preserved`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `history-v${version}-`));
    const databasePath = join(directory, "history.sqlite");
    try {
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, objective TEXT, status TEXT NOT NULL,
          next_entry_seq INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE entries (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          session_seq INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
          run_id TEXT NOT NULL, turn_id TEXT, tool_call_id TEXT,
          revision INTEGER NOT NULL DEFAULT 0, payload_version INTEGER NOT NULL DEFAULT 1,
          payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE (session_id, session_seq)
        );
        CREATE INDEX entries_session_order_idx ON entries (session_id, session_seq ASC);
        CREATE INDEX entries_tool_call_idx ON entries (session_id, tool_call_id);
        INSERT INTO sessions VALUES ('session', 'desktop', NULL, 'waiting', 3, 0, 1, 1);
        INSERT INTO entries VALUES ('user', 'session', 1, 'user_message', 'completed', 'run', NULL, NULL, 0, 1, '{"role":"user","content":"preserved"}', 1, 1);
        INSERT INTO entries VALUES ('draft', 'session', 2, 'assistant_message', 'interrupted', 'run', 'turn', NULL, 2, 1, '{"role":"assistant","content":"partial"}', 2, 2);
        PRAGMA user_version = ${version};
      `);
      if (version === 2) {
        legacy.exec(`
          CREATE TABLE tool_invocations (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL, turn_id TEXT NOT NULL, assistant_entry_id TEXT NOT NULL,
            tool_call_id TEXT NOT NULL, ordinal INTEGER NOT NULL, tool_name TEXT NOT NULL,
            tool_version TEXT NOT NULL, input_json TEXT NOT NULL, input_hash TEXT NOT NULL,
            phase TEXT NOT NULL, outcome_status TEXT, outcome_json TEXT,
            recovery_mode_snapshot TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
            checkpoint_json TEXT, result_entry_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            UNIQUE (session_id, tool_call_id)
          );
          INSERT INTO tool_invocations VALUES ('tool', 'session', 'run', 'turn', 'draft', 'call', 0, 'read', '1', '{}', 'hash', 'effect_pending', NULL, NULL, 'safe', 1, '{"version":1}', NULL, 3, 3);
        `);
      }
      legacy.close();
      const repository = new SqliteHistoryRepository(databasePath);
      const entries = await repository.listEntries(null);
      assert.deepEqual(entries.map((entry) => [entry.id, entry.entryOrder, entry.status, entry.payload.content]), [["user", 1, "completed", "preserved"], ["draft", 2, "interrupted", "partial"]]);
      const invocations = await repository.listOpenToolInvocations(null);
      assert.equal(invocations.length, version === 2 ? 1 : 0);
      if (version === 2) {
        assert.deepEqual([invocations[0]!.phase, invocations[0]!.attemptCount, invocations[0]!.cwd], ["effect_pending", 1, ""]);
        assert.deepEqual(invocations[0]!.checkpoint, { version: 1 });
      }
      assert.equal((repository.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
      assert.deepEqual(repository.database.prepare("PRAGMA foreign_key_check").all(), []);
      await repository.requestRunCancellation(null, "run");
      repository.close();
      const reopened = new SqliteHistoryRepository(databasePath);
      assert.equal(await reopened.isRunCancelled(null, "run"), true);
      assert.equal((await reopened.listEntries(null)).length, 2);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("schema v8 gains durable cancellation without changing its project, history or queue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "history-v8-"));
  const databasePath = join(directory, "history.sqlite");
  try {
    const first = new SqliteHistoryRepository(databasePath);
    const project = await first.createProject({ canonicalPath: "/tmp/migration", displayName: "migration" });
    await first.appendEntry(project.id, { id: "user", runId: "run", type: "user_message", status: "completed", payload: { role: "user", content: "old history" } });
    await first.acceptRunInput(project.id, { inputId: "input", runId: "run", content: "queued" });
    first.database.exec("DROP TABLE run_cancellations; PRAGMA user_version = 8");
    first.close();
    const upgraded = new SqliteHistoryRepository(databasePath);
    assert.equal((await upgraded.listEntries(project.id))[0]!.payload.content, "old history");
    assert.equal((await upgraded.listAcceptedRunInputs(project.id, "run"))[0]!.content, "queued");
    await upgraded.requestRunCancellation(project.id, "run");
    assert.equal(await upgraded.isRunCancelled(project.id, "run"), true);
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

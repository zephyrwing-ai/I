import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistoryRecorder } from "../../../agent/memory/session-recorder.js";
import { SqliteHistoryRepository } from "../../../agent/memory/sqlite-repository.js";
import { RepositoryError, type AppendEntryInput, type HistoryScope } from "../../../agent/memory/types.js";
import { toolResultMessage } from "../../../agent/tools/result.js";
import type { ToolResult } from "../../../agent/tools/types.js";

const result: ToolResult = { ok: true, output: "result", returncode: 0, truncated: false };
const message = toolResultMessage({ id: "call", name: "read" }, result);
const entry: AppendEntryInput = {
  id: "result", type: "tool_result", status: "completed", runId: "run", turnId: "turn",
  toolCallId: "call", payload: message, createdAt: 1_000,
};

async function ready(repository: SqliteHistoryRepository, projectId: HistoryScope = null) {
  const invocation = await repository.registerToolInvocation({
    projectId, runId: "run", turnId: "turn", cwd: "/tmp", assistantEntryId: "assistant", toolCallId: "call",
    ordinal: 0, toolName: "read", toolVersion: "1", inputJson: "{}", inputHash: "hash", recoveryModeSnapshot: "safe", resultEntryId: "result",
  });
  await repository.beginToolAttempt(invocation.id, { version: 1, kind: "read", data: { path: "a.txt" } });
  return repository.saveToolOutcome(invocation.id, { status: "succeeded", outcome: result });
}

async function setup(t: TestContext) {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  t.after(async () => { try { await recorder.close(); } finally { repository.close(); } });
  return { repository, recorder };
}

test("a failed ledger completion rolls back the ToolMessage and permits an atomic Recorder retry", async (t) => {
  const { repository, recorder } = await setup(t);
  const invocation = await ready(repository);
  repository.database.exec("CREATE TRIGGER reject_completion BEFORE UPDATE OF phase ON tool_invocations WHEN NEW.phase = 'completed' BEGIN SELECT RAISE(ABORT, 'completion rejected'); END");
  const context = { runId: "run", turnId: "turn", turnOrdinal: 1, toolCallId: "call", entryId: "result", invocationId: invocation.id, createdAt: 1_000 };
  await assert.rejects(recorder.commitToolResult(message, context), (error: unknown) => error instanceof RepositoryError && error.code === "conflict");
  assert.equal(await repository.getEntry("result"), null);
  assert.equal((await repository.getToolInvocation(null, "run", "call"))?.phase, "outcome_ready");
  assert.deepEqual(recorder.snapshot(), []);
  repository.database.exec("DROP TRIGGER reject_completion");
  await recorder.commitToolResult(message, context);
  const saved = (await repository.getEntry("result"))!;
  assert.deepEqual([saved.payload, saved.createdAt], [message, 1_000]);
  assert.equal((await repository.getToolInvocation(null, "run", "call"))?.phase, "completed");
  assert.deepEqual(recorder.snapshot(), [message]);
  await recorder.commitToolResult({ ...message, media: undefined }, { ...context, createdAt: 9_000 });
  assert.deepEqual(await repository.getEntry("result"), saved);
  assert.deepEqual(await repository.listOpenToolInvocations(null), []);
  assert.deepEqual(recorder.snapshot(), [message]);
});

for (const phase of ["BEGIN", "COMMIT"]) {
  test(`ToolMessage materialization rolls back on SQLite ${phase} contention and retries from outcome_ready`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "tool-materialization-"));
    const path = join(directory, "history.sqlite");
    const repository = new SqliteHistoryRepository(path);
    repository.database.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE");
    const invocation = await ready(repository);
    const blocker = new DatabaseSync(path);
    let locked = false;
    try {
      blocker.exec(phase === "BEGIN" ? "BEGIN IMMEDIATE" : "BEGIN; SELECT COUNT(*) FROM entries");
      locked = true;
      await assert.rejects(repository.commitToolResult(null, entry, invocation.id), (error: unknown) => error instanceof RepositoryError && error.code === "storage" && error.retryable);
      assert.equal(await repository.getEntry("result"), null);
      assert.equal((await repository.getToolInvocation(null, "run", "call"))?.phase, "outcome_ready");
      blocker.exec("ROLLBACK");
      locked = false;
      await repository.commitToolResult(null, entry, invocation.id);
      assert.equal((await repository.getToolInvocation(null, "run", "call"))?.phase, "completed");
      assert.equal((await repository.listEntries(null)).length, 1);
    } finally {
      if (locked) blocker.exec("ROLLBACK");
      blocker.close(); repository.close(); rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("ToolMessage materialization validates scope, invocation and result identity before publishing", async (t) => {
  const { repository, recorder } = await setup(t);
  const project = await repository.createProject({ canonicalPath: "/tmp/materialization", displayName: "materialization" });
  const invocation = await ready(repository);
  for (const [scope, changed] of [
    [project.id, {}], [null, { runId: "other" }], [null, { turnId: "other" }], [null, { id: "other" }],
    [null, { toolCallId: "other", payload: { ...message, toolCallId: "other" } }],
    [null, { payload: { ...message, content: "forged" } }], [null, { payload: { ...message, toolName: "write" } }],
  ] as const) {
    await assert.rejects(repository.commitToolResult(scope, { ...entry, ...changed }, invocation.id), (error: unknown) => error instanceof RepositoryError && error.code === "conflict");
    assert.deepEqual(await repository.listEntries(null), []);
    assert.deepEqual(await repository.listEntries(project.id), []);
    assert.equal((await repository.getToolInvocation(null, "run", "call"))?.phase, "outcome_ready");
  }
  const context = { runId: "run", turnId: "turn", turnOrdinal: 1, toolCallId: "call", entryId: "result", invocationId: invocation.id };
  await recorder.commitToolResult(message, context);
  const other = await repository.registerToolInvocation({
    projectId: null, runId: "other", turnId: "other-turn", cwd: "/tmp", assistantEntryId: "other-assistant", toolCallId: "other-call",
    ordinal: 0, toolName: "read", toolVersion: "1", inputJson: "{}", inputHash: "hash", recoveryModeSnapshot: "safe",
  });
  await assert.rejects(recorder.commitToolResult(message, { ...context, invocationId: other.id }), (error: unknown) => error instanceof RepositoryError && error.code === "conflict");
  await assert.rejects(recorder.commitToolResult(message, { ...context, turnId: "wrong" }), (error: unknown) => error instanceof RepositoryError && error.code === "conflict");
  assert.equal((await repository.getToolInvocation(null, "other", "other-call"))?.phase, "planned");
  assert.deepEqual(recorder.snapshot(), [message]);
});

test("restored historical ToolMessage materializes an existing outcome_ready invocation despite cached deduplication", async (t) => {
  const { repository, recorder } = await setup(t);
  const invocation = await ready(repository);
  await repository.appendEntry(null, entry);
  await recorder.close();
  const restored = await createHistoryRecorder(repository, null);
  t.after(() => restored.close());
  assert.deepEqual(restored.snapshot(), [message]);
  assert.equal((await repository.getToolInvocation(null, "run", "call"))?.phase, "outcome_ready");
  await restored.commitToolResult(message, {
    runId: "run", turnId: "turn", turnOrdinal: 1, toolCallId: "call", invocationId: invocation.id,
  });
  assert.equal((await repository.getToolInvocation(null, "run", "call"))?.phase, "completed");
  assert.equal((await repository.listEntries(null)).length, 1);
  assert.deepEqual(restored.snapshot(), [message]);
});

test("beginToolAttempt atomically updates evidence, pending state and attempt count", async (t) => {
  const { repository, recorder } = await setup(t);
  const invocation = await repository.registerToolInvocation({
    projectId: null, runId: "run", turnId: "turn", cwd: "/tmp", assistantEntryId: "assistant", toolCallId: "call",
    ordinal: 0, toolName: "read", toolVersion: "1", inputJson: "{}", inputHash: "hash", recoveryModeSnapshot: "safe",
  });
  const checkpoint = { version: 1, kind: "read", data: { path: "a.txt" } };
  repository.database.exec("CREATE TRIGGER reject_attempt BEFORE UPDATE OF phase ON tool_invocations WHEN NEW.phase = 'effect_pending' BEGIN SELECT RAISE(ABORT, 'attempt rejected'); END");
  await assert.rejects(recorder.beginToolAttempt(invocation.id, checkpoint), (error: unknown) => error instanceof RepositoryError && error.code === "conflict");
  assert.deepEqual(await repository.getToolInvocation(null, "run", "call"), invocation);
  repository.database.exec("DROP TRIGGER reject_attempt");
  const pending = await recorder.beginToolAttempt(invocation.id, checkpoint);
  assert.deepEqual([pending.phase, pending.attemptCount, pending.checkpoint], ["effect_pending", 1, checkpoint]);
  const replacement = { ...checkpoint, data: { path: "b.txt" } };
  const retry = await recorder.beginToolAttempt(invocation.id, replacement);
  assert.deepEqual([retry.phase, retry.attemptCount, retry.checkpoint], ["effect_pending", 2, replacement]);
});

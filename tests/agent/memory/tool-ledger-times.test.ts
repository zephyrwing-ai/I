import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { initializeSchema, SCHEMA_VERSION, SqliteHistoryRepository } from "../../../agent/memory/index.js";
import { canonicalJson } from "../../../agent/json.js";
import { toolInputHash } from "../../../agent/tools/identity.js";
import { readToolCheckpoint, readToolResult, toolResultMessage } from "../../../agent/tools/result.js";
import type { ToolResult } from "../../../agent/tools/types.js";

const result: ToolResult = {
  ok: true, output: "saved", returncode: 0, truncated: false,
  artifacts: [{ path: "/tmp/artifact.txt", operation: "updated", mediaType: "text/plain", byteSize: 5, updatedAt: "2026-10-10T00:00:00.000Z" }],
};
const otherTables = ["projects", "entries", "pending_run_inputs", "run_cancellations"] as const;

function databasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "tool-ledger-times-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "history.sqlite");
}

function snapshot(database: DatabaseSync) {
  return {
    tools: database.prepare("SELECT * FROM tool_invocations ORDER BY ordinal").all(),
    others: otherTables.map((table) => database.prepare(`SELECT * FROM ${table}`).all()),
    indexes: database.prepare("PRAGMA index_list(tool_invocations)").all(),
  };
}

async function seed(repository: SqliteHistoryRepository) {
  const project = await repository.createProject({ canonicalPath: "/tmp/tool-ledger-times", displayName: "ledger", createdAt: 100, lastOpenedAt: 200 });
  await repository.appendEntry(project.id, { id: "user", type: "user_message", status: "completed", runId: "run", createdAt: 500, payload: { role: "user", content: "task" } });
  const calls = [0, 1, 2, 3].map((ordinal) => ({ id: `call-${ordinal}`, name: "read", input: { path: `${ordinal}.txt` }, inputComplete: true }));
  const { invocations } = await repository.commitAssistantAttempt(project.id, {
    entry: { id: "assistant", type: "assistant_message", status: "completed", runId: "run", turnId: "turn", createdAt: 1_000, completedAt: 2_000, payload: { role: "assistant", content: "", toolCalls: calls } },
    expectedRevision: null,
  }, calls.map((call, ordinal) => ({ runId: "run", turnId: "turn", cwd: "/tmp", toolCallId: call.id, ordinal, toolName: call.name, toolVersion: "1", inputJson: canonicalJson(call.input), inputHash: toolInputHash(call.name, "1", call.input), recoveryModeSnapshot: "safe", resultEntryId: `result-${ordinal}`, createdAt: 3_000 + ordinal })));
  for (const invocation of invocations.slice(1)) {
    await repository.beginToolAttempt(invocation.id, { version: 1, kind: "evidence", data: { ordinal: invocation.ordinal, updatedAt: "private checkpoint evidence" } });
  }
  await repository.saveToolOutcome(invocations[2]!.id, { status: "failed", outcome: { ...result, ok: false, error: "not_found" } });
  await repository.saveToolOutcome(invocations[3]!.id, { status: "succeeded", outcome: result });
  await repository.commitToolResult(project.id, {
    id: invocations[3]!.resultEntryId!, type: "tool_result", status: "completed", runId: "run", turnId: "turn", toolCallId: calls[3]!.id, createdAt: 4_000, payload: toolResultMessage(calls[3]!, result),
  }, invocations[3]!.id);
  await repository.acceptRunInput(project.id, { inputId: "input", runId: "pending-run", content: "queued" });
  await repository.requestRunCancellation(project.id, "cancelled-run");
  return { projectId: project.id, invocations };
}

async function legacyV10(path: string) {
  const repository = new SqliteHistoryRepository(path);
  try {
    const identifiers = await seed(repository);
    const original = snapshot(repository.database);
    repository.database.exec(`
      ALTER TABLE tool_invocations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
      UPDATE tool_invocations SET updated_at = created_at + 500;
      PRAGMA user_version = 10;
    `);
    return { ...identifiers, original };
  } finally {
    repository.close();
  }
}

test("new ledgers expose twenty fields and keep file-artifact timestamps inside outcomes", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const { projectId, invocations } = await seed(repository);
    const columns = repository.database.prepare("PRAGMA table_info(tool_invocations)").all();
    assert.equal(columns.length, 20);
    assert.ok(columns.every((column) => column.name !== "updated_at"));
    const records = await Promise.all(invocations.map((invocation) => repository.getToolInvocation(projectId, "run", invocation.toolCallId)));
    assert.deepEqual(records.map((record) => record!.phase), ["planned", "effect_pending", "outcome_ready", "completed"]);
    assert.ok(records.every((record) => !Object.hasOwn(record!, "updatedAt")));
    assert.deepEqual(records[3]!.outcomeJson, result);
    assert.deepEqual(records.map((record) => record!.createdAt), [3_000, 3_001, 3_002, 3_003]);
    const checkpoint = readToolCheckpoint(records[1]!.checkpoint);
    assert.ok(checkpoint);
    assert.equal(checkpoint.data.updatedAt, "private checkpoint evidence");
  } finally { repository.close(); }
});

test("v10 migration drops only the ledger update time and preserves every phase, identity and related table", async (t) => {
  const path = databasePath(t);
  const { projectId, invocations, original } = await legacyV10(path);
  const repository = new SqliteHistoryRepository(path);
  try {
    assert.equal(repository.database.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
    assert.deepEqual(snapshot(repository.database), original);
    assert.deepEqual(repository.database.prepare("PRAGMA foreign_key_check").all(), []);
    for (const invocation of invocations) {
      const restored = await repository.getToolInvocation(projectId, "run", invocation.toolCallId);
      assert.ok(restored);
      assert.ok(!Object.hasOwn(restored, "updatedAt"));
      assert.equal((await repository.getToolInvocationCall(invocation.id)).id, invocation.toolCallId);
    }
    const retry = await repository.beginToolAttempt(invocations[1]!.id, { version: 1, kind: "evidence", data: { attempt: 2 } });
    assert.equal(retry.attemptCount, 2);
    const restoredReady = (await repository.getToolInvocation(projectId, "run", invocations[2]!.toolCallId))!;
    const failed = readToolResult(restoredReady.outcomeJson);
    assert.ok(failed);
    await repository.commitToolResult(projectId, {
      id: restoredReady.resultEntryId!, type: "tool_result", status: "completed", runId: "run", turnId: "turn", toolCallId: restoredReady.toolCallId,
      payload: toolResultMessage({ id: restoredReady.toolCallId, name: restoredReady.toolName }, failed),
    }, restoredReady.id);
    assert.equal((await repository.getToolInvocation(projectId, "run", restoredReady.toolCallId))!.phase, "completed");
  } finally { repository.close(); }
  const reopened = new SqliteHistoryRepository(path);
  try {
    assert.ok(!reopened.database.prepare("PRAGMA table_info(tool_invocations)").all().some((column) => column.name === "updated_at"));
    assert.equal((await reopened.getToolInvocation(projectId, "run", invocations[1]!.toolCallId))!.attemptCount, 2);
    assert.deepEqual((await reopened.getToolInvocation(projectId, "run", invocations[3]!.toolCallId))!.outcomeJson, result);
  } finally { reopened.close(); }
});

test("a failed update-time migration rolls back its schema and version and permits a later retry", async (t) => {
  const path = databasePath(t);
  await legacyV10(path);
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE INDEX external_update_time_idx ON tool_invocations(updated_at)");
    const before = snapshot(database);
    assert.throws(() => initializeSchema(database), /updated_at/);
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 10);
    assert.deepEqual(snapshot(database), before);
    assert.ok(database.prepare("PRAGMA table_info(tool_invocations)").all().some((column) => column.name === "updated_at"));
    database.exec("DROP INDEX external_update_time_idx");
    initializeSchema(database);
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
    assert.ok(!database.prepare("PRAGMA table_info(tool_invocations)").all().some((column) => column.name === "updated_at"));
  } finally { database.close(); }
});

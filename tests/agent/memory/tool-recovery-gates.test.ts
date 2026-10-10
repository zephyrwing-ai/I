import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { RepositoryError, ToolAttemptBlockedError, SqliteHistoryRepository, createHistoryRecorder, SCHEMA_VERSION } from "../../../agent/memory/index.js";
import { canonicalJson } from "../../../agent/json.js";
import { toolInputHash } from "../../../agent/tools/identity.js";
import { toolResultMessage } from "../../../agent/tools/result.js";
import type { ToolInvocationRecord, ToolOutcomeStatus } from "../../../agent/memory/types.js";
import type { ToolResult } from "../../../agent/tools/types.js";

const checkpoint = { version: 1, kind: "read", data: { path: "a.txt" } };

async function batch(repository: SqliteHistoryRepository, assistantId = "assistant", runId = "run") {
  const calls = [0, 1, 2].map((ordinal) => ({
    id: `${assistantId}:call-${ordinal}`, name: "read", input: { path: `file-${ordinal}.txt`, nested: { z: 1, ä: 2 } }, inputComplete: true,
  }));
  const committed = await repository.commitAssistantAttempt(null, {
    entry: { id: assistantId, type: "assistant_message", status: "completed", runId, turnId: `${assistantId}:turn`, payload: { role: "assistant", content: "", toolCalls: calls } },
    expectedRevision: null,
  }, calls.map((call, ordinal) => ({
    runId, turnId: `${assistantId}:turn`, cwd: "/tmp", ordinal, toolCallId: call.id, toolName: call.name,
    toolVersion: "1", inputJson: canonicalJson(call.input), inputHash: toolInputHash(call.name, "1", call.input), recoveryModeSnapshot: "safe",
  })));
  return { calls, records: committed.invocations };
}

async function save(repository: SqliteHistoryRepository, invocation: ToolInvocationRecord, status: ToolOutcomeStatus, materialized: boolean) {
  const result: ToolResult = {
    ok: status === "succeeded", output: status, returncode: status === "succeeded" ? 0 : -1, truncated: false,
    ...(status === "succeeded" ? {} : { error: status }),
  };
  await repository.beginToolAttempt(invocation.id, checkpoint);
  await repository.saveToolOutcome(invocation.id, { status, outcome: result });
  if (materialized) await repository.commitToolResult(invocation.projectId, {
    id: invocation.resultEntryId!, type: "tool_result", status: "completed", runId: invocation.runId,
    turnId: invocation.turnId, toolCallId: invocation.toolCallId,
    payload: toolResultMessage({ id: invocation.toolCallId, name: invocation.toolName }, result),
  }, invocation.id);
}

async function setup(t: TestContext) {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  t.after(async () => { try { await recorder.close(); } finally { repository.close(); } });
  return { repository, recorder };
}

for (const materialized of [false, true]) {
  test(`a prior interrupted ${materialized ? "completed" : "outcome_ready"} invocation blocks planned effects after a database restart`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "tool-gates-"));
    const path = join(directory, "history.sqlite");
    let repository = new SqliteHistoryRepository(path);
    try {
      const { records } = await batch(repository);
      const first = records[0]!;
      const target = records[1]!;
      await save(repository, first, "interrupted", materialized);
      const before = (await repository.getToolInvocation(null, target.runId, target.toolCallId))!;
      repository.close();
      repository = new SqliteHistoryRepository(path);
      const recorder = await createHistoryRecorder(repository, null);
      try {
        assert.equal(await recorder.isToolInvocationBlocked(target.id), true);
        assert.equal(await repository.isToolInvocationBlocked(first.id), false);
        await assert.rejects(recorder.beginToolAttempt(target.id, checkpoint), (error: unknown) => error instanceof ToolAttemptBlockedError && error.reason === "prior_interrupted" && error.code === "conflict" && !error.retryable);
        assert.deepEqual(await repository.getToolInvocation(null, target.runId, target.toolCallId), before);
        assert.equal((await repository.listOpenToolInvocations(null)).some((record) => record.id === target.id), true);
        assert.equal(repository.database.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
      } finally { await recorder.close(); }
    } finally { repository.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const status of ["succeeded", "failed", "cancelled"] as const) {
  test(`a prior completed ${status} result leaves subsequent planned calls eligible after restart`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "tool-gates-"));
    const path = join(directory, "history.sqlite");
    let repository = new SqliteHistoryRepository(path);
    try {
      const { records } = await batch(repository);
      await save(repository, records[0]!, status, true);
      repository.close();
      repository = new SqliteHistoryRepository(path);
      assert.equal(await repository.isToolInvocationBlocked(records[1]!.id), false);
      const attempted = await repository.beginToolAttempt(records[1]!.id, checkpoint);
      assert.deepEqual([attempted.phase, attempted.attemptCount, attempted.checkpoint], ["effect_pending", 1, checkpoint]);
    } finally { repository.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

test("the transaction rechecks a prior interruption after an earlier eligible preflight", async (t) => {
  const { repository, recorder } = await setup(t);
  const { records } = await batch(repository);
  assert.equal(await recorder.isToolInvocationBlocked(records[1]!.id), false);
  await save(repository, records[0]!, "interrupted", false);
  await assert.rejects(recorder.beginToolAttempt(records[1]!.id, checkpoint), (error: unknown) => error instanceof ToolAttemptBlockedError && error.reason === "prior_interrupted");
  const target = (await repository.getToolInvocation(null, "run", records[1]!.toolCallId))!;
  assert.deepEqual([target.phase, target.attemptCount, target.checkpoint], ["planned", 0, null]);
  const otherAssistant = await batch(repository, "other-assistant");
  const otherRun = await batch(repository, "other-run-assistant", "other-run");
  assert.equal(await recorder.isToolInvocationBlocked(otherAssistant.records[1]!.id), false);
  assert.equal(await recorder.isToolInvocationBlocked(otherRun.records[1]!.id), false);
});

test("the prior-interrupted admission gate applies to planned work while existing effects retain recovery attempts", async (t) => {
  const { repository } = await setup(t);
  const { records } = await batch(repository);
  await repository.beginToolAttempt(records[1]!.id, checkpoint);
  await save(repository, records[0]!, "interrupted", true);
  assert.equal(await repository.isToolInvocationBlocked(records[1]!.id), true);
  const recovered = await repository.beginToolAttempt(records[1]!.id, checkpoint);
  assert.deepEqual([recovered.phase, recovered.attemptCount], ["effect_pending", 2]);
});

test("durable run cancellation raises the explicit blocked type and preserves the invocation", async (t) => {
  const { repository, recorder } = await setup(t);
  const { records } = await batch(repository);
  await save(repository, records[0]!, "interrupted", false);
  await recorder.requestRunCancellation("run");
  const before = (await repository.getToolInvocation(null, "run", records[1]!.toolCallId))!;
  await assert.rejects(recorder.beginToolAttempt(records[1]!.id, checkpoint), (error: unknown) => error instanceof ToolAttemptBlockedError && error instanceof RepositoryError && error.reason === "cancelled" && error.code === "conflict" && !error.retryable);
  assert.deepEqual(await repository.getToolInvocation(null, "run", records[1]!.toolCallId), before);
});

for (const legacy of [false, true]) {
  test(`invocation call validation accepts ${legacy ? "the exact legacy persisted text hash" : "the current canonical hash"} and JSON-equivalent source inputs`, async (t) => {
    const { repository, recorder } = await setup(t);
    const { calls, records } = await batch(repository);
    const target = records[0]!;
    const inputJson = JSON.stringify({ nested: { ä: 2, z: 1 }, path: "file-0.txt" });
    const inputHash = legacy
      ? createHash("sha256").update(`read\n1\n${inputJson}`, "utf8").digest("hex")
      : toolInputHash("read", "1", calls[0]!.input);
    repository.database.prepare("UPDATE tool_invocations SET input_json = ?, input_hash = ? WHERE id = ?").run(inputJson, inputHash, target.id);
    if (legacy) assert.notEqual(inputHash, toolInputHash("read", "1", calls[0]!.input));
    assert.deepEqual(await recorder.getToolInvocationCall(target.id), calls[0]);
    assert.deepEqual(await repository.getToolInvocationCall(target.id), calls[0]);
    assert.equal((await repository.getToolInvocation(null, "run", target.toolCallId))?.attemptCount, 0);
  });
}

const corruptions: Array<[string, (repository: SqliteHistoryRepository, invocation: ToolInvocationRecord) => void]> = [
  ["hash", (repository, invocation) => { repository.database.prepare("UPDATE tool_invocations SET input_hash = 'wrong' WHERE id = ?").run(invocation.id); }],
  ...["{", "null", "[]", "\"text\""].map((inputJson): [string, (repository: SqliteHistoryRepository, invocation: ToolInvocationRecord) => void] => [
    `JSON ${inputJson}`, (repository, invocation) => { repository.database.prepare("UPDATE tool_invocations SET input_json = ? WHERE id = ?").run(inputJson, invocation.id); },
  ]),
  ["missing Assistant", (repository, invocation) => { repository.database.prepare("DELETE FROM entries WHERE id = ?").run(invocation.assistantEntryId); }],
  ["Assistant status", (repository, invocation) => { repository.database.prepare("UPDATE entries SET status = 'streaming' WHERE id = ?").run(invocation.assistantEntryId); }],
  ["Assistant run", (repository, invocation) => { repository.database.prepare("UPDATE entries SET run_id = 'other-run' WHERE id = ?").run(invocation.assistantEntryId); }],
  ["Assistant turn", (repository, invocation) => { repository.database.prepare("UPDATE entries SET turn_id = 'other-turn' WHERE id = ?").run(invocation.assistantEntryId); }],
  ["Assistant JSON", (repository, invocation) => { repository.database.prepare("UPDATE entries SET payload_json = '{' WHERE id = ?").run(invocation.assistantEntryId); }],
  ["call ordinal", (repository, invocation) => { repository.database.prepare("UPDATE tool_invocations SET ordinal = 20 WHERE id = ?").run(invocation.id); }],
  ...["id", "name", "input", "inputComplete"].map((field): [string, (repository: SqliteHistoryRepository, invocation: ToolInvocationRecord) => void] => [
    `source call ${field}`, (repository, invocation) => {
      const row = repository.database.prepare("SELECT payload_json FROM entries WHERE id = ?").get(invocation.assistantEntryId)!;
      const payload = JSON.parse(String(row.payload_json));
      payload.toolCalls[invocation.ordinal][field] = field === "input" ? { path: "changed" } : field === "inputComplete" ? false : "changed";
      repository.database.prepare("UPDATE entries SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), invocation.assistantEntryId);
    },
  ]),
];

for (const [name, corrupt] of corruptions) {
  test(`corrupt ${name} rejects call validation with storage error while leaving the ledger open`, async (t) => {
    const { repository, recorder } = await setup(t);
    const { records } = await batch(repository);
    const target = records[0]!;
    corrupt(repository, target);
    const before = repository.database.prepare("SELECT * FROM tool_invocations WHERE id = ?").get(target.id);
    for (const read of [() => repository.getToolInvocationCall(target.id), () => recorder.getToolInvocationCall(target.id)]) {
      await assert.rejects(read(), (error: unknown) => error instanceof RepositoryError && error.code === "storage" && !error.retryable);
    }
    assert.deepEqual(repository.database.prepare("SELECT * FROM tool_invocations WHERE id = ?").get(target.id), before);
    const open = await repository.listOpenToolInvocations(null);
    assert.equal(open.some((invocation) => invocation.id === target.id && invocation.phase === "planned" && invocation.attemptCount === 0), true);
  });
}

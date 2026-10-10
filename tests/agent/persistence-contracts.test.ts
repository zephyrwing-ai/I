import assert from "node:assert/strict";
import test from "node:test";
import { readModelMessage } from "../../agent/model/types.js";
import { readToolResult, readToolCheckpoint } from "../../agent/tools/result.js";
import { SqliteHistoryRepository, RepositoryError } from "../../agent/memory/index.js";
import { canonicalJson, jsonEqual } from "../../agent/json.js";
import { toolInputHash } from "../../agent/tools/identity.js";

test("canonical keys use a deterministic total order for distinct Unicode spellings", () => {
  const first = { nested: { "é": 1, "e\u0301": 2, Z: 3, a: 4 } };
  const second = { nested: { a: 4, Z: 3, "e\u0301": 2, "é": 1 } };
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.ok(jsonEqual(first, second));
  assert.equal(toolInputHash("test", "1", first), toolInputHash("test", "1", second));
});

test("stored-message and tool-result decoders validate the complete public contract", () => {
  const valid = { role: "assistant", content: "", toolCalls: [{ id: "call", name: "read", input: {}, inputComplete: true }] };
  assert.deepEqual(readModelMessage(valid), valid);
  for (const message of [{ ...valid, reasoning: 1 }, { ...valid, toolCalls: [{ ...valid.toolCalls[0], input: null }] }, { ...valid, media: { mediaType: "image/png", dataUrl: false } }]) {
    assert.equal(readModelMessage(message), undefined);
  }
  const result = { ok: true, output: "done", returncode: 0, truncated: false };
  assert.deepEqual(readToolResult(result), result);
  for (const malformed of [{ ...result, returncode: "0" }, { ...result, truncated: undefined }, { ...result, media: {} }, { ...result, artifacts: [{ path: "x" }] }]) assert.equal(readToolResult(malformed), undefined);
  assert.equal(readToolCheckpoint({ version: 0, kind: "file", data: {} }), undefined);
  assert.equal(readToolCheckpoint({ version: 1, kind: "file", data: [] }), undefined);
});

test("persistence rejects invalid outcomes and checkpoints before advancing execution state", async (t) => {
  const repository = new SqliteHistoryRepository(":memory:");
  t.after(() => repository.close());
  const invocation = await repository.registerToolInvocation({ projectId: null, runId: "run", turnId: "turn", assistantEntryId: "assistant", cwd: "/tmp", toolCallId: "call", ordinal: 0, toolName: "read", toolVersion: "1", inputJson: "{}", inputHash: "hash", recoveryModeSnapshot: "safe" });
  await assert.rejects(repository.beginToolAttempt(invocation.id, { version: 1, kind: "file" }), (error: unknown) => error instanceof RepositoryError && error.code === "invalid");
  assert.deepEqual(await repository.getToolInvocation(null, "run", "call"), invocation);
  await repository.beginToolAttempt(invocation.id);
  for (const outcome of [{ status: "succeeded" as const, outcome: { ok: true } }, { status: "failed" as const, outcome: { ok: true, output: "done", returncode: 0, truncated: false } }]) {
    await assert.rejects(repository.saveToolOutcome(invocation.id, outcome), (error: unknown) => error instanceof RepositoryError && error.code === "invalid");
    assert.equal((await repository.getToolInvocation(null, "run", "call"))!.phase, "effect_pending");
  }
});

test("unsupported message payload versions fail at decode rather than entering model history", async (t) => {
  const repository = new SqliteHistoryRepository(":memory:");
  t.after(() => repository.close());
  await repository.appendEntry(null, { id: "user", type: "user_message", status: "completed", runId: "run", payload: { role: "user", content: "hello" } });
  repository.database.prepare("UPDATE entries SET payload_version = 999 WHERE id = 'user'").run();
  await assert.rejects(repository.listEntries(null), (error: unknown) => error instanceof RepositoryError && error.code === "storage");
});

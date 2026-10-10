import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../../agent/loop.js";
import { SqliteHistoryRepository, createHistoryRecorder } from "../../agent/memory/index.js";
import type { RegisterToolInvocationInput } from "../../agent/memory/types.js";
import type { ModelMessage, ModelStreamEvent, ToolCall } from "../../agent/model/types.js";
import type { RegisteredTool } from "../../agent/tools/types.js";
import { canonicalJson } from "../../agent/json.js";
import { toolInputHash } from "../../agent/tools/identity.js";
import { toolResultMessage } from "../../agent/tools/result.js";

const model = { provider: "openai" as const, model: "fake" };
const ctx = { runId: "old-run", turnId: "old-turn", turnOrdinal: 1, attempt: 1 };
const successful = { ok: true, output: "done", returncode: 0, truncated: false };

function mockTool(overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    definition: { name: "test", description: "test", parameters: { type: "object", properties: {}, required: [] } },
    recovery: { version: "1", mode: "safe" },
    execute: async () => successful,
    ...overrides,
  };
}

function calls(count = 1): ToolCall[] {
  return Array.from({ length: count }, (_, index) => ({ id: `call-${index}`, name: "test", input: {}, inputComplete: true }));
}

function plan(batch: ToolCall[], recoveryModeSnapshot: RegisterToolInvocationInput["recoveryModeSnapshot"] = "safe"): Omit<RegisterToolInvocationInput, "assistantEntryId">[] {
  return batch.map((call, ordinal) => ({ ...ctx, cwd: process.cwd(), toolCallId: call.id, ordinal, toolName: call.name, toolVersion: "1", inputJson: canonicalJson(call.input), inputHash: toolInputHash(call.name, "1", call.input), recoveryModeSnapshot, checkpoint: { version: 1, kind: "evidence", data: { ordinal } } }));
}

const answer = async function* (_config: unknown, messages: ModelMessage[]): AsyncGenerator<ModelStreamEvent> {
  const assistant = messages.find((message) => message.role === "assistant" && message.toolCalls?.length);
  if (assistant) {
    const results = messages.filter((message) => message.role === "tool");
    assert.deepEqual(results.map((message) => message.toolCallId), assistant.toolCalls!.map((call) => call.id));
  }
  yield { type: "completed", content: "answer", toolCalls: [], stopReason: "stop" };
};

test("Stop settles an entire unstarted batch and the next run never executes it", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const controller = new AbortController();
  let executions = 0;
  const tools = new Map([["test", mockTool({ execute: async () => { executions += 1; return successful; } })]]);
  const batch = calls(2);
  const result = await run("task", model, {
    runId: ctx.runId, cwd: process.cwd(), systemPrompt: "", tools, recorder, signal: controller.signal,
    responseImpl: async function* () { yield { type: "completed", content: "", toolCalls: batch, stopReason: "tool_use" }; },
  }, { onAssistantCompleted: () => controller.abort() });
  assert.equal(result.status, "cancelled");
  assert.equal(await repository.isRunCancelled(null, ctx.runId), true);
  for (const call of batch) {
    const invocation = (await repository.getToolInvocation(null, ctx.runId, call.id))!;
    assert.deepEqual([invocation.phase, invocation.outcomeStatus, invocation.attemptCount], ["completed", "cancelled", 0]);
    assert.equal((await repository.getEntry(invocation.resultEntryId!))?.payload.toolCallId, call.id);
  }
  assert.equal((await run("next", model, { runId: "next", cwd: process.cwd(), systemPrompt: "", tools, recorder, responseImpl: answer })).status, "completed");
  assert.equal(executions, 0);
  await recorder.close();
  repository.close();
});

test("Stop preserves a definite completed outcome while cancelling later unstarted calls", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const controller = new AbortController();
  let executions = 0;
  const tools = new Map([["test", mockTool({ execute: async () => { executions += 1; controller.abort(); return successful; } })]]);
  const result = await run("task", model, {
    runId: ctx.runId, cwd: process.cwd(), systemPrompt: "", tools, recorder, signal: controller.signal,
    responseImpl: async function* () { yield { type: "completed", content: "", toolCalls: calls(2), stopReason: "tool_use" }; },
  });
  assert.equal(result.status, "cancelled");
  assert.equal((await repository.getToolInvocation(null, ctx.runId, "call-0"))?.outcomeStatus, "succeeded");
  assert.equal((await repository.getToolInvocation(null, ctx.runId, "call-1"))?.outcomeStatus, "cancelled");
  assert.equal((await run("next", model, { runId: "next", cwd: process.cwd(), systemPrompt: "", tools, recorder, responseImpl: answer })).status, "completed");
  assert.equal(executions, 1);
  await recorder.close();
  repository.close();
});

test("durable Stop survives a crash before settlement and prevents execute and reconcile", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const first = await createHistoryRecorder(repository, null);
  const batch = calls(3);
  const records = await first.finishAssistantAttempt(ctx, "completed", { role: "assistant", content: "", toolCalls: batch }, plan(batch, "reconcile"));
  await first.beginToolAttempt(records[0]!.id, records[0]!.checkpoint);
  await first.beginToolAttempt(records[1]!.id, records[1]!.checkpoint);
  await first.saveToolOutcome(records[1]!.id, { status: "succeeded", outcome: successful });
  await first.requestRunCancellation(ctx.runId);
  // No finishRun: recreating the recorder represents restart after Stop's commit.
  await first.close();
  const recorder = await createHistoryRecorder(repository, null);
  let executions = 0;
  let reconciliations = 0;
  const tools = new Map([["test", mockTool({
    execute: async () => { executions += 1; return successful; },
    recovery: { version: "1", mode: "reconcile", reconcile: async () => { reconciliations += 1; return { kind: "retry", reason: "not published" }; } },
  })]]);
  assert.equal((await run("next", model, { runId: "next", cwd: process.cwd(), systemPrompt: "", tools, recorder, responseImpl: answer })).status, "completed");
  const restored = await Promise.all(batch.map((call) => repository.getToolInvocation(null, ctx.runId, call.id)));
  assert.deepEqual(restored.map((record) => [record!.phase, record!.outcomeStatus, record!.attemptCount]), [
    ["completed", "interrupted", 1], ["completed", "succeeded", 1], ["completed", "cancelled", 0],
  ]);
  assert.deepEqual(restored[0]!.checkpoint, records[0]!.checkpoint);
  assert.deepEqual([executions, reconciliations], [0, 0]);
  await recorder.close();
  repository.close();
});

test("a planned Canvas call settles without a fake attempt and does not block the next model request", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const batch = [{ ...calls()[0]!, name: "canvas_edit" }];
  const records = await recorder.finishAssistantAttempt(ctx, "completed", { role: "assistant", content: "", toolCalls: batch }, plan(batch, "never"));
  let executions = 0;
  const tools = new Map([["canvas_edit", mockTool({ recovery: { version: "1", mode: "never", resumePlanned: false }, execute: async () => { executions += 1; return successful; } })]]);
  assert.equal((await run("next", model, { runId: "next", cwd: process.cwd(), systemPrompt: "", tools, recorder, responseImpl: answer })).status, "completed");
  const restored = (await repository.getToolInvocation(null, ctx.runId, batch[0]!.id))!;
  assert.deepEqual([restored.phase, restored.outcomeStatus, restored.attemptCount, executions], ["completed", "interrupted", 0, 0]);
  assert.equal(restored.id, records[0]!.id);
  assert.deepEqual(await recorder.listOpenToolInvocations(), []);
  await recorder.close();
  repository.close();
});

test("Stop during reconciliation prevents replay and persists cancellation for the recovered batch", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const batch = calls(2);
  const records = await recorder.finishAssistantAttempt(ctx, "completed", { role: "assistant", content: "", toolCalls: batch }, plan(batch, "reconcile"));
  await recorder.beginToolAttempt(records[0]!.id);
  const controller = new AbortController();
  let executions = 0;
  const tools = new Map([["test", mockTool({
    execute: async () => { executions += 1; return successful; },
    recovery: { version: "1", mode: "reconcile", reconcile: async () => { controller.abort(); return { kind: "retry", reason: "not published" }; } },
  })]]);
  const result = await run("next", model, { runId: "next", cwd: process.cwd(), systemPrompt: "", tools, recorder, signal: controller.signal, responseImpl: answer });
  assert.equal(result.status, "cancelled");
  assert.equal(await repository.isRunCancelled(null, ctx.runId), true);
  assert.equal((await repository.getToolInvocation(null, ctx.runId, "call-0"))?.attemptCount, 1);
  assert.equal((await repository.getToolInvocation(null, ctx.runId, "call-1"))?.attemptCount, 0);
  assert.equal(executions, 0);
  await recorder.close();
  repository.close();
});

test("an uncertain earlier call settles dependent planned calls without executing them", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const batch = calls(2);
  const records = await recorder.finishAssistantAttempt(ctx, "completed", { role: "assistant", content: "", toolCalls: batch }, plan(batch, "never"));
  await recorder.beginToolAttempt(records[0]!.id);
  let executions = 0;
  const tools = new Map([["test", mockTool({ recovery: { version: "1", mode: "never" }, execute: async () => { executions += 1; return successful; } })]]);
  assert.equal((await run("next", model, { runId: "next", cwd: process.cwd(), systemPrompt: "", tools, recorder, responseImpl: answer })).status, "completed");
  assert.equal((await repository.getToolInvocation(null, ctx.runId, "call-1"))?.attemptCount, 0);
  assert.equal(executions, 0);
  await recorder.close();
  repository.close();
});

test("per-attempt preparation failure preserves the full batch and settles without a fake attempt", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  let preparations = 0;
  let executions = 0;
  let requests = 0;
  const tools = new Map([["test", mockTool({ prepare: async () => {
    preparations += 1;
    if (preparations === 2) throw new Error("checkpoint failed");
    return { kind: "ready", execute: async () => { executions += 1; return successful; } };
  } })]]);
  const result = await run("task", model, {
    runId: ctx.runId, cwd: process.cwd(), systemPrompt: "", tools, recorder,
    responseImpl: async function* () {
      requests += 1;
      yield { type: "completed", content: requests === 1 ? "" : "done", toolCalls: requests === 1 ? calls(2) : [], stopReason: requests === 1 ? "tool_use" : "stop" };
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual([preparations, executions], [2, 1]);
  assert.deepEqual(await repository.listOpenToolInvocations(null), []);
  assert.equal(recorder.snapshot().some((message) => message.role === "assistant" && message.toolCalls?.length === 2), true);
  const second = (await repository.getToolInvocation(null, ctx.runId, "call-1"))!;
  assert.deepEqual([second.phase, second.attemptCount, second.outcomeStatus], ["completed", 0, "failed"]);
  assert.match((await repository.getEntry(second.resultEntryId!))!.payload.content, /checkpoint failed/);
  await recorder.close();
  repository.close();
});

test("an old effect_pending call without cwd never uses the new run directory", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const batch = calls();
  const records = await recorder.finishAssistantAttempt(ctx, "completed", { role: "assistant", content: "", toolCalls: batch }, plan(batch));
  await recorder.beginToolAttempt(records[0]!.id);
  repository.database.prepare("UPDATE tool_invocations SET cwd = '' WHERE id = ?").run(records[0]!.id);
  let executions = 0;
  const tools = new Map([["test", mockTool({ execute: async () => { executions += 1; return successful; } })]]);
  assert.equal((await run("next", model, { runId: "next", cwd: "/new-project", systemPrompt: "", tools, recorder, responseImpl: answer })).status, "completed");
  assert.equal((await repository.getToolInvocation(null, ctx.runId, batch[0]!.id))?.outcomeStatus, "interrupted");
  assert.equal(executions, 0);
  await recorder.close();
  repository.close();
});

test("online uncertain results settle later planned calls without executing them", async (t) => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  t.after(async () => { await recorder.close(); repository.close(); });
  let executions = 0;
  let requests = 0;
  const tools = new Map([["test", mockTool({ execute: async () => {
    executions += 1;
    return { ok: false, output: "unknown effect", returncode: -1, truncated: false, error: "interrupted" };
  } })]]);
  const result = await run("task", model, {
    runId: ctx.runId, cwd: process.cwd(), systemPrompt: "", tools, recorder,
    responseImpl: async function* () {
      requests += 1;
      yield { type: "completed", content: requests === 1 ? "" : "done", toolCalls: requests === 1 ? calls(2) : [], stopReason: requests === 1 ? "tool_use" : "stop" };
    },
  });
  assert.equal(result.status, "completed", result.error?.message);
  assert.equal(executions, 1);
  const second = (await repository.getToolInvocation(null, ctx.runId, "call-1"))!;
  assert.deepEqual([second.phase, second.outcomeStatus, second.attemptCount], ["completed", "interrupted", 0]);
});

test("a completed uncertain predecessor continues blocking planned calls after restart", async (t) => {
  const repository = new SqliteHistoryRepository(":memory:");
  const first = await createHistoryRecorder(repository, null);
  const batch = calls(2);
  const records = await first.finishAssistantAttempt(ctx, "completed", { role: "assistant", content: "", toolCalls: batch }, plan(batch));
  await first.beginToolAttempt(records[0]!.id);
  const result = { ok: false, output: "unknown effect", returncode: -1, truncated: false, error: "interrupted" };
  await first.saveToolOutcome(records[0]!.id, { status: "interrupted", outcome: result });
  await first.commitToolResult(toolResultMessage(batch[0]!, result), { ...ctx, toolCallId: batch[0]!.id, entryId: records[0]!.resultEntryId!, invocationId: records[0]!.id });
  await first.close();
  const recorder = await createHistoryRecorder(repository, null);
  t.after(async () => { await recorder.close(); repository.close(); });
  let executions = 0;
  const restored = await run("next", model, { runId: "next", cwd: process.cwd(), systemPrompt: "", recorder, responseImpl: answer, tools: new Map([["test", mockTool({ execute: async () => { executions += 1; return successful; } })]]) });
  assert.equal(restored.status, "completed", restored.error?.message);
  assert.equal(executions, 0);
  assert.deepEqual([(await repository.getToolInvocation(null, ctx.runId, "call-1"))!.attemptCount, (await repository.getToolInvocation(null, ctx.runId, "call-1"))!.outcomeStatus], [0, "interrupted"]);
});

test("Stop racing with execution intent is a cancelled run and settles the entire batch", async (t) => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  t.after(async () => { await recorder.close(); repository.close(); });
  const controller = new AbortController();
  const begin = repository.beginToolAttempt.bind(repository);
  repository.beginToolAttempt = async (...args) => {
    await repository.requestRunCancellation(null, ctx.runId);
    controller.abort();
    return begin(...args);
  };
  let executions = 0;
  const result = await run("task", model, {
    runId: ctx.runId, cwd: process.cwd(), systemPrompt: "", recorder, signal: controller.signal,
    tools: new Map([["test", mockTool({ execute: async () => { executions += 1; return successful; } })]]),
    responseImpl: async function* () { yield { type: "completed", content: "", toolCalls: calls(2), stopReason: "tool_use" }; },
  });
  assert.equal(result.status, "cancelled", result.error?.message);
  assert.equal(executions, 0);
  for (const call of calls(2)) {
    const invocation = (await repository.getToolInvocation(null, ctx.runId, call.id))!;
    assert.deepEqual([invocation.phase, invocation.outcomeStatus, invocation.attemptCount], ["completed", "cancelled", 0]);
  }
});

for (const inputJson of ['{"changed":true}', "null", "{"]) {
  test(`damaged invocation input ${inputJson} fails before execute, reconcile and model requests`, async (t) => {
    const repository = new SqliteHistoryRepository(":memory:");
    const first = await createHistoryRecorder(repository, null);
    const batch = calls();
    const [invocation] = await first.finishAssistantAttempt(ctx, "completed", { role: "assistant", content: "", toolCalls: batch }, plan(batch, "reconcile"));
    await first.beginToolAttempt(invocation!.id, invocation!.checkpoint);
    await first.close();
    repository.database.prepare("UPDATE tool_invocations SET input_json = ? WHERE id = ?").run(inputJson, invocation!.id);
    const recorder = await createHistoryRecorder(repository, null);
    t.after(async () => { await recorder.close(); repository.close(); });
    let operations = 0;
    const result = await run("next", model, {
      runId: "next", cwd: process.cwd(), systemPrompt: "", recorder,
      tools: new Map([["test", mockTool({ execute: async () => { operations += 1; return successful; }, recovery: { version: "1", mode: "reconcile", reconcile: async () => { operations += 1; return { kind: "retry", reason: "before" }; } } })]]),
      responseImpl: async function* () { operations += 1; yield { type: "completed", content: "done", toolCalls: [], stopReason: "stop" }; },
    });
    assert.equal(result.status, "failed");
    assert.equal(operations, 0);
    assert.equal((await repository.getToolInvocation(null, ctx.runId, batch[0]!.id))!.phase, "effect_pending");
  });
}

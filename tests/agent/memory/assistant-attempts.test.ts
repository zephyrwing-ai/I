import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { jsonEqual } from "../../../agent/json.js";
import { createHistoryRecorder, createTransientHistoryRecorder, DefaultHistoryRecorder } from "../../../agent/memory/session-recorder.js";
import { SqliteHistoryRepository } from "../../../agent/memory/sqlite-repository.js";
import { RepositoryError, type ToolInvocationPlan } from "../../../agent/memory/types.js";
import type { ModelMessage } from "../../../agent/model/types.js";

const context = { runId: "run", turnId: "turn", turnOrdinal: 1, attempt: 1, entryId: "assistant", createdAt: 1_000, completedAt: 2_000 };
const call = { id: "call", name: "read", input: { path: "a.txt" }, inputComplete: true };
const plan: ToolInvocationPlan = {
  runId: "run", turnId: "turn", cwd: "/tmp", toolCallId: "call", ordinal: 0,
  toolName: "read", toolVersion: "1", inputJson: JSON.stringify(call.input), inputHash: "hash",
  recoveryModeSnapshot: "safe", resultEntryId: "result",
};

async function setup(t: TestContext) {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  t.after(async () => { try { await recorder.close(); } finally { repository.close(); } });
  return { repository, recorder };
}

test("JSON comparisons follow persisted undefined, object order, array order and null semantics", () => {
  assert.ok(jsonEqual({ b: 2, a: 1, missing: undefined }, { a: 1, b: 2 }));
  assert.ok(jsonEqual({ array: [undefined, { omitted: undefined }] }, { array: [null, {}] }));
  assert.ok(!jsonEqual({ value: null }, {}));
  assert.ok(!jsonEqual({ array: [1, 2] }, { array: [2, 1] }));
});

test("Recorder normalizes and validates cloned messages before entering its write queue", async (t) => {
  const { repository, recorder } = await setup(t);
  const malformed = JSON.parse('{"role":"assistant","content":"done","reasoning":null}');
  await assert.rejects(recorder.finishAssistantAttempt(context, "completed", malformed), (error: unknown) => error instanceof RepositoryError && error.code === "storage");
  const circular: ModelMessage = { role: "assistant", content: "done" };
  Object.assign(circular, { circular });
  await assert.rejects(recorder.finishAssistantAttempt(context, "completed", circular), (error: unknown) => error instanceof RepositoryError && error.code === "storage" && error.cause instanceof TypeError);
  assert.deepEqual(await repository.listEntries(null), []);
  assert.deepEqual(recorder.snapshot(), []);
  await recorder.finishAssistantAttempt(context, "completed", { role: "assistant", content: "done", reasoning: undefined });
  assert.deepEqual(recorder.snapshot(), [{ role: "assistant", content: "done" }]);
});

test("Assistant retries reuse JSON-equivalent messages and plans while preserving explicit null", async (t) => {
  const { repository, recorder } = await setup(t);
  const input = { second: [undefined, { b: 2, a: 1 }], first: null, omitted: undefined };
  const message: ModelMessage = { role: "assistant", content: "", reasoning: undefined, toolCalls: [{ ...call, input }] };
  const plans = [{ ...plan, inputJson: JSON.stringify(input), checkpoint: undefined }];
  const first = await recorder.finishAssistantAttempt(context, "completed", message, plans);
  const normalized: ModelMessage = {
    toolCalls: [{ ...call, input: { first: null, second: [null, { a: 1, b: 2 }] } }], content: "", role: "assistant",
  };
  const second = await recorder.finishAssistantAttempt({ ...context, completedAt: 9_000 }, "completed", normalized, plans);
  assert.deepEqual(first, second);
  assert.equal((await repository.listEntries(null)).length, 1);
  assert.equal(recorder.snapshot().length, 1);
  await assert.rejects(recorder.finishAssistantAttempt(context, "completed", {
    ...normalized, toolCalls: [{ ...call, input: { second: [null, { a: 1, b: 2 }] } }],
  }, plans), (error: unknown) => error instanceof RepositoryError && error.code === "conflict");
});

for (const withTools of [false, true]) {
  test(`${withTools ? "tool-call" : "ordinary"} Assistant retries preserve draft identity and lifecycle times`, async (t) => {
    const { repository, recorder } = await setup(t);
    const message: ModelMessage = { role: "assistant", content: "done", ...(withTools ? { toolCalls: [call] } : {}) };
    recorder.recordAssistantDelta("text", "draft".repeat(1000), context);
    await nextTick();
    const draft = (await repository.getEntry(context.entryId))!;
    assert.deepEqual([draft.status, draft.createdAt, draft.completedAt], ["streaming", 1_000, null]);
    const commit = repository.commitAssistantAttempt.bind(repository);
    const attempts: Array<[string, number | undefined, number | null | undefined, number | null]> = [];
    t.mock.method(repository, "commitAssistantAttempt", async (...args: Parameters<typeof commit>) => {
      const { entry, expectedRevision } = args[1];
      attempts.push([entry.id, entry.createdAt, entry.completedAt, expectedRevision]);
      assert.deepEqual(recorder.snapshot(), []);
      if (attempts.length === 1) throw new RepositoryError("busy", "storage", { retryable: true });
      return commit(...args);
    });
    await assert.rejects(recorder.finishAssistantAttempt(context, "completed", message, withTools ? [plan] : []), /busy/);
    assert.deepEqual(await repository.listOpenToolInvocations(null), []);
    const records = await recorder.finishAssistantAttempt({ ...context, createdAt: 8_000, completedAt: 9_000 }, "completed", message, withTools ? [plan] : []);
    assert.deepEqual(attempts, [["assistant", 1_000, 2_000, draft.revision], ["assistant", 1_000, 2_000, draft.revision]]);
    assert.equal(records.length, withTools ? 1 : 0);
    assert.deepEqual(recorder.snapshot(), [message]);
    const entry = (await repository.getEntry("assistant"))!;
    assert.deepEqual([entry.runId, entry.turnId, entry.createdAt, entry.completedAt, entry.revision], ["run", "turn", 1_000, 2_000, draft.revision + 1]);
    t.mock.restoreAll();
    await recorder.finishAssistantAttempt(context, "completed", message, withTools ? [plan] : []);
    assert.equal((await repository.listEntries(null)).length, 1);
  });
}

test("successful terminal retry clears the same attempt's background draft failure", async (t) => {
  const { repository, recorder } = await setup(t);
  const append = repository.appendEntry.bind(repository);
  t.mock.method(repository, "appendEntry", async (...args: Parameters<typeof append>) => {
    if (args[1].status === "streaming") throw new RepositoryError("draft failed", "storage");
    return append(...args);
  });
  recorder.recordAssistantDelta("text", "x".repeat(4096), context);
  await nextTick();
  assert.equal(await repository.getEntry("assistant"), null);
  await recorder.finishAssistantAttempt(context, "completed", { role: "assistant", content: "done" });
  await recorder.finishRun({ runId: "run", status: "completed" });
  assert.deepEqual(recorder.snapshot(), [{ role: "assistant", content: "done" }]);
});

test("concurrent terminal commits serialize before publishing one immutable snapshot", async (t) => {
  const { repository, recorder } = await setup(t);
  const commit = repository.commitAssistantAttempt.bind(repository);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(repository, "commitAssistantAttempt", async (...args: Parameters<typeof commit>) => {
    started(); await gate; return commit(...args);
  });
  const message: ModelMessage = { role: "assistant", content: "done", toolCalls: [call] };
  const first = recorder.finishAssistantAttempt(context, "completed", message, [plan]);
  const second = recorder.finishAssistantAttempt(context, "completed", message, [plan]);
  await entered;
  assert.deepEqual(recorder.snapshot(), []);
  assert.deepEqual(await repository.listEntries(null), []);
  assert.deepEqual(await repository.listOpenToolInvocations(null), []);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.equal((await repository.listEntries(null)).length, 1);
  assert.deepEqual(recorder.snapshot(), [message]);
  const snapshot = recorder.snapshot();
  snapshot[0]!.toolCalls![0]!.input.path = "changed";
  assert.equal(recorder.snapshot()[0]!.toolCalls![0]!.input.path, "a.txt");
});

for (const trigger of ["bytes", "timer"]) {
  test(`draft coalescing retains the ${trigger === "bytes" ? "4096 UTF-8 byte" : "500ms"} boundary`, async (t) => {
    const { repository, recorder } = await setup(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    recorder.recordAssistantDelta("text", trigger === "bytes" ? "中".repeat(1365) : "text", context);
    await nextTick();
    assert.deepEqual(await repository.listEntries(null), []);
    if (trigger === "bytes") recorder.recordAssistantDelta("text", "a", context);
    else {
      t.mock.timers.tick(499);
      await nextTick();
      assert.deepEqual(await repository.listEntries(null), []);
      t.mock.timers.tick(1);
    }
    await nextTick();
    assert.equal((await repository.getEntry("assistant"))?.status, "streaming");
    assert.deepEqual(recorder.snapshot(), []);
    await recorder.finishAssistantAttempt(context, "interrupted");
  });
}

test("a delta arriving during a draft write remains in the terminal commit", async (t) => {
  const { repository, recorder } = await setup(t);
  const append = repository.appendEntry.bind(repository);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(repository, "appendEntry", async (...args: Parameters<typeof append>) => { started(); await gate; return append(...args); });
  recorder.recordAssistantDelta("text", "x".repeat(4096), context);
  await entered;
  recorder.recordAssistantDelta("text", "tail", context);
  const finish = recorder.finishAssistantAttempt(context, "completed");
  release();
  await finish;
  assert.equal((await repository.getEntry("assistant"))?.payload.content, `${"x".repeat(4096)}tail`);
  assert.equal(recorder.snapshot().length, 1);
});

test("an already queued delayed draft stays streaming until the full Assistant plan commits atomically", async (t) => {
  const { repository, recorder } = await setup(t);
  const append = repository.appendEntry.bind(repository);
  const commit = repository.commitAssistantAttempt.bind(repository);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const draftStatuses: string[] = [];
  t.mock.method(repository, "appendEntry", async (...args: Parameters<typeof append>) => {
    if (args[1].type === "user_message") { started(); await gate; }
    else draftStatuses.push(args[1].status);
    return append(...args);
  });
  t.mock.method(repository, "commitAssistantAttempt", async (...args: Parameters<typeof commit>) => {
    const draft = (await repository.getEntry("assistant"))!;
    assert.deepEqual([draft.status, draft.completedAt], ["streaming", null]);
    assert.deepEqual(await repository.listOpenToolInvocations(null), []);
    assert.deepEqual(recorder.snapshot().map((message) => message.role), ["user"]);
    return commit(...args);
  });
  const user = recorder.commitUser({ role: "user", content: "task" }, { runId: "run", entryId: "user" });
  await entered;
  recorder.recordAssistantDelta("text", "draft".repeat(1000), context);
  const finish = recorder.finishAssistantAttempt(context, "completed", { role: "assistant", content: "", toolCalls: [call] }, [plan]);
  recorder.recordAssistantDelta("text", "late".repeat(1100), context);
  release();
  const [, records] = await Promise.all([user, finish]);
  assert.deepEqual(draftStatuses, ["streaming"]);
  assert.equal(records.length, 1);
  assert.equal((await repository.getEntry("assistant"))?.status, "completed");
  assert.equal((await repository.listEntries(null)).length, 2);
  assert.deepEqual(recorder.snapshot().map((message) => message.role), ["user", "assistant"]);
});

test("concurrent run settlement leaves a successful queued Assistant commit intact", async (t) => {
  const { repository, recorder } = await setup(t);
  const commit = repository.commitAssistantAttempt.bind(repository);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(repository, "commitAssistantAttempt", async (...args: Parameters<typeof commit>) => { started(); await gate; return commit(...args); });
  recorder.recordAssistantDelta("text", "partial", context);
  const finish = recorder.finishAssistantAttempt(context, "completed", { role: "assistant", content: "done" });
  await entered;
  const settle = recorder.finishRun({ runId: "run", status: "failed" });
  release();
  await Promise.all([finish, settle]);
  assert.equal((await repository.getEntry("assistant"))?.status, "completed");
  assert.deepEqual(recorder.snapshot(), [{ role: "assistant", content: "done" }]);
});

test("attempt identities reject changes and preserve interrupted attempts alongside a completed retry", async (t) => {
  const { repository, recorder } = await setup(t);
  recorder.recordAssistantDelta("text", "partial", context);
  for (const changed of [{ runId: "other" }, { turnOrdinal: 2 }, { entryId: "other" }]) {
    await assert.rejects(recorder.finishAssistantAttempt({ ...context, ...changed }, "completed", { role: "assistant", content: "bad" }), (error: unknown) => error instanceof RepositoryError && error.code === "conflict");
  }
  await recorder.finishAssistantAttempt(context, "interrupted");
  await recorder.finishAssistantAttempt(context, "interrupted");
  await recorder.finishAssistantAttempt({ ...context, entryId: "second", attempt: 2 }, "completed", { role: "assistant", content: "done" });
  assert.deepEqual((await repository.listEntries(null)).map((entry) => [entry.id, entry.status]), [["assistant", "interrupted"], ["second", "completed"]]);
  assert.deepEqual(recorder.snapshot(), [{ role: "assistant", content: "done" }]);
});

test("restored completed Assistant reuses its original entry and scope", async (t) => {
  const { repository, recorder } = await setup(t);
  const message: ModelMessage = { role: "assistant", content: "done", toolCalls: [call] };
  const records = await recorder.finishAssistantAttempt(context, "completed", message, [plan]);
  await recorder.close();
  const restored = await createHistoryRecorder(repository, null);
  t.after(() => restored.close());
  const retry = await restored.finishAssistantAttempt({ ...context, entryId: undefined, completedAt: 9_000 }, "completed", message, [plan]);
  assert.deepEqual(retry, records);
  assert.equal((await repository.getEntry("assistant"))?.completedAt, 2_000);
  await assert.rejects(restored.finishAssistantAttempt({ ...context, runId: "wrong" }, "completed", message, [plan]), (error: unknown) => error instanceof RepositoryError && error.code === "conflict");
  const entry = (await repository.getEntry("assistant"))!;
  assert.throws(() => new DefaultHistoryRecorder("other-project", repository, [entry]), RepositoryError);
});

test("transient historical imports preserve tool-call history while live commits validate the complete plan", async () => {
  const history: ModelMessage[] = [
    { role: "user", content: "task" },
    { role: "assistant", content: "", toolCalls: [call] },
    { role: "tool", toolCallId: "call", toolName: "read", content: "historical result" },
    { role: "assistant", content: "done" },
  ];
  const recorder = await createTransientHistoryRecorder(history);
  try {
    assert.deepEqual(recorder.snapshot(), history);
    await assert.rejects(recorder.finishAssistantAttempt(context, "completed", history[1]!), (error: unknown) => error instanceof RepositoryError && error.code === "invalid");
    assert.deepEqual(recorder.snapshot(), history);
  } finally { await recorder.close(); }
});

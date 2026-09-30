import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryRecorder, PendingRunInput } from "../../../agent/memory/types.js";
import { createHistoryRecorder, SqliteHistoryRepository } from "../../../agent/memory/index.js";
import { RunInputInbox } from "../../../shell/main/run-input-inbox.js";

test("run inbox accepts two inputs in durable order and abandons an unapplied tail", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const inbox = new RunInputInbox("inbox-run", null, recorder);

  const first = await inbox.accept("input-one", "第一条");
  const second = await inbox.accept("input-two", "第二条");
  assert.equal((await inbox.accept("input-one", "第一条")).inputId, first.inputId);
  assert.ok(first.acceptOrder < second.acceptOrder);
  assert.deepEqual((await inbox.takePending()).map((input) => input.inputId), ["input-one", "input-two"]);
  assert.deepEqual(await inbox.closeAndAbandon("cancelled"), ["input-one", "input-two"]);
  assert.deepEqual((await repository.listEntries(null)).map((entry) => entry.status), ["interrupted", "interrupted"]);
  await assert.rejects(inbox.accept("input-three", "第三条"), /finishing/);

  await recorder.close();
  repository.close();
});

test("completion gate waits for admissions already in flight before deciding to finish", async () => {
  let release: (() => void) | undefined;
  const persistence = new Promise<void>((resolve) => { release = resolve; });
  const record: PendingRunInput = {
    inputId: "racing-input",
    projectId: null,
    runId: "race-run",
    content: "补充",
    acceptOrder: 1,
    state: "accepted",
    acceptedAt: 1,
    appliedAt: null,
    terminalReason: null,
  };
  const recorder = {
    acceptRunInput: async () => { await persistence; return record; },
    abandonRunInputs: async () => [],
  } as unknown as HistoryRecorder;
  const inbox = new RunInputInbox("race-run", null, recorder);

  const ack = inbox.accept(record.inputId, record.content);
  const boundary = inbox.takePendingOrSeal();
  release?.();
  assert.equal((await ack).inputId, record.inputId);
  assert.deepEqual(await boundary, [{ inputId: record.inputId, content: record.content }]);
  assert.deepEqual(await inbox.takePendingOrSeal(), []);
  await assert.rejects(inbox.accept("late-input", "稍后的补充"), /finishing/);
});

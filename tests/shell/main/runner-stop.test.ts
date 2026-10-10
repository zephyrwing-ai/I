import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../../../agent/loop.js";
import { SqliteHistoryRepository, createHistoryRecorder } from "../../../agent/memory/index.js";
import { AgentRunner, type ResolvedRunRequest } from "../../../shell/main/runner.js";
import type { AgentEvent } from "../../../shell/shared/ipc.js";

function request(historyRecorder: ResolvedRunRequest["historyRecorder"]): ResolvedRunRequest {
  return {
    runId: "stopped-run", initialUserEntryId: "accepted-task", initialUserCreatedAt: 1_234, task: "never execute", cwd: process.cwd(), projectId: null,
    projectContextVersion: null, historyRecorder, modelOptionId: "fake-model", providerProfileId: "fake-provider",
    provider: "openai", modelId: "fake", getApiKey: async () => { throw new Error("The stopped run must not request an API key."); },
  };
}

test("Main persists Stop before the deferred runtime starts and completes as cancelled", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const runner = new AgentRunner();
  let resolveCompleted!: (event: Extract<AgentEvent, { type: "runCompleted" }>) => void;
  const completed = new Promise<Extract<AgentEvent, { type: "runCompleted" }>>((resolve) => { resolveCompleted = resolve; });
  const handle = runner.start(request(recorder), (event) => { if (event.type === "runCompleted") resolveCompleted(event); });
  handle.stop();
  assert.equal(await repository.isRunCancelled(null, handle.runId), true);
  const terminal = await completed;
  assert.equal(terminal.status, "cancelled");
  assert.deepEqual(terminal.unappliedInputIds, ["accepted-task"]);
  assert.equal(runner.isActive, false);
  const archived = await repository.getEntry("accepted-task");
  assert.equal(archived?.payload.content, "never execute");
  assert.equal(archived?.status, "interrupted");
  assert.equal(archived?.createdAt, 1_234);
  assert.equal(archived?.completedAt, null);
  assert.deepEqual(recorder.snapshot(), []);
  await recorder.close();
  const restored = await createHistoryRecorder(repository, null);
  assert.deepEqual(restored.snapshot(), []);
  const next = await run("next task", { provider: "openai", model: "fake" }, {
    runId: "next", cwd: process.cwd(), systemPrompt: "", tools: new Map(), recorder: restored,
    responseImpl: async function* (_config, messages) {
      assert.deepEqual(messages.map((message) => message.content), ["next task"]);
      yield { type: "completed", content: "answer", toolCalls: [], stopReason: "stop" };
    },
  });
  assert.equal(next.status, "completed");
  await restored.close();
  repository.close();
});

test("Main aborts on Stop persistence failure and reports it through run completion", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  recorder.requestRunCancellation = () => Promise.reject(new Error("Stop could not be persisted"));
  const runner = new AgentRunner();
  let resolveCompleted!: (event: Extract<AgentEvent, { type: "runCompleted" }>) => void;
  const completed = new Promise<Extract<AgentEvent, { type: "runCompleted" }>>((resolve) => { resolveCompleted = resolve; });
  const handle = runner.start(request(recorder), (event) => { if (event.type === "runCompleted") resolveCompleted(event); });
  assert.doesNotThrow(() => handle.stop());
  const event = await completed;
  assert.equal(event.status, "failed");
  assert.match(event.error!.message, /Stop could not be persisted/);
  assert.equal(runner.isActive, false);
  await recorder.close();
  repository.close();
});

import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../../../agent/loop.js";
import { createHistoryRecorder, SqliteHistoryRepository } from "../../../agent/memory/index.js";
import { RepositoryError } from "../../../agent/memory/types.js";
import { ModelAdapterError, type ModelMessage, type ModelStreamEvent } from "../../../agent/model/types.js";
import type { ModelConfig } from "../../../agent/model/index.js";

const model: ModelConfig = {
  provider: "openai", model: "context-fixture",
  context: { windowTokens: 4096, outputReserveTokens: 256, safetyTokens: 128, growthTokens: 500, recentTokens: 256, summaryTokens: 128 },
};
const system = "Continue the current task.";

async function setup() {
  const repository = new SqliteHistoryRepository(":memory:");
  for (let index = 0; index < 6; index += 1) {
    await repository.appendEntry(null, {
      id: `old-${index}`, runId: `old-run-${Math.floor(index / 2)}`,
      type: index % 2 ? "assistant_message" : "user_message", status: "completed",
      payload: { role: index % 2 ? "assistant" : "user", content: `old-${index}:` + "history ".repeat(80) },
    });
  }
  const recorder = await createHistoryRecorder(repository, null);
  return { repository, recorder };
}

test("Runtime reuses a saved summary across runs while original records and UI replies remain intact", async () => {
  const { repository, recorder } = await setup();
  let summaries = 0;
  const requests: ModelMessage[][] = [];
  const visible: string[] = [];
  const responseImpl = async function* (_config: ModelConfig, messages: ModelMessage[], prompt: string): AsyncGenerator<ModelStreamEvent> {
    if (prompt !== system) {
      summaries += 1;
      yield { type: "text_delta", delta: "private continuity summary" };
      yield { type: "completed", content: "Goal: continue. Evidence: old-0 through old-5.", toolCalls: [], stopReason: "stop" };
      return;
    }
    requests.push(structuredClone(messages));
    yield { type: "text_delta", delta: "task reply" };
    yield { type: "completed", content: "task reply", toolCalls: [], stopReason: "stop" };
  };
  const first = await run("current task", model, { runId: "first", systemPrompt: system, cwd: process.cwd(), tools: new Map(), recorder, responseImpl }, {
    onAssistantDelta: (delta) => visible.push(delta),
  });
  assert.equal(first.status, "completed", first.error?.message);
  const snapshot = await repository.getLatestContextSnapshot(null);
  assert.ok(snapshot);
  assert.equal(summaries, 1);
  await recorder.close();
  const restored = await createHistoryRecorder(repository, null);
  const second = await run("next task", model, { runId: "second", systemPrompt: system, cwd: process.cwd(), tools: new Map(), recorder: restored, responseImpl });
  assert.equal(second.status, "completed", second.error?.message);
  assert.equal(summaries, 1);
  assert.deepEqual(visible, ["task reply"]);
  assert.match(requests[1]![0]!.content, /Evidence: old-0/);
  assert.equal(requests[1]!.filter((message) => message.content === "next task").length, 1);
  const all = await repository.listEntries(null);
  for (const entry of all.filter((entry) => entry.entryOrder <= snapshot.coveredThroughOrder)) {
    assert.ok(requests[1]!.every((message) => message.content !== entry.payload.content));
  }
  assert.equal(all.length, 10);
  assert.ok(all[0]!.payload.content.includes("history history"));
  assert.ok(all.every((entry) => !entry.payload.content.includes("Goal: continue")));
  await restored.close();
  repository.close();
});

test("a transient snapshot commit retries the same generated result and identity", async () => {
  const { repository, recorder } = await setup();
  const save = repository.saveContextSnapshot.bind(repository);
  const ids: Array<string | undefined> = [];
  repository.saveContextSnapshot = async (input) => {
    ids.push(input.id);
    if (ids.length === 1) throw new RepositoryError("busy", "storage", { retryable: true });
    return save(input);
  };
  let summaries = 0;
  const result = await run("current task", model, {
    runId: "commit-retry", systemPrompt: system, cwd: process.cwd(), tools: new Map(), recorder,
    responseImpl: async function* (_config, _messages, prompt): AsyncGenerator<ModelStreamEvent> {
      if (prompt !== system) summaries += 1;
      yield { type: "completed", content: prompt === system ? "done" : "Goal: continue. Evidence: old-0.", toolCalls: [], stopReason: "stop" };
    },
  });
  assert.equal(result.status, "completed", result.error?.message);
  assert.equal(summaries, 1);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  await recorder.close();
  repository.close();
});

test("a provider overflow gets one compaction recovery and preserves the logical turn", async () => {
  const { repository, recorder } = await setup();
  let summaries = 0;
  let requests = 0;
  const retries: string[] = [];
  const result = await run("current task", { ...model, context: { ...model.context!, growthTokens: 3000 } }, {
    runId: "overflow-recovery", systemPrompt: system, cwd: process.cwd(), tools: new Map(), recorder,
    responseImpl: async function* (_config, _messages, prompt): AsyncGenerator<ModelStreamEvent> {
      if (prompt !== system) {
        summaries += 1;
        yield { type: "completed", content: "Goal: continue. Evidence: old-0.", toolCalls: [], stopReason: "stop" };
        return;
      }
      requests += 1;
      throw new ModelAdapterError("context_overflow", "provider context limit");
    },
  }, { onTurnRetrying: ({ reason }) => retries.push(reason) });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.kind, "context_overflow");
  assert.equal(requests, 2);
  assert.equal(summaries, 1);
  assert.equal(result.turnCount, 1);
  assert.deepEqual(retries, ["context_overflow"]);
  await recorder.close();
  repository.close();
});

test("cancellation during summary generation saves no snapshot and sends no task request", async () => {
  const { repository, recorder } = await setup();
  const controller = new AbortController();
  let taskRequests = 0;
  const result = await run("current task", model, {
    runId: "cancel-summary", systemPrompt: system, cwd: process.cwd(), tools: new Map(), recorder, signal: controller.signal,
    responseImpl: async function* (_config, _messages, prompt): AsyncGenerator<ModelStreamEvent> {
      if (prompt === system) taskRequests += 1;
      controller.abort();
      yield { type: "completed", content: "Goal: continue.", toolCalls: [], stopReason: "stop" };
    },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(taskRequests, 0);
  assert.equal(await repository.getLatestContextSnapshot(null), null);
  assert.ok((await repository.getEntry("old-0"))!.payload.content.includes("history history"));
  await recorder.close();
  repository.close();
});

test("Stop during overflow recovery preserves cancellation after the failed model attempt is committed", async () => {
  const { repository, recorder } = await setup();
  const controller = new AbortController();
  const attempts: number[] = [];
  const result = await run("current task", { ...model, context: { ...model.context!, growthTokens: 3000 } }, {
    runId: "cancel-overflow", systemPrompt: system, cwd: process.cwd(), tools: new Map(), recorder, signal: controller.signal,
    responseImpl: async function* (_config, _messages, prompt): AsyncGenerator<ModelStreamEvent> {
      if (prompt === system) throw new ModelAdapterError("context_overflow", "provider context limit");
      controller.abort();
      yield { type: "completed", content: "Goal: continue.", toolCalls: [], stopReason: "stop" };
    },
  }, { onTurnStart: ({ attempt }) => attempts.push(attempt) });
  assert.equal(result.status, "cancelled", result.error?.message);
  assert.equal(result.error, undefined);
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(await repository.getLatestContextSnapshot(null), null);
  await recorder.close();
  repository.close();
});

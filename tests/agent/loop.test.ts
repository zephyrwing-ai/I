import assert from "node:assert/strict";
import test from "node:test";
import { classifyTurn, run } from "../../agent/loop.js";
import type { HistoryRecorder } from "../../agent/memory/types.js";
import { createTransientHistoryRecorder } from "../../agent/memory/index.js";
import { SqliteHistoryRepository, createHistoryRecorder } from "../../agent/memory/index.js";
import type { ModelConfig } from "../../agent/model/index.js";
import type { ModelMessage, ModelStreamEvent } from "../../agent/model/types.js";
import { RunInputInbox } from "../../shell/main/run-input-inbox.js";
import { toolInputHash } from "../../agent/tools/identity.js";

async function createTestRecorder(initial: ModelMessage[] = []): Promise<HistoryRecorder & { readonly messages: ModelMessage[]; commits: string[] }> {
  const recorder = await createTransientHistoryRecorder(initial);
  const commits: string[] = [];
  const commitUser = recorder.commitUser.bind(recorder);
  const archive = recorder.archiveUnappliedUser.bind(recorder);
  const finish = recorder.finishAssistantAttempt.bind(recorder);
  const commitTool = recorder.commitToolResult.bind(recorder);
  recorder.commitUser = async (message, context) => { commits.push("user"); await commitUser(message, context); };
  recorder.archiveUnappliedUser = async (message, context) => { commits.push("user-interrupted"); await archive(message, context); };
  recorder.finishAssistantAttempt = async (context, status, message, plans) => {
    commits.push(status === "completed" ? "assistant" : `assistant-${status}`);
    return finish(context, status, message, plans);
  };
  recorder.commitToolResult = async (message, context) => { commits.push("tool"); await commitTool(message, context); };
  const extended = Object.assign(recorder, { messages: [] as ModelMessage[], commits });
  return Object.defineProperty(extended, "messages", { get: () => recorder.snapshot() });
}

test("session transcript accumulates across runs and seeds the model context", async () => {
  const seen: ModelMessage[][] = [];

  const fakeResponse = async function* (
    _modelConfig: ModelConfig,
    messages: ModelMessage[],
  ): AsyncGenerator<ModelStreamEvent> {
    seen.push(messages.map((message) => ({ ...message })));
    yield { type: "text_delta", delta: "Hello from the model" };
    yield { type: "completed", content: "Hello from the model", toolCalls: [], stopReason: "stop" };
  };

  const base = {
    systemPrompt: "You are a test agent.",
    cwd: process.cwd(),
    tools: new Map(),
  };
  const recorder = await createTestRecorder();

  await run(
    "第一句",
    { provider: "openai", model: "fake" },
    { ...base, runId: "run-1", recorder, responseImpl: fakeResponse },
  );
  await run(
    "第二句",
    { provider: "openai", model: "fake" },
    { ...base, runId: "run-2", recorder, responseImpl: fakeResponse },
  );

  // 第一轮：上下文只有新任务
  assert.deepEqual(seen[0].map((message) => message.role), ["user"]);
  assert.equal(seen[0][0].content, "第一句");
  // 第二轮：上下文 = 第一轮全部 + 新任务
  assert.deepEqual(seen[1].map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(seen[1][0].content, "第一句");
  assert.equal(seen[1][1].content, "Hello from the model");
  assert.equal(seen[1][2].content, "第二句");
  // 会话存量跟着追加：两轮 = user/assistant x2
  assert.deepEqual(recorder.messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(recorder.commits, ["user", "assistant", "user", "assistant"]);
});

test("steering accepted during streaming and a tool batch enters the next model request in FIFO order", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const inbox = new RunInputInbox("run-steering-tools", null, recorder);
  const seen: ModelMessage[][] = [];
  const applied: string[][] = [];
  let requestCount = 0;
  const tool = {
    definition: { name: "test", description: "test", parameters: { type: "object" as const, properties: {}, required: [] } },
    recovery: { version: "1", mode: "safe" as const },
    execute: async () => {
      await inbox.accept("input-two", "第二条补充");
      return { ok: true, output: "tool result", returncode: 0, truncated: false };
    },
  };
  const result = await run("原始任务", { provider: "openai", model: "fake" }, {
    runId: "run-steering-tools",
    systemPrompt: "test",
    cwd: process.cwd(),
    tools: new Map([["test", tool]]),
    recorder,
    steeringInbox: inbox,
    responseImpl: async function* (_config, messages): AsyncGenerator<ModelStreamEvent> {
      seen.push(messages.map((message) => ({ ...message })));
      requestCount += 1;
      if (requestCount === 1) {
        yield { type: "text_delta", delta: "正在处理" };
        await inbox.accept("input-one", "第一条补充");
        yield { type: "completed", content: "正在处理", toolCalls: [{ id: "steering-call", name: "test", input: {}, inputComplete: true }], stopReason: "tool_use" };
        return;
      }
      yield { type: "completed", content: "完成", toolCalls: [], stopReason: "stop" };
    },
  }, {
    onInputsApplied: ({ inputIds }) => applied.push(inputIds),
  });

  assert.equal(result.status, "completed", result.error?.message);
  assert.deepEqual(applied, [["input-one", "input-two"]]);
  assert.deepEqual(seen[1]?.map((message) => message.role), ["user", "assistant", "tool", "user", "user"]);
  assert.deepEqual(seen[1]?.slice(-2).map((message) => message.content), ["第一条补充", "第二条补充"]);
  const entries = await repository.listEntries(null);
  assert.deepEqual(entries.slice(3, 5).map((entry) => entry.id), ["input-one", "input-two"]);
  assert.deepEqual(entries.map((entry) => entry.type), ["user_message", "assistant_message", "tool_result", "user_message", "user_message", "assistant_message"]);
  assert.equal(entries[1]?.durationMs, null);
  assert.equal(typeof entries.at(-1)?.durationMs, "number");
  await recorder.close();
  repository.close();
});

test("a steering input received before a normal answer finishes keeps the run open", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const inbox = new RunInputInbox("run-steering-answer", null, recorder);
  const seen: ModelMessage[][] = [];
  const appliedAt: number[] = [];
  let now = 1_000;
  let calls = 0;
  const result = await run("原任务", { provider: "openai", model: "fake" }, {
    runId: "run-steering-answer",
    systemPrompt: "test",
    cwd: process.cwd(),
    tools: new Map(),
    recorder,
    steeringInbox: inbox,
    clock: () => now,
    responseImpl: async function* (_config, messages): AsyncGenerator<ModelStreamEvent> {
      seen.push(messages.map((message) => ({ ...message })));
      calls += 1;
      if (calls === 1) {
        await inbox.accept("answer-steer", "补充方向");
        now = 1_600;
        yield { type: "completed", content: "前一段回复", toolCalls: [], stopReason: "stop" };
        return;
      }
      now = 2_400;
      yield { type: "completed", content: "依据补充完成", toolCalls: [], stopReason: "stop" };
    },
  }, {
    onInputsApplied: ({ startedAt }) => appliedAt.push(startedAt),
  });

  assert.equal(result.status, "completed");
  assert.equal(calls, 2);
  assert.deepEqual(appliedAt, [1_600]);
  assert.equal(result.finalDurationMs, 1_400);
  assert.ok(result.finalTurnId);
  assert.deepEqual(seen[1]?.map((message) => message.content), ["原任务", "前一段回复", "补充方向"]);
  const assistantEntries = (await repository.listEntries(null)).filter((entry) => entry.type === "assistant_message");
  assert.deepEqual(assistantEntries.map((entry) => entry.durationMs), [null, 1_400]);
  assert.equal(assistantEntries[1]?.turnId, result.finalTurnId);
  await assert.rejects(inbox.accept("late-steer", "迟到的补充"), /finishing/);
  await recorder.close();
  repository.close();
});

test("a single-turn answer attaches the whole run duration to its final assistant entry", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  let now = 5_000;
  const result = await run("原任务", { provider: "openai", model: "fake" }, {
    runId: "run-single-answer",
    systemPrompt: "test",
    cwd: process.cwd(),
    tools: new Map(),
    recorder,
    clock: () => now,
    responseImpl: async function* (): AsyncGenerator<ModelStreamEvent> {
      now = 6_250;
      yield { type: "completed", content: "完成", toolCalls: [], stopReason: "stop" };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.finalDurationMs, 1_250);
  const assistant = (await repository.listEntries(null)).find((entry) => entry.type === "assistant_message");
  assert.equal(result.finalTurnId, assistant?.turnId);
  assert.equal(assistant?.durationMs, 1_250);
  await recorder.close();
  repository.close();
});

test("cancelling a run archives accepted steering text and reports its input ID", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const inbox = new RunInputInbox("run-cancel-steer", null, recorder);
  const controller = new AbortController();
  const result = await run("原任务", { provider: "openai", model: "fake" }, {
    runId: "run-cancel-steer",
    systemPrompt: "test",
    cwd: process.cwd(),
    tools: new Map(),
    recorder,
    steeringInbox: inbox,
    signal: controller.signal,
    responseImpl: async function* (): AsyncGenerator<ModelStreamEvent> {
      await inbox.accept("cancelled-steer", "用户补充");
      controller.abort();
      yield { type: "completed", content: "中断前内容", toolCalls: [], stopReason: "stop" };
    },
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.finalTurnId, undefined);
  assert.equal(result.finalDurationMs, undefined);
  assert.deepEqual(result.unappliedInputIds, ["cancelled-steer"]);
  assert.equal((await repository.getEntry("cancelled-steer"))?.status, "interrupted");
  assert.deepEqual(recorder.snapshot().map((message) => message.content), ["原任务"]);
  await recorder.close();
  repository.close();
});

test("run-scoped canvas context is visible for one run but never enters the session snapshot", async () => {
  const seen: ModelMessage[][] = [];
  const recorder = await createTestRecorder();
  const fakeResponse = async function* (
    _modelConfig: ModelConfig,
    messages: ModelMessage[],
  ): AsyncGenerator<ModelStreamEvent> {
    seen.push(messages.map((message) => ({ ...message })));
    yield { type: "completed", content: "done", toolCalls: [], stopReason: "stop" };
  };
  const base = {
    systemPrompt: "test",
    cwd: process.cwd(),
    tools: new Map(),
    recorder,
    responseImpl: fakeResponse,
  };

  await run("使用画布", { provider: "openai", model: "fake" }, {
    ...base,
    runId: "canvas-run-1",
    runScopedContext: [{ role: "user", content: "Canvas context", media: { mediaType: "image/png", dataUrl: "data:image/png;base64,AA==" } }],
  });
  await run("下一句", { provider: "openai", model: "fake" }, { ...base, runId: "canvas-run-2" });

  assert.deepEqual(seen[0].map((message) => message.content), ["Canvas context", "使用画布"]);
  assert.deepEqual(seen[1].map((message) => message.content), ["使用画布", "done", "下一句"]);
  assert.equal(recorder.messages.some((message) => message.content === "Canvas context"), false);
});

test("persistence barriers complete before provider, tools, and next provider request", async () => {
  const recorder = await createTestRecorder();
  const order: string[] = [];
  let requestCount = 0;
  const fakeResponse = async function* (
    _modelConfig: ModelConfig,
    _messages: ModelMessage[],
  ): AsyncGenerator<ModelStreamEvent> {
    order.push(`provider-${++requestCount}`);
    if (requestCount === 1) {
      yield {
        type: "completed",
        content: "",
        toolCalls: [{ id: "call-1", name: "test", input: {}, inputComplete: true }],
        stopReason: "tool_use",
      };
      return;
    }
    yield { type: "completed", content: "done", toolCalls: [], stopReason: "stop" };
  };
  const tool = {
    definition: { name: "test", description: "test", parameters: { type: "object" as const, properties: {}, required: [] } },
    recovery: { version: "1", mode: "safe" as const },
    execute: async () => {
      order.push("tool-execute");
      return { ok: true, output: "ok", returncode: 0, truncated: false };
    },
  };

  const commitUser = recorder.commitUser.bind(recorder);
  const finishAssistant = recorder.finishAssistantAttempt.bind(recorder);
  const commitTool = recorder.commitToolResult.bind(recorder);
  const finishRun = recorder.finishRun.bind(recorder);
  recorder.commitUser = async (message, context) => { order.push("commit-user"); await commitUser(message, context); };
  recorder.finishAssistantAttempt = async (context, status, message, plans) => {
    if (status === "completed") order.push("commit-assistant");
    return finishAssistant(context, status, message, plans);
  };
  recorder.commitToolResult = async (message, context) => { order.push("commit-tool"); await commitTool(message, context); };
  recorder.finishRun = async (status) => { order.push(`finish-${status.status}`); await finishRun(status); };

  const result = await run("执行", { provider: "openai", model: "fake" }, {
    runId: "run-barrier",
    systemPrompt: "test",
    cwd: process.cwd(),
    tools: new Map([["test", tool]]),
    recorder,
    responseImpl: fakeResponse,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(order, [
    "commit-user",
    "provider-1",
    "commit-assistant",
    "tool-execute",
    "commit-tool",
    "provider-2",
    "commit-assistant",
    "finish-completed",
  ]);
});

test("runtime persists a tool invocation and settles it before the next model request", async () => {
  const recorder = await createTransientHistoryRecorder();
  let executionCount = 0;
  let requestCount = 0;
  const tool = {
    definition: { name: "test", description: "test", parameters: { type: "object" as const, properties: {}, required: [] } },
    recovery: { version: "1", mode: "safe" as const },
    execute: async () => {
      executionCount += 1;
      return { ok: true, output: "ok", returncode: 0, truncated: false };
    },
  };
  const result = await run("执行工具", { provider: "openai", model: "fake" }, {
    runId: "run-ledger",
    systemPrompt: "test",
    cwd: process.cwd(),
    tools: new Map([["test", tool]]),
    recorder,
    responseImpl: async function* (): AsyncGenerator<ModelStreamEvent> {
      requestCount += 1;
      if (requestCount === 1) {
        yield { type: "completed", content: "", toolCalls: [{ id: "ledger-call", name: "test", input: {}, inputComplete: true }], stopReason: "tool_use" };
        return;
      }
      yield { type: "completed", content: "done", toolCalls: [], stopReason: "stop" };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(executionCount, 1);
  assert.deepEqual(await recorder.listOpenToolInvocations("run-ledger"), []);
  await recorder.close();
});

test("runtime recovers a safe effect_pending invocation before the next model request", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const first = await createHistoryRecorder(repository, null);
  const call = { id: "recover-call", name: "test", input: {}, inputComplete: true } as const;
  const [invocation] = await first.finishAssistantAttempt({ runId: "old-run", turnId: "old-turn", turnOrdinal: 1 }, "completed", { role: "assistant", content: "", toolCalls: [call] }, [{
    runId: "old-run",
    turnId: "old-turn",
    cwd: process.cwd(),
    toolCallId: call.id,
    ordinal: 0,
    toolName: call.name,
    toolVersion: "1",
    inputJson: "{}",
    inputHash: toolInputHash(call.name, "1", call.input),
    recoveryModeSnapshot: "safe",
  }]);
  await first.beginToolAttempt(invocation!.id);

  const recorder = await createHistoryRecorder(repository, null);
  let executionCount = 0;
  const tool = {
    definition: { name: "test", description: "test", parameters: { type: "object" as const, properties: {}, required: [] } },
    recovery: { version: "1", mode: "safe" as const },
    execute: async () => {
      executionCount += 1;
      return { ok: true, output: "recovered", returncode: 0, truncated: false };
    },
  };
  const result = await run("继续任务", { provider: "openai", model: "fake" }, {
    runId: "new-run",
    systemPrompt: "test",
    cwd: process.cwd(),
    tools: new Map([["test", tool]]),
    recorder,
    responseImpl: async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "completed", content: "继续完成", toolCalls: [], stopReason: "stop" };
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(executionCount, 1);
  assert.deepEqual(await recorder.listOpenToolInvocations("new-run"), []);
  await first.close();
  await recorder.close();
  repository.close();
});

test("a model stream without completed fails with a model protocol error", async () => {
  const recorder = await createTestRecorder();
  const result = await run("缺少终态", { provider: "openai", model: "fake" }, {
    runId: "run-protocol",
    systemPrompt: "test",
    cwd: process.cwd(),
    tools: new Map(),
    recorder,
    modelRetry: { baseDelayMs: 0 },
    responseImpl: async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text_delta", delta: "partial" };
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.kind, "model_protocol");
  assert.deepEqual(recorder.commits, ["user", "assistant-interrupted", "assistant-interrupted", "assistant-interrupted"]);
});

test("a reasoning-only response is interrupted, retried, and does not enter the next model context", async () => {
  const recorder = await createTestRecorder();
  const seen: ModelMessage[][] = [];
  const retries: string[] = [];
  let requestCount = 0;
  const result = await run("继续完成", { provider: "openai", model: "fake" }, {
    runId: "run-retry",
    systemPrompt: "test",
    cwd: process.cwd(),
    tools: new Map(),
    recorder,
    modelRetry: { baseDelayMs: 0 },
    responseImpl: async function* (_modelConfig, messages): AsyncGenerator<ModelStreamEvent> {
      seen.push(messages.map((message) => ({ ...message })));
      requestCount += 1;
      if (requestCount === 1) {
        yield { type: "reasoning_delta", delta: "incomplete thought" };
        yield { type: "completed", content: "", reasoning: "incomplete thought", toolCalls: [], stopReason: "stop" };
        return;
      }
      yield { type: "completed", content: "完成答案", toolCalls: [], stopReason: "stop" };
    },
  }, {
    onTurnRetrying: ({ reason }) => retries.push(reason),
  });

  assert.equal(result.status, "completed");
  assert.equal(requestCount, 2);
  assert.deepEqual(retries, ["reasoning_only"]);
  assert.deepEqual(seen[0].map((message) => message.role), ["user"]);
  assert.deepEqual(seen[1].map((message) => message.role), ["user"]);
  assert.deepEqual(recorder.commits, ["user", "assistant-interrupted", "assistant"]);
  assert.equal(recorder.messages.at(-1)?.content, "完成答案");
});

test("classifyTurn separates a normal stop from incomplete and filtered responses", () => {
  const base = { content: "", reasoning: undefined, toolCalls: [] as ModelMessage["toolCalls"] };
  assert.equal(classifyTurn({ ...base, stopReason: "stop", toolCalls: [] }).kind, "incomplete");
  assert.equal(classifyTurn({ ...base, content: "answer", stopReason: "stop", toolCalls: [] }).kind, "answer");
  assert.equal(classifyTurn({ ...base, reasoning: "thinking", stopReason: "stop", toolCalls: [] }).kind, "incomplete");
  assert.equal(classifyTurn({ ...base, content: "partial", stopReason: "length", toolCalls: [] }).kind, "incomplete");
  assert.equal(classifyTurn({ ...base, stopReason: "content_filter", toolCalls: [] }).kind, "failed");
});

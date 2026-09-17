import assert from "node:assert/strict";
import test from "node:test";
import { classifyTurn, run } from "../../agent/loop.js";
import type { SessionRecorder } from "../../agent/memory/types.js";
import type { ModelConfig } from "../../agent/model/index.js";
import type { ModelMessage, ModelStreamEvent } from "../../agent/model/types.js";

function createTestRecorder(initial: ModelMessage[] = []): SessionRecorder & { messages: ModelMessage[]; commits: string[] } {
  const messages = initial.slice();
  const commits: string[] = [];
  return {
    sessionId: "session-test",
    messages,
    commits,
    snapshot: () => messages.slice(),
    commitUser: async (message) => {
      commits.push("user");
      messages.push(message);
    },
    recordAssistantDelta: () => undefined,
    finishAssistantAttempt: async (_context, status, message) => {
      commits.push(status === "completed" ? "assistant" : `assistant-${status}`);
      if (status === "completed" && message) messages.push(message);
    },
    commitAssistant: async (message) => {
      commits.push("assistant");
      messages.push(message);
    },
    commitToolResult: async (message) => {
      commits.push("tool");
      messages.push(message);
    },
    finishRun: async () => undefined,
    close: async () => undefined,
  };
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
  const recorder = createTestRecorder();

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

test("persistence barriers complete before provider, tools, and next provider request", async () => {
  const recorder = createTestRecorder();
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
    execute: async () => {
      order.push("tool-execute");
      return { ok: true, output: "ok", returncode: 0, truncated: false };
    },
  };

  const result = await run("执行", { provider: "openai", model: "fake" }, {
    runId: "run-barrier",
    systemPrompt: "test",
    cwd: process.cwd(),
    tools: new Map([["test", tool]]),
    recorder: {
      ...recorder,
      commitUser: async (message, context) => {
        order.push("commit-user");
        await recorder.commitUser(message, context);
      },
      finishAssistantAttempt: async (context, status, message) => {
        if (status === "completed") order.push("commit-assistant");
        await recorder.finishAssistantAttempt(context, status, message);
      },
      commitToolResult: async (message, context) => {
        order.push("commit-tool");
        await recorder.commitToolResult(message, context);
      },
      finishRun: async (status) => {
        order.push(`finish-${status.status}`);
        await recorder.finishRun(status);
      },
    },
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

test("a model stream without completed fails with a model protocol error", async () => {
  const recorder = createTestRecorder();
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
  const recorder = createTestRecorder();
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

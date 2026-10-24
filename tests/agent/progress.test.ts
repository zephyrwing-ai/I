import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { classifyTurn, run } from "../../agent/loop.js";
import { createHistoryRecorder, SqliteHistoryRepository } from "../../agent/memory/index.js";
import { ModelAdapterError, readModelMessage, type LlmResponse, type ModelStreamEvent } from "../../agent/model/types.js";
import { estimateMessageTokens, estimateTextTokens } from "../../agent/context/tokens.js";
import { serializeAssistantText } from "../../agent/model/assistant-text.js";

const model = { provider: "openai" as const, model: "progress-fixture" };

async function setup(t: TestContext) {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  t.after(async () => { await recorder.close(); repository.close(); });
  return { repository, recorder };
}

test("native tool prose persists as content and replays reasoning before a normal final answer", async (t) => {
  const { repository, recorder } = await setup(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const prose = "我先读取配置文件，确认应用名称。";
  const answer = "应用名称为 I。";
  const reasoning = "Check the configuration before answering.";
  const input = { path: "package.json", purpose: "确认应用名称", targets: ["package.json"] };
  const calls = [{ id: "read-config", type: "function", function: { name: "read", arguments: JSON.stringify(input) } }];
  const responses = [
    [
      { choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] },
      { choices: [{ delta: { content: prose, tool_calls: [{ index: 0, ...calls[0] }] }, finish_reason: "tool_calls" }] },
    ],
    [{ choices: [{ delta: { content: answer }, finish_reason: "stop" }] }],
  ];
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as typeof requests[number]);
    const chunks = responses[requests.length - 1];
    assert.ok(chunks, "Only the tool request and final-answer request are needed");
    const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  };
  const trace: string[] = [];
  const result = await run("请查看应用名称", {
    ...model, openai: { baseURL: "http://fixture.invalid/v1", apiKey: "fixture", reasoningField: "reasoning_content" },
  }, {
    runId: "native-content", systemPrompt: "", cwd: process.cwd(), recorder,
    tools: new Map([["read", {
      definition: { name: "read", description: "Read a file", parameters: {
        type: "object", properties: { path: { type: "string", description: "File path" } }, required: ["path"],
      } },
      recovery: { version: "1", mode: "safe" },
      async execute(args) {
        assert.deepEqual(args, { path: "package.json" });
        return { ok: true, output: '{"productName":"I"}', returncode: 0, truncated: false };
      },
    }]]),
  }, {
    onAssistantDelta: (delta) => trace.push(delta),
    onToolStart: () => { trace.push("tool started"); },
    onProgressDelta: () => assert.fail("Native content stays in text_delta"),
  });
  assert.equal(result.status, "completed", result.error?.message);
  assert.deepEqual(trace, [prose, "tool started", answer]);
  assert.equal(requests.length, 2);
  const assistant = requests[1].messages.find((message) => message.role === "assistant");
  assert.deepEqual(assistant, { role: "assistant", content: prose, reasoning_content: reasoning, tool_calls: calls });
  assert.ok(requests[1].messages.some((message) => message.role === "tool" && message.tool_call_id === "read-config"));
  const assistants = (await repository.listEntries(null)).filter((entry) => entry.type === "assistant_message");
  assert.deepEqual(assistants.map((entry) => [entry.status, entry.payload.content, entry.payload.progress]), [
    ["completed", prose, undefined], ["completed", answer, undefined],
  ]);
  assert.equal(assistants[0]?.payload.reasoning, reasoning);
  await recorder.close();
  const restored = await createHistoryRecorder(repository, null);
  try {
    const messages = restored.snapshot().filter((message) => message.role === "assistant");
    assert.deepEqual(messages.map((message) => message.content), [prose, answer]);
    assert.equal(messages[0]?.reasoning, reasoning);
    assert.ok(messages.every((message) => message.progress === undefined));
  } finally {
    await restored.close();
  }
});

test("legacy public progress events still persist and restore separately from content and reasoning", async (t) => {
  const { repository, recorder } = await setup(t);
  const progress = "我先核对准确率指标，再比较实时性和长音频稳定性。";
  const answer = "以下是指标分析结果。";
  const reasoning = "PRIVATE ENGLISH REASONING";
  const progressEvents: string[] = [];
  const answerEvents: string[] = [];
  const reasoningEvents: string[] = [];
  const completed: LlmResponse[] = [];
  let requests = 0;
  const result = await run("请分析语音识别的评价指标", model, {
    runId: "progress-run", systemPrompt: "", cwd: process.cwd(), tools: new Map(), recorder,
    responseImpl: async function* (_config, _messages, _system, tools): AsyncGenerator<ModelStreamEvent> {
      requests += 1;
      assert.equal(tools.length, 0);
      yield { type: "reasoning_delta", delta: reasoning };
      yield { type: "progress_delta", delta: progress.slice(0, 10) };
      yield { type: "progress_delta", delta: progress.slice(10) };
      yield { type: "text_delta", delta: answer };
      yield { type: "completed", content: answer, progress, reasoning, toolCalls: [], stopReason: "stop" };
    },
  }, {
    onProgressDelta: (delta) => progressEvents.push(delta),
    onAssistantDelta: (delta) => answerEvents.push(delta),
    onReasoningDelta: (delta) => reasoningEvents.push(delta),
    onAssistantCompleted: (response) => completed.push(response),
    onToolStart: () => assert.fail("Pure analysis has no tool execution"),
  });
  assert.equal(result.status, "completed", result.error?.message);
  assert.equal(requests, 1, "Process prose uses the answer request, not a second summarization request");
  assert.equal(progressEvents.join(""), progress);
  assert.equal(answerEvents.join(""), answer);
  assert.equal(reasoningEvents.join(""), reasoning);
  assert.equal(completed[0]?.progress, progress);
  const entries = await repository.listEntries(null);
  assert.deepEqual(entries.map((entry) => entry.type), ["user_message", "assistant_message"]);
  assert.deepEqual(entries[1]?.payload, { role: "assistant", content: answer, progress, reasoning, toolCalls: [] });
  assert.equal(entries[1]?.status, "completed");
  assert.ok(entries[1]?.durationMs !== null);
  await recorder.close();
  const restored = await createHistoryRecorder(repository, null);
  try {
    assert.equal(restored.snapshot()[1]?.progress, progress);
    assert.equal(restored.snapshot()[1]?.content, answer);
    assert.equal(restored.snapshot()[1]?.reasoning, reasoning);
  } finally {
    await restored.close();
  }
});

test("legacy progress-only output is incomplete and a native-content retry retains separate attempt evidence", async (t) => {
  const { repository, recorder } = await setup(t);
  const progressOnly: LlmResponse = { content: "", progress: "正在比较指标。", toolCalls: [], stopReason: "stop" };
  assert.equal(classifyTurn(progressOnly).kind, "incomplete");
  const retries: string[] = [];
  let requests = 0;
  const result = await run("比较这些指标", model, {
    runId: "progress-retry", systemPrompt: "", cwd: process.cwd(), tools: new Map(), recorder,
    modelRetry: { maxAttempts: 2, baseDelayMs: 0 },
    responseImpl: async function* (): AsyncGenerator<ModelStreamEvent> {
      requests += 1;
      if (requests === 1) {
        yield { type: "progress_delta", delta: progressOnly.progress! };
        yield { type: "completed", ...progressOnly };
      } else {
        yield { type: "text_delta", delta: "分析完成。" };
        yield { type: "completed", content: "分析完成。", toolCalls: [], stopReason: "stop" };
      }
    },
  }, { onTurnRetrying: (event) => retries.push(event.reason) });
  assert.equal(result.status, "completed", result.error?.message);
  assert.equal(requests, 2);
  assert.deepEqual(retries, ["empty_response"]);
  const assistants = (await repository.listEntries(null)).filter((entry) => entry.type === "assistant_message");
  assert.deepEqual(assistants.map((entry) => [entry.status, entry.payload.progress, entry.payload.content]), [
    ["interrupted", progressOnly.progress, ""],
    ["completed", undefined, "分析完成。"],
  ]);
  assert.equal(assistants[0]?.turnId, assistants[1]?.turnId);
});

test("Stop during native prose streaming preserves partial content and reasoning", async (t) => {
  const { repository, recorder } = await setup(t);
  const controller = new AbortController();
  let completed = false;
  const result = await run("分析指标", model, {
    runId: "progress-stop", systemPrompt: "", cwd: process.cwd(), tools: new Map(), recorder, signal: controller.signal,
    responseImpl: async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "reasoning_delta", delta: "PRIVATE REASONING" };
      yield { type: "text_delta", delta: "我先核对准确率口径。" };
      controller.abort();
      throw new ModelAdapterError("network", "Cancelled");
    },
  }, { onAssistantCompleted: () => { completed = true; } });
  assert.equal(result.status, "cancelled");
  assert.equal(completed, false);
  const assistant = (await repository.listEntries(null)).find((entry) => entry.type === "assistant_message");
  assert.equal(assistant?.status, "interrupted");
  assert.equal(assistant?.payload.progress, undefined);
  assert.equal(assistant?.payload.reasoning, "PRIVATE REASONING");
  assert.equal(assistant?.payload.content, "我先核对准确率口径。");
});

test("message validation and token estimation cover progress while legacy messages keep their shape", () => {
  const message = { role: "assistant" as const, content: "答案", progress: "我先比较各指标的定义。" };
  assert.equal(readModelMessage(message), message);
  assert.equal(readModelMessage({ ...message, progress: [] }), undefined);
  assert.equal(readModelMessage({ ...message, progress: 1 }), undefined);
  assert.equal(estimateMessageTokens(message), 8 + estimateTextTokens(serializeAssistantText(message)));
  const legacy = { role: "assistant" as const, content: "旧答案" };
  assert.equal(readModelMessage(legacy), legacy);
  assert.equal(estimateMessageTokens(legacy), 8 + estimateTextTokens(legacy.content));
  assert.ok(estimateMessageTokens(message) > estimateMessageTokens({ ...message, progress: undefined }));
});

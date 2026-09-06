import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../../agent/loop.js";
import type { ModelConfig } from "../../agent/model/index.js";
import type { ModelMessage, ModelStreamEvent } from "../../agent/model/types.js";
import { sessionStore } from "../../shell/main/session-store.js";

test("session transcript accumulates across runs and seeds the model context", async () => {
  sessionStore.clear();
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
  const events = { onMessageFinalized: (message: ModelMessage) => sessionStore.append(message) };

  await run(
    "第一句",
    { provider: "openai", model: "fake" },
    { ...base, runId: "run-1", history: sessionStore.snapshot(), responseImpl: fakeResponse },
    events,
  );
  await run(
    "第二句",
    { provider: "openai", model: "fake" },
    { ...base, runId: "run-2", history: sessionStore.snapshot(), responseImpl: fakeResponse },
    events,
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
  assert.deepEqual(sessionStore.snapshot().map((message) => message.role), ["user", "assistant", "user", "assistant"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../../../shell/shared/ipc.js";
import { agentReducer, initialAgentState } from "../../../../frontend/src/store/agentReducer.js";
import { projectAssistantActivity } from "../../../../frontend/src/store/assistantActivity.js";

function project(task: string, content: string, toolCalls: Array<{
  id: string;
  name: string;
  input: Record<string, unknown>;
}>) {
  let state = agentReducer(initialAgentState, { type: "runRequested" });
  state = agentReducer(state, {
    type: "runAccepted", runId: "run", inputId: "input", projectId: null, task, taskAt: 1_000,
  });
  const event = (value: Omit<AgentEvent, "runId">) => {
    state = agentReducer(state, { type: "event", event: { ...value, runId: "run" } as AgentEvent });
  };
  event({ type: "turnStarted", turnId: "turn", turnOrdinal: 1 });
  event({
    type: "assistantCompleted",
    turnId: "turn",
    content,
    stopReason: "tool_use",
    completedAt: 2_000,
    toolCalls: toolCalls.map((call) => ({ ...call, inputComplete: true })),
  });
  return projectAssistantActivity(state.runs.run, ["turn"], undefined, true,
    /[\u3400-\u9fff]/u.test(task) ? "zh" : "en");
}

test("empty native content becomes one ordered Chinese process sentence", () => {
  const activity = project("检查实现", "", [
    { id: "read", name: "read", input: { path: "config.ts", purpose: "检查实现。" } },
    { id: "inspect", name: "read", input: { path: "manager.ts", purpose: "读取配置" } },
    { id: "repeat", name: "bash", input: { command: "pwd", purpose: "读取配置" } },
    { id: "prefix", name: "bash", input: { command: "pwd", purpose: "我们需要先读取配置" } },
  ]);
  assert.equal(activity.turns[0].commentary, "本轮先检查实现，再读取配置。");
});

test("empty native content becomes one ordered English process sentence", () => {
  const activity = project("Check implementation", "", [
    { id: "read", name: "read", input: { path: "config.ts", purpose: "Inspect configuration" } },
    { id: "test", name: "bash", input: { command: "npm test", purpose: "I'll first run tests." } },
  ]);
  assert.equal(activity.turns[0].commentary, "First inspect configuration, then run tests.");
});

test("native content remains the first paragraph and purposes stay additive", () => {
  const activity = project("检查实现", "我先核对现有实现。", [
    { id: "read", name: "read", input: { path: "config.ts", purpose: "读取配置" } },
  ]);
  assert.equal(activity.turns[0].commentary, "我先核对现有实现。\n\n读取配置");
});

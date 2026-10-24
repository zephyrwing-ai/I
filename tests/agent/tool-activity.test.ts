import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createLocalBashOps } from "../../agent/environment.js";
import { canonicalJson } from "../../agent/json.js";
import { run } from "../../agent/loop.js";
import { createHistoryRecorder, SqliteHistoryRepository } from "../../agent/memory/index.js";
import type { ModelMessage, ModelStreamEvent, ToolCall } from "../../agent/model/types.js";
import { CANVAS_CODING_AGENT_PROMPT, DEFAULT_CODING_AGENT_PROMPT } from "../../agent/prompts.js";
import { withToolActivity } from "../../agent/tools/activity.js";
import { createCanvasEditTool } from "../../agent/tools/canvas-edit.js";
import { createHistoryReadTool, createToolRegistry } from "../../agent/tools/index.js";
import { toolInputHash } from "../../agent/tools/identity.js";
import type { RegisteredTool, ToolCheckpoint, ToolResult } from "../../agent/tools/types.js";

const model = { provider: "openai" as const, model: "activity-fixture" };
const success: ToolResult = { ok: true, output: "internal tool output", returncode: 0, truncated: false };

async function setup(t: TestContext) {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  t.after(async () => { await recorder.close(); repository.close(); });
  return { repository, recorder };
}

function strictTool(name: string): RegisteredTool {
  const tool: RegisteredTool = {
    definition: {
      name, description: "Strict operational tool",
      parameters: { type: "object", properties: { query: { type: "string", description: "Query" } }, required: ["query"] },
    },
    recovery: { version: "1", mode: "safe" },
    async execute(input) {
      assert.equal(this, tool);
      assert.deepEqual(Object.keys(input), ["query"]);
      assert.equal(input.query, "configuration");
      return success;
    },
  };
  return tool;
}

test("activity decoration preserves tool schemas, optional hooks and operational argument contracts", async () => {
  const tool = strictTool("strict");
  const definition = structuredClone(tool.definition);
  const decorated = withToolActivity(tool);
  assert.deepEqual(tool.definition, definition);
  assert.notEqual(decorated.definition, tool.definition);
  assert.notEqual(decorated.definition.parameters.properties, tool.definition.parameters.properties);
  assert.deepEqual(decorated.definition.parameters.required, ["query", "purpose"]);
  assert.deepEqual(decorated.definition.parameters.properties.targets.items?.type, "string");
  assert.equal(decorated.prepare, undefined);
  assert.equal(decorated.recovery.reconcile, undefined);
  assert.deepEqual(decorated.recovery, tool.recovery);
  for (const metadata of [{}, { purpose: "检查配置", targets: [] }, { purpose: null, targets: "legacy value" }]) {
    const input = Object.freeze({ query: "configuration", ...metadata });
    assert.equal(await decorated.execute(input, { cwd: process.cwd() }), success);
    assert.deepEqual(input, { query: "configuration", ...metadata });
  }
});

test("reserved activity schema collisions fail explicitly before replacing business parameters", () => {
  for (const field of ["purpose", "targets"]) {
    for (const declaration of ["property", "required"]) {
      const tool = strictTool("collision");
      if (declaration === "property") tool.definition.parameters.properties[field] = { type: "number", description: "Business argument" };
      else tool.definition.parameters.required.push(field);
      const original = structuredClone(tool.definition);
      assert.throws(() => withToolActivity(tool), new RegExp(`collision.*reserved.*${field}`));
      assert.deepEqual(tool.definition, original);
    }
  }
});

test("Runtime advertises activity on every tool and preserves prose, reasoning and raw calls through history and events", async (t) => {
  const { repository, recorder } = await setup(t);
  await recorder.commitUser({ role: "user", content: "Original stored evidence" }, { runId: "evidence-run", entryId: "evidence" });
  const tools = createToolRegistry(createLocalBashOps());
  tools.set("history_read", createHistoryReadTool(repository, null));
  let canvasCalls = 0;
  const canvas = createCanvasEditTool({
    runId: "activity-run", projectId: null, ownerWebContentsId: 42, sourceElements: [],
    execute: async (owner, body) => {
      canvasCalls += 1;
      assert.equal(owner, 42);
      assert.equal(body.operations[0]?.action, "create");
      return { requestId: "canvas-request", runId: body.runId, projectId: body.projectId, ok: true, createdIds: ["rectangle"] };
    },
  });
  tools.set("canvas_edit", {
    ...canvas,
    execute: (input, context) => {
      assert.deepEqual(Object.keys(input), ["operations"]);
      return canvas.execute(input, context);
    },
  });
  tools.set("strict", strictTool("strict"));
  const checkpoint: ToolCheckpoint = { version: 1, kind: "fixture", data: {} };
  let preparations = 0;
  let preparedExecutions = 0;
  const preparedTool: RegisteredTool = {
    ...strictTool("prepared"),
    async prepare(input, context) {
      assert.equal(this, preparedTool);
      assert.deepEqual(input, { query: "configuration" });
      assert.equal(context.attempt, 1);
      preparations += 1;
      return {
        kind: "ready", checkpoint,
        async execute(executionContext) {
          assert.deepEqual(executionContext.checkpoint, checkpoint);
          preparedExecutions += 1;
          return success;
        },
      };
    },
    execute: async () => { throw new Error("Prepared tools execute their prepared operation"); },
  };
  tools.set("prepared", preparedTool);
  const originalDefinitions = structuredClone([...tools.values()].map((tool) => tool.definition));
  const calls: ToolCall[] = [
    { id: "history", name: "history_read", input: { entryId: "evidence", purpose: "读取原始依据", targets: ["evidence"] }, inputComplete: true },
    { id: "canvas", name: "canvas_edit", input: { operations: [{ action: "create", element: { type: "rectangle", x: 0, y: 0 } }], purpose: "创建画布矩形", targets: ["矩形"] }, inputComplete: true },
    { id: "strict", name: "strict", input: { query: "configuration", purpose: "检查配置", targets: ["configuration"] }, inputComplete: true },
    { id: "prepared", name: "prepared", input: { query: "configuration", purpose: "准备配置检查", targets: [] }, inputComplete: true },
    { id: "legacy", name: "strict", input: { query: "configuration" }, inputComplete: true },
  ];
  const originalCalls = structuredClone(calls);
  const progress = "我会先核对历史依据，再检查配置并创建矩形。";
  const reasoning = "Private reasoning retained as evidence";
  const trace: string[] = [];
  const started: ToolCall[] = [];
  const completed: ToolCall[] = [];
  const results: ToolResult[] = [];
  const visible: string[] = [];
  const reasoningDeltas: string[] = [];
  let requests = 0;
  let continuation: ModelMessage[] = [];
  const result = await run("请检查配置和历史并创建矩形", model, {
    runId: "activity-run", systemPrompt: "", cwd: process.cwd(), tools, recorder,
    responseImpl: async function* (_config, messages, system, definitions): AsyncGenerator<ModelStreamEvent> {
      requests += 1;
      assert.equal(system, DEFAULT_CODING_AGENT_PROMPT);
      assert.deepEqual(definitions.map((definition) => definition.name), [...tools.keys()]);
      for (const definition of definitions) {
        assert.equal(definition.parameters.properties.purpose.type, "string");
        assert.equal(definition.parameters.properties.targets.type, "array");
        assert.equal(definition.parameters.properties.targets.items?.type, "string");
        assert.ok(definition.parameters.required.includes("purpose"));
        assert.ok(!definition.parameters.required.includes("targets"));
      }
      if (requests === 1) {
        yield { type: "reasoning_delta", delta: reasoning };
        yield { type: "text_delta", delta: progress };
        yield { type: "completed", content: progress, reasoning, toolCalls: calls, stopReason: "tool_use" };
        return;
      }
      assert.equal(requests, 2);
      continuation = structuredClone(messages);
      yield { type: "completed", content: "已完成。", toolCalls: [], stopReason: "stop" };
    },
  }, {
    onAssistantDelta: (delta) => { visible.push(delta); trace.push("progress"); },
    onReasoningDelta: (delta) => reasoningDeltas.push(delta),
    onAssistantCompleted: (response) => {
      if (response.toolCalls.length) {
        assert.equal(response.content, progress);
        assert.equal(response.reasoning, reasoning);
        assert.deepEqual(response.toolCalls, originalCalls);
        trace.push("assistant-completed");
      }
    },
    onToolStart: (call) => { started.push(call); trace.push("tool-started"); },
    onToolCompleted: (call, toolResult) => { completed.push(call); results.push(toolResult); },
  });

  assert.equal(result.status, "completed", result.error?.message);
  assert.equal(requests, 2, "One tool response and its ordinary continuation complete the task");
  assert.deepEqual([canvasCalls, preparations, preparedExecutions], [1, 1, 1]);
  assert.deepEqual(visible, [progress]);
  assert.deepEqual(reasoningDeltas, [reasoning]);
  assert.deepEqual(trace.slice(0, 3), ["progress", "assistant-completed", "tool-started"]);
  assert.deepEqual(started, originalCalls);
  assert.deepEqual(completed, originalCalls);
  assert.deepEqual(calls, originalCalls);
  assert.ok(results.every((toolResult) => toolResult.ok), JSON.stringify(results));
  assert.match(results[0]!.output, /Original stored evidence/);
  assert.deepEqual([...tools.values()].map((tool) => tool.definition), originalDefinitions);
  const assistant = continuation.find((message) => message.toolCalls?.length);
  assert.deepEqual(assistant, { role: "assistant", content: progress, reasoning, toolCalls: originalCalls });
  assert.deepEqual(continuation.filter((message) => message.role === "tool").map((message) => message.toolCallId), calls.map((call) => call.id));
  const storedAssistant = (await repository.listEntries(null)).find((entry) => entry.payload.toolCalls?.length);
  assert.deepEqual(storedAssistant?.payload, assistant);
  for (const call of calls) {
    const invocation = await repository.getToolInvocation(null, "activity-run", call.id);
    assert.ok(invocation);
    assert.equal(invocation.phase, "completed");
    assert.equal(invocation.inputJson, canonicalJson(call.input));
    assert.equal(invocation.inputHash, toolInputHash(call.name, "1", call.input));
    assert.deepEqual(await repository.getToolInvocationCall(invocation.id), call);
  }
});

test("Runtime recovery strips activity from reconciliation and replay preparation while retaining invocation identity", async (t) => {
  const { repository, recorder } = await setup(t);
  const call: ToolCall = { id: "recover", name: "recoverable", input: { query: "configuration", purpose: "核对配置状态", targets: ["configuration"] }, inputComplete: true };
  const checkpoint: ToolCheckpoint = { version: 1, kind: "fixture", data: { before: "original" } };
  const [invocation] = await recorder.finishAssistantAttempt({ runId: "old-run", turnId: "old-turn", turnOrdinal: 1 }, "completed", {
    role: "assistant", content: "我会核对配置状态。", reasoning: "Original reasoning", toolCalls: [call],
  }, [{
    runId: "old-run", turnId: "old-turn", cwd: process.cwd(), toolCallId: call.id, ordinal: 0,
    toolName: call.name, toolVersion: "1", inputJson: canonicalJson(call.input),
    inputHash: toolInputHash(call.name, "1", call.input), recoveryModeSnapshot: "reconcile",
  }]);
  assert.ok(invocation);
  await recorder.beginToolAttempt(invocation.id, checkpoint);
  const trace: string[] = [];
  const tool: RegisteredTool = {
    ...strictTool("recoverable"),
    recovery: {
      version: "1", mode: "reconcile",
      async reconcile(input, savedCheckpoint, context) {
        assert.equal(this, tool.recovery);
        assert.deepEqual(input, { query: "configuration" });
        assert.deepEqual(savedCheckpoint, checkpoint);
        assert.equal(context.invocationId, invocation.id);
        assert.equal(context.attempt, 1);
        trace.push("reconcile");
        return { kind: "retry", reason: "Original effect was not applied" };
      },
    },
    async prepare(input, context) {
      assert.equal(this, tool);
      assert.deepEqual(input, { query: "configuration" });
      assert.equal(context.attempt, 2);
      trace.push("prepare");
      return { kind: "ready", checkpoint, execute: async () => { trace.push("execute"); return success; } };
    },
  };
  const result = await run("继续检查", model, {
    runId: "new-run", systemPrompt: DEFAULT_CODING_AGENT_PROMPT, cwd: process.cwd(), tools: new Map([[call.name, tool]]), recorder,
    responseImpl: async function* (_config, messages): AsyncGenerator<ModelStreamEvent> {
      trace.push("model");
      assert.deepEqual(messages.find((message) => message.toolCalls?.length)?.toolCalls, [call]);
      assert.ok(messages.some((message) => message.toolCallId === call.id));
      yield { type: "completed", content: "完成。", toolCalls: [], stopReason: "stop" };
    },
  });
  assert.equal(result.status, "completed", result.error?.message);
  assert.deepEqual(trace, ["reconcile", "prepare", "execute", "model"]);
  const recovered = await repository.getToolInvocation(null, "old-run", call.id);
  assert.equal(recovered?.id, invocation.id);
  assert.equal(recovered?.phase, "completed");
  assert.equal(recovered?.attemptCount, 2);
  assert.equal(recovered?.inputJson, invocation.inputJson);
  assert.equal(recovered?.inputHash, invocation.inputHash);
  assert.deepEqual(await repository.getToolInvocationCall(invocation.id), call);
});

test("the shared prompt specifies same-response progress and localized intent while preserving Canvas instructions", () => {
  assert.match(DEFAULT_CODING_AGENT_PROMPT, /current user's language for progress prose, final answers, and each tool call's purpose/);
  assert.match(DEFAULT_CODING_AGENT_PROMPT, /Before each tool batch.*progress prose in content in the same response as the tool calls/);
  assert.match(DEFAULT_CODING_AGENT_PROMPT, /Use ordinary prose for these updates and normal Markdown for the final answer/);
  assert.doesNotMatch(DEFAULT_CODING_AGENT_PROMPT, /I_PROGRESS|I_ANSWER|frame|marker/);
  assert.match(DEFAULT_CODING_AGENT_PROMPT, /purpose: a short action intent.*targets: an array of specific file paths, search queries, or entity labels/);
  assert.match(DEFAULT_CODING_AGENT_PROMPT, /empty targets array/);
  assert.ok(CANVAS_CODING_AGENT_PROMPT.startsWith(DEFAULT_CODING_AGENT_PROMPT));
  assert.match(CANVAS_CODING_AGENT_PROMPT, /Live Canvas edits use canvas_edit/);
  assert.match(CANVAS_CODING_AGENT_PROMPT, /persistence_conflict.*Canvas controls/);
});

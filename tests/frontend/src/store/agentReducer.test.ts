import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, OutputFileDescriptor } from "../../../../shell/shared/ipc.js";
import { agentReducer, initialAgentState } from "../../../../frontend/src/store/agentReducer.js";
import { buildMessageBlockRecords } from "../../../../frontend/src/store/messageBlocks.js";
import { projectAssistantActivity } from "../../../../frontend/src/store/assistantActivity.js";

function acceptRun(runId: string, task = `task for ${runId}`) {
  let state = agentReducer(initialAgentState, { type: "runRequested" });
  return agentReducer(state, { type: "runAccepted", runId, inputId: `${runId}:task`, projectId: null, task, taskAt: 1_000 });
}

test("native content keeps its activity identity through tool batches until the final run event", () => {
  type RunEvent<T = AgentEvent> = T extends AgentEvent ? Omit<T, "runId"> : never;
  const runId = "native-trace";
  let state = acceptRun(runId, "检查实现");
  const apply = (value: RunEvent) => { state = event(state, { ...value, runId }); };
  const group = () => buildMessageBlockRecords(state).find((block) => block.kind === "assistant")!;
  const activity = () => {
    const block = group();
    assert.equal(block.kind, "assistant");
    if (block.kind !== "assistant") throw new Error("Expected activity group");
    return projectAssistantActivity(state.runs[runId], block.turnIds, block.answerTurnId, block.isWorking, "zh");
  };
  apply({ type: "turnStarted", turnId: "read", turnOrdinal: 1 });
  apply({ type: "assistantDelta", turnId: "read", delta: "先检查实现" });
  assert.equal(group().text, undefined);
  assert.equal(activity().turns[0].commentary, "先检查实现");
  apply({ type: "assistantCompleted", turnId: "read", content: "先检查实现", stopReason: "tool_use", completedAt: 2_000,
    toolCalls: ["a", "b"].map((id) => ({ id, name: "read", input: { path: `${id}.ts` }, inputComplete: true })) });
  assert.equal(activity().turns[0].toolsRunning, true);
  const result = { ok: true, output: "file body", returncode: 0, truncated: false };
  apply({ type: "toolCompleted", turnId: "read", toolCallId: "a", name: "read", result });
  assert.equal(activity().turns[0].toolsRunning, true, "the queued second call keeps the batch expanded");
  apply({ type: "toolCompleted", turnId: "read", toolCallId: "b", name: "read", result });
  assert.equal(activity().turns[0].toolsRunning, false);
  apply({ type: "turnCompleted", turnId: "read" });
  apply({ type: "turnStarted", turnId: "answer", turnOrdinal: 2 });
  apply({ type: "assistantDelta", turnId: "answer", delta: "这是结论" });
  assert.deepEqual(activity().turns.map((turn) => turn.commentary), ["先检查实现\n\n读取文件 a.ts\n\n读取文件 b.ts", "这是结论"]);
  assert.equal(group().text, undefined);
  apply({ type: "assistantCompleted", turnId: "answer", content: "这是结论", stopReason: "stop", toolCalls: [], completedAt: 3_000 });
  apply({ type: "turnCompleted", turnId: "answer" });
  assert.equal(group().text, undefined, "model stop still awaits the runtime steering boundary");
  apply({ type: "runCompleted", status: "completed", finalTurnId: "answer", finalDurationMs: 2_000, turnCount: 2 });
  assert.equal(group().text, "这是结论");
  assert.deepEqual(activity().turns.map((turn) => turn.commentary), ["先检查实现\n\n读取文件 a.ts\n\n读取文件 b.ts", ""]);
});

function outputFile(
  fileId: string,
  updatedAt: string,
  patch: Partial<OutputFileDescriptor> = {},
): OutputFileDescriptor {
  return {
    runId: "run-1",
    fileId,
    name: `${fileId}.md`,
    displayPath: `${fileId}.md`,
    operation: "created",
    mediaType: "text/markdown",
    byteSize: 12,
    updatedAt,
    ...patch,
  };
}

function event(state: ReturnType<typeof acceptRun>, value: AgentEvent) {
  return agentReducer(state, { type: "event", event: value });
}

test("agentReducer ignores late events from an earlier run", () => {
  let state = acceptRun("run-1");
  state = event(state, {
    type: "assistantDelta",
    runId: "run-1",
    turnId: "turn-1",
    delta: "first run",
  });
  state = agentReducer(state, {
    type: "event",
    event: { type: "runCompleted", runId: "run-1", status: "completed", turnCount: 1 },
  });
  state = agentReducer(state, { type: "runRequested" });
  state = agentReducer(state, {
    type: "runAccepted",
    runId: "run-2",
    inputId: "run-2:task",
    projectId: null,
    task: "second task",
    taskAt: 2_000,
  });

  const beforeLateEvents = state;
  state = event(state, {
    type: "assistantDelta",
    runId: "run-1",
    turnId: "turn-1",
    delta: " stale mutation",
  });
  state = event(state, {
    type: "outputFileRegistered",
    runId: "run-1",
    file: outputFile("stale", "2026-09-07T10:00:00.000Z"),
  });
  state = event(state, {
    type: "runCompleted",
    runId: "run-1",
    status: "failed",
    turnCount: 99,
    error: { kind: "runtime", message: "late failure" },
  });

  assert.strictEqual(state, beforeLateEvents);
  assert.equal(state.currentRunId, "run-2");
  assert.equal(state.status, "running");
  assert.equal(state.runs["run-1"].turns["turn-1"].assistantContent, "first run");
  assert.deepEqual(state.runs["run-1"].outputFileOrder, []);
});

test("output files are sorted newest first and updating a file moves its existing entry", () => {
  let state = acceptRun("run-1");
  state = agentReducer(state, {
    type: "event",
    event: {
      type: "outputFileRegistered",
      runId: "run-1",
      file: outputFile("older", "2026-09-07T10:00:00.000Z"),
    },
  });
  state = event(state, {
    type: "outputFileRegistered",
    runId: "run-1",
    file: outputFile("newer", "2026-09-07T12:00:00.000Z"),
  });
  state = event(state, {
    type: "outputFileRegistered",
    runId: "run-1",
    file: outputFile("middle", "2026-09-07T11:00:00.000Z"),
  });

  assert.deepEqual(state.runs["run-1"].outputFileOrder, ["newer", "middle", "older"]);

  state = event(state, {
    type: "outputFileRegistered",
    runId: "run-1",
    file: outputFile("older", "2026-09-07T13:00:00.000Z", {
      operation: "updated",
      byteSize: 42,
    }),
  });

  assert.deepEqual(state.runs["run-1"].outputFileOrder, ["older", "newer", "middle"]);
  assert.equal(state.runs["run-1"].outputFiles.older.operation, "updated");
  assert.equal(state.runs["run-1"].outputFiles.older.byteSize, 42);
  assert.equal(new Set(state.runs["run-1"].outputFileOrder).size, 3);
});

test("agentReducer projects one run from streamed content through cancellation", () => {
  let state = agentReducer(initialAgentState, { type: "runRequested" });
  assert.equal(state.status, "starting");
  assert.equal(state.currentRunId, null);

  state = agentReducer(state, {
    type: "runAccepted",
    runId: "run-1",
    inputId: "run-1:task",
    projectId: null,
    task: "检查项目",
    taskAt: 1_000,
  });
  state = event(state, {
    type: "runStarted",
    runId: "run-1",
    startedAt: "2026-09-08T10:00:00.000Z",
  });
  state = event(state, {
    type: "turnStarted",
    runId: "run-1",
    turnId: "turn-1",
    turnOrdinal: 1,
  });
  state = event(state, {
    type: "reasoningDelta",
    runId: "run-1",
    turnId: "turn-1",
    delta: "先读取",
  });
  state = event(state, {
    type: "assistantDelta",
    runId: "run-1",
    turnId: "turn-1",
    delta: "正在检查",
  });
  state = event(state, {
    type: "assistantCompleted",
    runId: "run-1",
    turnId: "turn-1",
    content: "正在检查目录",
    completedAt: 2_000,
    toolCalls: [{ id: "tool-1", name: "bash", input: { command: "pwd" }, inputComplete: true }],
    stopReason: "tool_use",
  });
  state = event(state, {
    type: "toolStarted",
    runId: "run-1",
    turnId: "turn-1",
    toolCallId: "tool-1",
    name: "bash",
    input: { command: "pwd" },
  });
  state = event(state, {
    type: "toolCompleted",
    runId: "run-1",
    turnId: "turn-1",
    toolCallId: "tool-1",
    name: "bash",
    result: { ok: true, output: "/workspace", returncode: 0, truncated: false },
  });
  state = agentReducer(state, { type: "stopRequested" });

  const turn = state.runs["run-1"].turns["turn-1"];
  assert.equal(state.status, "stopping");
  assert.equal(state.runs["run-1"].status, "stopping");
  assert.equal(state.runs["run-1"].startedAt, "2026-09-08T10:00:00.000Z");
  assert.equal(turn.reasoningContent, "先读取");
  assert.equal(turn.assistantContent, "正在检查目录");
  assert.deepEqual(turn.toolOrder, ["tool-1"]);
  assert.equal(turn.tools["tool-1"].status, "completed");
  assert.equal(turn.tools["tool-1"].result?.output, "/workspace");

  state = event(state, {
    type: "runCompleted",
    runId: "run-1",
    status: "cancelled",
    turnCount: 1,
  });
  assert.equal(state.status, "cancelled");
  assert.equal(state.runs["run-1"].status, "cancelled");
  assert.equal(state.runs["run-1"].turnCount, 1);
});

test("agentReducer exposes model retrying without marking the turn completed", () => {
  let state = acceptRun("run-retry");
  state = event(state, {
    type: "turnStarted",
    runId: "run-retry",
    turnId: "turn-1",
    turnOrdinal: 1,
    attempt: 1,
  });
  state = event(state, {
    type: "reasoningDelta",
    runId: "run-retry",
    turnId: "turn-1",
    delta: "partial thought",
  });
  state = event(state, {
    type: "turnRetrying",
    runId: "run-retry",
    turnId: "turn-1",
    attempt: 1,
    nextAttempt: 2,
    reason: "reasoning_only",
    delayMs: 0,
    maxAttempts: 3,
  });

  const turn = state.runs["run-retry"].turns["turn-1"];
  assert.equal(turn.status, "retrying");
  assert.equal(turn.reasoningContent, "partial thought");
});

test("progress deltas stay independent and completion reconciles the full process text", () => {
  let state = acceptRun("run-progress", "分析问题");
  state = event(state, { type: "turnStarted", runId: "run-progress", turnId: "turn-1", turnOrdinal: 1 });
  assert.equal(state.runs["run-progress"].turns["turn-1"].progressContent, "");
  state = event(state, { type: "reasoningDelta", runId: "run-progress", turnId: "turn-1", delta: "PRIVATE English reasoning" });
  state = event(state, { type: "progressDelta", runId: "run-progress", turnId: "turn-1", delta: "先比较约束" });
  state = event(state, { type: "assistantDelta", runId: "run-progress", turnId: "turn-1", delta: "中文答案" });
  state = event(state, { type: "progressDelta", runId: "run-progress", turnId: "turn-1", delta: "，再整理结论" });
  const streamed = state.runs["run-progress"].turns["turn-1"];
  assert.equal(streamed.progressContent, "先比较约束，再整理结论");
  assert.equal(streamed.assistantContent, "中文答案");
  assert.equal(streamed.reasoningContent, "PRIVATE English reasoning");
  state = event(state, {
    type: "assistantCompleted", runId: "run-progress", turnId: "turn-1", progress: "完整的过程说明", content: "完整的中文答案",
    completedAt: 2_000, toolCalls: [], stopReason: "stop",
  });
  state = event(state, { type: "progressDelta", runId: "run-progress", turnId: "turn-1", delta: "late delta" });
  const completed = state.runs["run-progress"].turns["turn-1"];
  assert.equal(completed.progressContent, "完整的过程说明");
  assert.equal(completed.assistantContent, "完整的中文答案");
  assert.equal(completed.reasoningContent, streamed.reasoningContent);
  assert.equal(streamed.progressContent, "先比较约束，再整理结论", "the previous streaming state stays immutable");
});

test("optional completion progress preserves streamed progress and an explicit empty value clears it", () => {
  for (const progress of [undefined, ""]) {
    let state = acceptRun("run-optional");
    state = event(state, { type: "progressDelta", runId: "run-optional", turnId: "turn-1", delta: "Recorded process" });
    state = event(state, {
      type: "assistantCompleted", runId: "run-optional", turnId: "turn-1", progress, content: "Answer",
      completedAt: 2_000, toolCalls: [], stopReason: "stop",
    });
    assert.equal(state.runs["run-optional"].turns["turn-1"].progressContent, progress ?? "Recorded process");
  }
});

test("retry attempts replace progress and cancellation retains it without accepting late deltas", () => {
  const runId = "run-progress-retry";
  let state = acceptRun(runId);
  state = event(state, { type: "turnStarted", runId, turnId: "turn-1", turnOrdinal: 1, attempt: 1 });
  for (const type of ["progressDelta", "assistantDelta", "reasoningDelta"] as const) {
    state = event(state, { type, runId, turnId: "turn-1", attempt: 1, delta: "discarded attempt" });
  }
  state = event(state, { type: "turnRetrying", runId, turnId: "turn-1", attempt: 1, nextAttempt: 2, reason: "network", delayMs: 0, maxAttempts: 3 });
  assert.equal(state.runs[runId].turns["turn-1"].progressContent, "discarded attempt");
  state = event(state, { type: "turnStarted", runId, turnId: "turn-1", turnOrdinal: 1, attempt: 2 });
  assert.equal(state.runs[runId].turns["turn-1"].progressContent, "");
  assert.equal(state.runs[runId].turns["turn-1"].assistantContent, "");
  assert.equal(state.runs[runId].turns["turn-1"].reasoningContent, "");
  state = event(state, { type: "progressDelta", runId, turnId: "turn-1", attempt: 2, delta: "新的过程" });
  for (const type of ["progressDelta", "assistantDelta", "reasoningDelta"] as const) {
    state = event(state, { type, runId, turnId: "turn-1", attempt: 1, delta: "stale attempt" });
  }
  state = event(state, { type: "turnStarted", runId, turnId: "turn-1", turnOrdinal: 1, attempt: 1 });
  state = event(state, { type: "turnRetrying", runId, turnId: "turn-1", attempt: 1, nextAttempt: 2, reason: "network", delayMs: 0, maxAttempts: 3 });
  assert.equal(state.runs[runId].turns["turn-1"].status, "running");
  state = event(state, { type: "progressDelta", runId, turnId: "turn-1", attempt: 2, delta: "继续处理" });
  state = event(state, { type: "runCompleted", runId, status: "cancelled", turnCount: 1 });
  const cancelled = state;
  state = event(state, { type: "progressDelta", runId, turnId: "turn-1", attempt: 2, delta: "late cancellation delta" });
  assert.strictEqual(state, cancelled);
  assert.equal(state.runs[runId].turns["turn-1"].progressContent, "新的过程继续处理");
  assert.equal(state.runs[runId].turns["turn-1"].assistantContent, "");
  assert.equal(state.runs[runId].turns["turn-1"].reasoningContent, "");
  assert.deepEqual(state.runs[runId].timeline.filter((item) => item.kind === "assistant"), [{ kind: "assistant", turnId: "turn-1" }]);
  assert.equal(buildMessageBlockRecords(state).filter((block) => block.kind === "assistant").length, 1);
});

test("a rejected start exposes the error without creating a phantom run", () => {
  let state = agentReducer(initialAgentState, { type: "runRequested" });
  state = agentReducer(state, { type: "runRejected", error: "请选择模型。" });

  assert.equal(state.status, "failed");
  assert.equal(state.currentRunId, null);
  assert.equal(state.error, "请选择模型。");
  assert.deepEqual(state.runOrder, []);
  assert.deepEqual(state.runs, {});
});

test("accepted steering bubbles keep stable IDs as a new assistant turn starts below them", () => {
  let state = acceptRun("run-steer", "原任务");
  state = event(state, { type: "turnStarted", runId: "run-steer", turnId: "turn-old", turnOrdinal: 1 });
  state = event(state, { type: "assistantDelta", runId: "run-steer", turnId: "turn-old", delta: "旧回复" });
  for (const [inputId, task, acceptOrder] of [["s1", "补充一", 1], ["s2", "补充二", 2]] as const) {
    state = agentReducer(state, { type: "steerAccepted", runId: "run-steer", projectId: null, inputId, task, acceptOrder, acceptedAt: 1_000 + acceptOrder });
  }
  const before = buildMessageBlockRecords(state);
  assert.deepEqual(before.map((block) => block.blockId), ["run-steer:task", "run-steer:work:run-steer:task", "s1", "s2"]);
  assert.deepEqual(before.map((block) => block.kind), ["user", "assistant", "user", "user"]);
  assert.deepEqual(before.filter((block) => block.kind === "assistant").map((block) => ({
    anchor: block.anchorInputId, turns: block.turnIds, working: block.isWorking,
  })), [{ anchor: "run-steer:task", turns: ["turn-old"], working: true }]);
  assert.deepEqual(state.runs["run-steer"].pendingInputIds, ["s1", "s2"]);

  state = event(state, { type: "assistantDelta", runId: "run-steer", turnId: "turn-old", delta: "继续输出" });
  assert.equal(state.runs["run-steer"].turns["turn-old"].assistantContent, "旧回复继续输出");
  assert.equal(buildMessageBlockRecords(state).find((block) => block.blockId === "run-steer:work:run-steer:task")?.text, undefined, "streamed prose has no final answer identity");

  state = event(state, { type: "turnCompleted", runId: "run-steer", turnId: "turn-old" });
  state = event(state, { type: "inputsApplied", runId: "run-steer", inputIds: ["s1", "s2"], startedAt: 2_000 });
  assert.deepEqual(buildMessageBlockRecords(state).filter((block) => block.kind === "assistant").map((block) => block.blockId), ["run-steer:work:run-steer:task"]);
  state = event(state, { type: "turnStarted", runId: "run-steer", turnId: "turn-new", turnOrdinal: 2 });
  state = event(state, { type: "assistantDelta", runId: "run-steer", turnId: "turn-new", delta: "新回复" });
  const after = buildMessageBlockRecords(state);
  assert.deepEqual(after.filter((block) => block.kind === "user").map((block) => block.blockId), ["run-steer:task", "s1", "s2"]);
  assert.ok(after.findIndex((block) => block.blockId === "s2") < after.findIndex((block) => block.blockId === "run-steer:work:s2"));
  assert.deepEqual(state.runs["run-steer"].pendingInputIds, []);
  assert.deepEqual(after.filter((block) => block.kind === "assistant").map((block) => block.isWorking), [false, true]);

  state = event(state, { type: "runCompleted", runId: "run-steer", status: "completed", turnCount: 2, finalTurnId: "turn-new", finalDurationMs: 800 });
  assert.deepEqual(buildMessageBlockRecords(state).filter((block) => block.kind === "assistant").map((block) => block.showDuration), [false, true]);
  assert.deepEqual(state.runs["run-steer"].timeline, [
    { kind: "user", inputId: "run-steer:task" },
    { kind: "assistant", turnId: "turn-old" },
    { kind: "user", inputId: "s1" },
    { kind: "user", inputId: "s2" },
    { kind: "assistant", turnId: "turn-new" },
  ]);
});

test("a steer ACK before a queued turn start cannot reanchor that turn when the input is later applied", () => {
  let state = acceptRun("run-queued", "原任务");
  state = agentReducer(state, {
    type: "steerAccepted", runId: "run-queued", projectId: null, inputId: "steer", task: "补充", acceptOrder: 1, acceptedAt: 1_500,
  });
  assert.equal(state.runs["run-queued"].appliedInputId, "run-queued:task");
  state = event(state, { type: "turnStarted", runId: "run-queued", turnId: "turn-old", turnOrdinal: 1 });
  state = event(state, { type: "assistantDelta", runId: "run-queued", turnId: "turn-old", delta: "继续处理原任务" });
  const oldBlocks = buildMessageBlockRecords(state);
  assert.deepEqual(oldBlocks.map((block) => block.blockId), ["run-queued:task", "run-queued:work:run-queued:task", "steer"]);
  assert.equal(state.runs["run-queued"].turns["turn-old"].anchorInputId, "run-queued:task");

  state = event(state, { type: "inputsApplied", runId: "run-queued", inputIds: ["steer"], startedAt: 2_000 });
  assert.equal(state.runs["run-queued"].appliedInputId, "steer");
  assert.equal(state.runs["run-queued"].turns["turn-old"].anchorInputId, "run-queued:task");
  assert.deepEqual(buildMessageBlockRecords(state), oldBlocks);

  state = event(state, { type: "turnStarted", runId: "run-queued", turnId: "turn-new", turnOrdinal: 2 });
  assert.equal(state.runs["run-queued"].turns["turn-new"].anchorInputId, "steer");
  assert.deepEqual(buildMessageBlockRecords(state).filter((block) => block.kind === "assistant").map((block) => ({
    id: block.blockId, turns: block.turnIds, working: block.isWorking,
  })), [
    { id: "run-queued:work:run-queued:task", turns: ["turn-old"], working: false },
    { id: "run-queued:work:steer", turns: ["turn-new"], working: true },
  ]);
});

test("out-of-order application and ACK merge by input ID while terminal rejection marks only unapplied text", () => {
  let state = acceptRun("run-race");
  state = event(state, { type: "inputsApplied", runId: "run-race", inputIds: ["fast"], startedAt: 2_000 });
  state = agentReducer(state, { type: "steerAccepted", runId: "run-race", projectId: null, inputId: "fast", task: "快速补充", acceptOrder: 1, acceptedAt: 1_500 });
  state = agentReducer(state, { type: "steerAccepted", runId: "run-race", projectId: null, inputId: "slow", task: "尚待处理", acceptOrder: 2, acceptedAt: 1_600 });
  state = event(state, { type: "runCompleted", runId: "run-race", status: "cancelled", turnCount: 1, unappliedInputIds: ["slow"] });
  assert.equal(state.runs["run-race"].inputs.fast.status, "applied");
  assert.equal(state.runs["run-race"].inputs.slow.status, "interrupted");
  assert.equal(buildMessageBlockRecords(state).filter((block) => block.blockId === "fast").length, 1);
  assert.equal(buildMessageBlockRecords(state).filter((block) => block.blockId === "slow").length, 1);
  assert.deepEqual(buildMessageBlockRecords(state).map((block) => block.blockId), ["run-race:task", "fast", "slow"]);
});

test("tool-call completion keeps assistant text and tools in the same turn block before toolStarted arrives", () => {
  let state = acceptRun("run-tool-text");
  state = event(state, { type: "turnStarted", runId: "run-tool-text", turnId: "turn-1", turnOrdinal: 1 });
  state = event(state, {
    type: "assistantCompleted",
    runId: "run-tool-text",
    turnId: "turn-1",
    content: "先查看目录",
    completedAt: 2_000,
    toolCalls: [{ id: "call-1", name: "list_dir", input: { path: "." }, inputComplete: true }],
    stopReason: "tool_use",
  });
  assert.deepEqual(state.runs["run-tool-text"].turns["turn-1"].toolOrder, ["call-1"]);
  assert.deepEqual(buildMessageBlockRecords(state).map((block) => block.blockId), ["run-tool-text:task", "run-tool-text:work:run-tool-text:task"]);
  assert.deepEqual(buildMessageBlockRecords(state).map((block) => block.kind), ["user", "assistant"]);
});

test("FIFO ACK order, application before ACK and late ACK preserve one timeline item per input", () => {
  let state = acceptRun("run-order");
  state = event(state, { type: "turnStarted", runId: "run-order", turnId: "turn-a", turnOrdinal: 1 });
  state = event(state, { type: "assistantDelta", runId: "run-order", turnId: "turn-a", delta: "A" });
  state = agentReducer(state, { type: "steerAccepted", runId: "run-order", projectId: null, inputId: "second", task: "第二条", acceptOrder: 2, acceptedAt: 2_000 });
  state = agentReducer(state, { type: "steerAccepted", runId: "run-order", projectId: null, inputId: "first", task: "第一条", acceptOrder: 1, acceptedAt: 1_900 });
  assert.deepEqual(buildMessageBlockRecords(state).map((block) => block.blockId), ["run-order:task", "run-order:work:run-order:task", "first", "second"]);

  state = event(state, { type: "inputsApplied", runId: "run-order", inputIds: ["first", "second", "third"], startedAt: 3_000 });
  const appliedTimeline = state.runs["run-order"].timeline;
  state = event(state, { type: "inputsApplied", runId: "run-order", inputIds: ["first", "second", "third"], startedAt: 3_000 });
  assert.strictEqual(state.runs["run-order"].timeline, appliedTimeline);
  state = event(state, { type: "turnStarted", runId: "run-order", turnId: "turn-b", turnOrdinal: 2 });
  state = event(state, { type: "assistantDelta", runId: "run-order", turnId: "turn-b", delta: "B" });
  const timelineBeforeLateAck = state.runs["run-order"].timeline;
  const groupsBeforeLateAck = buildMessageBlockRecords(state).filter((block) => block.kind === "assistant");
  assert.deepEqual(groupsBeforeLateAck.map((block) => block.blockId), ["run-order:work:run-order:task", "run-order:work:third"]);
  state = agentReducer(state, { type: "steerAccepted", runId: "run-order", projectId: null, inputId: "third", task: "第三条", acceptOrder: 3, acceptedAt: 2_100 });
  assert.deepEqual(buildMessageBlockRecords(state).map((block) => block.blockId), [
    "run-order:task", "run-order:work:run-order:task", "first", "second", "third", "run-order:work:third",
  ]);
  assert.strictEqual(state.runs["run-order"].timeline, timelineBeforeLateAck);
  assert.deepEqual(buildMessageBlockRecords(state).filter((block) => block.kind === "assistant"), groupsBeforeLateAck);
  assert.deepEqual(state.runs["run-order"].timeline.filter((item) => item.kind === "user").map((item) => item.inputId), ["run-order:task", "first", "second", "third"]);
  assert.deepEqual(state.runs["run-order"].pendingInputIds, []);
  assert.equal(state.runs["run-order"].inputs.third.status, "applied");
});

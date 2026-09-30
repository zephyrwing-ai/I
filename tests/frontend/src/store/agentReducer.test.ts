import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, OutputFileDescriptor } from "../../../../shell/shared/ipc.js";
import { agentReducer, initialAgentState } from "../../../../frontend/src/store/agentReducer.js";
import { buildMessageBlockRecords } from "../../../../frontend/src/store/messageBlocks.js";

function acceptRun(runId: string, task = `task for ${runId}`) {
  let state = agentReducer(initialAgentState, { type: "runRequested" });
  return agentReducer(state, { type: "runAccepted", runId, inputId: `${runId}:task`, projectId: null, task, taskAt: 1_000 });
}

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
  assert.deepEqual(before.map((block) => block.blockId), ["run-steer:task", "run-steer:work:run-steer:task", "s1", "s2", "run-steer:work:s2"]);
  assert.deepEqual(before.map((block) => block.kind), ["user", "assistant", "user", "user"]);

  state = event(state, { type: "turnCompleted", runId: "run-steer", turnId: "turn-old" });
  state = event(state, { type: "inputsApplied", runId: "run-steer", inputIds: ["s1", "s2"], startedAt: 2_000 });
  state = event(state, { type: "turnStarted", runId: "run-steer", turnId: "turn-new", turnOrdinal: 2 });
  state = event(state, { type: "assistantDelta", runId: "run-steer", turnId: "turn-new", delta: "新回复" });
  const after = buildMessageBlockRecords(state);
  assert.deepEqual(after.filter((block) => block.kind === "user").map((block) => block.blockId), ["run-steer:task", "s1", "s2"]);
  assert.ok(after.findIndex((block) => block.blockId === "s2") < after.findIndex((block) => block.blockId === "run-steer:work:s2"));
  assert.deepEqual(state.runs["run-steer"].pendingInputIds, []);

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
  assert.deepEqual(buildMessageBlockRecords(state).map((block) => block.blockId), ["run-order:task", "run-order:work:run-order:task", "first", "second", "run-order:work:second"]);

  state = event(state, { type: "inputsApplied", runId: "run-order", inputIds: ["first", "second", "third"], startedAt: 3_000 });
  const appliedTimeline = state.runs["run-order"].timeline;
  state = event(state, { type: "inputsApplied", runId: "run-order", inputIds: ["first", "second", "third"], startedAt: 3_000 });
  assert.strictEqual(state.runs["run-order"].timeline, appliedTimeline);
  state = event(state, { type: "turnStarted", runId: "run-order", turnId: "turn-b", turnOrdinal: 2 });
  state = event(state, { type: "assistantDelta", runId: "run-order", turnId: "turn-b", delta: "B" });
  state = agentReducer(state, { type: "steerAccepted", runId: "run-order", projectId: null, inputId: "third", task: "第三条", acceptOrder: 3, acceptedAt: 2_100 });
  assert.deepEqual(buildMessageBlockRecords(state).map((block) => block.blockId), [
    "run-order:task", "run-order:work:run-order:task", "first", "second", "run-order:work:second", "third", "run-order:work:third",
  ]);
  assert.deepEqual(state.runs["run-order"].pendingInputIds, []);
  assert.equal(state.runs["run-order"].inputs.third.status, "applied");
});

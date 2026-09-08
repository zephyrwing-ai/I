import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, OutputFileDescriptor } from "../../../../shell/shared/ipc.js";
import { agentReducer, initialAgentState } from "../../../../frontend/src/store/agentReducer.js";

function acceptRun(runId: string, task = `task for ${runId}`) {
  let state = agentReducer(initialAgentState, { type: "runRequested" });
  return agentReducer(state, { type: "runAccepted", runId, task, taskAt: 1_000 });
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

test("a rejected start exposes the error without creating a phantom run", () => {
  let state = agentReducer(initialAgentState, { type: "runRequested" });
  state = agentReducer(state, { type: "runRejected", error: "请选择模型。" });

  assert.equal(state.status, "failed");
  assert.equal(state.currentRunId, null);
  assert.equal(state.error, "请选择模型。");
  assert.deepEqual(state.runOrder, []);
  assert.deepEqual(state.runs, {});
});

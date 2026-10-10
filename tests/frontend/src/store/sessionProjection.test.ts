import assert from "node:assert/strict";
import test from "node:test";
import { mergePersistedEntries } from "../../../../frontend/src/store/sessionProjection";
import { buildMessageBlockRecords } from "../../../../frontend/src/store/messageBlocks";
import { agentReducer, initialAgentState } from "../../../../frontend/src/store/agentReducer";
import {
  buildVirtualMessageLayout,
  calculateVirtualMessageRange,
  scrollToBottomInstant,
  shouldStickToBottom,
} from "../../../../frontend/src/middle-column/message-stream/useVirtualMessageWindow";
import type { HistoryPageEntry } from "../../../../shell/shared/ipc";

function entry(partial: Partial<HistoryPageEntry> & Pick<HistoryPageEntry, "entryId" | "entryOrder" | "type" | "runId" | "payload">): HistoryPageEntry {
  return {
    entryId: partial.entryId,
    entryOrder: partial.entryOrder,
    projectId: partial.projectId ?? null,
    type: partial.type,
    status: partial.status ?? "completed",
    runId: partial.runId,
    turnId: partial.turnId ?? null,
    toolCallId: partial.toolCallId ?? null,
    revision: partial.revision ?? 0,
    payload: partial.payload,
    createdAt: partial.createdAt ?? partial.entryOrder,
    completedAt: partial.completedAt ?? null,
    durationMs: partial.durationMs ?? null,
    ...(partial.toolResult ? { toolResult: partial.toolResult } : {}),
  };
}

test("history projection rebuilds runs, turns and tool results from persisted entries", () => {
  const projected = mergePersistedEntries({ runs: {}, runOrder: [] }, [
    entry({ entryId: "u1", entryOrder: 1, type: "user_message", runId: "run-1", payload: { role: "user", content: "读取文件" } }),
    entry({
      entryId: "a1",
      entryOrder: 2,
      type: "assistant_message",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_234,
      payload: {
        role: "assistant",
        content: "我来读取。",
        reasoning: "需要先查看文件。",
        toolCalls: [{ id: "call-1", name: "read", input: { path: "README.md" }, inputComplete: true }],
      },
    }),
    entry({
      entryId: "t1",
      entryOrder: 3,
      type: "tool_result",
      runId: "run-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      payload: { role: "tool", content: "内容", toolCallId: "call-1", toolName: "read" },
    }),
  ]);

  const run = projected.runs["run-1"]!;
  const turn = run.turns["turn-1"]!;
  assert.deepEqual(projected.runOrder, ["run-1"]);
  assert.equal(run.inputs.u1?.task, "读取文件");
  assert.deepEqual(run.timeline, [{ kind: "user", inputId: "u1" }, { kind: "assistant", turnId: "turn-1" }]);
  assert.equal(turn.assistantAt, 1_700_000_001_234);
  assert.equal(turn.anchorInputId, "u1");
  assert.equal(turn.reasoningContent, "需要先查看文件。");
  assert.equal(turn.tools["call-1"]?.status, "completed");
  assert.equal(turn.tools["call-1"]?.result?.output, "内容");
});

test("history projection preserves the public tool outcome rather than reconstructing it from model text", () => {
  const toolResult = { ok: false, output: "raw output", returncode: 37, truncated: true, error: "command_failed" };
  const projected = mergePersistedEntries({ runs: {}, runOrder: [] }, [entry({
    entryId: "tool", entryOrder: 1, type: "tool_result", runId: "run", turnId: "turn", toolCallId: "call",
    payload: { role: "tool", content: "<returncode>37</returncode>\n<output>raw output</output>", toolCallId: "call", toolName: "bash", isError: true },
    toolResult,
  })]);
  assert.deepEqual(projected.runs.run.turns.turn.tools.call.result, toolResult);
});

test("history projection restores two steering inputs, the continued answer and an unapplied tail", () => {
  const projected = mergePersistedEntries({ runs: {}, runOrder: [] }, [
    entry({ entryId: "u1", entryOrder: 1, type: "user_message", runId: "run-steer", payload: { role: "user", content: "原任务" } }),
    entry({ entryId: "a1", entryOrder: 2, type: "assistant_message", runId: "run-steer", turnId: "turn-1", payload: { role: "assistant", content: "前一段回复" } }),
    entry({ entryId: "s1", entryOrder: 3, type: "user_message", runId: "run-steer", payload: { role: "user", content: "补充一" } }),
    entry({ entryId: "s2", entryOrder: 4, type: "user_message", runId: "run-steer", payload: { role: "user", content: "补充二" } }),
    entry({ entryId: "a2", entryOrder: 5, type: "assistant_message", runId: "run-steer", turnId: "turn-2", durationMs: 900, payload: { role: "assistant", content: "新的回复" } }),
    entry({ entryId: "s3", entryOrder: 6, type: "user_message", status: "interrupted", runId: "run-steer", payload: { role: "user", content: "未应用的补充" } }),
  ]);
  const run = projected.runs["run-steer"]!;
  assert.deepEqual(run.timeline, [
    { kind: "user", inputId: "u1" },
    { kind: "assistant", turnId: "turn-1" },
    { kind: "user", inputId: "s1" },
    { kind: "user", inputId: "s2" },
    { kind: "assistant", turnId: "turn-2" },
    { kind: "user", inputId: "s3" },
  ]);
  assert.deepEqual(run.pendingInputIds, ["s3"]);
  assert.equal(run.inputs.s3.status, "interrupted");
  const blocks = buildMessageBlockRecords(projected);
  assert.deepEqual(blocks.map((block) => block.blockId), ["u1", "run-steer:work:u1", "s1", "s2", "run-steer:work:s2", "s3"]);
  assert.deepEqual(blocks.filter((block) => block.kind === "user").map((block) => block.blockId), ["u1", "s1", "s2", "s3"]);
  assert.deepEqual(blocks.filter((block) => block.kind === "assistant").map((block) => block.text), ["前一段回复", "新的回复"]);
  assert.deepEqual(blocks.filter((block) => block.kind === "assistant").map((block) => block.showDuration), [false, true]);
});

test("live steering and reloaded history produce the same message groups after a late ACK", () => {
  const runId = "run-parity";
  let live = agentReducer(initialAgentState, {
    type: "runAccepted", runId, projectId: null, inputId: "u1", task: "原任务", taskAt: 100,
  });
  live = agentReducer(live, { type: "steerAccepted", runId, projectId: null, inputId: "s1", task: "补充一", acceptOrder: 1, acceptedAt: 300 });
  live = agentReducer(live, { type: "event", event: { type: "turnStarted", runId, turnId: "turn-1", turnOrdinal: 1 } });
  live = agentReducer(live, { type: "event", event: {
    type: "assistantCompleted", runId, turnId: "turn-1", content: "旧回答", completedAt: 200, toolCalls: [], stopReason: "stop",
  } });
  live = agentReducer(live, { type: "event", event: { type: "inputsApplied", runId, inputIds: ["s1", "s2"], startedAt: 500 } });
  live = agentReducer(live, { type: "event", event: { type: "turnStarted", runId, turnId: "turn-2", turnOrdinal: 2 } });
  live = agentReducer(live, { type: "event", event: {
    type: "assistantCompleted", runId, turnId: "turn-2", content: "新回答", completedAt: 600, toolCalls: [], stopReason: "stop",
  } });
  live = agentReducer(live, { type: "steerAccepted", runId, projectId: null, inputId: "s2", task: "补充二", acceptOrder: 2, acceptedAt: 400 });
  live = agentReducer(live, { type: "steerAccepted", runId, projectId: null, inputId: "s3", task: "未应用输入", acceptOrder: 3, acceptedAt: 550 });
  live = agentReducer(live, { type: "event", event: {
    type: "runCompleted", runId, status: "completed", turnCount: 2, finalTurnId: "turn-2", finalDurationMs: 500, unappliedInputIds: ["s3"],
  } });
  const reloaded = mergePersistedEntries({ runs: {}, runOrder: [] }, [
    entry({ entryId: "u1", entryOrder: 1, type: "user_message", runId, createdAt: 100, payload: { role: "user", content: "原任务" } }),
    entry({ entryId: "a1", entryOrder: 2, type: "assistant_message", runId, turnId: "turn-1", completedAt: 200, payload: { role: "assistant", content: "旧回答" } }),
    entry({ entryId: "s1", entryOrder: 3, type: "user_message", runId, createdAt: 300, payload: { role: "user", content: "补充一" } }),
    entry({ entryId: "s2", entryOrder: 4, type: "user_message", runId, createdAt: 400, payload: { role: "user", content: "补充二" } }),
    entry({ entryId: "a2", entryOrder: 5, type: "assistant_message", runId, turnId: "turn-2", completedAt: 600, durationMs: 500, payload: { role: "assistant", content: "新回答" } }),
    entry({ entryId: "s3", entryOrder: 6, type: "user_message", status: "interrupted", runId, createdAt: 550, payload: { role: "user", content: "未应用输入" } }),
  ]);

  assert.deepEqual(buildMessageBlockRecords(live), buildMessageBlockRecords(reloaded));
  assert.equal(live.runs[runId].appliedInputId, "s2");
  assert.equal(reloaded.runs[runId].appliedInputId, "s2");
  assert.deepEqual(Object.values(reloaded.runs[runId].turns).map((turn) => turn.anchorInputId), ["u1", "s2"]);
  assert.deepEqual(buildMessageBlockRecords(reloaded).map((block) => block.blockId), [
    "u1", "run-parity:work:u1", "s1", "s2", "run-parity:work:s2", "s3",
  ]);
});

test("older pages rebuild stable block IDs and select only the last legacy duration", () => {
  const all = [
    entry({ entryId: "u1", entryOrder: 1, type: "user_message", runId: "run-legacy", payload: { role: "user", content: "开始" } }),
    entry({ entryId: "a1", entryOrder: 2, type: "assistant_message", runId: "run-legacy", turnId: "turn-a", durationMs: 100, payload: { role: "assistant", content: "旧回答" } }),
    entry({ entryId: "s1", entryOrder: 3, type: "user_message", runId: "run-legacy", payload: { role: "user", content: "补充" } }),
    entry({ entryId: "a2", entryOrder: 4, type: "assistant_message", runId: "run-legacy", turnId: "turn-b", durationMs: 300, payload: { role: "assistant", content: "最终回答" } }),
  ];
  const latest = mergePersistedEntries({ runs: {}, runOrder: [] }, all.slice(2));
  const complete = mergePersistedEntries(latest, [...all].reverse());
  const blocks = buildMessageBlockRecords(complete);
  assert.deepEqual(blocks.map((block) => block.blockId), ["u1", "run-legacy:work:u1", "s1", "run-legacy:work:s1"]);
  assert.deepEqual(blocks.filter((block) => block.kind === "assistant").map((block) => block.showDuration), [false, true]);
  assert.equal(complete.runs["run-legacy"].turns["turn-a"].assistantDurationMs, undefined);
  assert.equal(complete.runs["run-legacy"].finalTurnId, "turn-b");
});

test("history duration ownership ignores non-completed assistant entries", () => {
  const projected = mergePersistedEntries({ runs: {}, runOrder: [] }, [
    entry({ entryId: "u1", entryOrder: 1, type: "user_message", runId: "run-status", payload: { role: "user", content: "任务" } }),
    entry({ entryId: "a1", entryOrder: 2, type: "assistant_message", runId: "run-status", turnId: "turn-a", durationMs: 100, payload: { role: "assistant", content: "已完成" } }),
    entry({ entryId: "a2", entryOrder: 3, type: "assistant_message", status: "failed", runId: "run-status", turnId: "turn-b", durationMs: 200, payload: { role: "assistant", content: "失败片段" } }),
  ]);
  const run = projected.runs["run-status"];
  assert.equal(run.finalTurnId, "turn-a");
  assert.equal(run.turns["turn-b"].assistantDurationMs, undefined);
  assert.deepEqual(buildMessageBlockRecords(projected).map((block) => block.blockId), ["u1", "run-status:work:u1"]);
  assert.deepEqual(buildMessageBlockRecords(projected).filter((block) => block.kind === "assistant").map((block) => block.showDuration), [false]);
});

test("history tool-only turn remains a locatable assistant block", () => {
  const projected = mergePersistedEntries({ runs: {}, runOrder: [] }, [
    entry({ entryId: "u1", entryOrder: 1, type: "user_message", runId: "run-tools", payload: { role: "user", content: "检查" } }),
    entry({ entryId: "t1", entryOrder: 2, type: "tool_result", runId: "run-tools", turnId: "turn-tools", toolCallId: "call-1", payload: { role: "tool", content: "结果", toolCallId: "call-1", toolName: "read" } }),
  ]);
  assert.deepEqual(buildMessageBlockRecords(projected).map((block) => block.blockId), ["u1", "run-tools:work:u1"]);
  assert.equal(projected.runs["run-tools"].turns["turn-tools"].tools["call-1"].result?.output, "结果");
});

test("virtual message range keeps a bounded window and spacer sizes", () => {
  const layout = buildVirtualMessageLayout(
    Array.from({ length: 100 }, (_, index) => ({ blockId: `block-${index}`, estimatedHeight: 20 })),
    new Map(),
  );
  const range = calculateVirtualMessageRange(layout, 1000, 100, 40);
  assert.ok(range.startIndex > 0);
  assert.ok(range.endIndex - range.startIndex < 20);
  assert.equal(range.topSpacer, range.startIndex * 20);
  assert.equal(range.topSpacer + (range.endIndex - range.startIndex) * 20 + range.bottomSpacer, layout.totalSize);
});

test("stream auto-follow stops once the user leaves the bottom threshold", () => {
  assert.equal(shouldStickToBottom(900, 1000, 1900), true);
  assert.equal(shouldStickToBottom(876, 1000, 1900), true);
  assert.equal(shouldStickToBottom(875, 1000, 1900), false);
});

test("initial latest positioning is instant rather than animated", () => {
  const calls: Array<{ top: number; behavior: string }> = [];
  scrollToBottomInstant({
    scrollHeight: 1900,
    scrollTo(options: { top: number; behavior: string }) {
      calls.push(options);
    },
  });
  assert.deepEqual(calls, [{ top: 1900, behavior: "instant" }]);
});

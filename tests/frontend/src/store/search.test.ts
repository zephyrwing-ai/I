import assert from "node:assert/strict";
import test from "node:test";
import type { AgentState, RunState, TurnState } from "../../../../frontend/src/store/agentReducer.js";
import { buildSearchIndex, searchMessageBlocks } from "../../../../frontend/src/store/search.js";

function turn(partial: Partial<TurnState> & Pick<TurnState, "turnId">): TurnState {
  return {
    turnId: partial.turnId,
    turnOrdinal: partial.turnOrdinal ?? 1,
    status: partial.status ?? "completed",
    assistantContent: partial.assistantContent ?? "",
    reasoningContent: partial.reasoningContent ?? "",
    toolOrder: partial.toolOrder ?? [],
    tools: partial.tools ?? {},
    finalContent: partial.finalContent,
  };
}

function run(partial: Partial<RunState> & Pick<RunState, "runId">): RunState {
  return {
    runId: partial.runId,
    task: partial.task,
    taskAt: partial.taskAt,
    status: partial.status ?? "completed",
    turnOrder: partial.turnOrder ?? [],
    turns: partial.turns ?? {},
    outputFileOrder: [],
    outputFiles: {},
  };
}

function state(runs: RunState[]): Pick<AgentState, "runOrder" | "runs"> {
  return {
    runOrder: runs.map(({ runId }) => runId),
    runs: Object.fromEntries(runs.map((item) => [item.runId, item])),
  };
}

test("buildSearchIndex creates one entry per user or final model message block", () => {
  const indexed = buildSearchIndex(state([
    run({
      runId: "run-1",
      task: "检查项目",
      turnOrder: ["turn-1", "turn-2"],
      turns: {
        "turn-1": turn({
          turnId: "turn-1",
          assistantContent: "读取完成",
          reasoningContent: "查看目录",
          toolOrder: ["tool-1"],
        }),
        "turn-2": turn({
          turnId: "turn-2",
          assistantContent: "最终答案",
          finalContent: "最终答案",
        }),
      },
    }),
  ]));

  assert.deepEqual(indexed, [
    { blockId: "run-1:task", text: "检查项目" },
    { blockId: "run-1:answer:turn-2", text: "最终答案" },
  ]);
});

test("buildSearchIndex includes the current streaming final message and follows run order", () => {
  const indexed = buildSearchIndex(state([
    run({ runId: "run-2", task: "第二条" }),
    run({
      runId: "run-1",
      task: "第一条",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": turn({
          turnId: "turn-1",
          status: "running",
          assistantContent: "正在生成答案",
        }),
      },
    }),
  ]));

  assert.deepEqual(indexed, [
    { blockId: "run-2:task", text: "第二条" },
    { blockId: "run-1:task", text: "第一条" },
    { blockId: "run-1:answer:turn-1", text: "正在生成答案" },
  ]);
});

test("searchMessageBlocks matches case-insensitively and returns only the first match per block", () => {
  const [result] = searchMessageBlocks([
    { blockId: "run-1:task", text: "Before Hello, then hello again" },
  ], "HELLO", { contextChars: 7 });

  assert.equal(result.blockId, "run-1:task");
  assert.equal(result.text, "Before Hello, then hello again");
  assert.deepEqual(result.matchRange, { start: 7, end: 12 });
  assert.equal(result.snippet, "Before Hello, then …");
  assert.deepEqual(result.snippetMatchRange, { start: 7, end: 12 });
});

test("searchMessageBlocks preserves the complete first hit while ellipsizing surrounding context", () => {
  const [result] = searchMessageBlocks([
    { blockId: "answer-1", text: "0123456789MATCHabcdefghij" },
  ], "match", { contextChars: 2 });

  assert.equal(result.snippet, "…89MATCHab…");
  assert.deepEqual(result.matchRange, { start: 10, end: 15 });
  assert.deepEqual(result.snippetMatchRange, { start: 3, end: 8 });
});

test("searchMessageBlocks returns no results for blank queries or unmatched text", () => {
  const blocks = [{ blockId: "run-1:task", text: "检查项目" }];

  assert.deepEqual(searchMessageBlocks(blocks, "   "), []);
  assert.deepEqual(searchMessageBlocks(blocks, "不存在"), []);
});

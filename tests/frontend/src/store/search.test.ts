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
    stopReason: partial.stopReason,
  };
}

function run(partial: Partial<RunState> & Pick<RunState, "runId"> & { task?: string; turnIds?: string[] }): RunState {
  const inputId = `${partial.runId}:task`;
  return {
    runId: partial.runId,
    projectId: null,
    inputs: partial.task ? { [inputId]: { inputId, task: partial.task, at: 1_000, status: "applied" } } : {},
    pendingInputIds: [],
    timeline: [
      ...(partial.task ? [{ kind: "user" as const, inputId }] : []),
      ...(partial.turnIds ?? []).map((turnId) => ({ kind: "assistant" as const, turnId })),
    ],
    status: partial.status ?? "completed",
    finalTurnId: partial.finalTurnId,
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

test("buildSearchIndex creates one entry per user or visible model message block", () => {
  const indexed = buildSearchIndex(state([
    run({
      runId: "run-1",
      task: "检查项目",
      turnIds: ["turn-1", "turn-2"],
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
    { blockId: "run-1:work:run-1:task", text: "最终答案" },
  ]);
  assert.deepEqual(searchMessageBlocks(indexed, "读取完成"), []);
  assert.deepEqual(searchMessageBlocks(indexed, "查看目录"), []);
});

test("tool-loop activity is readable in its fold while only the user's message and answer are searchable", () => {
  const toolRun = run({
    runId: "run-tools", task: "检查项目", turnIds: ["tool-turn", "answer-turn"], finalTurnId: "answer-turn",
    turns: {
      "tool-turn": turn({
        turnId: "tool-turn", assistantContent: "准备读取文件", reasoningContent: "思考读取步骤", toolOrder: ["call-1"],
        tools: { "call-1": {
          toolCallId: "call-1", name: "read", input: { path: "secret-path.md" }, status: "completed",
          result: { ok: true, output: "工具原始输出", returncode: 0, truncated: false },
        } },
      }),
      "answer-turn": turn({ turnId: "answer-turn", assistantContent: "最终回答", finalContent: "最终回答" }),
    },
  });
  const indexed = buildSearchIndex(state([toolRun]));
  for (const text of ["准备读取文件", "思考读取步骤", "secret-path.md", "工具原始输出"]) {
    assert.deepEqual(searchMessageBlocks(indexed, text), [], text);
  }
  assert.deepEqual(indexed, [
    { blockId: "run-tools:task", text: "检查项目" },
    { blockId: "run-tools:work:run-tools:task", text: "最终回答" },
  ]);

  toolRun.timeline.pop();
  delete toolRun.turns["answer-turn"];
  toolRun.finalTurnId = undefined;
  assert.deepEqual(buildSearchIndex(state([toolRun])), [{ blockId: "run-tools:task", text: "检查项目" }]);
});

test("a streaming body leaves the search index when it becomes tool activity and returns with the next answer", () => {
  const current = run({
    runId: "run-stream", task: "检查", status: "running", turnIds: ["turn-1"],
    turns: { "turn-1": turn({ turnId: "turn-1", status: "running", assistantContent: "生成中的正文" }) },
  });
  const index = () => buildSearchIndex(state([current]));
  assert.equal(searchMessageBlocks(index(), "生成中的正文").length, 1);
  current.turns["turn-1"].stopReason = "tool_use";
  current.turns["turn-1"].toolOrder = ["call-1"];
  assert.deepEqual(searchMessageBlocks(index(), "生成中的正文"), []);

  current.timeline.push({ kind: "assistant", turnId: "turn-2" });
  current.turns["turn-2"] = turn({ turnId: "turn-2", status: "running", assistantContent: "新的回答正文" });
  assert.deepEqual(index(), [
    { blockId: "run-stream:task", text: "检查" },
    { blockId: "run-stream:work:run-stream:task", text: "新的回答正文" },
  ]);
});

test("each steer group's externally displayed answer stays searchable beside its user messages", () => {
  const current = run({
    runId: "run-steer", task: "原任务", finalTurnId: "turn-new",
    turns: {
      "turn-old": turn({ turnId: "turn-old", assistantContent: "前一段回答" }),
      "turn-tool": turn({ turnId: "turn-tool", assistantContent: "内部操作正文", stopReason: "tool_use", toolOrder: ["call-1"] }),
      "turn-new": turn({ turnId: "turn-new", assistantContent: "补充后的回答" }),
    },
  });
  current.inputs.s1 = { inputId: "s1", task: "补充一", at: 2_000, status: "applied" };
  current.inputs.s2 = { inputId: "s2", task: "补充二", at: 2_100, status: "applied" };
  current.timeline.push(
    { kind: "assistant", turnId: "turn-old" },
    { kind: "user", inputId: "s1" }, { kind: "user", inputId: "s2" },
    { kind: "assistant", turnId: "turn-tool" }, { kind: "assistant", turnId: "turn-new" },
  );
  const indexed = buildSearchIndex(state([current]));
  assert.deepEqual(indexed, [
    { blockId: "run-steer:task", text: "原任务" },
    { blockId: "run-steer:work:run-steer:task", text: "前一段回答" },
    { blockId: "s1", text: "补充一" }, { blockId: "s2", text: "补充二" },
    { blockId: "run-steer:work:s2", text: "补充后的回答" },
  ]);
  assert.deepEqual(searchMessageBlocks(indexed, "内部操作正文"), []);
});

test("buildSearchIndex includes the current streaming final message and follows run order", () => {
  const indexed = buildSearchIndex(state([
    run({ runId: "run-2", task: "第二条" }),
    run({
      runId: "run-1",
      task: "第一条",
      turnIds: ["turn-1"],
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
    { blockId: "run-1:work:run-1:task", text: "正在生成答案" },
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

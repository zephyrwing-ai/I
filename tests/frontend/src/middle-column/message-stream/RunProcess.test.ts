import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunState, TurnState } from "../../../../../frontend/src/store/agentReducer.js";
import {
  RunProcess,
  formatElapsed,
} from "../../../../../frontend/src/middle-column/message-stream/RunProcess.js";

function turn(patch: Partial<TurnState> = {}): TurnState {
  return {
    turnId: "turn-1",
    turnOrdinal: 1,
    status: "running",
    assistantContent: "",
    reasoningContent: "",
    toolOrder: [],
    tools: {},
    ...patch,
  };
}

function run(turns: TurnState[]): RunState {
  return {
    runId: "run-1",
    status: "running",
    turnOrder: turns.map((item) => item.turnId),
    turns: Object.fromEntries(turns.map((item) => [item.turnId, item])),
    outputFileOrder: [],
    outputFiles: {},
  };
}

test("elapsed time follows the workbench display boundaries", () => {
  assert.equal(formatElapsed(-100), "0.0s");
  assert.equal(formatElapsed(9_949), "9.9s");
  assert.equal(formatElapsed(10_400), "10s");
  assert.equal(formatElapsed(126_000), "2m6s");
  assert.equal(formatElapsed(3_723_000), "1h2m3s");
});

test("a running tool-free last turn streams as the visible answer without copy metadata", () => {
  const state = run([
    turn({
      assistantContent: "正在生成，答案",
      reasoningContent: "内部过程",
    }),
  ]);
  const html = renderToStaticMarkup(createElement(RunProcess, {
    run: state,
    runTiming: { startedAt: Date.now() },
  }));

  assert.ok(html.includes("Working for"), html);
  assert.ok(html.includes('class="model-text final-answer markdown"'), html);
  assert.ok(html.includes("正在生成, 答案"), html);
  assert.ok(html.includes("内部过程"), html);
  assert.doesNotMatch(html, /aria-label="复制答案"/);
});

test("the latest completed tool-free turn is the final answer and shows copy metadata", () => {
  const state = run([
    turn({
      turnId: "tool-turn",
      status: "completed",
      assistantContent: "准备运行工具",
      toolOrder: ["tool-1"],
      tools: {
        "tool-1": {
          toolCallId: "tool-1",
          name: "bash",
          input: { command: "pwd" },
          status: "completed",
          result: { ok: true, output: "/tmp", returncode: 0, truncated: false },
        },
      },
    }),
    turn({
      turnId: "answer-turn",
      turnOrdinal: 2,
      status: "completed",
      assistantContent: "**最终答案**，完成。",
      finalContent: "**最终答案**，完成。",
    }),
  ]);
  const html = renderToStaticMarkup(createElement(RunProcess, {
    run: state,
    runTiming: { startedAt: 1_000, completedAt: 3_000 },
  }));

  assert.ok(html.includes("Worked for 2.0s"), html);
  assert.ok(html.includes("最终答案, 完成."), html);
  assert.doesNotMatch(html, /<strong>/);
  assert.match(html, /aria-label="复制答案"/);
});

test("assistant text moves into process details once its turn starts a tool", () => {
  const state = run([
    turn({
      assistantContent: "先检查目录",
      toolOrder: ["tool-1"],
      tools: {
        "tool-1": {
          toolCallId: "tool-1",
          name: "bash",
          input: { command: "ls" },
          status: "running",
        },
      },
    }),
  ]);
  const html = renderToStaticMarkup(createElement(RunProcess, { run: state }));

  assert.ok(html.includes("先检查目录"), html);
  assert.ok(html.includes("Ran ls"), html);
  assert.doesNotMatch(html, /final-answer/);
});

test("long tool output renders a bounded preview and an expansion control", () => {
  const output = `${"a".repeat(600)}${"b".repeat(1_500)}`;
  const state = run([
    turn({
      status: "completed",
      toolOrder: ["tool-1"],
      tools: {
        "tool-1": {
          toolCallId: "tool-1",
          name: "bash",
          input: { command: "generate" },
          status: "completed",
          result: { ok: true, output, returncode: 0, truncated: false },
        },
      },
    }),
  ]);
  const html = renderToStaticMarkup(createElement(RunProcess, { run: state }));

  assert.ok(html.includes(`${"a".repeat(600)}\n… 已折叠（共 2100 字符）`), html);
  assert.ok(html.includes("展开完整输出"), html);
  assert.ok(!html.includes("b".repeat(100)), "collapsed preview should not render the hidden tail");
});

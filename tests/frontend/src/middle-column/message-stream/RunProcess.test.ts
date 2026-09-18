import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunState, TurnState } from "../../../../../frontend/src/store/agentReducer.js";
import {
  FinalAnswer,
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

test("a running tool-free last turn keeps process and answer rendering as separate blocks", () => {
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
  const answerHtml = renderToStaticMarkup(createElement(FinalAnswer, {
    run: state,
    runTiming: { startedAt: Date.now() },
  }));

  assert.ok(html.includes("Working for"), html);
  assert.ok(html.includes("内部过程"), html);
  assert.doesNotMatch(html, /final-answer|正在生成, 答案|Copy answer/);
  assert.ok(answerHtml.includes('class="model-text final-answer markdown"'), answerHtml);
  assert.ok(answerHtml.includes("正在生成, 答案"), answerHtml);
  assert.doesNotMatch(answerHtml, /aria-label="Copy answer"/);
});

test("the latest completed tool-free turn is rendered by the separate final-answer block", () => {
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
  const answerHtml = renderToStaticMarkup(createElement(FinalAnswer, {
    run: state,
    runTiming: { startedAt: 1_000, completedAt: 3_000 },
  }));

  assert.ok(html.includes("Worked for 2.0s"), html);
  assert.doesNotMatch(html, /最终答案|final-answer|Copy answer/);
  assert.ok(answerHtml.includes("最终答案, 完成."), answerHtml);
  assert.doesNotMatch(answerHtml, /<strong>/);
  assert.match(answerHtml, /aria-label="Copy answer"/);
});

test("a persisted assistant message shows its timestamp in the final-answer block", () => {
  const state = run([
    turn({
      status: "completed",
      assistantContent: "历史答案",
      assistantAt: new Date(2026, 8, 17, 11, 45).getTime(),
    }),
  ]);
  const html = renderToStaticMarkup(createElement(FinalAnswer, { run: state }));

  assert.match(html, /Thu Sep 17 11:45 AM/);
  assert.match(html, /aria-label="Copy answer"/);
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

  assert.ok(html.includes(`${"a".repeat(600)}\n… Collapsed (2100 characters total)`), html);
  assert.ok(html.includes("Expand full output"), html);
  assert.ok(!html.includes("b".repeat(100)), "collapsed preview should not render the hidden tail");
});

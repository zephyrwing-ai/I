import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunState, TurnState } from "../../../../../frontend/src/store/agentReducer.js";
import {
  AssistantMessage,
  formatElapsed,
} from "../../../../../frontend/src/middle-column/message-stream/AssistantMessage.js";

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
  const inputId = "run-1:task";
  return {
    runId: "run-1",
    projectId: null,
    source: "live",
    inputs: { [inputId]: { inputId, task: "任务", at: 1_000, status: "applied" } },
    pendingInputIds: [],
    timeline: [
      { kind: "user", inputId },
      ...turns.map((item) => ({ kind: "assistant" as const, turnId: item.turnId })),
    ],
    status: "running",
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

test("a running assistant turn keeps reasoning collapsed and renders the streaming answer", () => {
  const state = run([
    turn({
      assistantContent: "正在生成，答案",
      reasoningContent: "内部过程",
    }),
  ]);
  const html = renderToStaticMarkup(createElement(AssistantMessage, {
    run: state,
    turnIds: ["turn-1"],
    answerTurnId: "turn-1",
    isWorking: true,
  }));

  assert.match(html, /aria-expanded="false"/);
  assert.match(html, />Working for</);
  assert.doesNotMatch(html, />Thinking</);
  assert.ok(html.indexOf("run-work-detail") < html.indexOf("内部过程"), html);
  assert.ok(html.includes('class="model-text final-answer markdown"'), html);
  assert.ok(html.includes("正在生成, 答案"), html);
  assert.doesNotMatch(html, /aria-label="Copy answer"/);
});

test("tool turns and the final model request share one work fold and one run duration", () => {
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
      assistantAt: 3_000,
    }),
  ]);
  const completed = { ...state, status: "completed" as const, finalTurnId: "answer-turn", finalDurationMs: 2_000 };
  const oldHtml = renderToStaticMarkup(createElement(AssistantMessage, {
    run: completed,
    turnIds: ["tool-turn"],
  }));
  const answerHtml = renderToStaticMarkup(createElement(AssistantMessage, {
    run: completed,
    turnIds: ["tool-turn", "answer-turn"],
    answerTurnId: "answer-turn",
    showDuration: true,
  }));

  assert.doesNotMatch(oldHtml, /Worked for|最终答案/);
  assert.match(oldHtml, /Ran commands/);
  assert.ok(answerHtml.includes("Worked for 2.0s"), answerHtml);
  assert.ok(answerHtml.includes("最终答案, 完成."), answerHtml);
  assert.doesNotMatch(answerHtml, /<strong>/);
  assert.match(answerHtml, /aria-label="Copy answer"/);
});

test("a persisted duration restores Worked for after reload", () => {
  const state = run([
    turn({
      status: "completed",
      assistantContent: "历史答案",
      assistantDurationMs: 2_000,
    }),
  ]);
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: { ...state, status: "completed", finalTurnId: "turn-1" }, turnIds: ["turn-1"], answerTurnId: "turn-1", showDuration: true }));
  assert.ok(html.includes("Worked for 2.0s"), html);
});

test("a persisted assistant message shows its timestamp in its assistant block", () => {
  const state = run([
    turn({
      status: "completed",
      assistantContent: "历史答案",
      assistantAt: new Date(2026, 8, 17, 11, 45).getTime(),
    }),
  ]);
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: state, turnIds: ["turn-1"], answerTurnId: "turn-1" }));

  assert.match(html, /Thu Sep 17 11:45 AM/);
  assert.match(html, /aria-label="Copy answer"/);
});

test("assistant text and tool actions stay together in the same assistant block", () => {
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
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: state, turnIds: ["turn-1"] }));

  assert.ok(html.includes("先检查目录"), html);
  assert.ok(html.includes("Ran ls"), html);
  assert.match(html, />Working for</);
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
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: state, turnIds: ["turn-1"] }));

  assert.ok(html.includes(`${"a".repeat(600)}\n… Collapsed (2100 characters total)`), html);
  assert.ok(html.includes("Expand full output"), html);
  assert.ok(!html.includes("b".repeat(100)), "collapsed preview should not render the hidden tail");
});

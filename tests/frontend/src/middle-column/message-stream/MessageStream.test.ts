import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunState } from "../../../../../frontend/src/store/agentReducer.js";

register("../../../css-module-loader.mjs", import.meta.url);

const { MessageStream } = await import("../../../../../frontend/src/middle-column/message-stream/MessageStream.js");

function run(runId: string, task: string): RunState {
  const inputId = `${runId}:task`;
  return {
    runId,
    projectId: null,
    inputs: { [inputId]: { inputId, task, at: 1_000, status: "applied" } },
    pendingInputIds: [],
    timeline: [{ kind: "user", inputId }],
    status: "completed",
    turns: {},
    outputFileOrder: [],
    outputFiles: {},
  };
}

test("MessageStream follows run order and normalizes user text for display and copy", () => {
  const runs = {
    "run-1": run("run-1", "第一条，消息。"),
    "run-2": run("run-2", "第二条，消息。"),
  };
  const html = renderToStaticMarkup(createElement(MessageStream, {
    order: ["run-2", "missing", "run-1"],
    runs,
  }));

  const second = html.indexOf("第二条, 消息.");
  const first = html.indexOf("第一条, 消息.");
  assert.ok(second >= 0 && first > second, html);
  assert.equal(html.match(/aria-label="Copy message"/g)?.length, 2);
  assert.doesNotMatch(html, /missing/);
});

test("MessageStream gives the final model message its own stable block", () => {
  const runs = {
    "run-1": {
      ...run("run-1", "用户任务"),
      finalTurnId: "turn-1",
      timeline: [{ kind: "user" as const, inputId: "run-1:task" }, { kind: "assistant" as const, turnId: "turn-1" }],
      turns: {
        "turn-1": {
          turnId: "turn-1",
          turnOrdinal: 1,
          status: "completed" as const,
          assistantContent: "最终答案",
          finalContent: "最终答案",
          reasoningContent: "",
          toolOrder: [],
          tools: {},
        },
      },
    },
  };
  const html = renderToStaticMarkup(createElement(MessageStream, {
    order: ["run-1"],
    runs,
  }));

  assert.match(html, /data-message-block-id="run-1:task"/);
  assert.match(html, /data-message-block-id="run-1:work:run-1:task"/);
  assert.equal(html.match(/class="model-text final-answer markdown"/g)?.length, 1);
  assert.doesNotMatch(html, /block-process|>Process<|>Thinking</);
});

test("MessageStream keeps each steering bubble between the earlier and continued assistant output", () => {
  const original = run("run-1", "原任务");
  const steered: RunState = {
    ...original,
    inputs: {
      ...original.inputs,
      "steer-one": { inputId: "steer-one", task: "第一条补充", at: 2_000, status: "applied" },
      "steer-two": { inputId: "steer-two", task: "第二条补充", at: 2_100, status: "applied" },
    },
    timeline: [
      { kind: "user", inputId: "run-1:task" },
      { kind: "assistant", turnId: "turn-1" },
      { kind: "user", inputId: "steer-one" },
      { kind: "user", inputId: "steer-two" },
      { kind: "assistant", turnId: "turn-2" },
    ],
    finalTurnId: "turn-2",
    finalDurationMs: 800,
    turns: {
      "turn-1": { turnId: "turn-1", turnOrdinal: 1, status: "completed", assistantContent: "旧回复", finalContent: "旧回复", reasoningContent: "", toolOrder: [], tools: {} },
      "turn-2": { turnId: "turn-2", turnOrdinal: 2, status: "completed", assistantContent: "新回复", finalContent: "新回复", assistantDurationMs: 800, reasoningContent: "", toolOrder: [], tools: {} },
    },
  };
  const html = renderToStaticMarkup(createElement(MessageStream, { order: ["run-1"], runs: { "run-1": steered } }));
  const order = ["旧回复", "第一条补充", "第二条补充", "新回复"].map((text) => html.indexOf(text));
  assert.ok(order.every((position) => position >= 0));
  assert.ok(order.every((position, index) => index === 0 || position > order[index - 1]));
  assert.equal(html.match(/Worked for/g)?.length, 1);
  assert.ok(html.indexOf("Worked for") > html.indexOf("第二条补充"));
  assert.doesNotMatch(html, /block-process|>Process<|>Thinking</);
});

test("a tool-only turn occupies an assistant block with visible action details", () => {
  const toolRun = run("run-tool", "检查目录");
  toolRun.timeline.push({ kind: "assistant", turnId: "tool-turn" });
  toolRun.turns["tool-turn"] = {
    turnId: "tool-turn", turnOrdinal: 1, status: "completed", assistantContent: "", reasoningContent: "", toolOrder: ["call-1"],
    tools: { "call-1": { toolCallId: "call-1", name: "bash", input: { command: "pwd" }, status: "completed", result: { ok: true, output: "/tmp", returncode: 0, truncated: false } } },
  };
  const html = renderToStaticMarkup(createElement(MessageStream, { order: ["run-tool"], runs: { "run-tool": toolRun } }));
  assert.match(html, /data-message-block-id="run-tool:work:run-tool:task"/);
  assert.match(html, /Ran commands/);
  assert.doesNotMatch(html, /block-process|>Process<|>Thinking</);
});

test("pending steering inputs leave the live work indicator with the existing assistant group", () => {
  const current = run("run-pending", "原任务");
  current.status = "running";
  current.startedAt = new Date(1_000).toISOString();
  current.inputs.steer = { inputId: "steer", task: "待应用补充", at: 2_000, status: "accepted" };
  current.pendingInputIds = ["steer"];
  current.timeline.push({ kind: "assistant", turnId: "turn-old" }, { kind: "user", inputId: "steer" });
  current.turns["turn-old"] = {
    turnId: "turn-old", turnOrdinal: 1, status: "running", assistantContent: "继续原任务",
    reasoningContent: "仍在处理原任务", toolOrder: [], tools: {},
  };

  const html = renderToStaticMarkup(createElement(MessageStream, { order: [current.runId], runs: { [current.runId]: current } }));
  assert.equal(html.match(/Working for/g)?.length, 1);
  assert.match(html, /data-message-block-id="run-pending:work:run-pending:task"/);
  assert.doesNotMatch(html, /data-message-block-id="run-pending:work:steer"/);
  assert.ok(html.indexOf("继续原任务") < html.indexOf("待应用补充"));
});

test("the initial waiting work group keeps its identity when a pending steer precedes the first turn", () => {
  const current = run("run-initial", "开始任务");
  current.status = "running";
  current.inputs.steer = { inputId: "steer", task: "补充任务", at: 2_000, status: "accepted" };
  current.pendingInputIds = ["steer"];
  current.timeline.push({ kind: "user", inputId: "steer" });
  const render = () => renderToStaticMarkup(createElement(MessageStream, { order: [current.runId], runs: { [current.runId]: current } }));
  const waiting = render();
  assert.equal(waiting.match(/Working for/g)?.length, 1);
  assert.ok(waiting.indexOf("run-initial:work:run-initial:task") < waiting.indexOf("补充任务"));

  current.timeline.push({ kind: "assistant", turnId: "turn-1" });
  current.turns["turn-1"] = {
    turnId: "turn-1", turnOrdinal: 1, status: "running", assistantContent: "", reasoningContent: "开始处理", toolOrder: [], tools: {},
  };
  const started = render();
  assert.equal(started.match(/data-message-block-id="run-initial:work:run-initial:task"/g)?.length, 1);
  assert.equal(started.match(/Working for/g)?.length, 1);
  assert.ok(started.indexOf("run-initial:work:run-initial:task") < started.indexOf("补充任务"));
  assert.doesNotMatch(started, /data-message-block-id="run-initial:work:steer"/);
});

test("tool-call prose stays inside activity details even before its stop reason is projected", () => {
  const current = run("run-tool-prose", "检查目录");
  current.timeline.push({ kind: "assistant", turnId: "turn-1" });
  current.turns["turn-1"] = {
    turnId: "turn-1", turnOrdinal: 1, status: "completed", assistantContent: "准备读取目录", reasoningContent: "",
    toolOrder: ["call-1"], tools: { "call-1": { toolCallId: "call-1", name: "list_dir", input: { path: "." }, status: "completed" } },
  };
  const html = renderToStaticMarkup(createElement(MessageStream, { order: [current.runId], runs: { [current.runId]: current } }));
  assert.match(html, /work-commentary-text/);
  assert.match(html, /准备读取目录/);
  assert.doesNotMatch(html, /final-answer/);
});

test("an active turn keeps one Working for block as reasoning and tools arrive", () => {
  const current = run("run-empty", "开始");
  current.status = "running";
  current.timeline.push({ kind: "assistant", turnId: "turn-1" });
  current.turns["turn-1"] = {
    turnId: "turn-1", turnOrdinal: 1, status: "running", assistantContent: "", reasoningContent: "", toolOrder: [], tools: {},
  };
  const render = () => renderToStaticMarkup(createElement(MessageStream, { order: ["run-empty"], runs: { "run-empty": current } }));
  const emptyHtml = render();
  assert.match(emptyHtml, /data-block-count="2"/);
  assert.match(emptyHtml, /data-message-block-id="run-empty:work:run-empty:task"/);
  assert.match(emptyHtml, />Working for</);
  assert.match(emptyHtml, /class="run-work-toggle" aria-expanded="true"/);
  assert.match(emptyHtml, /正在等待过程说明/);

  current.turns["turn-1"].reasoningContent = "先看目录";
  const activeHtml = render();
  assert.match(activeHtml, /data-block-count="2"/);
  assert.match(activeHtml, /data-message-block-id="run-empty:work:run-empty:task"/);
  assert.match(activeHtml, />Working for</);
  assert.doesNotMatch(activeHtml, />Thinking</);
  assert.doesNotMatch(activeHtml, /先看目录/);

  current.turns["turn-1"].progressContent = "先确认目录边界";
  const progressHtml = render();
  assert.match(progressHtml, /work-commentary-text/);
  assert.match(progressHtml, /先确认目录边界/);
  assert.doesNotMatch(progressHtml, /正在等待过程说明|先看目录/);

  current.turns["turn-1"].toolOrder = ["call-1"];
  current.turns["turn-1"].tools["call-1"] = { toolCallId: "call-1", name: "bash", input: { command: "pwd" }, status: "running" };
  assert.equal(render().match(/data-message-block-id="run-empty:work:run-empty:task"/g)?.length, 1);
});

test("a historical reasoning-only turn leaves no empty activity block", () => {
  const current = run("run-reasoning", "查看项目");
  current.status = "cancelled";
  current.timeline.push({ kind: "assistant", turnId: "old-turn" });
  current.turns["old-turn"] = {
    turnId: "old-turn", turnOrdinal: 1, status: "failed", assistantContent: "", reasoningContent: "PRIVATE HISTORICAL THOUGHT", toolOrder: [], tools: {},
  };
  const html = renderToStaticMarkup(createElement(MessageStream, { order: [current.runId], runs: { [current.runId]: current } }));
  assert.match(html, /data-block-count="1"/);
  assert.doesNotMatch(html, /PRIVATE|run-work|block-assistant/);
  assert.equal(current.turns["old-turn"].reasoningContent, "PRIVATE HISTORICAL THOUGHT");
});

test("a completed pure answer has one progress fold with the answer and metadata outside it", () => {
  const current = run("run-pure", "分析问题");
  current.timeline.push({ kind: "assistant", turnId: "answer" });
  current.finalTurnId = "answer";
  current.finalDurationMs = 2_000;
  current.turns.answer = {
    turnId: "answer", turnOrdinal: 1, status: "completed", assistantContent: "中文结论", progressContent: "先核对约束再形成结论",
    reasoningContent: "PRIVATE English reasoning", toolOrder: [], tools: {}, assistantAt: 3_000,
  };
  const html = renderToStaticMarkup(createElement(MessageStream, { order: [current.runId], runs: { [current.runId]: current } }));
  assert.match(html, /data-block-count="2"/);
  assert.equal(html.match(/class="run-work-toggle"/g)?.length, 1);
  assert.match(html, /Worked for 2\.0s/);
  assert.match(html, /work-commentary-text markdown"><p>先核对约束再形成结论/);
  assert.match(html, /<\/section><div class="model-text final-answer markdown"><p>中文结论/);
  assert.match(html, /aria-label="Copy answer"/);
  assert.doesNotMatch(html, /PRIVATE|turn-action|work-legacy-notice/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

  current.turns["turn-1"].reasoningContent = "先看目录";
  const activeHtml = render();
  assert.match(activeHtml, /data-block-count="2"/);
  assert.match(activeHtml, /data-message-block-id="run-empty:work:run-empty:task"/);
  assert.match(activeHtml, />Working for</);
  assert.doesNotMatch(activeHtml, />Thinking</);
  assert.match(activeHtml, /先看目录/);

  current.turns["turn-1"].toolOrder = ["call-1"];
  current.turns["turn-1"].tools["call-1"] = { toolCallId: "call-1", name: "bash", input: { command: "pwd" }, status: "running" };
  assert.equal(render().match(/data-message-block-id="run-empty:work:run-empty:task"/g)?.length, 1);
});

test("user message bubble has a uniform 16px corner radius", () => {
  const cssPath = fileURLToPath(
    new URL("../../../../../frontend/src/middle-column/message-stream/message-stream.css", import.meta.url),
  );
  const css = readFileSync(cssPath, "utf8");

  const ruleStart = css.indexOf(".user-message {");
  assert.ok(ruleStart >= 0, ".user-message rule should exist");
  const open = css.indexOf("{", ruleStart);
  const rule = css.slice(open + 1, css.indexOf("}", open));

  const radius = rule.match(/border-radius:\s*([^;]+);/)?.[1];
  assert.ok(radius, "border-radius declaration should exist");
  assert.equal(radius.trim().split(/\s+/).length, 1, "all four corners share one radius value");
  assert.equal(radius.trim(), "16px");
});

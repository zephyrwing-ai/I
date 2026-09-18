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
  return {
    runId,
    task,
    taskAt: 1_000,
    status: "completed",
    turnOrder: [],
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
    runTimings: {},
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
      turnOrder: ["turn-1"],
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
    runTimings: {},
  }));

  assert.match(html, /data-message-block-id="run-1:task"/);
  assert.match(html, /data-message-block-id="run-1:process"/);
  assert.match(html, /data-message-block-id="run-1:answer:turn-1"/);
  assert.equal(html.match(/class="model-text final-answer markdown"/g)?.length, 1);
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

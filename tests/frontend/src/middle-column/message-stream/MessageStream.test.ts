import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
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
  assert.equal(html.match(/aria-label="复制消息"/g)?.length, 2);
  assert.doesNotMatch(html, /missing/);
});

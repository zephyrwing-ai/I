import assert from "node:assert/strict";
import test from "node:test";
import type { ToolState } from "../../../../frontend/src/store/agentReducer.js";
import {
  activityLanguage,
  projectToolActivity,
  summarizeToolActivities,
  type ToolActivityKind,
} from "../../../../frontend/src/store/toolActivity.js";

function tool(name: string, input: unknown, overrides: Partial<ToolState> = {}): ToolState {
  return { toolCallId: "call-1", name, input, status: "running", ...overrides };
}

test("row labels use actual operational arguments across supported tool categories", () => {
  const cases: Array<[string, unknown, ToolActivityKind, string]> = [
    ["read", { path: "agent/model/assistant-text.ts" }, "read", "Read agent/model/assistant-text.ts"],
    ["bash", { command: "sqlite3 -readonly 'sessions.sqlite'" }, "command", "Ran sqlite3 -readonly 'sessions.sqlite'"],
    ["shell", { command: "pwd" }, "command", "Ran pwd"],
    ["write", { path: "new.ts" }, "edit", "Wrote new.ts"],
    ["edit", { path: "existing.ts" }, "edit", "Edited existing.ts"],
    ["list_dir", { path: "agent" }, "list", "Listed agent"],
    ["list_dir", {}, "list", "Listed ."],
    ["search_content", { text: "history_read", path: "agent" }, "search", "Searched history_read in agent"],
    ["find_files", { pattern: ".tsx" }, "search", "Searched .tsx in ."],
    ["search", { query: "Working for", path: "frontend" }, "search", "Searched Working for in frontend"],
    ["history_read", { entryId: "entry-1" }, "history", "Read history entry-1"],
    ["canvas_edit", { operations: [{ type: "update", id: "element-1" }] }, "canvas", "Edited Canvas"],
    ["custom_tool", { path: "target.ts" }, "unknown", "Used custom_tool"],
  ];
  for (const [name, input, kind, label] of cases) {
    const activity = projectToolActivity(tool(name, input), "zh");
    assert.equal(activity.kind, kind, name);
    assert.equal(activity.label, label, name);
  }
});

test("long commands and paths reach the component in full with original whitespace", () => {
  const command = `TSX_TSCONFIG_PATH=tsconfig.web.json node --input-type=module <<'JS'\nconst value = '${"x".repeat(2_000)}';\nconsole.log('two  spaces', value);\nJS`;
  const path = `directory with  spaces/${"long-directory/".repeat(80)}assistant-text.ts`;
  assert.equal(projectToolActivity(tool("bash", { command }), "en").label, `Ran ${command}`);
  assert.equal(projectToolActivity(tool("read", { path }), "en").label, `Read ${path}`);
});

test("legacy purpose and targets remain in raw input while row text uses the command or path", () => {
  for (const [name, input, label] of [
    ["read", { path: "actual.ts", purpose: "查看其他文件", targets: ["invented.ts"] }, "Read actual.ts"],
    ["bash", { command: "pwd", purpose: "检查工作区", targets: ["workspace"] }, "Ran pwd"],
  ] as const) {
    const call = tool(name, input);
    const activity = projectToolActivity(call, "zh");
    assert.equal(activity.label, label);
    assert.strictEqual(activity.tool.input, input);
  }
});

test("expanded details keep the exact tool reference and full input and result", () => {
  const input = Object.freeze({ command: "pwd", cwd: "/workspace", purpose: "检查目录" });
  const result = Object.freeze({ ok: false, output: "output\n".repeat(2_000), error: "failed", returncode: 1, truncated: false });
  const call = Object.freeze(tool("bash", input, { status: "completed", result }));
  const activity = projectToolActivity(call, "zh");
  assert.strictEqual(activity.tool, call);
  assert.strictEqual(activity.tool.input, input);
  assert.strictEqual(activity.tool.result, result);
  assert.equal(activity.toolCallId, call.toolCallId);
  assert.equal(activity.tool.status, "completed");
  assert.equal(activity.failed, true);
  assert.equal(activity.failureLabel, "执行失败");
  assert.equal(projectToolActivity(call).failureLabel, "Failed");
});

test("running and successful snapshots expose their current status without a failure", () => {
  const running = tool("read", { path: "config.ts" });
  const completed = { ...running, status: "completed" as const, result: { ok: true, output: "{}", returncode: 0, truncated: false } };
  for (const call of [running, completed]) {
    const activity = projectToolActivity(call, "en");
    assert.strictEqual(activity.tool, call);
    assert.equal(activity.tool.status, call.status);
    assert.equal(activity.failed, false);
    assert.equal(activity.failureLabel, "Failed");
    assert.equal(activity.label, "Read config.ts");
  }
});

test("missing and malformed input uses category fallbacks while retaining raw details", () => {
  for (const input of [null, undefined, false, 42, "raw input", [], { path: null, command: {}, text: 12, purpose: "invented command" }, { path: "  ", command: "\n " }]) {
    for (const [name, label] of [["read", "Read file"], ["bash", "Ran command"], ["history_read", "Read history"], ["search_content", "Searched ."]]) {
      const call = tool(name, input);
      const activity = projectToolActivity(call, "en");
      assert.equal(activity.label, label, `${name}: ${JSON.stringify(input)}`);
      assert.strictEqual(activity.tool.input, input);
    }
  }
});

test("a batch summary deduplicates actual categories in first-call order and includes commands", () => {
  const read = projectToolActivity(tool("read", { path: "one.ts" }), "en");
  const command = projectToolActivity(tool("bash", { command: "pwd" }), "en");
  assert.equal(summarizeToolActivities([read, command, read, command]), "Read files, ran commands");
  assert.equal(summarizeToolActivities([command, read]), "Ran commands, read files");
  assert.equal(summarizeToolActivities([command]), "Ran commands");
  assert.equal(summarizeToolActivities([read]), "Read files");
  assert.equal(summarizeToolActivities([]), "");
});

test("batch titles cover write, search, directory, history, canvas and custom tools", () => {
  const calls = ["write", "edit", "search_content", "find_files", "list_dir", "history_read", "canvas_edit", "custom_tool", "another_tool"];
  assert.equal(
    summarizeToolActivities(calls.map((name) => projectToolActivity(tool(name, {}), "en"))),
    "Edited files, searched files, listed directories, read history, edited Canvas, used tools",
  );
});

test("activityLanguage remains available and fixed action labels preserve original arguments", () => {
  assert.equal(activityLanguage("查看文件 config.ts"), "zh");
  assert.equal(activityLanguage("Read config.ts"), "en");
  assert.equal(activityLanguage(""), "en");
  const call = tool("read", { path: "文档/配置.ts" });
  assert.equal(projectToolActivity(call, "zh").label, "Read 文档/配置.ts");
  assert.equal(projectToolActivity(call, "en").label, "Read 文档/配置.ts");
});

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

test("trace purposes prefer the declared intent and fall back to localized operational facts", () => {
  const declared = { path: "actual.ts", purpose: "\n 检查上下文\n边界 \t", targets: ["invented.ts"] };
  const activity = projectToolActivity(tool("read", declared), "zh");
  assert.equal(activity.purpose, "检查上下文 边界");
  assert.strictEqual(activity.tool.input, declared);
  for (const purpose of [undefined, null, false, {}, [], "\n "]) {
    assert.equal(projectToolActivity(tool("read", { path: "actual.ts", purpose, targets: ["invented.ts"] }), "zh").purpose, "读取文件 actual.ts");
    assert.equal(projectToolActivity(tool("read", { path: "actual.ts", purpose }), "en").purpose, "Read file actual.ts");
  }
  assert.equal(projectToolActivity(tool("bash", { command: "long operational command" }), "zh").purpose, "执行命令");
  assert.equal(projectToolActivity(tool("write", { path: "new.ts" }), "zh").purpose, "写入文件 new.ts");
  assert.equal(projectToolActivity(tool("search_content", { text: "context", path: "agent" }), "zh").purpose, "搜索文件 context");
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

test("web search uses its query and execution facts without changing local search labels", () => {
  const input = { query: "Electron web search", purpose: "核对当前官方资料" };
  const running = projectToolActivity(tool("web_search", input), "zh");
  assert.equal(running.kind, "web-search");
  assert.equal(running.label, "Searching Electron web search");
  assert.equal(running.statusLabel, "搜索中");
  assert.equal(running.purpose, input.purpose);
  const result = { ok: true, output: "Saved search evidence", returncode: 0, truncated: false, web: { pages: [
    { url: "https://www.electronjs.org/docs/latest/", title: "Electron Documentation", snippet: "Original source snippet" },
    { url: "https://example.com/article", title: "Article", faviconUrl: "https://example.com/site.png" },
  ] } };
  const complete = projectToolActivity(tool("web_search", input, { status: "completed", result }), "en");
  assert.equal(complete.label, "Searched Electron web search");
  assert.equal(complete.statusLabel, "2 results");
  assert.deepEqual(complete.webPages, [
    { url: "https://www.electronjs.org/docs/latest/", title: "Electron Documentation", domain: "electronjs.org", faviconUrl: "https://www.electronjs.org/favicon.ico" },
    { url: "https://example.com/article", title: "Article", domain: "example.com", faviconUrl: "https://example.com/site.png" },
  ]);
  assert.strictEqual(complete.tool.result, result, "source snippets and raw output remain in the execution result");
  assert.equal(summarizeToolActivities([complete, projectToolActivity(tool("search_content", { text: "query" }))]), "Searched web, searched files");
  assert.equal(projectToolActivity(tool("web_search", { query: "releases" }), "zh").purpose, "搜索网页 releases");
  assert.equal(projectToolActivity(tool("search_content", { text: "query" })).label, "Searched query in .");
});

test("web sources accept HTTP links and distinguish successful empty search from failure", () => {
  const result = { ok: true, output: "raw", returncode: 0, truncated: false, web: { pages: [
    { url: "javascript:alert(1)", title: "Unsafe" },
    { url: "file:///private/document", title: "Local" },
    { url: "not a URL", title: "Invalid" },
    { url: "http://example.com/page", title: " ", faviconUrl: "data:image/svg+xml,unsafe" },
  ] } };
  const valid = projectToolActivity(tool("web_search", { query: "docs" }, { status: "completed", result }));
  assert.equal(valid.statusLabel, "1 result");
  assert.deepEqual(valid.webPages, [{ url: "http://example.com/page", title: "example.com", domain: "example.com", faviconUrl: "http://example.com/favicon.ico" }]);
  const emptyResult = { ...result, web: { pages: [] } };
  const empty = projectToolActivity(tool("web_search", { query: "rare query" }, { status: "completed", result: emptyResult }), "zh");
  assert.equal(empty.statusLabel, "0 个结果");
  assert.equal(empty.emptyLabel, "本次搜索没有找到结果。");
  const failed = projectToolActivity(tool("web_search", { query: "docs" }, { status: "completed", result: { ok: false, output: "", returncode: -1, truncated: false, error: "network_error" } }), "zh");
  assert.equal(failed.failed, true);
  assert.equal(failed.statusLabel, undefined);
  assert.equal(failed.emptyLabel, undefined);
  assert.equal(projectToolActivity(tool("web_search", { query: "docs" }, { status: "completed" })).statusLabel, undefined, "a terminal call without a saved outcome is not presented as a successful search");
});

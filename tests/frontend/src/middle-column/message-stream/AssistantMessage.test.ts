import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunState, TurnState } from "../../../../../frontend/src/store/agentReducer.js";
import { agentReducer, initialAgentState } from "../../../../../frontend/src/store/agentReducer.js";
import { mergePersistedEntries } from "../../../../../frontend/src/store/sessionProjection.js";
import type { HistoryPageEntry } from "../../../../../shell/shared/ipc.js";
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

test("a running assistant turn retains its work indicator and renders only user-facing text", () => {
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

  assert.match(html, />Working for</);
  assert.doesNotMatch(html, />Thinking</);
  assert.doesNotMatch(html, /内部过程|think-block|work-progress-text|work-purpose-text|work-intermediate-text/);
  assert.match(html, /class="run-work-toggle" aria-expanded="true"/);
  assert.doesNotMatch(html, /work-status|final-answer/);
  assert.ok(html.includes('class="work-commentary-text markdown"'), html);
  assert.ok(html.includes("正在生成, 答案"), html);
  assert.doesNotMatch(html, /aria-label="Copy answer"/);
  assert.doesNotMatch(html, /class="message-time"/);
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
          input: { command: "ls", purpose: "查看工作目录", targets: ["当前项目"] },
          status: "running",
        },
      },
    }),
  ]);
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: state, turnIds: ["turn-1"] }));

  assert.ok(html.includes("先检查目录"), html);
  assert.ok(html.includes("Ran ls"), html);
  assert.match(html, /tool-fold/);
  assert.match(html, /work-commentary-text markdown"><p>先检查目录<\/p>\s*<p>查看工作目录/);
  assert.doesNotMatch(html, /当前项目|tool-detail/);
  assert.match(html, />Working for</);
});

test("collapsed tool rows show actual commands and defer mounting input and output", () => {
  const output = `${"a".repeat(600)}${"b".repeat(1_500)}`;
  const state = run([
    turn({
      status: "completed",
      toolOrder: ["tool-1"],
      tools: {
        "tool-1": {
          toolCallId: "tool-1",
          name: "bash",
          input: { command: "generate --private-argument", purpose: "生成报告", targets: ["report.md"] },
          status: "completed",
          result: { ok: true, output, returncode: 0, truncated: false },
        },
      },
    }),
  ]);
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: state, turnIds: ["turn-1"] }));

  assert.match(html, /Ran generate --private-argument/);
  assert.match(html, /class="tool-fold" aria-expanded="false"/);
  assert.match(html, /work-commentary-text markdown"><p>生成报告/);
  assert.doesNotMatch(html, /报告.*report\.md|tool-input-pre|tool-output-pre/);
  assert.ok(!html.includes("a".repeat(100)) && !html.includes("b".repeat(100)));
  assert.equal(state.turns["turn-1"].tools["tool-1"].result?.output, output, "presentation preserves execution evidence");
});

test("process prose alternates with its tool batch and the final answer stays outside the fold", () => {
  const state = run([
    turn({ turnId: "analysis-turn", progressContent: "先梳理问题与约束", reasoningContent: "PRIVATE ANALYSIS" }),
    turn({
      turnId: "read-turn", progressContent: "接着检查实现", assistantContent: "先查看上下文实现", reasoningContent: "PRIVATE FIRST THOUGHT", toolOrder: ["read-call"],
      tools: { "read-call": { toolCallId: "read-call", name: "read", input: { path: "agent/context/config.ts", purpose: "读取上下文管理实现" }, status: "completed" } },
    }),
    turn({
      turnId: "search-turn", turnOrdinal: 2, assistantContent: "然后核对历史读取逻辑", reasoningContent: "PRIVATE SECOND THOUGHT", toolOrder: ["search-call"],
      tools: { "search-call": { toolCallId: "search-call", name: "search_content", input: { text: "history_read", path: "agent", purpose: "查找历史读取入口" }, status: "completed" } },
    }),
    turn({ turnId: "answer-turn", turnOrdinal: 3, progressContent: "依据检查结果整理结论", assistantContent: "这是最终分析", status: "completed" }),
  ]);
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: state, turnIds: ["analysis-turn", "read-turn", "search-turn", "answer-turn"], answerTurnId: "answer-turn" }));
  const positions = ["先梳理问题与约束", "接着检查实现", "先查看上下文实现", "Read agent/context/config.ts", "然后核对历史读取逻辑", "history_read", "依据检查结果整理结论", "这是最终分析"].map((text) => html.indexOf(text));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), html);
  assert.equal(html.match(/class="turn-action"/g)?.length, 2);
  assert.match(html, /Read files/);
  assert.match(html, /Searched files/);
  assert.ok(html.indexOf('class="model-text final-answer markdown"') > html.lastIndexOf('class="turn-action"'));
  assert.doesNotMatch(html, /PRIVATE|think-text/);
  assert.equal(state.turns["read-turn"].reasoningContent, "PRIVATE FIRST THOUGHT");
});

test("purpose-only turns show one ordered explanation before each batch and preserve the final answer", () => {
  const state = run([
    turn({ turnId: "read", status: "completed", reasoningContent: "PRIVATE REASONING", toolOrder: ["a", "b"], tools: {
      a: { toolCallId: "a", name: "read", input: { path: "config.ts", purpose: "读取上下文管理实现" }, status: "completed" },
      b: { toolCallId: "b", name: "read", input: { path: "manager.ts", purpose: " 读取上下文管理实现 " }, status: "completed" },
    } }),
    turn({ turnId: "check", turnOrdinal: 2, status: "completed", toolOrder: ["c"], tools: {
      c: { toolCallId: "c", name: "bash", input: { command: "pwd", purpose: "检查历史读取逻辑" }, status: "completed" },
    } }),
    turn({ turnId: "answer", turnOrdinal: 3, status: "completed", assistantContent: "最终结论" }),
  ]);
  state.status = "completed";
  state.finalTurnId = "answer";
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: state, turnIds: ["read", "check", "answer"], answerTurnId: "answer" }));
  const positions = ["读取上下文管理实现", "Read files", "检查历史读取逻辑", "Ran commands", "最终结论"].map((text) => html.indexOf(text));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), html);
  assert.equal(html.match(/读取上下文管理实现/g)?.length, 1);
  assert.equal(html.match(/class="work-commentary-text markdown"/g)?.length, 2);
  assert.match(html, /<\/section><div class="model-text final-answer markdown"><p>最终结论/);
  assert.doesNotMatch(html, /PRIVATE/);
  assert.equal(state.turns.read.assistantContent, "", "purpose projection preserves raw native content");
});

test("commentary preserves source Markdown boundaries while merging tool purposes", () => {
  const state = run([turn({ assistantContent: "    const answer = 1;", toolOrder: ["call"], tools: {
    call: { toolCallId: "call", name: "read", input: { path: "answer.ts", purpose: "核对答案" }, status: "completed" },
  } })]);
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: state, turnIds: ["turn-1"], isWorking: true }));
  assert.ok(html.includes("<pre><code>const answer = 1;"), html);
  assert.match(html, /<\/pre>\s*<p>核对答案/);
});

test("purpose de-duplicates against native prose and legacy progress while keeping distinct intents", () => {
  const state = run([turn({ progressContent: "核对约束", assistantContent: "检查实现\n整理结论", toolOrder: ["a", "b", "c"], tools: {
    a: { toolCallId: "a", name: "read", input: { path: "a.ts", purpose: " 检查实现 " }, status: "running" },
    b: { toolCallId: "b", name: "read", input: { path: "b.ts", purpose: "核对约束" }, status: "running" },
    c: { toolCallId: "c", name: "read", input: { path: "c.ts", purpose: "查看其他文件" }, status: "running" },
  } })]);
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: state, turnIds: ["turn-1"], isWorking: true }));
  assert.equal(html.match(/检查实现/g)?.length, 1);
  assert.equal(html.match(/核对约束/g)?.length, 1);
  assert.match(html, /work-commentary-text markdown/);
  assert.ok(html.indexOf("查看其他文件") < html.indexOf("Read files"), html);
});

test("a pure answer discloses independent progress and keeps raw reasoning out of markup", () => {
  const state = run([turn({
    status: "completed", progressContent: "先比较约束，再整理结论", assistantContent: "最终中文答案",
    reasoningContent: "PRIVATE English reasoning <progress>raw marker</progress><answer>raw answer</answer>",
  })]);
  state.status = "completed";
  state.finalTurnId = "turn-1";
  state.finalDurationMs = 900;
  const html = renderToStaticMarkup(createElement(AssistantMessage, {
    run: state, turnIds: ["turn-1"], answerTurnId: "turn-1", showDuration: true,
  }));
  assert.match(html, /class="run-work-toggle" aria-expanded="false"/);
  assert.match(html, /Worked for 0.9s/);
  assert.match(html, /class="work-commentary-text markdown"><p>先比较约束, 再整理结论/);
  assert.match(html, /<\/section><div class="model-text final-answer markdown"><p>最终中文答案/);
  assert.doesNotMatch(html, /PRIVATE|English reasoning|raw marker|raw answer|&lt;progress|<progress|<answer|turn-action|work-legacy-notice/);
  assert.equal(html.match(/aria-label="Copy answer"/g)?.length, 1);
});

test("legacy final answers disclose a truthful notice in their associated applied input language", () => {
  for (const [task, notice] of [
    ["分析问题", "原始推理已保存，公开正文见下方回答。"],
    ["Analyze the problem", "Raw reasoning is saved; the public response appears below."],
  ]) {
    const state = run([turn({ status: "completed", assistantContent: "Saved answer", reasoningContent: "PRIVATE ENGLISH REASONING" })]);
    state.status = "completed";
    state.inputs.associated = { inputId: "associated", task, at: 2_000, status: "applied" };
    state.inputs.pending = { inputId: "pending", task: task === "分析问题" ? "English pending" : "中文待应用", at: 3_000, status: "accepted" };
    state.appliedInputId = "associated";
    state.pendingInputIds = ["pending"];
    const render = () => renderToStaticMarkup(createElement(AssistantMessage, {
      run: state, anchorInputId: "associated", turnIds: ["turn-1"], answerTurnId: "turn-1",
    }));
    const html = render();
    assert.match(html, /class="run-work-toggle" aria-expanded="false"/);
    assert.ok(html.includes(notice), html);
    assert.doesNotMatch(html, /PRIVATE ENGLISH REASONING|work-progress-text/);
    state.turns["turn-1"].progressContent = "Recorded process";
    assert.doesNotMatch(render(), /work-legacy-notice/);
    state.turns["turn-1"].progressContent = "";
    state.turns["turn-1"].reasoningContent = "";
    assert.doesNotMatch(render(), /run-work-toggle|work-legacy-notice/);
  }
});

test("an active empty group has an expandable waiting status in the applied input language", () => {
  const state = run([]);
  state.inputs["run-1:task"].task = "Analyze the problem";
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: state, turnIds: [], isWorking: true }));
  assert.match(html, /class="run-work-toggle" aria-expanded="true"/);
  assert.match(html, /class="work-status" role="status">Waiting for a process explanation\./);
  assert.doesNotMatch(html, /work-commentary-text|work-legacy-notice/);
});

test("tool failures remain visible with an expandable action and lazily mounted error details", () => {
  const state = run([turn({ toolOrder: ["call"], tools: {
    call: { toolCallId: "call", name: "read", input: { path: "missing.ts" }, status: "completed", result: { ok: false, output: "PRIVATE ERROR", error: "read_failed", returncode: -1, truncated: false } },
  } })]);
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: state, turnIds: ["turn-1"] }));
  assert.match(html, /missing\.ts/);
  assert.match(html, /执行失败/);
  assert.match(html, /tool-row is-failed/);
  assert.match(html, /tool-fold/);
  assert.doesNotMatch(html, /PRIVATE ERROR|tool-detail/);
});

test("web search stays in the existing tool fold with query, count and commentary", () => {
  const state = run([turn({ toolOrder: ["search"], tools: {
    search: { toolCallId: "search", name: "web_search", input: { query: "Electron current documentation", purpose: "查找官方资料" }, status: "completed", result: {
      ok: true, output: "FULL SEARCH EVIDENCE", returncode: 0, truncated: false,
      web: { pages: [{ url: "https://www.electronjs.org/docs/latest/", title: "Electron Documentation" }] },
    } },
  } })]);
  const html = renderToStaticMarkup(createElement(AssistantMessage, { run: state, turnIds: ["turn-1"] }));
  assert.match(html, /Searched web/);
  assert.match(html, /Searched Electron current documentation/);
  assert.match(html, /1 个结果/);
  assert.match(html, /查找官方资料/);
  assert.match(html, /class="tool-fold" aria-expanded="false"/);
  assert.doesNotMatch(html, /tool-web-source|Electron Documentation|FULL SEARCH EVIDENCE|Searched files/);
});

test("live tool metadata and restored history render the identical chronological activity", () => {
  const runId = "parity-run";
  const call = { id: "read-call", name: "read", input: { path: "config.ts", purpose: "读取上下文配置", targets: ["incorrect.ts"] }, inputComplete: true };
  const result = { ok: true, output: "PRIVATE TOOL OUTPUT", returncode: 0, truncated: false };
  let live = agentReducer(initialAgentState, { type: "runAccepted", runId, projectId: null, inputId: "user", task: "检查上下文配置", taskAt: 100 });
  live = agentReducer(live, { type: "event", event: { type: "turnStarted", runId, turnId: "tool-turn", turnOrdinal: 1 } });
  live = agentReducer(live, { type: "event", event: { type: "reasoningDelta", runId, turnId: "tool-turn", delta: "PRIVATE REASONING" } });
  live = agentReducer(live, { type: "event", event: { type: "progressDelta", runId, turnId: "tool-turn", delta: "开始检查" } });
  live = agentReducer(live, { type: "event", event: { type: "assistantCompleted", runId, turnId: "tool-turn", progress: "先确认配置来源", content: "先查看项目配置", toolCalls: [call], stopReason: "tool_use", completedAt: 200 } });
  live = agentReducer(live, { type: "event", event: { type: "toolCompleted", runId, turnId: "tool-turn", toolCallId: call.id, name: call.name, result } });
  live = agentReducer(live, { type: "event", event: { type: "turnStarted", runId, turnId: "answer-turn", turnOrdinal: 2 } });
  live = agentReducer(live, { type: "event", event: { type: "assistantCompleted", runId, turnId: "answer-turn", progress: "据此整理配置分析", content: "这是配置分析结果", toolCalls: [], stopReason: "stop", completedAt: 1_000 } });
  live = agentReducer(live, { type: "event", event: { type: "runCompleted", runId, status: "completed", turnCount: 2, finalTurnId: "answer-turn", finalDurationMs: 900 } });
  const stored = (partial: Partial<HistoryPageEntry>): HistoryPageEntry => ({
    entryId: "", entryOrder: 0, projectId: null, type: "assistant_message", status: "completed", runId, turnId: null, toolCallId: null,
    revision: 0, createdAt: 100, completedAt: null, durationMs: null, payload: { role: "assistant", content: "" }, ...partial,
  });
  const restored = mergePersistedEntries({ runs: {}, runOrder: [] }, [
    stored({ entryId: "user", entryOrder: 1, type: "user_message", payload: { role: "user", content: "检查上下文配置" } }),
    stored({ entryId: "tool-assistant", entryOrder: 2, turnId: "tool-turn", completedAt: 200, payload: { role: "assistant", progress: "先确认配置来源", content: "先查看项目配置", reasoning: "PRIVATE REASONING", toolCalls: [call] } }),
    stored({ entryId: "result", entryOrder: 3, type: "tool_result", turnId: "tool-turn", toolCallId: call.id, payload: { role: "tool", content: result.output, toolName: "read", toolCallId: call.id }, toolResult: result }),
    stored({ entryId: "answer", entryOrder: 4, turnId: "answer-turn", completedAt: 1_000, durationMs: 900, payload: { role: "assistant", progress: "据此整理配置分析", content: "这是配置分析结果" } }),
  ]);
  const render = (state: RunState) => renderToStaticMarkup(createElement(AssistantMessage, {
    run: state, anchorInputId: "user", turnIds: ["tool-turn", "answer-turn"], answerTurnId: "answer-turn", showDuration: true,
  }));
  const liveHtml = render(live.runs[runId]);
  assert.equal(liveHtml, render(restored.runs[runId]));
  assert.match(liveHtml, /先查看项目配置/);
  assert.match(liveHtml, /Read config\.ts/);
  assert.match(liveHtml, /work-commentary-text markdown/);
  assert.match(liveHtml, /读取上下文配置/);
  assert.match(liveHtml, /config\.ts/);
  assert.match(liveHtml, /先确认配置来源/);
  assert.match(liveHtml, /据此整理配置分析/);
  assert.doesNotMatch(liveHtml, /PRIVATE|incorrect\.ts/);
  assert.deepEqual(restored.runs[runId].turns["tool-turn"].tools[call.id].input, call.input);
});

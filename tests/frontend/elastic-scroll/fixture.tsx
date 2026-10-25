import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { StreamRegion } from "../../../frontend/src/middle-column/message-stream/StreamScrollbar";
import { AssistantMessage } from "../../../frontend/src/middle-column/message-stream/AssistantMessage";
import { agentReducer, initialAgentState, type RunState } from "../../../frontend/src/store/agentReducer";
import { buildMessageBlockRecords } from "../../../frontend/src/store/messageBlocks";
import type { AgentEvent } from "../../../shell/shared/ipc";
import "../../../frontend/src/styles.css";
import "../../../frontend/src/middle-column/Column.css";
import "../../../frontend/src/middle-column/message-stream/message-stream.css";

const root = createRoot(document.getElementById("root")!);
let mountId = 0;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frames = async () => { await frame(); await frame(); };

function commentarySnapshot() {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(".work-commentary-text"));
  return {
    commentaryTexts: nodes.map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? ""),
    commentaryVisible: nodes.map((node) => !node.closest("[inert]") && node.getBoundingClientRect().height > 0
      && getComputedStyle(node).visibility === "visible"),
  };
}

function sample(scroll: HTMLElement) {
  const content = scroll.querySelector<HTMLElement>(".stream-content")!;
  const thumb = document.querySelector<HTMLElement>(".stream-scrollbar-thumb")!;
  const fill = thumb.querySelector<HTMLElement>(".stream-scrollbar-thumb-fill")!;
  const viewport = scroll.getBoundingClientRect();
  const fillBounds = fill.getBoundingClientRect();
  return {
    scrollHeight: scroll.scrollHeight,
    scrollTop: scroll.scrollTop,
    viewportHeight: scroll.clientHeight,
    offset: new DOMMatrixReadOnly(getComputedStyle(content).transform).m42,
    thumbTop: thumb.offsetTop,
    thumbHeight: thumb.offsetHeight,
    fillScale: new DOMMatrixReadOnly(getComputedStyle(fill).transform).m22,
    fillTopGap: fillBounds.top - viewport.top,
    fillBottomGap: viewport.bottom - fillBounds.bottom,
    disabled: thumb.getAttribute("aria-disabled"),
  };
}

async function mount(height: number, nested = false) {
  const scrollRef = createRef<HTMLElement>();
  flushSync(() => root.render(
    <StreamRegion key={++mountId} scrollRef={scrollRef}>
      <div id="fixture-content" style={{ height }}>
        {nested && <div id="nested-scroll" style={{ height: 100, overflowY: "auto" }}>
          <div style={{ height: 600 }}>Nested scrollable content</div>
        </div>}
      </div>
    </StreamRegion>,
  ));
  await frames();
  return scrollRef.current!;
}

async function wheel(scroll: HTMLElement, deltaY: number, target: HTMLElement = scroll) {
  const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  await frames();
  return { ...sample(scroll), consumed: event.defaultPrevented };
}

/** 单帧等待版本：连续采样必须落在跟手上限（ELASTIC_TRACK_MAX = 200ms）内。 */
async function wheelQuick(scroll: HTMLElement, deltaY: number) {
  const event = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
  scroll.dispatchEvent(event);
  await frame();
  return { ...sample(scroll), consumed: event.defaultPrevented };
}

/** 根据实际回弹进度接续输入，使交互测试适用于不同回弹速度。 */
async function halfwayThroughReturn(scroll: HTMLElement) {
  const halfway = Math.abs(sample(scroll).offset) / 2;
  for (let i = 0; i < 120; i += 1) {
    await frame();
    const current = sample(scroll);
    if (Math.abs(current.offset) <= halfway) return current;
  }
  throw new Error("Elastic scroll did not reach the middle of its return");
}

async function boundarySequence(delta: number) {
  const scroll = await mount(1200);
  if (delta > 0) scroll.scrollTo({ top: scroll.scrollHeight, behavior: "instant" });
  await frames();
  const baseline = sample(scroll);
  const samples = [];
  let lastInputAt = 0;
  for (let i = 0; i < 6; i += 1) {
    lastInputAt = performance.now();
    samples.push(await wheelQuick(scroll, delta));
  }
  return { scroll, baseline, samples, lastInputAt };
}

/** 持续越界输入超过跟手上限：位移应在 200ms 附近见顶，随后回落，滑块始终不变形。 */
async function sustainedSequence() {
  const scroll = await mount(1200);
  scroll.scrollTo({ top: scroll.scrollHeight, behavior: "instant" });
  await frames();
  const samples: { at: number; offset: number; fillScale: number }[] = [];
  const start = performance.now();
  while (performance.now() - start < 420) {
    const event = new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
    scroll.dispatchEvent(event);
    await frame();
    const current = sample(scroll);
    samples.push({ at: performance.now() - start, offset: current.offset, fillScale: current.fillScale });
  }
  return samples;
}

/** Reuse the Electron message-area fixture to check real disclosure layout and focus. */
async function activityTraceRegression() {
  const purpose = "检查上下文管理实现";
  const command = "stat -f '%Sm %N' -t '%Y-%m-%d' agent/model/openai.ts";
  const longCommand = `sqlite3 -readonly 'sessions.sqlite' "SELECT ${"entry_order, ".repeat(120)}payload_json FROM entries;"`;
  const output = "FULL TOOL OUTPUT\n".repeat(1_000);
  const extraCalls = Array.from({ length: 14 }, (_, index) => ({
    toolCallId: `extra-${index}`, name: "read", input: { path: `agent/context/dependency-${index}.ts`, purpose }, status: "completed" as const,
  }));
  const run: RunState = {
    runId: "activity", projectId: null, status: "completed", finalTurnId: "answer", finalDurationMs: 2_000,
    inputs: { user: { inputId: "user", task: "检查上下文与历史读取", at: 1_000, status: "applied" } },
    pendingInputIds: [], timeline: [{ kind: "user", inputId: "user" }, { kind: "assistant", turnId: "files" }, { kind: "assistant", turnId: "history" }, { kind: "assistant", turnId: "answer" }],
    outputFileOrder: [], outputFiles: {},
    turns: {
      files: {
        turnId: "files", turnOrdinal: 1, anchorInputId: "user", status: "completed", assistantContent: "", reasoningContent: "PRIVATE REASONING",
        toolOrder: ["files-call", "short-call", "command-call", "long-call", ...extraCalls.map((call) => call.toolCallId)],
        tools: {
          "files-call": { toolCallId: "files-call", name: "read", status: "completed", input: { path: "agent/context/config.ts", purpose }, result: { ok: true, output: "export const config = {};", returncode: 0, truncated: false } },
          "short-call": { toolCallId: "short-call", name: "bash", status: "completed", input: { command: "pwd", purpose: ` \n${purpose}\t ` } },
          "command-call": { toolCallId: "command-call", name: "bash", status: "completed", input: { command, purpose } },
          "long-call": { toolCallId: "long-call", name: "bash", status: "completed", input: { command: longCommand, cwd: "/workspace", purpose }, result: { ok: true, output, returncode: 0, truncated: false } },
          ...Object.fromEntries(extraCalls.map((call) => [call.toolCallId, call])),
        },
      },
      history: {
        turnId: "history", turnOrdinal: 2, anchorInputId: "user", status: "completed", assistantContent: "", reasoningContent: "PRIVATE REASONING", toolOrder: ["history-call"],
        tools: { "history-call": { toolCallId: "history-call", name: "read", input: { path: "agent/tools/history-read.ts" }, status: "completed" } },
      },
      answer: { turnId: "answer", turnOrdinal: 3, status: "completed", assistantContent: "已完成分析", reasoningContent: "PRIVATE FINAL REASONING", toolOrder: [], tools: {} },
    },
  };
  const render = (width: number) => flushSync(() => root.render(
    <div style={{ width, padding: 16 }}>
      <AssistantMessage run={run} anchorInputId="user" turnIds={["files", "history", "answer"]} answerTurnId="answer" showDuration />
    </div>,
  ));
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-tool-call-id="${id}"]`)!;
  const label = (id: string) => row(id).querySelector<HTMLElement>(".tool-action")!;
  const labelGeometry = (id: string) => {
    const node = label(id);
    const style = getComputedStyle(node);
    return { text: node.textContent, width: node.clientWidth, contentWidth: node.scrollWidth, ellipsis: style.textOverflow, whiteSpace: style.whiteSpace, overflow: style.overflowX };
  };
  const activitySequence = () => Array.from(document.querySelectorAll<HTMLElement>(".work-commentary-text, .turn-action-summary"))
    .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "");
  render(760);
  await frames();
  const outer = document.querySelector<HTMLButtonElement>(".run-work-toggle")!;
  const detail = document.querySelector<HTMLElement>(".run-work-detail")!;
  const groups = Array.from(document.querySelectorAll<HTMLButtonElement>(".turn-action-fold"));
  groups[0].focus();
  const initiallyClosed = detail.inert && detail.getBoundingClientRect().height < 1;
  const closedFocusBlocked = document.activeElement !== groups[0];
  outer.click();
  await delay(220);
  await frames();
  const foldedCommentary = {
    ...commentarySnapshot(),
    outerOpen: outer.getAttribute("aria-expanded") === "true" && !detail.inert,
    groupsClosed: groups.every((group) => group.getAttribute("aria-expanded") === "false"),
  };
  groups[0].focus();
  const openFocusAllowed = document.activeElement === groups[0];
  groups[0].click();
  groups[1].click();
  await delay(220);
  await frames();
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".tool-row"));
  const sequence = activitySequence();
  const text = document.getElementById("root")!.textContent ?? "";
  const reasoningHidden = !text.includes("PRIVATE");
  const commandVisible = text.includes(`Ran ${command}`);
  const detailsInitiallyUnmounted = document.querySelectorAll(".tool-detail, .tool-input-pre, .tool-output-pre").length === 0;
  const finalOutside = !document.querySelector(".final-answer")!.closest(".run-work");
  const individualDisclosures = document.querySelectorAll(".tool-row .tool-fold").length;
  const expandedHeight = detail.getBoundingClientRect().height;
  const wideShort = labelGeometry("short-call");
  const wideCommand = labelGeometry("command-call");
  const clip = document.querySelector<HTMLElement>(".turn-action-clip")!;
  const groupScroll = { maxHeight: getComputedStyle(clip).maxHeight, overflowY: getComputedStyle(clip).overflowY, height: clip.clientHeight, contentHeight: clip.scrollHeight, scrollTop: 0 };
  clip.scrollTop = 80;
  await frames();
  groupScroll.scrollTop = clip.scrollTop;

  row("files-call").querySelector<HTMLButtonElement>(".tool-fold")!.click();
  await frames();
  const firstRowExpanded = row("files-call").querySelector(".tool-input-pre")?.textContent === JSON.stringify(run.turns.files.tools["files-call"].input, null, 2)
    && row("files-call").querySelector(".tool-output-pre")?.textContent === run.turns.files.tools["files-call"].result!.output
    && !row("long-call").querySelector(".tool-detail");
  row("long-call").querySelector<HTMLButtonElement>(".tool-fold")!.click();
  await frames();
  const independentExpansion = Boolean(row("files-call").querySelector(".tool-detail"))
    && Boolean(row("long-call").querySelector(".tool-detail"))
    && !row("command-call").querySelector(".tool-detail");
  const fullCommandInput = row("long-call").querySelector(".tool-input-pre")?.textContent === JSON.stringify(run.turns.files.tools["long-call"].input, null, 2);
  const fullCommandOutput = row("long-call").querySelector(".tool-output-pre")?.textContent === output;
  const reasoningHiddenWithDetails = !document.getElementById("root")!.textContent?.includes("PRIVATE");
  row("files-call").querySelector<HTMLButtonElement>(".tool-fold")!.click();
  await frames();
  const independentCollapse = !row("files-call").querySelector(".tool-detail") && Boolean(row("long-call").querySelector(".tool-detail"));
  row("long-call").querySelector<HTMLButtonElement>(".tool-fold")!.click();
  await frames();
  const detailsUnmountedAgain = document.querySelectorAll(".tool-detail, .tool-input-pre, .tool-output-pre").length === 0;

  render(300);
  await frames();
  const narrowRows = Array.from(document.querySelectorAll<HTMLElement>(".tool-row"));
  const narrowShort = labelGeometry("short-call");
  const narrowCommand = labelGeometry("command-call");
  const narrowLong = labelGeometry("long-call");
  const completeLabels = label("long-call").textContent === `Ran ${longCommand}` && label("files-call").textContent === "Read agent/context/config.ts";
  const noHorizontalOverflow = narrowRows.every((row) => row.scrollWidth <= row.clientWidth + 1);

  run.turns.files.progressContent = `保留上下文检查进度\n \t${purpose}  `;
  run.turns.files.assistantContent = "保留上下文检查正文";
  run.turns.history.progressContent = "保留历史读取进度";
  run.turns.history.assistantContent = "保留历史读取正文";
  run.turns.history.tools["history-call"].input = { path: "agent/tools/history-read.ts", purpose: "查看历史读取工具" };
  render(760);
  await frames();
  const legacyDuplicateSequence = activitySequence();
  const legacyDuplicateCommentary = commentarySnapshot().commentaryTexts;

  run.turns.files.progressContent = "保留上下文检查进度";
  run.turns.files.assistantContent = ` \n${purpose}\t `;
  render(760);
  await frames();
  const nativeDuplicateSequence = activitySequence();
  const nativeDuplicateCommentary = commentarySnapshot().commentaryTexts;
  outer.click();
  await delay(220);
  await frames();
  return {
    initiallyClosed, closedFocusBlocked, openFocusAllowed, reasoningHidden, commandVisible, finalOutside, individualDisclosures, expandedHeight,
    sequence, foldedCommentary, legacyDuplicateSequence, legacyDuplicateCommentary, nativeDuplicateSequence, nativeDuplicateCommentary,
    rows: rows.map((row) => row.querySelector(".tool-action")?.textContent), headers: groups.map((group) => group.textContent), noHorizontalOverflow,
    detailsInitiallyUnmounted, firstRowExpanded, independentExpansion, independentCollapse, fullCommandInput, fullCommandOutput, reasoningHiddenWithDetails, detailsUnmountedAgain,
    wideShort, wideCommand, narrowShort, narrowCommand, narrowLong, completeLabels, groupScroll,
    collapsedAgain: detail.inert && detail.getBoundingClientRect().height < 1,
    retainedOutput: run.turns.files.tools["long-call"].result!.output.length,
  };
}

/** A tool-free answer uses the same real disclosure, inert region and focus boundary. */
async function pureProgressRegression() {
  const run: RunState = {
    runId: "pure-progress", projectId: null, status: "completed", finalTurnId: "answer", finalDurationMs: 900,
    inputs: { user: { inputId: "user", task: "分析问题并给出中文结论", at: 1_000, status: "applied" } },
    pendingInputIds: [], timeline: [{ kind: "user", inputId: "user" }, { kind: "assistant", turnId: "answer" }],
    outputFileOrder: [], outputFiles: {},
    turns: { answer: {
      turnId: "answer", turnOrdinal: 1, anchorInputId: "user", status: "completed", assistantContent: "最终中文结论", assistantAt: 2_000,
      progressContent: "先比较[约束记录](https://example.com/constraints)，再整理中文结论。",
      reasoningContent: "PRIVATE English raw reasoning <progress>PRIVATE MARKER</progress><answer>PRIVATE ANSWER</answer>",
      toolOrder: [], tools: {},
    } },
  };
  const key = ++mountId;
  const render = (isWorking = false) => flushSync(() => root.render(
    <div style={{ width: 760, padding: 16 }}>
      <AssistantMessage key={key} run={run} anchorInputId="user" turnIds={["answer"]} answerTurnId="answer" showDuration isWorking={isWorking} />
    </div>,
  ));
  render();
  await frames();
  const outer = document.querySelector<HTMLButtonElement>(".run-work-toggle")!;
  const detail = document.querySelector<HTMLElement>(".run-work-detail")!;
  const link = detail.querySelector<HTMLAnchorElement>(".work-commentary-text a")!;
  const initiallyClosed = detail.inert && detail.getBoundingClientRect().height < 1;
  link.focus();
  const closedFocusBlocked = document.activeElement !== link;
  outer.focus();
  const toggleFocusAllowed = document.activeElement === outer;
  outer.click();
  await delay(220);
  await frames();
  const openedByClick = outer.getAttribute("aria-expanded") === "true" && !detail.inert && detail.getBoundingClientRect().height > 20;
  link.focus();
  const openFocusAllowed = document.activeElement === link;
  const progressInside = Boolean(link.closest(".run-work"));
  const finalOutside = !document.querySelector(".final-answer")!.closest(".run-work");
  const metadataOutside = !document.querySelector(".message-meta")!.closest(".run-work");
  const noTools = document.querySelectorAll(".turn-action, .tool-row").length === 0;
  const noPurposeText = document.querySelectorAll(".work-purpose-text").length === 0;
  const progressText = link.closest(".work-commentary-text")?.textContent;
  const finalText = document.querySelector(".final-answer")?.textContent;
  const noRawEvidence = !document.getElementById("root")!.textContent?.includes("PRIVATE")
    && !document.querySelector("progress, answer");
  const workedLabel = outer.textContent;
  outer.click();
  await delay(220);
  await frames();
  const collapsedAgain = detail.inert && detail.getBoundingClientRect().height < 1;

  run.turns.answer.progressContent = undefined;
  render();
  await frames();
  outer.click();
  await delay(220);
  await frames();
  const legacyNotice = document.querySelector(".work-legacy-notice")?.textContent;
  const legacyClickable = outer.getAttribute("aria-expanded") === "true" && !detail.inert;
  const legacyNoRawEvidence = !document.getElementById("root")!.textContent?.includes("PRIVATE");
  outer.click();
  await frames();

  run.status = "running";
  run.turns.answer.assistantContent = "";
  render(true);
  await frames();
  const waitingAutoOpen = outer.getAttribute("aria-expanded") === "true" && !detail.inert;
  outer.click();
  await frames();
  outer.click();
  await delay(220);
  await frames();
  const waitingClickable = outer.getAttribute("aria-expanded") === "true" && !detail.inert;
  const waitingStatus = detail.querySelector('[role="status"]')?.textContent;
  const waitingHasNoProse = !detail.querySelector(".work-commentary-text, .work-legacy-notice");
  run.turns.answer.progressContent = "现在开始核对约束";
  render(true);
  await frames();
  const streamedWhileOpen = outer.getAttribute("aria-expanded") === "true"
    && detail.querySelector(".work-commentary-text")?.textContent === "现在开始核对约束"
    && !detail.querySelector('[role="status"]');
  return {
    initiallyClosed, closedFocusBlocked, toggleFocusAllowed, openedByClick, openFocusAllowed, progressInside, finalOutside, metadataOutside,
    noTools, noPurposeText, progressText, finalText, noRawEvidence, workedLabel, collapsedAgain, legacyNotice, legacyClickable, legacyNoRawEvidence,
    waitingAutoOpen, waitingClickable, waitingStatus, waitingHasNoProse, streamedWhileOpen,
  };
}

/** Drive the real reducer and message-block caller without remounting on phase changes. */
async function activityLifecycleRegression() {
  let state = initialAgentState;
  let runId = "lifecycle";
  const key = ++mountId;
  const accept = (id: string) => {
    runId = id;
    state = agentReducer(state, { type: "runAccepted", runId, projectId: null, inputId: "user", task: "检查上下文和历史读取", taskAt: 1_000 });
  };
  const send = (event: AgentEvent) => { state = agentReducer(state, { type: "event", event }); };
  const render = () => {
    const block = buildMessageBlockRecords(state).find((item) => item.kind === "assistant" && item.runId === runId);
    if (!block || block.kind !== "assistant") throw new Error(`Missing assistant block in ${runId}`);
    flushSync(() => root.render(
      <div key={key} style={{ width: 760, padding: 16 }}>
        <AssistantMessage key={block.blockId} run={state.runs[runId]} anchorInputId={block.anchorInputId} turnIds={block.turnIds}
          answerTurnId={block.answerTurnId} showDuration={block.showDuration} isWorking={block.isWorking} />
      </div>,
    ));
  };
  const capture = async () => {
    render();
    await frames();
    const final = document.querySelector<HTMLElement>(".final-answer");
    const run = state.runs[runId];
    return {
      status: run.status,
      outerOpen: document.querySelector(".run-work-toggle")?.getAttribute("aria-expanded") === "true",
      outerInert: document.querySelector<HTMLElement>(".run-work-detail")?.inert,
      groupsOpen: Array.from(document.querySelectorAll(".turn-action-fold")).map((node) => node.getAttribute("aria-expanded") === "true"),
      groupsInert: Array.from(document.querySelectorAll<HTMLElement>(".turn-action-detail")).map((node) => node.inert),
      groupRows: Array.from(document.querySelectorAll(".turn-action")).map((node) => Array.from(node.querySelectorAll(".tool-row")).map((row) => row.getAttribute("data-tool-call-id"))),
      runningToolIds: Object.values(run.turns).flatMap((turn) => turn.toolOrder.filter((id) => turn.tools[id]?.status === "running")),
      flowTexts: Array.from(document.querySelectorAll(".work-commentary-text"))
        .map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      ...commentarySnapshot(),
      finalText: final?.textContent ?? null,
      finalOutside: Boolean(final && !final.closest(".run-work")),
      reasoningHidden: !document.getElementById("root")!.textContent?.includes("PRIVATE"),
    };
  };
  const steps: Record<string, Awaited<ReturnType<typeof capture>>> = {};
  const outer = () => document.querySelector<HTMLButtonElement>(".run-work-toggle")!;
  const group = (index: number) => document.querySelectorAll<HTMLButtonElement>(".turn-action-fold")[index];
  const completeTool = (turnId: string, toolCallId: string, name: string) => send({ type: "toolCompleted", runId, turnId, toolCallId, name, result: { ok: true, output: "工具完成", returncode: 0, truncated: false } });
  const beginTools = (turnId: string, turnOrdinal: number, content: string, purpose = content) => {
    send({ type: "turnStarted", runId, turnId, turnOrdinal });
    send({ type: "assistantDelta", runId, turnId, delta: content });
    send({ type: "assistantCompleted", runId, turnId, content, completedAt: 2_000, stopReason: "tool_use", toolCalls: [
      { id: `${turnId}-read`, name: "read", input: { path: "agent/context/config.ts", purpose }, inputComplete: true },
      { id: `${turnId}-command`, name: "bash", input: { command: "pwd", purpose }, inputComplete: true },
    ] });
  };

  accept(runId);
  send({ type: "turnStarted", runId, turnId: "first", turnOrdinal: 1 });
  steps.running = await capture();
  send({ type: "reasoningDelta", runId, turnId: "first", delta: "PRIVATE English reasoning" });
  send({ type: "assistantDelta", runId, turnId: "first", delta: "先检查上下文管理实现" });
  steps.nativeContent = await capture();
  send({ type: "assistantCompleted", runId, turnId: "first", content: "先检查上下文管理实现", completedAt: 2_000, stopReason: "tool_use", toolCalls: [
    { id: "first-read", name: "read", input: { path: "agent/context/config.ts", purpose: "检查上下文管理实现" }, inputComplete: true },
    { id: "first-command", name: "bash", input: { command: "pwd", purpose: " \n检查上下文管理实现\t " }, inputComplete: true },
    { id: "pending-command", name: "bash", input: { command: "stat agent/model/openai.ts", purpose: "检查上下文管理实现" }, inputComplete: true },
  ] });
  steps.batchOpened = await capture();
  group(0).click();
  await frames();
  completeTool("first", "first-read", "read");
  steps.manualGroupClosed = await capture();
  group(0).click();
  await frames();
  completeTool("first", "first-command", "bash");
  steps.pendingKeepsOpen = await capture();
  outer().click();
  await frames();
  send({ type: "toolStarted", runId, turnId: "first", toolCallId: "pending-command", name: "bash", input: { command: "stat agent/model/openai.ts", purpose: "检查上下文管理实现" } });
  steps.manualOuterClosed = await capture();
  outer().click();
  await frames();
  completeTool("first", "pending-command", "bash");
  steps.allToolsDone = await capture();
  send({ type: "turnCompleted", runId, turnId: "first" });
  beginTools("second", 2, "然后检查历史读取逻辑", "查看历史读取工具");
  steps.nextTurnOpened = await capture();
  completeTool("second", "second-read", "read");
  steps.secondPartiallyDone = await capture();
  completeTool("second", "second-command", "bash");
  steps.secondAllDone = await capture();
  send({ type: "turnCompleted", runId, turnId: "second" });
  send({ type: "turnStarted", runId, turnId: "text-only", turnOrdinal: 3 });
  send({ type: "assistantCompleted", runId, turnId: "text-only", content: "接下来汇总核验结果", completedAt: 3_000, stopReason: "stop", toolCalls: [] });
  send({ type: "turnCompleted", runId, turnId: "text-only" });
  send({ type: "turnStarted", runId, turnId: "answer", turnOrdinal: 4 });
  send({ type: "assistantDelta", runId, turnId: "answer", delta: "最终中文结论" });
  steps.answerStreamingInFlow = await capture();
  send({ type: "assistantCompleted", runId, turnId: "answer", content: "最终中文结论", completedAt: 4_000, stopReason: "stop", toolCalls: [] });
  send({ type: "turnCompleted", runId, turnId: "answer" });
  steps.answerWaitingForRunCompleted = await capture();
  send({ type: "runCompleted", runId, status: "completed", turnCount: 4, finalTurnId: "answer", finalDurationMs: 3_000 });
  steps.runCompleted = await capture();

  outer().click();
  await frames();
  group(0).click();
  await frames();
  steps.doneManuallyReopened = await capture();
  // Preserve the same React keys to expose stale manual overrides after a full phase cycle.
  state = { ...state, status: "running", runs: { ...state.runs, [runId]: { ...state.runs[runId], status: "running" } } };
  send({ type: "turnStarted", runId, turnId: "first", turnOrdinal: 1 });
  send({ type: "toolStarted", runId, turnId: "first", toolCallId: "first-read", name: "read", input: { path: "agent/context/config.ts", purpose: "检查上下文管理实现" } });
  steps.sameGroupWorkingAgain = await capture();
  completeTool("first", "first-read", "read");
  steps.sameGroupDoneAgain = await capture();
  send({ type: "turnCompleted", runId, turnId: "first" });
  send({ type: "runCompleted", runId, status: "completed", turnCount: 4, finalTurnId: "answer", finalDurationMs: 3_000 });
  steps.doneAgainReset = await capture();

  accept("cancel-after-stop");
  beginTools("cancel", 1, "正在检查，等待执行完成");
  steps.beforeStop = await capture();
  state = agentReducer(state, { type: "stopRequested" });
  steps.stopRequested = await capture();
  send({ type: "runCompleted", runId, status: "cancelled", turnCount: 1 });
  steps.stopped = await capture();
  accept("direct-cancel");
  beginTools("cancel-direct", 1, "检查历史读取");
  steps.beforeCancel = await capture();
  send({ type: "runCompleted", runId, status: "cancelled", turnCount: 1 });
  steps.cancelled = await capture();
  return steps;
}

async function runElasticScrollRegression() {
  const bottom = await boundarySequence(40);
  await delay(Math.max(0, 500 - (performance.now() - bottom.lastInputAt)));
  await frame();
  const settled = sample(bottom.scroll);
  const settledAfter = performance.now() - bottom.lastInputAt;

  const sustained = await sustainedSequence();

  const top = await boundarySequence(-40);
  await delay(250); // 手势间隔：回弹完成并重置跟手窗口，再接续输入
  await wheel(top.scroll, -40);
  const beforeResume = await halfwayThroughReturn(top.scroll);
  const resumed = await wheel(top.scroll, -8);
  const beforeReverse = await halfwayThroughReturn(top.scroll);
  const reversed = await wheel(top.scroll, 8);

  const remainderScroll = await mount(1200);
  remainderScroll.scrollTo({ top: remainderScroll.scrollHeight, behavior: "instant" });
  await frames();
  await wheel(remainderScroll, 40);
  await wheel(remainderScroll, 40);
  const remainder = await wheel(remainderScroll, -100);

  const short = await mount(120);
  const shortSamples = [];
  for (const delta of [-40, -40, 40, 40, 40]) shortSamples.push(await wheel(short, delta));

  const resized = await mount(1200);
  resized.scrollTo({ top: resized.scrollHeight, behavior: "instant" });
  await frames();
  document.getElementById("fixture-content")!.style.height = "120px";
  await frames();
  await frames();
  const shortened = sample(resized);

  const nested = await mount(1200, true);
  const nestedScroll = document.getElementById("nested-scroll")!;
  nestedScroll.scrollTop = 50;
  const nestedSamples = [await wheel(nested, -40, nestedScroll), await wheel(nested, 40, nestedScroll)];

  const touchScroll = await mount(1200);
  const touch = (clientY: number) => new Touch({ identifier: 1, target: touchScroll, clientY });
  touchScroll.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(100)], bubbles: true }));
  touchScroll.dispatchEvent(new TouchEvent("touchmove", { touches: [touch(140)], bubbles: true, cancelable: true }));
  await frames();
  const touchStarted = sample(touchScroll);
  await delay(150);
  const touchHeld = sample(touchScroll);
  touchScroll.dispatchEvent(new TouchEvent("touchend", { touches: [], bubbles: true }));
  await delay(500);
  await frame();
  const touchEnded = sample(touchScroll);

  const activityTrace = await activityTraceRegression();
  const pureProgress = await pureProgressRegression();
  const activityLifecycle = await activityLifecycleRegression();
  root.unmount();
  return {
    bottom: { baseline: bottom.baseline, samples: bottom.samples, settled, settledAfter },
    sustained,
    top: { baseline: top.baseline, samples: top.samples },
    returning: { beforeResume, resumed, beforeReverse, reversed },
    remainder,
    shortSamples,
    shortened,
    nestedSamples,
    touch: { started: touchStarted, held: touchHeld, ended: touchEnded },
    activityTrace,
    pureProgress,
    activityLifecycle,
  };
}

Object.assign(window, { runElasticScrollRegression });

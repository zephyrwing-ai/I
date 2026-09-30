import type { ModelMessage } from "../../../agent/model/types";
import type { HistoryPageEntry } from "../../../shell/shared/ipc";
import type { AgentState, RunState, ToolState, TurnState } from "./agentReducer";

function newRun(entry: HistoryPageEntry): RunState {
  return {
    runId: entry.runId,
    projectId: entry.projectId,
    status: "completed",
    inputs: {},
    pendingInputIds: [],
    timeline: [],
    turns: {},
    outputFileOrder: [],
    outputFiles: {},
  };
}

function toolResult(message: ModelMessage): ToolState["result"] {
  return {
    ok: !message.isError,
    output: message.content,
    returncode: message.isError ? -1 : 0,
    truncated: false,
  };
}

function ensureTurn(run: RunState, entry: HistoryPageEntry): TurnState {
  const turnId = entry.turnId ?? `${entry.entryId}:turn`;
  const existing = run.turns[turnId];
  if (existing) return existing;
  const turn: TurnState = {
    turnId,
    turnOrdinal: Object.keys(run.turns).length + 1,
    status: entry.status === "failed" || entry.status === "interrupted" ? "failed" : "completed",
    assistantContent: "",
    reasoningContent: "",
    toolOrder: [],
    tools: {},
  };
  run.timeline.push({ kind: "assistant", turnId });
  run.turns[turnId] = turn;
  return turn;
}

/** Rebuilds reading order from persisted entryOrder, including newly prepended history pages. */
export function mergePersistedEntries(
  _state: Pick<AgentState, "runs" | "runOrder">,
  entries: HistoryPageEntry[],
): Pick<AgentState, "runs" | "runOrder"> {
  const runs: Record<string, RunState> = {};
  const runOrder: string[] = [];
  const lastDurationTurnByRun: Record<string, string> = {};
  const sorted = [...entries].sort((left, right) => left.entryOrder - right.entryOrder);

  for (const entry of sorted) {
    let run = runs[entry.runId];
    if (!run) {
      run = newRun(entry);
      runs[entry.runId] = run;
      runOrder.push(entry.runId);
    }
    if (entry.type === "user_message") {
      if (run.inputs[entry.entryId]) continue;
      run.timeline.push({ kind: "user", inputId: entry.entryId });
      if (entry.status === "interrupted") {
        run.pendingInputIds.push(entry.entryId);
        run.inputs[entry.entryId] = {
          inputId: entry.entryId,
          task: entry.payload.content,
          at: entry.createdAt,
          status: "interrupted",
        };
        continue;
      }
      run.inputs[entry.entryId] = {
        inputId: entry.entryId,
        task: entry.payload.content,
        at: entry.createdAt,
        status: "applied",
      };
      continue;
    }
    const turn = ensureTurn(run, entry);
    if (entry.status === "failed") run.status = "failed";
    else if (entry.status === "interrupted" && run.status !== "failed") run.status = "cancelled";
    if (entry.type === "assistant_message") {
      turn.assistantContent = entry.payload.content;
      turn.assistantAt = entry.updatedAt;
      turn.assistantDurationMs = entry.status === "completed" ? entry.durationMs ?? undefined : undefined;
      if (entry.status === "completed" && entry.durationMs !== null) lastDurationTurnByRun[run.runId] = turn.turnId;
      turn.finalContent = entry.status === "completed" ? entry.payload.content : undefined;
      turn.reasoningContent = entry.payload.reasoning ?? "";
      turn.stopReason = entry.payload.toolCalls?.length ? "tool_use" : "stop";
      for (const call of entry.payload.toolCalls ?? []) {
        if (turn.tools[call.id]) continue;
        turn.toolOrder.push(call.id);
        turn.tools[call.id] = { toolCallId: call.id, name: call.name, input: call.input, status: "running" };
      }
    } else if (entry.toolCallId) {
      const existing = turn.tools[entry.toolCallId];
      const tool: ToolState = {
        toolCallId: entry.toolCallId,
        name: existing?.name ?? entry.payload.toolName ?? "Tool",
        input: existing?.input,
        status: "completed",
        result: toolResult(entry.payload),
      };
      if (!existing) turn.toolOrder.push(entry.toolCallId);
      turn.tools[entry.toolCallId] = tool;
    }
  }

  // Older runs may contain a duration on several replies. The final duration-bearing
  // assistant entry alone owns the run's visible Worked for label.
  for (const runId of runOrder) {
    const run = runs[runId];
    run.finalTurnId = lastDurationTurnByRun[runId];
    for (const turn of Object.values(run.turns)) {
      if (turn.turnId !== run.finalTurnId) turn.assistantDurationMs = undefined;
    }
  }

  return { runs, runOrder };
}

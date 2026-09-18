import type { ModelMessage } from "../../../agent/model/types";
import type { SessionHistoryEntry } from "../../../shell/shared/ipc";
import type { AgentState, RunState, ToolState, TurnState } from "./agentReducer";

function newRun(runId: string, task?: string, taskAt?: number): RunState {
  return {
    runId,
    task,
    taskAt,
    status: "completed",
    turnOrder: [],
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

function ensureTurn(run: RunState, entry: SessionHistoryEntry): TurnState {
  const turnId = entry.turnId ?? `${entry.entryId}:turn`;
  const existing = run.turns[turnId];
  if (existing) return existing;
  const turn: TurnState = {
    turnId,
    turnOrdinal: run.turnOrder.length + 1,
    status: entry.status === "failed" ? "failed" : "completed",
    assistantContent: "",
    reasoningContent: "",
    toolOrder: [],
    tools: {},
  };
  run.turnOrder.push(turnId);
  run.turns[turnId] = turn;
  return turn;
}

export function mergePersistedEntries(
  state: Pick<AgentState, "runs" | "runOrder">,
  entries: SessionHistoryEntry[],
): Pick<AgentState, "runs" | "runOrder"> {
  const runs = { ...state.runs };
  const runOrder = [...state.runOrder];
  const sorted = [...entries].sort((left, right) => left.sessionSeq - right.sessionSeq);

  for (const entry of sorted) {
    let run = runs[entry.runId];
    if (!run) {
      run = newRun(entry.runId);
      runs[entry.runId] = run;
      runOrder.push(entry.runId);
    }
    if (entry.type === "user_message") {
      run.task = entry.payload.content;
      run.taskAt = entry.createdAt;
      continue;
    }
    const turn = ensureTurn(run, entry);
    if (entry.status === "failed") run.status = "failed";
    if (entry.type === "assistant_message") {
      turn.assistantContent = entry.payload.content;
      turn.assistantAt = entry.updatedAt;
      turn.finalContent = entry.status === "completed" ? entry.payload.content : undefined;
      turn.reasoningContent = entry.payload.reasoning ?? "";
      turn.stopReason = entry.payload.toolCalls?.length ? "tool_use" : "stop";
      for (const call of entry.payload.toolCalls ?? []) {
        if (turn.tools[call.id]) continue;
        turn.toolOrder.push(call.id);
        turn.tools[call.id] = {
          toolCallId: call.id,
          name: call.name,
          input: call.input,
          status: "running",
        };
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

  runOrder.sort((left, right) => (runs[left]?.taskAt ?? 0) - (runs[right]?.taskAt ?? 0));
  return { runs, runOrder };
}

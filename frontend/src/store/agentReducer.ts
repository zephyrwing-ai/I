import type {
  AgentEvent,
  OutputFileDescriptor,
  RunStatus,
  HistoryPageResult,
  ToolResult,
} from "../../../shell/shared/ipc";
import { initialHistoryState, mergeHistoryEntries, type HistoryState } from "./sessionHistory";
import { mergePersistedEntries } from "./sessionProjection";

export type AppStatus = "idle" | "starting" | "running" | "stopping" | RunStatus;
export type TurnStatus = "running" | "retrying" | "completed" | "failed";
export type ToolStatus = "running" | "completed";

export interface ToolState {
  toolCallId: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  result?: ToolResult;
}

export interface TurnState {
  turnId: string;
  turnOrdinal: number;
  /** 已启动回合捕获的输入锚点；后续补充输入继续使用各自的新回合。 */
  anchorInputId?: string;
  status: TurnStatus;
  assistantContent: string;
  /** 完整模型输出的固定完成时间；实时事件与历史 entry 共享该值。 */
  assistantAt?: number;
  /** 最终助手消息持久化的 run 总耗时，单位毫秒。 */
  assistantDurationMs?: number;
  /** 思考内容（reasoningDelta 增量累加）；展示在该助手消息内。 */
  reasoningContent: string;
  finalContent?: string;
  stopReason?: string;
  toolOrder: string[];
  tools: Record<string, ToolState>;
}

export interface UserInputState {
  inputId: string;
  task: string;
  at: number;
  status: "accepted" | "applied" | "interrupted";
  acceptOrder?: number;
}

export type MessageTimelineItem =
  | { kind: "user"; inputId: string }
  | { kind: "assistant"; turnId: string };

export interface RunState {
  runId: string;
  projectId: string | null;
  source?: "live";
  inputs: Record<string, UserInputState>;
  pendingInputIds: string[];
  timeline: MessageTimelineItem[];
  /** 当前模型上下文中最后一条已应用输入，与 ACK 的可见消息顺序分别记录。 */
  appliedInputId?: string;
  startedAt?: string;
  finalTurnId?: string;
  finalDurationMs?: number;
  unappliedInputIds?: string[];
  status: AppStatus;
  error?: string;
  turns: Record<string, TurnState>;
  outputFileOrder: string[];
  outputFiles: Record<string, OutputFileDescriptor>;
  turnCount?: number;
}

export interface AgentState {
  status: AppStatus;
  currentRunId: string | null;
  runs: Record<string, RunState>;
  runOrder: string[];
  error: string | null;
  history: HistoryState;
}

export type AgentAction =
  | { type: "runRequested" }
  | { type: "runAccepted"; runId: string; projectId: string | null; inputId: string; task: string; taskAt: number }
  | { type: "steerAccepted"; runId: string; projectId: string | null; inputId: string; task: string; acceptOrder: number; acceptedAt: number }
  | { type: "steerRejected"; error: string }
  | { type: "runRejected"; error: string }
  | { type: "stopRequested" }
  | { type: "historyScopeLoadStarted"; projectId: string | null; generation: number }
  | { type: "historyLoadStarted"; scope: "older" | "search"; generation: number }
  | { type: "historyHydrated"; page: HistoryPageResult; generation: number }
  | { type: "olderHistoryLoaded"; page: HistoryPageResult; generation: number }
  | { type: "historyLoadFailed"; scope: "initial" | "older" | "search"; generation: number; error: string }
  | { type: "event"; event: AgentEvent };

export const initialAgentState: AgentState = {
  status: "idle",
  currentRunId: null,
  runs: {},
  runOrder: [],
  error: null,
  history: initialHistoryState,
};

function createRun(runId: string, projectId: string | null, task: string, taskAt: number, inputId: string): RunState {
  return {
    runId,
    projectId,
    source: "live",
    inputs: { [inputId]: { inputId, task, at: taskAt, status: "applied" } },
    pendingInputIds: [],
    timeline: [{ kind: "user", inputId }],
    appliedInputId: inputId,
    status: "running",
    turns: {},
    outputFileOrder: [],
    outputFiles: {},
  };
}

function belongsToCurrentRun(state: AgentState, runId: string): boolean {
  return (
    state.currentRunId === runId
    && (state.status === "starting" || state.status === "running" || state.status === "stopping")
  );
}

function withCurrentRun(state: AgentState, update: (run: RunState) => RunState): AgentState {
  if (!state.currentRunId) return state;
  const run = state.runs[state.currentRunId];
  if (!run) return state;
  return { ...state, runs: { ...state.runs, [run.runId]: update(run) } };
}

function ensureTurn(run: RunState, turnId: string, turnOrdinal = 0): RunState {
  if (run.turns[turnId]) return run;
  return {
    ...run,
    timeline: [...run.timeline, { kind: "assistant", turnId }],
    turns: {
      ...run.turns,
      [turnId]: {
        turnId,
        turnOrdinal,
        anchorInputId: run.appliedInputId,
        status: "running",
        assistantContent: "",
        reasoningContent: "",
        toolOrder: [],
        tools: {},
      },
    },
  };
}

function timelineHasInput(run: RunState, inputId: string): boolean {
  return run.timeline.some((item) => item.kind === "user" && item.inputId === inputId);
}

/** ACKs may resolve out of order; accepted inputs occupy the tail in Main's FIFO order. */
function insertAcceptedInput(run: RunState, inputId: string, acceptOrder: number): MessageTimelineItem[] {
  if (timelineHasInput(run, inputId)) return run.timeline;
  const timeline = [...run.timeline];
  let insertAt = timeline.length;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.kind === "assistant") break;
    if (run.pendingInputIds.includes(item.inputId)
      && (run.inputs[item.inputId]?.acceptOrder ?? Number.NEGATIVE_INFINITY) > acceptOrder) {
      insertAt = index;
    }
  }
  timeline.splice(insertAt, 0, { kind: "user", inputId });
  return timeline;
}

/** The application event fixes batch order even when its ACKs arrive later. */
function placeAppliedInputs(run: RunState, inputIds: string[]): MessageTimelineItem[] {
  const positions = inputIds.map((inputId) => run.timeline.findIndex(
    (item) => item.kind === "user" && item.inputId === inputId,
  ));
  if (positions[0] >= 0 && positions.every((position, index) => position === positions[0] + index)) {
    return run.timeline;
  }
  const ids = new Set(inputIds);
  const first = run.timeline.findIndex((item) => item.kind === "user" && ids.has(item.inputId));
  const timeline = run.timeline.filter((item) => item.kind !== "user" || !ids.has(item.inputId));
  const insertAt = first < 0 ? timeline.length : Math.min(first, timeline.length);
  timeline.splice(insertAt, 0, ...inputIds.map((inputId): MessageTimelineItem => ({ kind: "user", inputId })));
  return timeline;
}

function updateTurn(run: RunState, turnId: string, update: (turn: TurnState) => TurnState): RunState {
  const turn = run.turns[turnId];
  if (!turn) return run;
  return { ...run, turns: { ...run.turns, [turnId]: update(turn) } };
}

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case "runRequested":
      return { ...state, status: "starting", currentRunId: null, error: null };

    case "stopRequested":
      return state.status === "running"
        ? {
            ...state,
            status: "stopping",
            ...(state.currentRunId
              ? {
                  runs: {
                    ...state.runs,
                    [state.currentRunId]: {
                      ...state.runs[state.currentRunId],
                      status: "stopping",
                    },
                  },
                }
              : {}),
          }
        : state;

    case "runAccepted": {
      const existing = state.runs[action.runId];
      const run = existing ?? createRun(action.runId, action.projectId, action.task, action.taskAt, action.inputId);
      return {
        ...state,
        status: "running",
        currentRunId: action.runId,
        error: null,
        runs: { ...state.runs, [action.runId]: run },
        runOrder: existing ? state.runOrder : [...state.runOrder, action.runId],
      };
    }

    case "steerAccepted": {
      const run = state.runs[action.runId];
      if (!run || run.projectId !== action.projectId) return state;
      const existing = run.inputs[action.inputId];
      if (existing) return state;
      const applied = timelineHasInput(run, action.inputId);
      const interrupted = run.unappliedInputIds?.includes(action.inputId) ?? false;
      const pendingInputIds = applied || interrupted ? run.pendingInputIds : [...run.pendingInputIds, action.inputId]
        .sort((left, right) => (
          (left === action.inputId ? action.acceptOrder : run.inputs[left].acceptOrder ?? 0)
          - (right === action.inputId ? action.acceptOrder : run.inputs[right].acceptOrder ?? 0)
        ));
      return {
        ...state,
        error: null,
        runs: {
          ...state.runs,
          [run.runId]: {
            ...run,
            pendingInputIds,
            timeline: insertAcceptedInput(run, action.inputId, action.acceptOrder),
            inputs: {
              ...run.inputs,
              [action.inputId]: {
                inputId: action.inputId,
                task: action.task,
                at: action.acceptedAt,
                acceptOrder: action.acceptOrder,
                status: interrupted ? "interrupted" : applied ? "applied" : "accepted",
              },
            },
          },
        },
      };
    }

    case "steerRejected":
      return { ...state, error: action.error };

    case "runRejected":
      return { ...state, status: "failed", currentRunId: null, error: action.error };

    case "historyScopeLoadStarted":
      if (action.generation <= state.history.requestGeneration) return state;
      return {
        ...state,
        status: "idle",
        currentRunId: null,
        runs: {},
        runOrder: [],
        error: null,
        history: {
          ...initialHistoryState,
          projectId: action.projectId,
          requestGeneration: action.generation,
          hydrationVersion: state.history.hydrationVersion,
          loadingInitial: true,
        },
      };

    case "historyLoadStarted":
      if (action.generation !== state.history.requestGeneration) return state;
      return {
        ...state,
        history: {
          ...state.history,
          loadingOlder: action.scope === "older" ? true : state.history.loadingOlder,
          loadingSearch: action.scope === "search" ? true : state.history.loadingSearch,
          error: null,
        },
      };

    case "historyHydrated": {
      if (action.generation !== state.history.requestGeneration || action.page.projectId !== state.history.projectId) return state;
      const history = mergeHistoryEntries(state.history, action.page.entries, action.page);
      const projected = mergePersistedEntries({ runs: {}, runOrder: [] }, action.page.entries);
      return {
        ...state,
        history: { ...history, hydrationVersion: state.history.hydrationVersion + 1 },
        runs: projected.runs,
        runOrder: projected.runOrder,
        currentRunId: null,
        status: "idle",
        error: null,
      };
    }

    case "olderHistoryLoaded": {
      if (action.generation !== state.history.requestGeneration || action.page.projectId !== state.history.projectId) return state;
      const history = mergeHistoryEntries(state.history, action.page.entries, action.page);
      const projected = mergePersistedEntries({ runs: {}, runOrder: [] }, history.entryOrder.map((id) => history.entriesById[id]));
      const liveRuns = Object.values(state.runs).filter((run) => run.source === "live");
      const runs = { ...projected.runs };
      for (const run of liveRuns) runs[run.runId] = run;
      const runOrder = [...projected.runOrder, ...liveRuns.map((run) => run.runId).filter((id) => !projected.runs[id])];
      return { ...state, history, runs, runOrder };
    }

    case "historyLoadFailed":
      if (action.generation !== state.history.requestGeneration) return state;
      return {
        ...state,
        history: {
          ...state.history,
          loadingInitial: action.scope === "initial" ? false : state.history.loadingInitial,
          loadingOlder: action.scope === "older" ? false : state.history.loadingOlder,
          loadingSearch: action.scope === "search" ? false : state.history.loadingSearch,
          error: action.error,
        },
      };

    case "event": {
      const event = action.event;

      // Events from a previous run are deliberately ignored. No positional
      // fallback exists, so an old completion cannot mutate the new run.
      if (event.type !== "runStarted" && !belongsToCurrentRun(state, event.runId)) return state;

      if (event.type === "runStarted") {
        if (state.currentRunId !== event.runId) return state;
        return withCurrentRun(state, (run) => ({ ...run, startedAt: event.startedAt }));
      }

      if (event.type === "inputsApplied") {
        if (!event.inputIds.length) return state;
        return withCurrentRun(state, (run) => {
          const appliedIds = new Set(event.inputIds);
          const inputs = { ...run.inputs };
          for (const id of event.inputIds) {
            if (inputs[id]) inputs[id] = { ...inputs[id], status: "applied" };
          }
          return {
            ...run,
            inputs,
            pendingInputIds: run.pendingInputIds.filter((id) => !appliedIds.has(id)),
            timeline: placeAppliedInputs(run, event.inputIds),
            appliedInputId: event.inputIds[event.inputIds.length - 1],
          };
        });
      }

      if (event.type === "turnStarted") {
        return withCurrentRun(state, (run) => {
          const next = ensureTurn(run, event.turnId, event.turnOrdinal);
          return updateTurn(next, event.turnId, (turn) => ({ ...turn, turnOrdinal: event.turnOrdinal, status: "running" }));
        });
      }

      if (event.type === "assistantDelta") {
        return withCurrentRun(state, (run) => {
          const next = ensureTurn(run, event.turnId);
          return updateTurn(next, event.turnId, (turn) => ({
            ...turn,
            assistantContent: turn.assistantContent + event.delta,
          }));
        });
      }

      if (event.type === "reasoningDelta") {
        return withCurrentRun(state, (run) => {
          const next = ensureTurn(run, event.turnId);
          return updateTurn(next, event.turnId, (turn) => ({
            ...turn,
            reasoningContent: turn.reasoningContent + event.delta,
          }));
        });
      }

      if (event.type === "turnRetrying") {
        return withCurrentRun(state, (run) => {
          const next = ensureTurn(run, event.turnId);
          return updateTurn(next, event.turnId, (turn) => ({ ...turn, status: "retrying" }));
        });
      }

      if (event.type === "assistantCompleted") {
        return withCurrentRun(state, (run) => {
          const next = ensureTurn(run, event.turnId);
          return updateTurn(next, event.turnId, (turn) => {
            const tools = { ...turn.tools };
            const toolOrder = [...turn.toolOrder];
            for (const call of event.toolCalls) {
              if (tools[call.id]) continue;
              tools[call.id] = { toolCallId: call.id, name: call.name, input: call.input, status: "running" };
              toolOrder.push(call.id);
            }
            return {
              ...turn,
              assistantContent: event.content,
              assistantAt: event.completedAt,
              finalContent: event.content,
              stopReason: event.stopReason,
              tools,
              toolOrder,
            };
          });
        });
      }

      if (event.type === "toolStarted") {
        return withCurrentRun(state, (run) => {
          const next = ensureTurn(run, event.turnId);
          return updateTurn(next, event.turnId, (turn) => {
            const existing = turn.tools[event.toolCallId];
            const tool: ToolState = {
              toolCallId: event.toolCallId,
              name: event.name,
              input: event.input,
              status: "running",
              result: existing?.result,
            };
            return {
              ...turn,
              toolOrder: existing ? turn.toolOrder : [...turn.toolOrder, event.toolCallId],
              tools: { ...turn.tools, [event.toolCallId]: tool },
            };
          });
        });
      }

      if (event.type === "toolCompleted") {
        return withCurrentRun(state, (run) => {
          const next = ensureTurn(run, event.turnId);
          return updateTurn(next, event.turnId, (turn) => {
            const existing = turn.tools[event.toolCallId];
            const tool: ToolState = {
              toolCallId: event.toolCallId,
              name: existing?.name ?? "Tool",
              input: existing?.input,
              status: "completed",
              result: event.result,
            };
            return {
              ...turn,
              toolOrder: existing ? turn.toolOrder : [...turn.toolOrder, event.toolCallId],
              tools: { ...turn.tools, [event.toolCallId]: tool },
            };
          });
        });
      }

      if (event.type === "turnCompleted") {
        return withCurrentRun(state, (run) => updateTurn(run, event.turnId, (turn) => ({ ...turn, status: "completed" })));
      }

      if (event.type === "outputFileRegistered") {
        return withCurrentRun(state, (run) => {
          const existing = run.outputFiles[event.file.fileId];
          const outputFiles = {
            ...run.outputFiles,
            [event.file.fileId]: event.file,
          };
          const outputFileOrder = [...(existing
            ? run.outputFileOrder
            : [...run.outputFileOrder, event.file.fileId]
          )].sort((leftId, rightId) => (
            outputFiles[rightId].updatedAt.localeCompare(outputFiles[leftId].updatedAt)
          ));
          return { ...run, outputFiles, outputFileOrder };
        });
      }

      const run = state.runs[event.runId];
      const unappliedInputIds = [...new Set([...run.pendingInputIds, ...(event.unappliedInputIds ?? [])])];
      const missingInputIds = unappliedInputIds.filter((id) => !timelineHasInput(run, id));
      return {
        ...state,
        status: event.status,
        currentRunId: event.runId,
        error: event.error?.message ?? null,
        runs: {
          ...state.runs,
          [event.runId]: {
            ...run,
            status: event.status,
            error: event.error?.message,
            turnCount: event.turnCount,
            finalTurnId: event.status === "completed" ? event.finalTurnId : undefined,
            finalDurationMs: event.finalDurationMs,
            unappliedInputIds,
            timeline: [...run.timeline, ...missingInputIds.map((inputId): MessageTimelineItem => ({ kind: "user", inputId }))],
            inputs: Object.fromEntries(Object.entries(run.inputs).map(([id, input]) => [
              id,
              unappliedInputIds.includes(id) ? { ...input, status: "interrupted" } : input,
            ])),
          },
        },
      };
    }
  }
}

import type {
  AgentEvent,
  OutputFileDescriptor,
  RunStatus,
  SessionPageResult,
  ToolResult,
} from "../../../shell/shared/ipc";
import { initialSessionHistoryState, mergeHistoryEntries, type SessionHistoryState } from "./sessionHistory";
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
  status: TurnStatus;
  assistantContent: string;
  /** 模型消息时间；历史记录使用 assistant entry 的最终更新时间。 */
  assistantAt?: number;
  /** 思考内容（reasoningDelta 增量累加）；展示在 worked for 折叠内。 */
  reasoningContent: string;
  finalContent?: string;
  stopReason?: string;
  toolOrder: string[];
  tools: Record<string, ToolState>;
}

export interface RunState {
  runId: string;
  /** 本次运行的用户任务；每次发送创建新 run，消息流按 run 累积回显。 */
  task?: string;
  /** 任务发送时间（Renderer 侧观察；事件不带时间戳，reducer 只保存动作携带的观察值）。 */
  taskAt?: number;
  startedAt?: string;
  status: AppStatus;
  error?: string;
  turnOrder: string[];
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
  history: SessionHistoryState;
}

export type AgentAction =
  | { type: "runRequested" }
  | { type: "runAccepted"; runId: string; task: string; taskAt: number }
  | { type: "runRejected"; error: string }
  | { type: "stopRequested" }
  | { type: "historyLoadStarted"; scope: "initial" | "older" | "search" }
  | { type: "sessionHydrated"; page: SessionPageResult }
  | { type: "olderHistoryLoaded"; page: SessionPageResult }
  | { type: "historyLoadFailed"; scope: "initial" | "older" | "search"; error: string }
  | { type: "event"; event: AgentEvent };

export const initialAgentState: AgentState = {
  status: "idle",
  currentRunId: null,
  runs: {},
  runOrder: [],
  error: null,
  history: initialSessionHistoryState,
};

function createRun(runId: string, task: string, taskAt: number): RunState {
  return {
    runId,
    task,
    taskAt,
    status: "running",
    turnOrder: [],
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
    turnOrder: [...run.turnOrder, turnId],
    turns: {
      ...run.turns,
      [turnId]: {
        turnId,
        turnOrdinal,
        status: "running",
        assistantContent: "",
        reasoningContent: "",
        toolOrder: [],
        tools: {},
      },
    },
  };
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
      const run = existing ?? createRun(action.runId, action.task, action.taskAt);
      return {
        ...state,
        status: "running",
        currentRunId: action.runId,
        error: null,
        runs: { ...state.runs, [action.runId]: run },
        runOrder: existing ? state.runOrder : [...state.runOrder, action.runId],
      };
    }

    case "runRejected":
      return { ...state, status: "failed", currentRunId: null, error: action.error };

    case "historyLoadStarted":
      return {
        ...state,
        history: {
          ...state.history,
          loadingInitial: action.scope === "initial" ? true : state.history.loadingInitial,
          loadingOlder: action.scope === "older" ? true : state.history.loadingOlder,
          loadingSearch: action.scope === "search" ? true : state.history.loadingSearch,
          error: null,
        },
      };

    case "sessionHydrated": {
      const history = mergeHistoryEntries(state.history, action.page.entries, action.page);
      const projected = mergePersistedEntries({ runs: {}, runOrder: [] }, action.page.entries);
      return {
        ...state,
        history,
        runs: projected.runs,
        runOrder: projected.runOrder,
        currentRunId: null,
        status: "idle",
        error: null,
      };
    }

    case "olderHistoryLoaded": {
      const history = mergeHistoryEntries(state.history, action.page.entries, action.page);
      const projected = mergePersistedEntries(state, action.page.entries);
      return { ...state, history, runs: projected.runs, runOrder: projected.runOrder };
    }

    case "historyLoadFailed":
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
          return updateTurn(next, event.turnId, (turn) => ({
            ...turn,
            assistantContent: event.content,
            finalContent: event.content,
            stopReason: event.stopReason,
          }));
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

      return {
        ...state,
        status: event.status,
        currentRunId: event.runId,
        error: event.error?.message ?? null,
        runs: {
          ...state.runs,
          [event.runId]: {
            ...state.runs[event.runId],
            status: event.status,
            error: event.error?.message,
            turnCount: event.turnCount,
          },
        },
      };
    }
  }
}

/**
 * transcript 状态 — 把 IPC 事件流映射成只增不删的步骤数组。
 * 单向数据流：事件 → action → state，前端渲染只依赖 state。
 */

import type { AgentEvent, RunStatus } from "../../../shell/shared/ipc";
import type { ExecResult } from "../../../agent/types";

export type AppStatus = "idle" | "running" | RunStatus;

export interface AgentAction {
  command: string;
  status: "pending" | "running" | "done";
  result?: ExecResult;
}

export interface Step {
  stepNumber: number;
  messageCount: number;
  thought: string;
  actions: AgentAction[];
  actionCursor: number;
}

export interface AgentState {
  status: AppStatus;
  totalSteps: number;
  steps: Step[];
}

export type AgentAction_ =
  | { type: "reset" }
  | { type: "setRunning" }
  | { type: "event"; event: AgentEvent };

export const initialAgentState: AgentState = {
  status: "idle",
  totalSteps: 0,
  steps: [],
};

function patchLastStep(state: AgentState, fn: (step: Step) => Step): AgentState {
  if (state.steps.length === 0) return state;
  const last = state.steps[state.steps.length - 1];
  const steps = [...state.steps.slice(0, -1), fn(last)];
  return { ...state, steps };
}

export function agentReducer(state: AgentState, action: AgentAction_): AgentState {
  switch (action.type) {
    case "reset":
      return { ...initialAgentState, status: "running" };

    case "setRunning":
      return { ...state, status: "running" };

    case "event": {
      const e = action.event;
      switch (e.type) {
        case "turnStart": {
          const step: Step = {
            stepNumber: e.stepNumber,
            messageCount: e.messageCount,
            thought: "",
            actions: [],
            actionCursor: 0,
          };
          return { ...state, steps: [...state.steps, step] };
        }

        case "llmResponse": {
          return patchLastStep(state, (step) => ({
            ...step,
            thought: e.content,
            actions: e.actions.map((a) => ({ command: a.command, status: "pending" as const })),
            actionCursor: 0,
          }));
        }

        case "actionStart": {
          return patchLastStep(state, (step) => {
            const actions = step.actions.map((a, i) =>
              i === step.actionCursor ? { ...a, status: "running" as const } : a,
            );
            return { ...step, actions };
          });
        }

        case "actionDone": {
          return patchLastStep(state, (step) => {
            const actions = step.actions.map((a, i) =>
              i === step.actionCursor ? { ...a, status: "done" as const, result: e.result } : a,
            );
            return { ...step, actions, actionCursor: Math.min(step.actionCursor + 1, actions.length) };
          });
        }

        case "done":
          return { ...state, status: e.status, totalSteps: e.totalSteps };
      }
    }
  }
}

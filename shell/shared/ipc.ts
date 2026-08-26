/**
 * IPC 契约 — main / preload / renderer 三方共用的类型与通道名。
 * 只放"协议"，不放进任何进程实现。
 */

import type { ExecResult } from "../../agent/types.js";

export type Provider = "openai" | "anthropic" | "google";

export type RunStatus = "completed" | "step_limit" | "error";

export interface RunRequest {
  task: string;
  provider: Provider;
  model: string;
  baseURL?: string;
  apiKey?: string;
  useDocker: boolean;
  stepLimit: number;
  cwd: string;
}

export type RunStartAck = { ok: true; runId: string } | { ok: false; error: string };

/** main -> renderer 事件流（与 AgentEvents 一一对应，done 也走这里） */
export type AgentEvent =
  | { type: "turnStart"; stepNumber: number; messageCount: number }
  | { type: "llmResponse"; stepNumber: number; content: string; actions: Array<{ command: string }> }
  | { type: "actionStart"; stepNumber: number; command: string }
  | { type: "actionDone"; stepNumber: number; command: string; result: ExecResult }
  | { type: "done"; status: RunStatus; totalSteps: number };

/** 渲染进程唯一能访问的 API（经 preload 注入 window.agentAPI） */
export interface AgentAPI {
  run(req: RunRequest): Promise<RunStartAck>;
  stop(): void;
  selectDirectory(): Promise<string | null>;
  /** 打开一个本地文件（用于查看截断的完整输出）。 */
  openPath(path: string): void;
  onEvent(cb: (e: AgentEvent) => void): () => void;
}

/** 通道名常量 */
export const IPC = {
  run: "agent:run",
  stop: "agent:stop",
  event: "agent:event",
  selectDirectory: "app:select-directory",
  openPath: "app:open-path",
} as const;

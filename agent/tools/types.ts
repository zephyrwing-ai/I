import type { ExecResult } from "../types.js";
import type { ToolCall, ToolDef } from "../model/types.js";

/** 工具执行现场：cwd 只用做相对路径解析起点，不构成沙盒。 */
export interface ToolExecutionContext {
  cwd: string;
  signal?: AbortSignal;
  invocationId?: string;
  toolCallId?: string;
  attempt?: number;
  checkpoint?: ToolCheckpoint;
}

export type ToolRecoveryMode = "safe" | "reconcile" | "never";

export interface ToolCheckpoint {
  version: number;
  kind: string;
  data: Record<string, unknown>;
}

export type ToolRecoveryResult =
  | { kind: "succeeded"; result: ToolResult }
  | { kind: "retry"; reason: string }
  | { kind: "interrupted"; reason: string; result?: ToolResult };

export interface ToolRecoverySpec {
  version: string;
  mode: ToolRecoveryMode;
  prepare?(input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolCheckpoint | undefined>;
  reconcile?(
    input: Record<string, unknown>,
    checkpoint: ToolCheckpoint | undefined,
    context: ToolExecutionContext,
  ): Promise<ToolRecoveryResult>;
}

/** 工具结果随模型工具消息回填；图片类结果经 media 走多模态通道。 */
export interface ToolResultMedia {
  mediaType: string;
  dataUrl: string;
}

export interface ToolResult extends ExecResult {
  ok: boolean;
  error?: string;
  /** 图片内容：适配层拼进模型 tool 消息的图片部分，不打印成文本。 */
  media?: ToolResultMedia;
}

/** 注册表项：模型可见的定义 + 宿主可执行的实现。 */
export interface RegisteredTool {
  definition: ToolDef;
  recovery: ToolRecoverySpec;
  execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>;
}

/** 复用回填格式：参数被截断等无法走到工具实现的失败都走这里。 */
export function toolResultForInvalidCall(_call: ToolCall, reason: string): ToolResult {
  return { ok: false, output: reason, returncode: -1, truncated: false, error: "invalid_tool_call" };
}

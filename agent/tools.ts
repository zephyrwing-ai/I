import type { BashOperations, ExecResult } from "./types.js";
import { BASH_TOOL } from "./model/index.js";
import type { ToolCall, ToolDef } from "./model/types.js";

export interface ToolExecutionContext {
  cwd: string;
  signal?: AbortSignal;
}

export interface ToolResult extends ExecResult {
  ok: boolean;
  error?: string;
}

export interface RegisteredTool {
  definition: ToolDef;
  execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>;
}

export function createToolRegistry(ops: BashOperations): Map<string, RegisteredTool> {
  return new Map([[BASH_TOOL.name, {
    definition: BASH_TOOL,
    async execute(input, context): Promise<ToolResult> {
      if (typeof input.command !== "string" || input.command.trim() === "") {
        return { ok: false, output: "工具参数 command 必须是非空字符串。", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      try {
        const result = await ops.exec(input.command, context.cwd, { timeout: 30, signal: context.signal });
        return { ...result, ok: result.returncode === 0, error: result.returncode === 0 ? undefined : "command_failed" };
      } catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : String(error), returncode: -1, truncated: false, error: "execution_failed" };
      }
    },
  }]]);
}

export function toolResultForInvalidCall(_call: ToolCall, reason: string): ToolResult {
  return { ok: false, output: reason, returncode: -1, truncated: false, error: "invalid_tool_call" };
}

import type { BashOperations } from "../types.js";
import type { ToolDef } from "../model/types.js";
import type { RegisteredTool, ToolResult } from "./types.js";

/** Bash 工具定义 — 通用终端命令，处理长尾任务。 */
export const BASH_TOOL: ToolDef = {
  name: "bash",
  description: "Execute a bash command on the local machine",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute" },
    },
    required: ["command"],
  },
};

export function createBashTool(ops: BashOperations): RegisteredTool {
  return {
    definition: BASH_TOOL,
    recovery: { version: "1", mode: "never" },
    async execute(input, context): Promise<ToolResult> {
      if (typeof input.command !== "string" || input.command.trim() === "") {
        return { ok: false, output: "Tool parameter command must be a non-empty string.", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      try {
        const result = await ops.exec(input.command, context.cwd, { timeout: 30, signal: context.signal });
        return { ...result, ok: result.returncode === 0, error: result.returncode === 0 ? undefined : "command_failed" };
      } catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : String(error), returncode: -1, truncated: false, error: "execution_failed" };
      }
    },
  };
}

import type { BashOperations } from "../types.js";
import { createBashTool } from "./bash.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createQueryTools } from "./query.js";
import type { RegisteredTool } from "./types.js";

export type { RegisteredTool, ToolResult, ToolExecutionContext, ToolResultMedia, ToolRecoveryMode, ToolRecoverySpec, ToolRecoveryResult, ToolCheckpoint } from "./types.js";
export { toolResultForInvalidCall } from "./types.js";

/**
 * 工具注册表 — 模型可见能力的完整清单。
 * 只有这里登记过的工具才会进入模型请求；实现文件存在但没有注册不代表模型拥有该能力。
 * 注册表由 run.ts（CLI）与 shell/main/runner.ts（桌面端）共享，两处入口自动同步。
 */
export function createToolRegistry(ops: BashOperations): Map<string, RegisteredTool> {
  const tools: RegisteredTool[] = [
    createBashTool(ops),
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    ...createQueryTools(),
  ];
  const registry = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    if (registry.has(tool.definition.name)) {
      throw new Error(`Duplicate tool registration: ${tool.definition.name}`);
    }
    registry.set(tool.definition.name, tool);
  }
  return registry;
}

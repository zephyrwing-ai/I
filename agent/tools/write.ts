import { relative } from "node:path";
import { mediaTypeForPath } from "../environment.js";
import type { ToolDef } from "../model/types.js";
import type { PreparedToolExecution, RegisteredTool, ToolExecutionContext, ToolResult } from "./types.js";
import { checkpointForFilePublication, reconcileTextFile, resolveToolPath } from "./recovery.js";
import { checkFileCancellation, fileErrorResult, filePublicationExecution, observeFile, planFilePublication } from "./atomic-file.js";

/** Write 工具定义 — 整文件写入；目标目录不存在时创建父目录。 */
export const WRITE_TOOL: ToolDef = {
  name: "write",
  description: "Create a file, or overwrite an existing file with the full given content. Creates missing parent directories.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Target file path, absolute or relative to the workspace root" },
      content: { type: "string", description: "Complete file content to write" },
    },
    required: ["path", "content"],
  },
};

export function createWriteTool(): RegisteredTool {
  return {
    definition: WRITE_TOOL,
    recovery: {
      version: "1",
      mode: "reconcile",
      reconcile: (input, checkpoint, context) => reconcileTextFile(checkpoint, context, "Write", input.path),
    },
    prepare: prepareWrite,
    async execute(input, context): Promise<ToolResult> {
      const prepared = await prepareWrite(input, context);
      return prepared.kind === "result" ? prepared.result : prepared.execute(context);
    },
  };
}

async function prepareWrite(input: Record<string, unknown>, context: ToolExecutionContext): Promise<PreparedToolExecution> {
  if (typeof input.path !== "string" || input.path.trim() === "" || input.path.includes("\0")) {
    return { kind: "result", result: { ok: false, output: "Tool parameter path must be a non-empty string without NUL.", returncode: -1, truncated: false, error: "invalid_arguments" } };
  }
  if (typeof input.content !== "string") {
    return { kind: "result", result: { ok: false, output: "Tool parameter content must be a string.", returncode: -1, truncated: false, error: "invalid_arguments" } };
  }
  try {
    checkFileCancellation(context);
    const target = resolveToolPath(input.path, context.cwd);
    const source = await observeFile(target);
    const plan = await planFilePublication(source, Buffer.from(input.content, "utf8"), context);
    const mediaType = mediaTypeForPath(target);
    const rel = relative(context.cwd, target) || target;
    const output = `Wrote ${rel} (${plan.bytes.length} bytes, ${source.state.exists ? "overwritten" : "created"})`;
    return filePublicationExecution(plan, checkpointForFilePublication(plan, mediaType), "Write", output, mediaType);
  } catch (error) {
    return { kind: "result", result: fileErrorResult("Write", error, "read_failed") };
  }
}

import { mkdir, writeFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, relative, dirname } from "node:path";
import { mediaTypeForPath } from "../environment.js";
import type { ToolDef } from "../model/types.js";
import type { RegisteredTool, ToolResult } from "./types.js";
import { checkpointForTextFile, readTextFileIfPresent, reconcileTextFile, resolveToolPath } from "./recovery.js";

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
      async prepare(input, context) {
        if (typeof input.path !== "string" || typeof input.content !== "string") return undefined;
        const target = resolveToolPath(input.path, context.cwd);
        const previous = await readTextFileIfPresent(target);
        return checkpointForTextFile(target, previous.exists ? previous.content : null, input.content, previous.exists ? "updated" : "created", mediaTypeForPath(target));
      },
      reconcile: (input, checkpoint, context) => reconcileTextFile(checkpoint, context, "Write"),
    },
    async execute(input, context): Promise<ToolResult> {
      if (typeof input.path !== "string" || input.path.trim() === "") {
        return { ok: false, output: "Tool parameter path must be a non-empty string.", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      if (typeof input.content !== "string") {
        return { ok: false, output: "Tool parameter content must be a non-empty string.", returncode: -1, truncated: false, error: "invalid_arguments" };
      }

      const target = isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path);

      let exists = false;
      try {
        const stats = await stat(target);
        if (stats.isDirectory()) {
          return { ok: false, output: `Target is a directory; Write expects a file: ${input.path}`, returncode: -1, truncated: false, error: "target_is_directory" };
        }
        exists = true;
      } catch {
        exists = false;
      }

      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, input.content, "utf8");
      } catch (error) {
          return { ok: false, output: `Write failed: ${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: "write_failed" };
      }

      const bytes = Buffer.byteLength(input.content, "utf8");
      const rel = relative(context.cwd, target) || target;
      const operation = exists ? "updated" : "created";
      // 与 Bash 侧 snapshot 产物同构：相同文件在同一回合内按调用顺序执行，不会并发覆盖。
      return {
        ok: true,
        output: `Wrote ${rel} (${bytes} bytes, ${operation === "created" ? "created" : "overwritten"})`,
        returncode: 0,
        truncated: false,
        artifacts: [{
          path: target,
          operation,
          mediaType: mediaTypeForPath(target),
          byteSize: bytes,
          updatedAt: new Date().toISOString(),
        }],
      };
    },
  };
}

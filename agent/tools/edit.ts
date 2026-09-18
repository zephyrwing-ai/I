import { stat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, relative } from "node:path";
import { mediaTypeForPath } from "../environment.js";
import type { ToolDef } from "../model/types.js";
import type { RegisteredTool, ToolResult } from "./types.js";

/** Edit 工具定义 — 一组基于同一份原始内容、互不重叠的“原文本→新文本”替换。 */
export const EDIT_TOOL: ToolDef = {
  name: "edit",
  description: "Apply non-overlapping text replacements to an existing text file. Each oldText must match exactly once; the whole call fails if any check fails (no partial write).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the workspace root" },
      edits: {
        type: "array",
        description: "Replacements, all checked against the current file content before writing",
        items: {
          type: "object",
          description: "One replacement",
          properties: {
            oldText: { type: "string", description: "Exact existing text to replace (must match exactly once)" },
            newText: { type: "string", description: "Replacement text" },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
};

interface EditItem {
  oldText: string;
  newText: string;
}

export function createEditTool(): RegisteredTool {
  return {
    definition: EDIT_TOOL,
    async execute(input, context): Promise<ToolResult> {
      if (typeof input.path !== "string" || input.path.trim() === "") {
        return { ok: false, output: "Tool parameter path must be a non-empty string.", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      if (!Array.isArray(input.edits) || input.edits.length === 0) {
        return { ok: false, output: "Tool parameter edits must be a non-empty array.", returncode: -1, truncated: false, error: "invalid_arguments" };
      }
      const edits: EditItem[] = [];
      for (const [i, item] of input.edits.entries()) {
        const oldText = (item as Record<string, unknown>).oldText;
        const newText = (item as Record<string, unknown>).newText;
        if (typeof oldText !== "string" || oldText.length === 0) {
          return { ok: false, output: `Edit ${i + 1}: oldText must be a non-empty string.`, returncode: -1, truncated: false, error: "invalid_arguments" };
        }
        if (typeof newText !== "string") {
          return { ok: false, output: `Edit ${i + 1}: newText must be a string.`, returncode: -1, truncated: false, error: "invalid_arguments" };
        }
        edits.push({ oldText, newText });
      }

      const target = isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path);
      let stats;
      try {
        stats = await stat(target);
      } catch {
          return { ok: false, output: `File not found: ${input.path}`, returncode: -1, truncated: false, error: "not_found" };
      }
      if (stats.isDirectory()) {
          return { ok: false, output: `Target is a directory; Edit expects a file: ${input.path}`, returncode: -1, truncated: false, error: "target_is_directory" };
      }

      let original: string;
      try {
        const buffer = await readFile(target);
        if (buffer.includes(0)) {
          return { ok: false, output: `File is not editable text (contains binary data): ${input.path}`, returncode: -1, truncated: false, error: "binary_file" };
        }
        original = buffer.toString("utf8");
      } catch (error) {
          return { ok: false, output: `Read failed: ${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: "read_failed" };
      }

      // 1. 每段 oldText 必须在原始内容中唯一匹配。
      const matches: Array<{ index: number; length: number; edit: EditItem; order: number }> = [];
      for (const [order, edit] of edits.entries()) {
        const positions: number[] = [];
        for (let at = original.indexOf(edit.oldText); at !== -1; at = original.indexOf(edit.oldText, at + 1)) {
          positions.push(at);
        }
        if (positions.length === 0) {
          return { ok: false, output: `Edit ${order + 1}: oldText was not found in the file: ${JSON.stringify(edit.oldText.slice(0, 200))}`, returncode: -1, truncated: false, error: "text_not_found" };
        }
        if (positions.length > 1) {
          return { ok: false, output: `Edit ${order + 1}: oldText matched ${positions.length} locations; exactly one match is required: ${JSON.stringify(edit.oldText.slice(0, 200))}`, returncode: -1, truncated: false, error: "text_not_unique" };
        }
        matches.push({ index: positions[0], length: edit.oldText.length, edit, order });
      }

      // 2. 各替换不能相互重叠。
      matches.sort((a, b) => a.index - b.index);
      for (let i = 1; i < matches.length; i += 1) {
        const prev = matches[i - 1];
        const curr = matches[i];
        if (curr.index < prev.index + prev.length) {
          return { ok: false, output: `Overlapping edits: ${prev.order + 1} and ${curr.order + 1}`, returncode: -1, truncated: false, error: "edits_overlap" };
        }
      }

      // 3. 基于同一份原始内容，自后向前应用，长度变化不影响前面的位置。
      let updated = original;
      for (const match of [...matches].sort((a, b) => b.index - a.index)) {
        updated = updated.slice(0, match.index) + match.edit.newText + updated.slice(match.index + match.length);
      }

      try {
        await writeFile(target, updated, "utf8");
      } catch (error) {
          return { ok: false, output: `Write failed: ${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: "write_failed" };
      }

      // 第一处变更位置：1-based 行号。
      const firstLine = (original.slice(0, matches[0].index).match(/\n/g) ?? []).length + 1;
      const rel = relative(context.cwd, target) || target;
      const lines = matches.map((m) => `  #${m.order + 1} line ${(original.slice(0, m.index).match(/\n/g) ?? []).length + 1} ${JSON.stringify(m.edit.oldText.slice(0, 200))} → ${JSON.stringify(m.edit.newText.slice(0, 200))}`).join("\n");

      return {
        ok: true,
        output: `<file>${rel}</file>\nEdit count: ${matches.length}\nFirst change: line ${firstLine}\n<diff>\n${lines}\n</diff>`,
        returncode: 0,
        truncated: false,
        artifacts: [{
          path: target,
          operation: "updated",
          mediaType: mediaTypeForPath(target),
          byteSize: Buffer.byteLength(updated, "utf8"),
          updatedAt: new Date().toISOString(),
        }],
      };
    },
  };
}

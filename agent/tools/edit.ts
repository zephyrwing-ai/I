import { isUtf8 } from "node:buffer";
import { relative } from "node:path";
import { mediaTypeForPath } from "../environment.js";
import type { ToolDef } from "../model/types.js";
import type { PreparedToolExecution, RegisteredTool, ToolExecutionContext, ToolResult } from "./types.js";
import { checkpointForFilePublication, reconcileTextFile, resolveToolPath } from "./recovery.js";
import { checkFileCancellation, FilePublicationError, fileErrorResult, filePublicationExecution, isRecord, observeFile, planFilePublication } from "./atomic-file.js";

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

interface EditItem { oldText: string; newText: string }

export function createEditTool(): RegisteredTool {
  return {
    definition: EDIT_TOOL,
    recovery: {
      version: "1",
      mode: "reconcile",
      reconcile: (input, checkpoint, context) => reconcileTextFile(checkpoint, context, "Edit", input.path),
    },
    prepare: prepareEdit,
    async execute(input, context): Promise<ToolResult> {
      const prepared = await prepareEdit(input, context);
      return prepared.kind === "result" ? prepared.result : prepared.execute(context);
    },
  };
}

async function prepareEdit(input: Record<string, unknown>, context: ToolExecutionContext): Promise<PreparedToolExecution> {
  try {
    if (typeof input.path !== "string" || input.path.trim() === "" || input.path.includes("\0")) {
      throw new FilePublicationError("invalid_arguments", "Tool parameter path must be a non-empty string without NUL.");
    }
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      throw new FilePublicationError("invalid_arguments", "Tool parameter edits must be a non-empty array.");
    }
    const edits: EditItem[] = [];
    for (const [i, item] of input.edits.entries()) {
      if (!isRecord(item) || typeof item.oldText !== "string" || item.oldText.length === 0 || item.oldText.includes("\0")) {
        throw new FilePublicationError("invalid_arguments", `Edit ${i + 1}: oldText must be a non-empty string without NUL.`);
      }
      if (typeof item.newText !== "string" || item.newText.includes("\0")) {
        throw new FilePublicationError("invalid_arguments", `Edit ${i + 1}: newText must be a string without NUL.`);
      }
      edits.push({ oldText: item.oldText, newText: item.newText });
    }
    checkFileCancellation(context);
    const target = resolveToolPath(input.path, context.cwd);
    const source = await observeFile(target);
    if (!source.bytes) throw new FilePublicationError("not_found", `File not found: ${input.path}`);
    if (source.bytes.includes(0)) throw new FilePublicationError("binary_file", `File contains NUL bytes: ${input.path}`);
    if (!isUtf8(source.bytes)) throw new FilePublicationError("invalid_encoding", `File must contain valid UTF-8: ${input.path}`);
    const original = source.bytes.toString("utf8");

    const matches: Array<{ index: number; length: number; edit: EditItem; order: number }> = [];
    for (const [order, edit] of edits.entries()) {
      let count = 0;
      let index = -1;
      for (let at = original.indexOf(edit.oldText); at !== -1; at = original.indexOf(edit.oldText, at + 1)) {
        count += 1;
        index = at;
      }
      if (count !== 1) throw new FilePublicationError(count === 0 ? "text_not_found" : "text_not_unique",
        `Edit ${order + 1}: oldText ${count === 0 ? "was not found" : `matched ${count} locations; exactly one match is required`}: ${JSON.stringify(edit.oldText.slice(0, 200))}`);
      matches.push({ index, length: edit.oldText.length, edit, order });
    }
    matches.sort((left, right) => left.index - right.index);
    for (let i = 1; i < matches.length; i += 1) {
      const prev = matches[i - 1];
      const curr = matches[i];
      if (curr.index < prev.index + prev.length) throw new FilePublicationError("edits_overlap", `Overlapping edits: ${prev.order + 1} and ${curr.order + 1}`);
    }
    // Build final bytes once from disjoint spans of the original snapshot.
    const parts: string[] = [];
    const lines: string[] = [];
    let offset = 0;
    let line = 1;
    let firstLine = 1;
    for (const match of matches) {
      const unchanged = original.slice(offset, match.index);
      line += (unchanged.match(/\n/g) ?? []).length;
      if (lines.length === 0) firstLine = line;
      parts.push(unchanged, match.edit.newText);
      lines.push(`  #${match.order + 1} line ${line} ${JSON.stringify(match.edit.oldText.slice(0, 200))} → ${JSON.stringify(match.edit.newText.slice(0, 200))}`);
      line += (match.edit.oldText.match(/\n/g) ?? []).length;
      offset = match.index + match.length;
    }
    parts.push(original.slice(offset));
    const plan = await planFilePublication(source, Buffer.from(parts.join(""), "utf8"), context);
    const mediaType = mediaTypeForPath(target);
    const rel = relative(context.cwd, target) || target;
    const output = `<file>${rel}</file>\nEdit count: ${matches.length}\nFirst change: line ${firstLine}\n<diff>\n${lines.join("\n")}\n</diff>`;
    return filePublicationExecution(plan, checkpointForFilePublication(plan, mediaType), "Edit", output, mediaType);
  } catch (error) {
    return { kind: "result", result: fileErrorResult("Edit", error, "read_failed") };
  }
}

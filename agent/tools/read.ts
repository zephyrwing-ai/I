import { stat, readFile } from "node:fs/promises";
import { isAbsolute, resolve, relative, extname } from "node:path";
import type { ToolDef } from "../model/types.js";
import type { RegisteredTool, ToolResult } from "./types.js";

/** Read 工具定义 — 按行读取文本文件；模型支持的图片返回图片内容。 */
export const READ_TOOL: ToolDef = {
  name: "read",
  description: "Read a text file by lines, or an image file as visual content. Returns the read range and the next start line when truncated.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the workspace root" },
      start: { type: "integer", description: "1-based line to start reading from (default 1)" },
      maxLines: { type: "integer", description: "Maximum lines to return (default 1000, max 5000)" },
    },
    required: ["path"],
  },
};

const DEFAULT_MAX_LINES = 1000;
const MAX_LINES = 5000;
const MAX_LINE_DISPLAY = 2000;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function createReadTool(): RegisteredTool {
  return {
    definition: READ_TOOL,
    recovery: { version: "1", mode: "safe" },
    async execute(input, context): Promise<ToolResult> {
      if (typeof input.path !== "string" || input.path.trim() === "") {
        return { ok: false, output: "Tool parameter path must be a non-empty string.", returncode: -1, truncated: false, error: "invalid_arguments" };
      }

      const start = typeof input.start === "number" && Number.isInteger(input.start) && input.start >= 1 ? input.start : 1;
      let maxLines = typeof input.maxLines === "number" && Number.isInteger(input.maxLines) ? input.maxLines : DEFAULT_MAX_LINES;
      maxLines = Math.min(Math.max(maxLines, 1), MAX_LINES);

      const target = isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path);

      let stats;
      try {
        stats = await stat(target);
      } catch {
        return { ok: false, output: `File not found: ${input.path}`, returncode: -1, truncated: false, error: "not_found" };
      }
      if (stats.isDirectory()) {
        return { ok: false, output: `Target is a directory; Read expects a file: ${input.path}`, returncode: -1, truncated: false, error: "target_is_directory" };
      }

      const ext = extname(target).toLowerCase();
      let buffer: Buffer;
      try {
        buffer = await readFile(target);
      } catch (error) {
        return { ok: false, output: `Read failed: ${error instanceof Error ? error.message : String(error)}`, returncode: -1, truncated: false, error: "read_failed" };
      }

      // 模型支持的图片：作为图片内容返回，不把二进制打印成文本。
      if (IMAGE_EXTENSIONS.has(ext)) {
        const dataUrl = `data:${mimeForExtension(ext)};base64,${buffer.toString("base64")}`;
        return {
          ok: true,
          output: `Image returned as visual content: ${input.path} (${stats.size} bytes)`,
          returncode: 0,
          truncated: false,
          media: { mediaType: mimeForExtension(ext), dataUrl },
        };
      }

      // 二进制文本检测：包含 NUL 字节的内容不是可编辑/可读文本。
      if (buffer.includes(0)) {
        return { ok: false, output: `File is neither text nor a model-supported image format: ${input.path}`, returncode: -1, truncated: false, error: "binary_file" };
      }

      const raw = buffer.toString("utf8");
      const lines = raw.split("\n");
      if (lines.at(-1) === "") lines.pop();

      const from = Math.min(start, lines.length + 1);
      const page = lines.slice(from - 1, from - 1 + maxLines);
      // 按实际读到的行数判断是否还有剩余（start/maxLines 覆盖不完文件时截断）。
      const linesTruncated = lines.length > from - 1 + page.length;
      const nextStart = linesTruncated ? from + page.length : undefined;
      const rel = relative(context.cwd, target) || target;

      const rendered = page.map((line, i) => {
        const display = line.length > MAX_LINE_DISPLAY ? `${line.slice(0, MAX_LINE_DISPLAY)} …(Line too long; truncated)` : line;
        return `${from + i}: ${display}`;
      });

      const rangeNote = linesTruncated
        ? `Read lines ${from}-${from + page.length - 1} of ${lines.length}; continue with start=${nextStart}`
        : `Read ${lines.length} lines`;

      return {
        ok: true,
        output: `<file>${rel}</file>\n${rangeNote}\n<content>\n${rendered.join("\n")}\n</content>`,
        returncode: 0,
        truncated: linesTruncated,
      };
    },
  };
}

function mimeForExtension(ext: string): string {
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

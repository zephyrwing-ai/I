import { readdir, stat, readFile } from "node:fs/promises";
import { isAbsolute, resolve, relative, extname, join, sep } from "node:path";
import { SNAPSHOT_IGNORED_DIRECTORIES } from "../environment.js";
import type { ToolDef } from "../model/types.js";
import type { RegisteredTool, ToolResult } from "./types.js";

/** Query 是本地工作区的三类结构化只读查询：列目录、找文件、搜内容。 */

export const LIST_DIR_TOOL: ToolDef = {
  name: "list_dir",
  description: "List entries of a directory (default workspace root), sorted by name, distinguishing files and directories",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list, absolute or relative to the workspace root" },
      limit: { type: "integer", description: "Maximum entries to return (default 200, max 1000)" },
    },
    required: [],
  },
};

export const FIND_FILES_TOOL: ToolDef = {
  name: "find_files",
  description: "Find files whose name or path relative to the search directory contains the pattern (case-insensitive)",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Substring to match against file names or relative paths" },
      path: { type: "string", description: "Search directory, absolute or relative to the workspace root (default workspace root)" },
      limit: { type: "integer", description: "Maximum results (default 100)" },
    },
    required: ["pattern"],
  },
};

export const SEARCH_CONTENT_TOOL: ToolDef = {
  name: "search_content",
  description: "Search lines of text files, returning file path, line number and matching lines (respects workspace ignore rules)",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to search for in file lines (case-insensitive substring)" },
      path: { type: "string", description: "Directory to search, absolute or relative to the workspace root (default workspace root)" },
      types: { type: "array", description: "File extensions to include (e.g. [\"ts\", \"md\"]); all text-typed files by default", items: { type: "string", description: "extension without dot" } },
      caseSensitive: { type: "boolean", description: "Whether the match is case-sensitive (default false)" },
      contextLines: { type: "integer", description: "Lines of context around each match (default 0, max 5)" },
      limit: { type: "integer", description: "Maximum matches (default 100)" },
    },
    required: ["text"],
  },
};

const DEFAULT_LIMIT = 100;
const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 1000;
const MAX_CONTEXT_LINES = 5;
const MAX_SCAN_FILES = 20_000;
const MAX_LINE_DISPLAY = 300;

export function createQueryTools(): RegisteredTool[] {
  return [
    { definition: LIST_DIR_TOOL, recovery: { version: "1", mode: "safe" }, execute: listDir },
    { definition: FIND_FILES_TOOL, recovery: { version: "1", mode: "safe" }, execute: findFiles },
    { definition: SEARCH_CONTENT_TOOL, recovery: { version: "1", mode: "safe" }, execute: searchContent },
  ];
}

function fail(output: string, error: string): ToolResult {
  return { ok: false, output, returncode: -1, truncated: false, error };
}

function toAbs(path: string | undefined, cwd: string): string {
  if (!path) return cwd;
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function statOrError(target: string, inputPath: string | undefined): Promise<{ stats?: Awaited<ReturnType<typeof stat>>; error?: ToolResult }> {
  try {
    const stats = await stat(target);
    return { stats };
  } catch {
    return { error: fail(`Path not found: ${inputPath ?? target}`, "not_found") };
  }
}

/** 目录遍历：跳过忽略目录与符号链接，受总扫描文件数保护。 */
async function* walkFiles(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  const stack = [root];
  let scanned = 0;
  while (stack.length > 0) {
    if (signal?.aborted) return;
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SNAPSHOT_IGNORED_DIRECTORIES.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      if (scanned > MAX_SCAN_FILES) return;
      yield full;
    }
  }
}

async function listDir(input: Record<string, unknown>, context: { cwd: string; signal?: AbortSignal }): Promise<ToolResult> {
  if (input.path !== undefined && typeof input.path !== "string") {
    return fail("Tool parameter path must be a string.", "invalid_arguments");
  }
  let limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : LIST_DEFAULT_LIMIT;
  limit = Math.min(Math.max(limit, 1), LIST_MAX_LIMIT);

  const target = toAbs(input.path as string | undefined, context.cwd);
  const { stats, error } = await statOrError(target, input.path as string | undefined);
  if (error) return error;
  if (!stats?.isDirectory()) {
    return fail(`Target is not a directory: ${input.path ?? target}`, "not_a_directory");
  }

  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch (err) {
    return fail(`Failed to read directory: ${err instanceof Error ? err.message : String(err)}`, "read_failed");
  }

  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
  const page = sorted.slice(0, limit);
  const rel = relative(context.cwd, target);
  const label = rel === "" ? "." : rel;
  const rows = page.map((e) => `${e.isDirectory() ? "dir " : "file "}${e.name}${e.isDirectory() ? "/" : ""}`);
  const truncNote = sorted.length > page.length ? `\nListed the first ${page.length} of ${sorted.length} items; more items were not listed.` : "";

  return {
    ok: true,
    output: `<directory>${label}</directory>\n${rows.join("\n") || "(Empty directory)"}${truncNote}`,
    returncode: 0,
    truncated: sorted.length > page.length,
  };
}

async function findFiles(input: Record<string, unknown>, context: { cwd: string; signal?: AbortSignal }): Promise<ToolResult> {
  if (typeof input.pattern !== "string" || input.pattern.trim() === "") {
    return fail("Tool parameter pattern must be a non-empty string.", "invalid_arguments");
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    return fail("Tool parameter path must be a string.", "invalid_arguments");
  }
  let limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : DEFAULT_LIMIT;
  limit = Math.min(Math.max(limit, 1), 1000);

  const needle = input.pattern.toLowerCase();
  const target = toAbs(input.path as string | undefined, context.cwd);
  const { stats, error } = await statOrError(target, input.path as string | undefined);
  if (error) return error;
  if (!stats?.isDirectory()) {
    return fail(`Target is not a directory: ${input.path ?? target}`, "not_a_directory");
  }

  const matches: string[] = [];
  for await (const file of walkFiles(target, context.signal)) {
    if (matches.length >= limit) {
      return {
        ok: true,
        output: `<search_root>${relative(context.cwd, target) || "."}</search_root>\n${matches.join("\n")}\nFound ${limit} matches; the result limit was reached, so not all files may have been searched.`,
        returncode: 0,
        truncated: true,
      };
    }
    const relativeToDir = relative(target, file).split(sep).join("/");
    if (relativeToDir.toLowerCase().includes(needle)) {
      matches.push(relativeToDir);
    }
  }
  matches.sort();

  return {
    ok: true,
    output: `<search_root>${relative(context.cwd, target) || "."}</search_root>\n${matches.join("\n") || "(No matching files)"}`,
    returncode: 0,
    truncated: false,
  };
}

async function searchContent(input: Record<string, unknown>, context: { cwd: string; signal?: AbortSignal }): Promise<ToolResult> {
  if (typeof input.text !== "string" || input.text === "") {
    return fail("Tool parameter text must be a non-empty string.", "invalid_arguments");
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    return fail("Tool parameter path must be a string.", "invalid_arguments");
  }
  let limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : DEFAULT_LIMIT;
  limit = Math.min(Math.max(limit, 1), 1000);
  const contextLines = Math.min(Math.max(typeof input.contextLines === "number" ? input.contextLines : 0, 0), MAX_CONTEXT_LINES);
  const caseSensitive = input.caseSensitive === true;
  const types = Array.isArray(input.types)
    ? input.types.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase().replace(/^\./, ""))
    : undefined;

  const target = toAbs(input.path as string | undefined, context.cwd);
  const { stats, error } = await statOrError(target, input.path as string | undefined);
  if (error) return error;
  if (!stats?.isDirectory()) {
    return fail(`Target is not a directory: ${input.path ?? target}`, "not_a_directory");
  }

  const needle = caseSensitive ? input.text : input.text.toLowerCase();
  const lines: string[] = [];
  let matched = 0;
  let reachedLimit = false;
  let reachedScanCap = false;

  for await (const file of walkFiles(target, context.signal)) {
    if (matched >= limit) { reachedLimit = true; break; }
    if (types) {
      const ext = extname(file).toLowerCase().replace(/^\./, "");
      if (!types.includes(ext)) continue;
    }
    let buffer: Buffer;
    try {
      buffer = await readFile(file);
    } catch {
      continue;
    }
    if (buffer.includes(0)) continue; // 跳过二进制

    const text = buffer.toString("utf8");
    const fileLines = text.split("\n");
    for (let i = 0; i < fileLines.length; i += 1) {
      if (matched >= limit) { reachedLimit = true; break; }
      const line = fileLines[i];
      const hay = caseSensitive ? line : line.toLowerCase();
      if (!hay.includes(needle)) continue;
      matched += 1;
      lines.push(`${relative(target, file).split(sep).join("/")}:${i + 1}: ${truncateLine(line)}`);
      if (contextLines > 0) {
        for (let c = Math.max(0, i - contextLines); c <= Math.min(fileLines.length - 1, i + contextLines); c += 1) {
          if (c === i) continue;
          lines.push(`  ${c + 1}: ${truncateLine(fileLines[c])}`);
        }
      }
    }
    if (reachedLimit) break;
  }

  const suffix: string[] = [];
  if (reachedLimit) suffix.push(`The match limit of ${limit} was reached; not all files may have been searched.`);
  if (reachedScanCap) suffix.push(`The scanned file limit of ${MAX_SCAN_FILES} was reached; results may be incomplete.`);

  return {
    ok: true,
    output: `<search_root>${relative(context.cwd, target) || "."}</search_root>\n${lines.join("\n") || "(No matching content)"}${suffix.length ? `\n${suffix.join("\n")}` : ""}`,
    returncode: 0,
    truncated: reachedLimit || reachedScanCap,
  };
}

function truncateLine(line: string): string {
  return line.length > MAX_LINE_DISPLAY ? `${line.slice(0, MAX_LINE_DISPLAY)} …(Line truncated)` : line;
}

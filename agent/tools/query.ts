import { readdir, stat } from "node:fs/promises";
import { isAbsolute, resolve, relative, extname, sep } from "node:path";
import { SNAPSHOT_IGNORED_DIRECTORIES } from "../environment.js";
import type { ToolDef } from "../model/types.js";
import type { RegisteredTool, ToolResult } from "./types.js";
import { runRipgrep, type RipgrepOutcome, type RipgrepStop } from "./ripgrep.js";

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
  description: "Find files by a case-insensitive literal substring of their relative path. Respects ignore rules and returns all matching paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Substring to match against file names or relative paths" },
      path: { type: "string", description: "Search directory, absolute or relative to the workspace root (default workspace root)" },
    },
    required: ["pattern"],
  },
};

export const SEARCH_CONTENT_TOOL: ToolDef = {
  name: "search_content",
  description: "Search text files for a literal keyword using ripgrep and workspace ignore rules. Returns all matches with paths, line numbers and full matching lines.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to search for in file lines (case-insensitive substring)" },
      path: { type: "string", description: "Directory to search, absolute or relative to the workspace root (default workspace root)" },
      types: { type: "array", description: "File extensions to include (e.g. [\"ts\", \"md\"]); all text-typed files by default", items: { type: "string", description: "extension without dot" } },
      caseSensitive: { type: "boolean", description: "Whether the match is case-sensitive (default false)" },
      contextLines: { type: "integer", description: "Lines of context around each match (non-negative safe integer, default 0)" },
    },
    required: ["text"],
  },
};

const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 1000;

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
  return executeSearch(input, context, "files");
}

async function searchContent(input: Record<string, unknown>, context: { cwd: string; signal?: AbortSignal }): Promise<ToolResult> {
  if (typeof input.text !== "string" || input.text === "") {
    return fail("Tool parameter text must be a non-empty string.", "invalid_arguments");
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    return fail("Tool parameter path must be a string.", "invalid_arguments");
  }
  return executeSearch(input, context, "content");
}

async function executeSearch(input: Record<string, unknown>, context: { cwd: string; signal?: AbortSignal }, mode: "files" | "content"): Promise<ToolResult> {
  if (context.signal?.aborted) return { ...fail("Query cancelled; results are incomplete.", "cancelled"), truncated: true };
  const keyword = (mode === "files" ? input.pattern : input.text) as string;
  if (keyword.includes("\0") || (input.path as string | undefined)?.includes("\0")) return fail("Query parameters must contain valid text and paths.", "invalid_arguments");
  const target = toAbs(input.path as string | undefined, context.cwd);
  const { stats, error } = await statOrError(target, input.path as string | undefined);
  if (context.signal?.aborted) return { ...fail("Query cancelled; results are incomplete.", "cancelled"), truncated: true };
  if (error) return error;
  if (!stats?.isDirectory()) return fail(`Target is not a directory: ${input.path ?? target}`, "not_a_directory");

  if (mode === "content" && input.contextLines !== undefined && (typeof input.contextLines !== "number" || !Number.isSafeInteger(input.contextLines) || input.contextLines < 0)) {
    return fail("Tool parameter contextLines must be a non-negative safe integer.", "invalid_arguments");
  }
  const contextLines = mode === "content" ? (input.contextLines as number | undefined) ?? 0 : 0;
  const types = Array.isArray(input.types)
    ? input.types.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase().replace(/^\./, "")) : undefined;
  if (types?.some((type) => type.includes("\0"))) return fail("File extensions must contain valid text.", "invalid_arguments");

  const header = `<search_root>${displayPath(relative(context.cwd, target) || ".")}</search_root>`;
  const rows: string[] = [];
  const pathNeedle = keyword.toLowerCase();
  const args = ["--hidden", "--no-require-git", "--color=never"];
  if (mode === "files") args.push("--files", "--null");
  else {
    args.push("--json", "--fixed-strings", "--context", String(contextLines));
    if (input.caseSensitive !== true) args.push("--ignore-case");
    // Native type filters compose with gitignore; positive --glob filters would override it.
    if (types?.length) {
      args.push("--type-clear", "agentquery");
      for (const type of types) args.push("--type-add", `agentquery:${extensionGlob(type)}`);
      args.push("--type", "agentquery");
    }
    args.push("--regexp", keyword);
  }
  for (const directory of SNAPSHOT_IGNORED_DIRECTORIES) args.push("--glob", `!**/${directory}/**`);
  args.push("--", ".");

  // Stage leading context until its matching line; trailing context belongs to the last match.
  let lastMatch: number | undefined;
  let pending: string[] = [];
  const outcome = mode === "content" && (keyword.includes("\n") || types?.length === 0)
    ? { code: 1, diagnostic: "" }
    : await runRipgrep({
      args, cwd: target, signal: context.signal, delimiter: mode === "files" ? 0 : 10,
      onFrame(frame) {
        if (mode === "files") {
          const file = normalizePath(frame.toString("utf8"));
          if (!file.toLowerCase().includes(pathNeedle)) return;
          rows.push(displayPath(file));
          return;
        }
        const event = JSON.parse(frame.toString("utf8")) as { type: string; data: Record<string, unknown> };
        if (event.type === "begin" || event.type === "end") {
          lastMatch = undefined;
          pending = [];
          return;
        }
        if (event.type === "summary") return;
        if (event.type !== "match" && event.type !== "context") throw new Error("Unexpected ripgrep event.");
        const file = normalizePath(decodeField(event.data.path));
        if (types && !types.includes(extname(file).toLowerCase().replace(/^\./, ""))) return;
        const line = event.data.line_number;
        if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) throw new Error("Invalid ripgrep line number.");
        const content = decodeField(event.data.lines).replace(/\r?\n$/, "");
        const row = `${displayPath(file)}:${line}: ${content}`;
        if (event.type === "context") {
          if (lastMatch !== undefined && line <= lastMatch + contextLines) {
            rows.push(row);
            return;
          }
          pending.push(row);
          if (pending.length > contextLines) pending.shift();
          return;
        }
        for (const contextRow of pending) rows.push(contextRow);
        pending = [];
        lastMatch = line;
        rows.push(row);
      },
    });
  if (mode === "files") rows.sort();
  return searchResult(header, rows, outcome, mode);
}

function searchResult(header: string, rows: string[], outcome: RipgrepOutcome, mode: "files" | "content"): ToolResult {
  const reasons: Record<RipgrepStop, string> = {
    cancelled: "Query cancelled; results are incomplete.",
    invalid_output: "Ripgrep returned invalid output; results are incomplete.",
    execution_failed: "Ripgrep execution failed; results are incomplete.",
  };
  const abnormalExit = outcome.code !== null && outcome.code !== 0 && outcome.code !== 1;
  const failed = Boolean(outcome.stop) || (outcome.code !== 0 && outcome.code !== 1);
  const notes = [
    outcome.stop ? reasons[outcome.stop] : failed ? `Ripgrep exited with code ${outcome.code ?? "unknown"}; results are incomplete.` : "",
    outcome.stop && abnormalExit ? `Ripgrep exited with code ${outcome.code}; results are incomplete.` : "",
    outcome.diagnostic,
  ].filter(Boolean);
  const empty = failed ? "(Partial results: 0 rows retained)" : mode === "files" ? "(No matching files)" : "(No matching content)";
  return {
    ok: !failed,
    output: [header, rows.join("\n") || empty, ...notes].join("\n"),
    returncode: failed ? abnormalExit ? outcome.code! : -1 : 0,
    truncated: failed,
    ...(failed ? { error: outcome.stop === "cancelled" ? "cancelled" : outcome.stop === "invalid_output" ? "invalid_output" : "execution_failed" } : {}),
  };
}

function decodeField(field: unknown): string {
  if (typeof field !== "object" || field === null) throw new Error("Invalid ripgrep text field.");
  if ("text" in field && typeof field.text === "string") return field.text;
  if ("bytes" in field && typeof field.bytes === "string") return Buffer.from(field.bytes, "base64").toString("utf8");
  throw new Error("Invalid ripgrep text encoding.");
}

function normalizePath(file: string): string {
  return file.split(sep).join("/").replace(/^\.\//, "");
}

function displayPath(file: string): string {
  return /[\r\n\x00-\x1f]/.test(file) ? JSON.stringify(file) : file;
}

function escapeGlob(value: string): string {
  return value.replace(/[\\*?\[\]{}]/g, "\\$&");
}

function extensionGlob(extension: string): string {
  // Unicode case mappings can change length; the exact extname check handles these candidates.
  if (extension === "" || /[^\x00-\x7f]/.test(extension)) return "*";
  return `*.${escapeGlob(extension).replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)}`;
}

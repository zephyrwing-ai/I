import type { ToolState } from "./agentReducer";

export type ActivityLanguage = "zh" | "en";
export type ToolActivityKind = "command" | "read" | "edit" | "search" | "list" | "history" | "canvas" | "unknown";

/** A disposable view of a call; execution arguments and results remain in AgentState. */
export interface ToolActivity {
  toolCallId: string;
  kind: ToolActivityKind;
  /** Full row text; the component controls width-based ellipsis. */
  label: string;
  /** User-facing intent; legacy calls use a factual action and target. */
  purpose: string;
  /** The original call provides status, input, and result for expanded details. */
  tool: ToolState;
  failed: boolean;
  failureLabel: string;
}

export function activityLanguage(userInput: string): ActivityLanguage {
  return /\p{Script=Han}/u.test(userInput) ? "zh" : "en";
}

function kindForTool(name: string): ToolActivityKind {
  if (["bash", "shell"].includes(name)) return "command";
  if (["read", "file", "cat"].includes(name)) return "read";
  if (["write", "edit", "patch"].includes(name)) return "edit";
  if (["search_content", "find_files", "search", "grep", "find"].includes(name)) return "search";
  if (["list_dir", "list", "files", "glob"].includes(name)) return "list";
  if (name === "history_read") return "history";
  if (name === "canvas_edit") return "canvas";
  return "unknown";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

const PURPOSE_ACTIONS: Record<ActivityLanguage, Record<ToolActivityKind, string>> = {
  zh: { command: "执行命令", read: "读取文件", edit: "编辑文件", search: "搜索文件", list: "查看目录", history: "读取历史记录", canvas: "编辑画布", unknown: "使用工具" },
  en: { command: "Run command", read: "Read file", edit: "Edit file", search: "Search files", list: "List directory", history: "Read history", canvas: "Edit Canvas", unknown: "Use tool" },
};

function purposeForTool(kind: ToolActivityKind, name: string, input: Record<string, unknown>, language: ActivityLanguage): string {
  const declared = text(input.purpose);
  if (declared) return declared.replace(/\s+/g, " ").trim();
  const action = kind === "edit" && name === "write"
    ? language === "zh" ? "写入文件" : "Write file"
    : PURPOSE_ACTIONS[language][kind];
  const target = kind === "read" || kind === "edit" || kind === "list" ? text(input.path) ?? (kind === "list" ? "." : undefined)
    : kind === "search" ? text(input.text) ?? text(input.query) ?? text(input.pattern) ?? text(input.path)
    : kind === "history" ? text(input.entryId)
    : kind === "unknown" ? text(name) : undefined;
  return target ? `${action} ${target}` : action;
}

/** Operational arguments supply row labels; the raw input remains available on the tool. */
function labelForTool(kind: ToolActivityKind, name: string, input: Record<string, unknown>): string {
  const path = text(input.path);
  switch (kind) {
    case "command": return `Ran ${text(input.command) ?? "command"}`;
    case "read": return `Read ${path ?? "file"}`;
    case "edit": return `${name === "write" ? "Wrote" : "Edited"} ${path ?? "file"}`;
    case "list": return `Listed ${path ?? "."}`;
    case "search": {
      const query = text(input.text) ?? text(input.query) ?? text(input.pattern);
      return query ? `Searched ${query} in ${path ?? "."}` : `Searched ${path ?? "."}`;
    }
    case "history": {
      const entryId = text(input.entryId);
      return entryId ? `Read history ${entryId}` : "Read history";
    }
    case "canvas": return "Edited Canvas";
    default: return `Used ${text(name) ?? "tool"}`;
  }
}

export function projectToolActivity(tool: ToolState, language: ActivityLanguage = "en"): ToolActivity {
  const input = tool.input && typeof tool.input === "object" && !Array.isArray(tool.input)
    ? tool.input as Record<string, unknown>
    : {};
  const kind = kindForTool(tool.name);
  return {
    toolCallId: tool.toolCallId,
    kind,
    label: labelForTool(kind, tool.name, input),
    purpose: purposeForTool(kind, tool.name, input, language),
    tool,
    failed: tool.result?.ok === false,
    failureLabel: language === "zh" ? "执行失败" : "Failed",
  };
}

const GROUP_ACTIONS: Record<ToolActivityKind, string> = {
  command: "ran commands", read: "read files", edit: "edited files", search: "searched files", list: "listed directories", history: "read history", canvas: "edited Canvas", unknown: "used tools",
};

/** The caller supplies one turn's batch; each category appears once in call order. */
export function summarizeToolActivities(activities: readonly ToolActivity[]): string {
  const summary = [...new Set(activities.map((activity) => GROUP_ACTIONS[activity.kind]))].join(", ");
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

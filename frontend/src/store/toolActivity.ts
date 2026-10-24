import type { ToolState } from "./agentReducer";

export type ActivityLanguage = "zh" | "en";
export type ToolActivityKind = "command" | "read" | "edit" | "search" | "list" | "history" | "canvas" | "unknown";

/** A disposable view of a call; execution arguments and results remain in AgentState. */
export interface ToolActivity {
  toolCallId: string;
  kind: ToolActivityKind;
  /** Full row text; the component controls width-based ellipsis. */
  label: string;
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

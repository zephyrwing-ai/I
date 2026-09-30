import { useEffect, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import type { RunState, ToolState } from "../../store/agentReducer";
import { MarkdownText } from "./MarkdownText";
import { MessageMeta } from "./MessageMeta";

/** <10s 保留一位小数，否则按秒取整；≥60s 转分钟：126s → "2m6s"；≥1h → "1h2m3s"。 */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}h${minutes}m${rest}s`;
  return `${minutes}m${rest}s`;
}

const COLLAPSE_THRESHOLD = 2000;
const PREVIEW_LENGTH = 600;

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return "Unable to display parameters";
  }
}

/** 从工具输入里提取展示用文本（command/path/query/pattern 优先）。 */
function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "path", "query", "pattern"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return formatInput(input).replace(/\s*\n+\s*/g, " ");
}

type ToolKind = "command" | "read" | "edit" | "search" | "list" | "unknown";

/** 工具名归入动作类型；未知工具名按原名展示。 */
function classifyTool(name: string): ToolKind {
  if (name === "bash" || name === "shell") return "command";
  if (name === "read" || name === "file" || name === "cat") return "read";
  if (name === "write" || name === "edit" || name === "patch") return "edit";
  if (name === "search_content" || name === "find_files" || name === "search" || name === "grep" || name === "find") return "search";
  if (name === "list_dir" || name === "list" || name === "files" || name === "glob") return "list";
  return "unknown";
}

/** 动作描述：动词开头加实际操作内容；未知工具名显示工具名本身。 */
function actionLabel(tool: ToolState): string {
  const content = inputText(tool.input);
  switch (classifyTool(tool.name)) {
    case "command": return `Ran ${content}`;
    case "read": return `Read ${content}`;
    case "edit": return "Edited file";
    case "search": return `Searched ${content}`;
    case "list": return `Listed files in ${content}`;
    default: return tool.name;
  }
}

function toolIconName(tool: ToolState): IconName {
  switch (classifyTool(tool.name)) {
    case "command": return "terminal";
    case "read": return "book-open";
    case "edit": return "edit";
    case "search": return "search";
    case "list": return "folder";
    default: return "tool";
  }
}

/** 回合折叠摘要：按操作类型聚合，同类合并，短语按首次执行顺序排列。 */
function summarizeTurn(tools: ToolState[]): string {
  const phrases: string[] = [];
  for (const tool of tools) {
    const kind = classifyTool(tool.name);
    const phrase =
      kind === "command" ? "Ran commands"
      : kind === "read" ? "Read files"
      : kind === "edit" ? "Edited files"
      : kind === "list" ? "Listed files"
      : kind === "search" ? "Searched"
      : null;
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases.length > 0 ? phrases.join(", ") : "Loaded a tool";
}

/** 折叠箭头：复用系统图标（同模型选择器），chevron-right 收起指右，展开旋转 90° 指下。 */
function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <Icon
      name="chevron-right"
      width={15}
      height={15}
      className={`chevron${expanded ? " is-expanded" : ""}`}
    />
  );
}

/** One steer-bounded assistant work group owns multiple model turns and their activity details. */
export function AssistantMessage({
  run,
  turnIds,
  answerTurnId,
  showDuration = false,
  isWorking = false,
  active = false,
}: {
  run: RunState;
  turnIds: string[];
  answerTurnId?: string;
  showDuration?: boolean;
  isWorking?: boolean;
  active?: boolean;
}) {
  const turns = turnIds.map((turnId) => run.turns[turnId]).filter((turn): turn is NonNullable<typeof turn> => Boolean(turn));
  const answerTurn = answerTurnId ? run.turns[answerTurnId] : undefined;
  const duration = showDuration && run.status === "completed"
    ? run.finalDurationMs ?? (run.finalTurnId ? run.turns[run.finalTurnId]?.assistantDurationMs : undefined)
    : undefined;
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isWorking) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isWorking, run.startedAt]);

  const hasActivity = turns.some((turn) => (
    Boolean(turn.reasoningContent)
    || turn.toolOrder.length > 0
    || (turn.turnId !== answerTurnId && Boolean(turn.assistantContent))
  ));
  const hasWorkDisclosure = hasActivity || isWorking;
  const startTime = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const elapsed = Number.isFinite(startTime) ? Math.max(0, now - startTime) : undefined;
  const workLabel = duration !== undefined
    ? `Worked for ${formatElapsed(duration)}`
    : `Working for${isWorking && elapsed !== undefined ? ` ${formatElapsed(elapsed)}` : ""}`;

  return (
    <div className={`model-message${active ? " search-active" : ""}`}>
      {hasWorkDisclosure ? (
        <section className={`run-work${open ? " is-open" : ""}`}>
          {hasActivity ? (
            <button type="button" className="run-work-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              <span>{workLabel}</span>
              <Chevron expanded={open} />
            </button>
          ) : (
            <div className="run-work-label">{workLabel}</div>
          )}
          {hasActivity && (
            <div className="run-work-detail">
              <div className="run-work-clip">
                {turns.map((turn) => {
                  const tools = turn.toolOrder
                    .map((toolCallId) => turn.tools[toolCallId])
                    .filter((tool): tool is ToolState => Boolean(tool));
                  const intermediateText = turn.turnId !== answerTurnId ? turn.assistantContent : "";
                  if (!turn.reasoningContent && !intermediateText && tools.length === 0) return null;
                  return (
                    <div className="run-work-turn" key={turn.turnId}>
                      {turn.reasoningContent && (
                        <div className="think-block">
                          <MarkdownText className="think-text" text={turn.reasoningContent} />
                        </div>
                      )}
                      {intermediateText && <MarkdownText className="work-intermediate-text" text={intermediateText} />}
                      {tools.length > 0 && <TurnActionFold tools={tools} />}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      ) : duration !== undefined ? (
        <div className="run-work-label">{workLabel}</div>
      ) : null}
      {answerTurn?.assistantContent && (
        <MarkdownText
          className="model-text final-answer"
          text={answerTurn.assistantContent}
        />
      )}
      {answerTurn?.assistantAt !== undefined && answerTurn.assistantContent && (
        <MessageMeta time={answerTurn.assistantAt} text={answerTurn.assistantContent} copyLabel="Copy answer" />
      )}
    </div>
  );
}

/** 回合动作折叠：一个回合的全部 agent 操作合并为一级折叠，行内再逐操作折叠。 */
function TurnActionFold({ tools }: { tools: ToolState[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`turn-action${open ? " is-open" : ""}`}>
      <button type="button" className="turn-action-fold" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="tool" width={16} height={16} className="turn-action-icon" />
        <span className="turn-action-summary">{summarizeTurn(tools)}</span>
        <Chevron expanded={open} />
      </button>
      <div className="turn-action-detail">
        <div className="turn-action-clip">
          {tools.map((tool) => <ToolRow key={tool.toolCallId} tool={tool} />)}
        </div>
      </div>
    </section>
  );
}

/** 单个工具操作：默认收起只显示图标加动作描述（`Ran git status --short`），展开显示参数与输出查看器。 */
function ToolRow({ tool }: { tool: ToolState }) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const result = tool.result;
  const output = result?.output ?? result?.error ?? "";
  const shouldCollapse = output.length > COLLAPSE_THRESHOLD;
  const shownOutput = shouldCollapse && !showAll
    ? `${output.slice(0, PREVIEW_LENGTH)}\n… Collapsed (${output.length} characters total)`
    : output;
  const isCommand = classifyTool(tool.name) === "command";

  const copyOutput = (): void => {
    void navigator.clipboard?.writeText(output).catch(() => undefined);
  };

  return (
    <section className={`tool-row${open ? " is-open" : ""}`}>
      <button type="button" className="tool-fold" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name={toolIconName(tool)} width={16} height={16} className="tool-icon" />
        <span className="tool-action">{actionLabel(tool)}</span>
        <Chevron expanded={open} />
      </button>

      <div className="tool-detail">
        <div className="tool-detail-clip">
          {!isCommand && <pre className="tool-input-pre">{formatInput(tool.input)}</pre>}
          {result?.ok === false && <span className="tool-error">Tool execution failed</span>}
          <section className="output-card">
            <div className="output-card-head">
              <span className="output-label">{isCommand ? "Shell" : tool.name}</span>
              <button type="button" className="output-copy" title="Copy output" aria-label="Copy output" onClick={copyOutput}>
                <Icon name="copy" width={15} height={15} />
              </button>
            </div>
            <pre className="output-pre">
              {isCommand && `$ ${inputText(tool.input)}\n`}
              {shownOutput}
            </pre>
          </section>
          {shouldCollapse && (
            <button className="ghost-btn" onClick={() => setShowAll((value) => !value)}>
              {showAll ? "Collapse" : "Expand full output"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

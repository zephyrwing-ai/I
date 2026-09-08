import { useEffect, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import type { RunState, TurnState, ToolState } from "../../store/agentReducer";
import { MarkdownText } from "./MarkdownText";
import { MessageMeta } from "./MessageMeta";

/**
 * 计时是 Renderer 侧对事件的观察（事件不带时间戳；规范：Main 只发结构化运行事件）。
 * 只保留 run 级总时长：runStarted → runCompleted（含全部回合与工具调用）；
 * 回合级时间不展示。reducer 保持纯函数，不写入时间。
 */
export interface RunTiming {
  startedAt: number;
  completedAt?: number;
}

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
    return "无法显示参数";
  }
}

/** 思考块：reasoning 通道的内容在折叠内以 markdown 结构直接展示（无标签），文本字样与用户消息一致（14px/24px 行高、0.02em 字距）。
 * 展示经 MarkdownText 统一管道（结构解析 → 标点规范化 → 渲染），数据层保持原始文本。 */
function ThinkBlock({ text }: { text: string }) {
  return (
    <div className="think-block">
      <MarkdownText className="think-text" text={text} />
    </div>
  );
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
      kind === "command" ? "ran commands"
      : kind === "read" ? "read files"
      : kind === "edit" ? "edited files"
      : kind === "list" ? "listed files"
      : kind === "search" ? "searched"
      : null;
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases.length > 0 ? phrases.join(", ") : "loaded a tool";
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

/**
 * 一次 run 的过程块：`Working for 27s`（运行中扫光）/ `Worked for 2m6s` 折叠行 + 展开内容。
 * 折叠内 = 思考块 + 过程文本 + 回合动作折叠；
 * 最终答案（最后一个未调用工具的回合文本，运行中亦随流实时渲染）在折叠外，直接进入阅读流。
 */
export function RunProcess({
  run,
  runTiming,
}: {
  run: RunState;
  runTiming?: RunTiming;
}) {
  const [open, setOpen] = useState(false);
  const working = runTiming !== undefined && runTiming.completedAt === undefined;
  const [now, setNow] = useState<number>(() => (working && runTiming ? Date.now() : 0));

  useEffect(() => {
    if (!working || !runTiming) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [working, runTiming]);

  const totalElapsed = runTiming
    ? working
      ? now - runTiming.startedAt
      : (runTiming.completedAt ?? now) - runTiming.startedAt
    : undefined;
  // 最终答案的时间戳行沿用 run 完成的观察时刻；运行中不显示，完成瞬间补齐。
  const completedAt = runTiming?.completedAt;

  const turns = run.turnOrder
    .map((turnId) => run.turns[turnId])
    .filter((turn): turn is TurnState => Boolean(turn));

  const finalTurn = [...turns].reverse().find(
    (turn) => turn.status === "completed" && turn.toolOrder.length === 0,
  );
  // 流式回答：运行中的最后回合若未动用工具，即为正在生成的最终回答——
  // 不等待 completed，随 text_delta 增量实时渲染进阅读流。
  const runningTurn = turns[turns.length - 1];
  const answerTurn =
    runningTurn?.status === "running" && runningTurn.toolOrder.length === 0
      ? runningTurn
      : finalTurn;

  return (
    <section className="run-process" data-searchable>
      <button type="button" className="run-fold" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={`turn-state${working ? " working" : ""}`}>
          {working ? "Working for" : "Worked for"}
          {totalElapsed !== undefined && ` ${formatElapsed(totalElapsed)}`}
        </span>
        <Chevron expanded={open} />
      </button>

      <div className={`run-detail${open ? " is-open" : ""}`}>
        <div className="run-detail-clip">
          {turns.map((turn) => {
            const isFinal = turn === answerTurn;
            const tools = turn.toolOrder
              .map((toolCallId) => turn.tools[toolCallId])
              .filter((tool): tool is ToolState => Boolean(tool));
            const showThink = Boolean(turn.reasoningContent);
            const showText = !isFinal && Boolean(turn.assistantContent);
            const showTools = tools.length > 0;
            if (!showThink && !showText && !showTools) return null;
            return (
              <div className="fold-turn" key={turn.turnId}>
                {showThink && <ThinkBlock text={turn.reasoningContent} />}
                {showText && <MarkdownText className="model-text" text={turn.assistantContent} />}
                {showTools && <TurnActionFold tools={tools} />}
              </div>
            );
          })}
        </div>
      </div>

      {answerTurn?.assistantContent && (
        <div className="model-message">
          <MarkdownText className="model-text final-answer" text={answerTurn.assistantContent} searchable />
          {completedAt !== undefined && (
            <MessageMeta time={completedAt} text={answerTurn.assistantContent} copyLabel="复制答案" />
          )}
        </div>
      )}
    </section>
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
    ? `${output.slice(0, PREVIEW_LENGTH)}\n… 已折叠（共 ${output.length} 字符）`
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
          {result?.ok === false && <span className="tool-error">工具执行失败</span>}
          <section className="output-card">
            <div className="output-card-head">
              <span className="output-label">{isCommand ? "Shell" : tool.name}</span>
              <button type="button" className="output-copy" title="复制输出" aria-label="复制输出" onClick={copyOutput}>
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
              {showAll ? "收起" : "展开完整输出"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

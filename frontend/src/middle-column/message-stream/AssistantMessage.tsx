import { useEffect, useState } from "react";
import { Icon, type IconName } from "../../shared/ui/Icon";
import type { RunState } from "../../store/agentReducer";
import { projectAssistantActivity } from "../../store/assistantActivity";
import { activityLanguage, summarizeToolActivities, type ToolActivity } from "../../store/toolActivity";
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

function toolIconName(kind: ToolActivity["kind"]): IconName {
  switch (kind) {
    case "command": return "terminal";
    case "read":
    case "history": return "book-open";
    case "edit":
    case "canvas": return "edit";
    case "search": return "search";
    case "list": return "folder";
    default: return "tool";
  }
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

/** User choice lasts for the current execution phase; phase changes restore its default. */
function useActivityDisclosure(autoOpen: boolean) {
  const [choice, setChoice] = useState<{ phase: boolean; open: boolean }>();
  if (choice && choice.phase !== autoOpen) setChoice(undefined);
  const open = choice?.phase === autoOpen ? choice.open : autoOpen;
  return { open, toggle: () => setChoice({ phase: autoOpen, open: !open }) };
}

/** One steer-bounded assistant work group owns multiple model turns and their activity details. */
export function AssistantMessage({
  run,
  anchorInputId,
  turnIds,
  answerTurnId,
  showDuration = false,
  isWorking = false,
  active = false,
}: {
  run: RunState;
  anchorInputId?: string;
  turnIds: string[];
  answerTurnId?: string;
  showDuration?: boolean;
  isWorking?: boolean;
  active?: boolean;
}) {
  const turns = turnIds.map((turnId) => run.turns[turnId]).filter((turn): turn is NonNullable<typeof turn> => Boolean(turn));
  const confirmedAnswerId = isWorking ? undefined : answerTurnId;
  const answerTurn = confirmedAnswerId ? run.turns[confirmedAnswerId] : undefined;
  const initialInput = run.timeline.find((item) => item.kind === "user" && run.inputs[item.inputId]?.status === "applied");
  const inputId = anchorInputId ?? turns[0]?.anchorInputId ?? (initialInput?.kind === "user" ? initialInput.inputId : undefined);
  const language = activityLanguage(inputId ? run.inputs[inputId]?.task ?? "" : "");
  const duration = showDuration && run.status === "completed"
    ? run.finalDurationMs ?? (run.finalTurnId ? run.turns[run.finalTurnId]?.assistantDurationMs : undefined)
    : undefined;
  const { open, toggle } = useActivityDisclosure(isWorking);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isWorking) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isWorking, run.startedAt]);

  const { turns: activityTurns, hasActivity, hasReasoningNotice } = projectAssistantActivity(run, turnIds, confirmedAnswerId, isWorking, language);
  const hasWorkDisclosure = hasActivity || isWorking || hasReasoningNotice;
  const startTime = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const elapsed = Number.isFinite(startTime) ? Math.max(0, now - startTime) : undefined;
  const workLabel = duration !== undefined
    ? `Worked for ${formatElapsed(duration)}`
    : `Working for${isWorking && elapsed !== undefined ? ` ${formatElapsed(elapsed)}` : ""}`;

  return (
    <div className={`model-message${active ? " search-active" : ""}`}>
      {hasWorkDisclosure ? (
        <section className={`run-work${open ? " is-open" : ""}`}>
          <button type="button" className="run-work-toggle" aria-expanded={open} onClick={toggle}>
            <span>{workLabel}</span>
            <Chevron expanded={open} />
          </button>
          <div className="run-work-detail" aria-hidden={!open} {...(!open ? { inert: "" } : {})}>
            <div className="run-work-clip">
              {activityTurns.map((turn) => {
                if (!turn.commentary && turn.tools.length === 0) return null;
                return (
                  <div className="run-work-turn" key={turn.turnId}>
                    {turn.commentary && <MarkdownText className="work-commentary-text" text={turn.commentary} />}
                    {turn.tools.length > 0 && <TurnActionFold activities={turn.tools} running={turn.toolsRunning} />}
                  </div>
                );
              })}
              {!hasActivity && isWorking && (
                <p className="work-status" role="status">
                  {language === "zh" ? "正在等待过程说明。" : "Waiting for a process explanation."}
                </p>
              )}
              {hasReasoningNotice && (
                <p className="work-status work-legacy-notice">
                  {language === "zh"
                    ? "原始推理已保存，公开正文见下方回答。"
                    : "Raw reasoning is saved; the public response appears below."}
                </p>
              )}
            </div>
          </div>
        </section>
      ) : duration !== undefined ? (
        <div className="run-work-label">{workLabel}</div>
      ) : null}
      {answerTurn?.assistantContent && (
        <>
          <MarkdownText className="model-text final-answer" text={answerTurn.assistantContent} />
          <MessageMeta time={answerTurn.assistantAt} text={answerTurn.assistantContent} copyLabel="Copy answer" />
        </>
      )}
    </div>
  );
}

/** Each turn keeps its prose followed by one disclosure of concise tool activities. */
function TurnActionFold({ activities, running }: { activities: ToolActivity[]; running: boolean }) {
  const { open, toggle } = useActivityDisclosure(running);
  return (
    <section className={`turn-action${open ? " is-open" : ""}`}>
      <button type="button" className="turn-action-fold" aria-expanded={open} onClick={toggle}>
        <Icon name="tool" width={16} height={16} className="turn-action-icon" />
        <span className="turn-action-summary">{summarizeToolActivities(activities)}</span>
        <Chevron expanded={open} />
      </button>
      <div className="turn-action-detail" aria-hidden={!open} {...(!open ? { inert: "" } : {})}>
        <div className="turn-action-clip">
          {activities.map((activity) => <ToolRow key={activity.toolCallId} activity={activity} />)}
        </div>
      </div>
    </section>
  );
}

/** Expanded evidence is mounted on demand; collapsed rows keep only the actual action. */
function ToolRow({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool-row${activity.failed ? " is-failed" : ""}${open ? " is-open" : ""}`} data-tool-call-id={activity.toolCallId}>
      <button type="button" className="tool-fold" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name={activity.failed ? "warning" : toolIconName(activity.kind)} width={16} height={16} className="tool-icon" />
        <span className="tool-action">{activity.label}</span>
        {activity.failed && <span className="tool-error">{activity.failureLabel}</span>}
        <Chevron expanded={open} />
      </button>
      {open && (
        <div className="tool-detail">
          <pre className="tool-input-pre">{JSON.stringify(activity.tool.input, null, 2)}</pre>
          {activity.tool.result && <pre className="tool-output-pre">{activity.tool.result.output}</pre>}
          {activity.tool.result?.error && <p className="tool-error">{activity.tool.result.error}</p>}
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";

const messageTimeFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** 消息时间：Thu Sep 17 11:45 AM，不带逗号。 */
export function formatMessageTime(timestamp: number): string {
  const parts = messageTimeFormatter.formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes): string => (
    parts.find((part) => part.type === type)?.value ?? ""
  );
  return `${value("weekday")} ${value("month")} ${value("day")} ${value("hour")}:${value("minute")} ${value("dayPeriod")}`;
}

const COPY_FEEDBACK_DURATION = 2_000;
type CopyState = "idle" | "success" | "error";

export async function copyMessageText(text: string): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) throw new Error("Clipboard API unavailable");
  await clipboard.writeText(text);
}

/**
 * 消息元信息行：发送时间 + 复制图标。用户消息右对齐、模型消息左对齐，与消息下缘间距 8px；
 * 默认隐藏，悬停或键盘聚焦消息区域时 120ms 淡入。
 * 复制图标 14×14px、无背景；点击把消息全文写入剪贴板，成功或失败时显示短暂反馈。
 */
export function MessageMeta({
  time,
  text,
  copyLabel = "Copy message",
}: {
  time: number;
  text: string;
  copyLabel?: string;
}) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const feedbackTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
  }, []);

  const showCopyState = (nextState: CopyState): void => {
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    setCopyState(nextState);
    feedbackTimer.current = window.setTimeout(() => {
      feedbackTimer.current = null;
      setCopyState("idle");
    }, COPY_FEEDBACK_DURATION);
  };

  const copyMessage = async (): Promise<void> => {
    try {
      await copyMessageText(text);
      showCopyState("success");
    } catch {
      showCopyState("error");
    }
  };

  const feedbackLabel = copyState === "success" ? "Copied" : copyState === "error" ? "Copy failed" : copyLabel;
  const iconName = copyState === "success" ? "check" : copyState === "error" ? "warning" : "copy";

  return (
    <div className={`message-meta${copyState !== "idle" ? " has-copy-feedback" : ""}`}>
      <span className="message-time">{formatMessageTime(time)}</span>
      <button
        type="button"
        className={`message-copy${copyState === "success" ? " is-copied" : ""}${copyState === "error" ? " is-copy-error" : ""}`}
        title={feedbackLabel}
        aria-label={feedbackLabel}
        onClick={() => void copyMessage()}
      >
        <Icon name={iconName} width={14} height={14} strokeWidth={2} />
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copyState === "success" ? "Copied" : copyState === "error" ? "Copy failed" : ""}
      </span>
    </div>
  );
}

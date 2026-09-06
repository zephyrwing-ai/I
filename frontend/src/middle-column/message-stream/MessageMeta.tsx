import { Icon } from "../../components/Icon";

/** 消息时间：英文星期 + h:mm AM/PM，如 Wednesday 2:17 PM（见设计文档「时间戳与复制行」）。 */
export function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * 消息元信息行：发送时间 + 复制图标。用户消息右对齐、模型消息左对齐，与消息下缘间距 8px；
 * 默认隐藏，悬停或键盘聚焦消息区域时 120ms 淡入。
 * 复制图标 14×14px、无背景；点击把消息全文写入剪贴板。
 */
export function MessageMeta({
  time,
  text,
  copyLabel = "复制消息",
}: {
  time: number;
  text: string;
  copyLabel?: string;
}) {
  const copyMessage = (): void => {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  };

  return (
    <div className="message-meta">
      <span className="message-time">{formatMessageTime(time)}</span>
      <button type="button" className="message-copy" title={copyLabel} aria-label={copyLabel} onClick={copyMessage}>
        <Icon name="copy" width={14} height={14} />
      </button>
    </div>
  );
}

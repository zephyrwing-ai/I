import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { InputAttachmentDescriptor, ModelOption, RunRequest } from "../../../../shell/shared/ipc";
import type { RunSettings } from "../../store/runSettings";
import { Icon } from "../../components/Icon";
import "./Composer.css";

interface ComposerProps {
  running: boolean;
  stopping: boolean;
  settings: RunSettings;
  modelOptions: ModelOption[];
  modelLoading: boolean;
  onSettingsChange: (settings: RunSettings) => void;
  onRun: (req: RunRequest) => void;
  onStop: () => void;
}

/** 对话框列：输入框 + 附件 + 模型选择 + 发送/停止。位于中间列（Column）的 auto 行。 */
export function Composer({ running, stopping, settings, modelOptions, modelLoading, onSettingsChange, onRun, onStop }: ComposerProps) {
  const [task, setTask] = useState("");
  const [attachments, setAttachments] = useState<InputAttachmentDescriptor[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const modelRootRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelLabelRef = useRef<HTMLSpanElement>(null);
  const taskInputRef = useRef<HTMLTextAreaElement>(null);
  const selectedModel = modelOptions.find((option) => option.modelOptionId === settings.modelOptionId);
  const selectableModels = modelOptions.filter((option) => option.available);

  const canRun = !running && task.trim() !== "" && Boolean(selectedModel?.available);
  const disabledReason = !task.trim()
    ? "请输入任务"
    : !selectedModel?.available
      ? "请选择可用模型"
      : null;

  /** 模型按钮宽度自适应：按文本自然宽与固定构成（水平边距8×2、间隙12、箭头15）设置显式宽度，由 CSS 180ms 过渡平滑变化。 */
  useLayoutEffect(() => {
    const trigger = modelTriggerRef.current;
    const label = modelLabelRef.current;
    if (!trigger || !label) return;
    // 解除 flex 收缩与 max-width 约束后测量文本自然宽，避免被旧宽度裁出省略号污染测量值；
    // 用小数几何宽并向上取整：scrollWidth 按整数取整会丢 0.4~0.9px 的小数部分，
    // 内容宽超出按钮宽的零点几像素会被省略号补齐，反而吃掉末位一两个字母。
    const previousFlex = label.style.flex;
    const previousMaxWidth = label.style.maxWidth;
    label.style.flex = "none";
    label.style.maxWidth = "none";
    const naturalWidth = Math.ceil(label.getBoundingClientRect().width);
    label.style.flex = previousFlex;
    label.style.maxWidth = previousMaxWidth;
    trigger.style.width = `${naturalWidth + 43}px`;
  }, [modelLoading, selectedModel?.displayName]);

  useEffect(() => {
    if (!modelOpen) return;
    const close = (event: PointerEvent): void => {
      if (!modelRootRef.current?.contains(event.target as Node)) setModelOpen(false);
    };
    const closeWithEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setModelOpen(false);
      modelTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [modelOpen]);

  const navigateModels = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!modelOpen || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [...(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'))];
    if (!options.length) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : event.key === "ArrowDown"
          ? (current + 1 + options.length) % options.length
          : (current - 1 + options.length) % options.length;
    options[next].focus();
  };

  const pickAttachments = async (): Promise<void> => {
    if (!window.agentAPI || typeof window.agentAPI.selectAttachments !== "function") return;
    const selected = await window.agentAPI.selectAttachments();
    if (!selected.length) return;
    setAttachments((current) => {
      const byId = new Map(current.map((attachment) => [attachment.attachmentId, attachment]));
      for (const attachment of selected) byId.set(attachment.attachmentId, attachment);
      return [...byId.values()];
    });
  };

  const submit = (): void => {
    if (!canRun) return;
    const request = {
      task: task.trim(),
      modelOptionId: settings.modelOptionId,
      attachmentIds: attachments.map((attachment) => attachment.attachmentId),
    } satisfies RunRequest;
    onRun(request);
    // 发送后清空输入与附件：消息已经在消息列，Composer 不再保留副本；
    // 文本域高度也同步重置（updateTask 曾按内容撑高）。
    setTask("");
    setAttachments([]);
    const input = taskInputRef.current;
    if (input) {
      input.style.height = "auto";
      input.style.overflowY = "hidden";
    }
  };

  const onTaskKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const updateTask = (element: HTMLTextAreaElement): void => {
    setTask(element.value);
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
    element.style.overflowY = element.scrollHeight > 180 ? "auto" : "hidden";
  };

  return (
    <footer className="composer">
      <div className="composer-shell">
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="附件">
            {attachments.map((attachment) => (
              <div className="composer-attachment" key={attachment.attachmentId}>
                <span className="attachment-icon"><Icon name={attachment.mediaType.startsWith("image/") ? "image" : "file"} width="15" height="15" /></span>
                <span className="attachment-info"><strong>{attachment.name}</strong><small>{formatBytes(attachment.byteSize)}</small></span>
                <button type="button" onClick={() => setAttachments((current) => current.filter((candidate) => candidate.attachmentId !== attachment.attachmentId))} disabled={running} aria-label={`移除附件 ${attachment.name}`} title="移除附件"><Icon name="close" width="14" height="14" /></button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taskInputRef}
          className="task-input"
          placeholder="What's up?"
          value={task}
          disabled={running}
          onChange={(event) => updateTask(event.currentTarget)}
          onKeyDown={onTaskKeyDown}
          aria-label="任务"
        />

        <div className="composer-toolbar">
          <div className="composer-left">
            <button type="button" className="composer-icon-button" onClick={() => void pickAttachments()} disabled={running} aria-label="上传文件" title="上传文件"><Icon name="plus" width="18" height="18" /></button>
          </div>

          <div className="composer-right">
            <div className="model-picker" ref={modelRootRef}>
              <button ref={modelTriggerRef} type="button" className="model-picker-trigger" onClick={() => setModelOpen((value) => !value)} disabled={running || modelLoading} aria-haspopup="listbox" aria-expanded={modelOpen} title="选择模型">
                <span ref={modelLabelRef}>{modelLoading ? "读取模型…" : selectedModel?.displayName ?? "选择模型"}</span><Icon name="chevron-right" width="15" height="15" />
              </button>
              {modelOpen && (
                <div className="model-popover" role="listbox" aria-label="选择模型" onKeyDown={navigateModels}>
                  {selectableModels.length === 0 && <div className="model-empty"><span>尚未添加可用模型</span></div>}
                  {selectableModels.map((model) => (
                    <button key={model.modelOptionId} type="button" role="option" aria-selected={model.modelOptionId === settings.modelOptionId} onClick={() => {
                      onSettingsChange({ ...settings, modelOptionId: model.modelOptionId });
                      setModelOpen(false);
                      modelTriggerRef.current?.focus();
                    }}>
                      <strong>{model.displayName}</strong>{model.modelOptionId === settings.modelOptionId && <Icon name="check" width="16" height="16" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button type="button" className={`send-stop-button ${running ? "is-stop" : "is-send"}`} onClick={running ? onStop : submit} disabled={running ? stopping : !canRun} aria-label={running ? (stopping ? "正在停止" : "停止运行") : "发送"} title={running ? (stopping ? "正在停止" : "停止运行") : (disabledReason ?? "发送")} aria-busy={stopping || undefined}>
              <span className="send-stop-icon" key={running ? "stop" : "send"}><Icon name={running ? "stop" : "arrow-up"} width={18} height={18} /></span>
            </button>
          </div>
        </div>
        {!running && disabledReason && task.trim() && <span className="composer-hint" role="status">{disabledReason}</span>}
      </div>
    </footer>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { InputAttachmentDescriptor, ModelOption, RunRequest } from "../../../../shell/shared/ipc";
import { Icon } from "../../components/Icon";
import { isSendKey } from "./sendKey";
import "./Composer.css";

const MODEL_OPTION_STORAGE_KEY = "workbench.modelOptionId";
const MODEL_PICKER_LAYOUT_STORAGE_KEY = "workbench.modelPickerLayout.v1";

export interface StoredModelPickerPreference {
  modelOptionId: string;
  displayName: string;
  width: number | null;
}

interface ComposerProps {
  running: boolean;
  stopping: boolean;
  ready?: boolean;
  modelOptions: ModelOption[];
  modelLoading: boolean;
  onRun: (req: RunRequest) => void;
  onStop: () => void;
}

/** 只有仍在导入目录中的模型才能成为 Composer 的已恢复选择；可用性由发送条件单独判断。 */
export function restoreStoredModelOptionId(storedId: string, modelOptions: ModelOption[]): string {
  const modelOptionId = storedId.trim();
  return modelOptions.some((model) => model.imported && model.modelOptionId === modelOptionId) ? modelOptionId : "";
}

export function parseStoredModelPickerPreference(serialized: string | null, legacyModelOptionId: string | null): StoredModelPickerPreference {
  const legacyId = legacyModelOptionId?.trim() ?? "";
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized) as Partial<StoredModelPickerPreference>;
      const modelOptionId = typeof parsed.modelOptionId === "string" ? parsed.modelOptionId.trim() : "";
      const displayName = typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
      const width = typeof parsed.width === "number" && Number.isFinite(parsed.width) && parsed.width > 0
        ? parsed.width
        : null;
      if (modelOptionId && displayName && width !== null) {
        // 旧 key 在用户刚切换模型时会先写入；两者不一致时，以最新的选择为准，避免恢复旧布局对应的模型。
        if (legacyId && legacyId !== modelOptionId) return { modelOptionId: legacyId, displayName: "", width: null };
        return { modelOptionId, displayName, width };
      }
    } catch {
      // 旧版本或损坏的布局缓存不应阻断 Composer 启动。
    }
  }

  return { modelOptionId: legacyId, displayName: "", width: null };
}

/** 对话框列：输入框 + 附件 + 模型选择 + 发送/停止。位于中间列（Column）的 auto 行。 */
export function Composer({ running, stopping, ready = true, modelOptions, modelLoading, onRun, onStop }: ComposerProps) {
  const [task, setTask] = useState("");
  const [attachments, setAttachments] = useState<InputAttachmentDescriptor[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const { selectedModelOptionId, selectModel, storedPreference } = useSelectedModelOption(modelOptions, modelLoading);
  const modelRootRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelLabelRef = useRef<HTMLSpanElement>(null);
  const taskInputRef = useRef<HTMLTextAreaElement>(null);
  const modelSelectionChangedRef = useRef(false);
  const modelPickerPreferenceRef = useRef(storedPreference);
  const [modelTriggerWidth, setModelTriggerWidth] = useState<number | null>(() => (
    storedPreference.modelOptionId === selectedModelOptionId ? storedPreference.width : null
  ));
  const [animateModelWidth, setAnimateModelWidth] = useState(false);
  const selectedModel = modelOptions.find((option) => option.imported && option.modelOptionId === selectedModelOptionId);
  const selectableModels = modelOptions.filter((option) => option.imported && option.available);
  const cachedModelDisplayName = storedPreference.modelOptionId === selectedModelOptionId
    ? storedPreference.displayName
    : "";
  const modelDisplayName = selectedModel?.displayName
    ?? (cachedModelDisplayName || (modelLoading ? "读取模型…" : "选择模型"));

  const canRun = ready && !running && task.trim() !== "" && Boolean(selectedModel?.available);
  const disabledReason = !task.trim()
    ? "请输入任务"
    : !selectedModel?.available
      ? "请选择可用模型"
      : null;

  /**
   * 启动时优先使用已缓存的布局快照；只有缓存缺失、模型名称变化或用户切换模型时才重新测量。
   * 启动校正不启用过渡，避免异步模型目录返回后按钮再次闪动。
   */
  useLayoutEffect(() => {
    const trigger = modelTriggerRef.current;
    const label = modelLabelRef.current;
    if (!trigger || !label) return;
    const cachedPreference = modelPickerPreferenceRef.current;
    const cachedLayoutMatches = cachedPreference.modelOptionId === selectedModelOptionId
      && cachedPreference.displayName === modelDisplayName
      && cachedPreference.width !== null
      && modelTriggerWidth === cachedPreference.width;
    if (cachedLayoutMatches) return;
    if (modelLoading && !selectedModel && !cachedModelDisplayName) return;

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
    const nextWidth = naturalWidth + 43;
    const shouldAnimate = modelSelectionChangedRef.current;
    modelSelectionChangedRef.current = false;
    if (modelTriggerWidth !== nextWidth) setModelTriggerWidth(nextWidth);
    setAnimateModelWidth(shouldAnimate);
    if (selectedModel) {
      const nextPreference = { modelOptionId: selectedModelOptionId, displayName: selectedModel.displayName, width: nextWidth };
      modelPickerPreferenceRef.current = nextPreference;
      persistModelPickerPreference(nextPreference);
    }
  // modelTriggerWidth intentionally stays out of the dependency list: setting the measured width
  // must not schedule a second measurement for the same model.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cachedModelDisplayName, modelDisplayName, modelLoading, selectedModel?.displayName, selectedModelOptionId, storedPreference.displayName, storedPreference.modelOptionId, storedPreference.width]);

  useEffect(() => {
    if (!animateModelWidth) return;
    const timer = window.setTimeout(() => setAnimateModelWidth(false), 220);
    return () => window.clearTimeout(timer);
  }, [animateModelWidth]);

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
      modelOptionId: selectedModelOptionId,
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
    // 输入法组字期间 Enter 确认候选并上屏（isComposing 为 true）；组字结束后再次 Enter 才提交任务。
    // 原生事件携带 isComposing，合成事件类型未声明该字段。
    if (isSendKey(e.key, e.shiftKey, e.nativeEvent.isComposing)) {
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
                <span className="attachment-icon"><Icon name={attachment.mediaType.startsWith("image/") ? "image" : "book-open"} width="15" height="15" /></span>
                <span className="attachment-info"><strong>{attachment.name}</strong><small>{formatBytes(attachment.byteSize)}</small></span>
          <button type="button" onClick={() => setAttachments((current) => current.filter((candidate) => candidate.attachmentId !== attachment.attachmentId))} disabled={running || !ready} aria-label={`移除附件 ${attachment.name}`} title="移除附件"><Icon name="close" width="14" height="14" /></button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taskInputRef}
          className="task-input"
          placeholder="What's up?"
          value={task}
          disabled={running || !ready}
          onChange={(event) => updateTask(event.currentTarget)}
          onKeyDown={onTaskKeyDown}
          aria-label="任务"
        />

        <div className="composer-toolbar">
          <div className="composer-left">
            <button type="button" className="composer-icon-button" onClick={() => void pickAttachments()} disabled={running || !ready} aria-label="上传文件" title="上传文件"><Icon name="plus" width="18" height="18" /></button>
          </div>

          <div className="composer-right">
            <div className="model-picker" ref={modelRootRef}>
              <button ref={modelTriggerRef} type="button" className={`model-picker-trigger ${animateModelWidth ? "is-width-animated" : ""}`} style={modelTriggerWidth === null ? undefined : { width: `${modelTriggerWidth}px` }} onClick={() => setModelOpen((value) => !value)} disabled={running || !ready || modelLoading} aria-haspopup="listbox" aria-expanded={modelOpen} title={ready ? "选择模型" : "正在加载历史"}>
                <span ref={modelLabelRef}>{modelDisplayName}</span><Icon name="chevron-right" width="15" height="15" />
              </button>
              {modelOpen && (
                <div className="model-popover" role="listbox" aria-label="选择模型" onKeyDown={navigateModels}>
                  {selectableModels.length === 0 && <div className="model-empty"><span>尚未添加可用模型</span></div>}
                  {selectableModels.map((model) => (
                    <button key={model.modelOptionId} type="button" role="option" aria-selected={model.modelOptionId === selectedModelOptionId} onClick={() => {
                      if (model.modelOptionId !== selectedModelOptionId) modelSelectionChangedRef.current = true;
                      selectModel(model.modelOptionId);
                      setModelOpen(false);
                      modelTriggerRef.current?.focus();
                    }}>
                      <strong>{model.displayName}</strong>{model.modelOptionId === selectedModelOptionId && <Icon name="check" width="16" height="16" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button type="button" className={`send-stop-button ${running ? "is-stop" : "is-send"}`} onClick={running ? onStop : submit} disabled={running ? stopping : !canRun} aria-label={running ? (stopping ? "正在停止" : "停止运行") : "发送"} title={running ? (stopping ? "正在停止" : "停止运行") : (ready ? (disabledReason ?? "发送") : "正在加载历史")} aria-busy={stopping || undefined}>
              <span className="send-stop-icon" key={running ? "stop" : "send"}><Icon name={running ? "stop" : "arrow-up"} width={18} height={18} /></span>
            </button>
          </div>
        </div>
        {!running && disabledReason && task.trim() && <span className="composer-hint" role="status">{disabledReason}</span>}
      </div>
    </footer>
  );
}

function useSelectedModelOption(modelOptions: ModelOption[], modelLoading: boolean): {
  selectedModelOptionId: string;
  selectModel: (modelOptionId: string) => void;
  storedPreference: StoredModelPickerPreference;
} {
  const [storedPreference] = useState(readStoredModelPickerPreference);
  const [selectedModelOptionId, setSelectedModelOptionId] = useState(storedPreference.modelOptionId);

  useEffect(() => {
    if (modelLoading) return;
    setSelectedModelOptionId((current) => restoreStoredModelOptionId(current || storedPreference.modelOptionId, modelOptions));
  }, [modelLoading, modelOptions, storedPreference.modelOptionId]);

  const selectModel = useCallback((modelOptionId: string): void => {
    setSelectedModelOptionId(modelOptionId);
    persistModelOptionId(modelOptionId);
  }, []);

  return { selectedModelOptionId, selectModel, storedPreference };
}

function readStoredModelPickerPreference(): StoredModelPickerPreference {
  try {
    return parseStoredModelPickerPreference(
      globalThis.localStorage?.getItem(MODEL_PICKER_LAYOUT_STORAGE_KEY) ?? null,
      globalThis.localStorage?.getItem(MODEL_OPTION_STORAGE_KEY) ?? null,
    );
  } catch {
    return { modelOptionId: "", displayName: "", width: null };
  }
}

function persistModelOptionId(modelOptionId: string): void {
  try {
    globalThis.localStorage?.setItem(MODEL_OPTION_STORAGE_KEY, modelOptionId);
  } catch {
    // 本地偏好不可写时，Composer 保持本次 Renderer 生命周期内的选择。
  }
}

function persistModelPickerPreference(preference: StoredModelPickerPreference): void {
  try {
    globalThis.localStorage?.setItem(MODEL_PICKER_LAYOUT_STORAGE_KEY, JSON.stringify(preference));
    globalThis.localStorage?.setItem(MODEL_OPTION_STORAGE_KEY, preference.modelOptionId);
  } catch {
    // 本地偏好不可写时，Composer 保持本次 Renderer 生命周期内的布局。
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

import { useI18n } from "../../shared/i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type SetStateAction } from "react";
import type { CanvasContextDescriptor, InputAttachmentDescriptor, ModelOption, ProjectDescriptor, RunRequest, SteerRequest } from "../../../../shell/shared/ipc";
import { Icon } from "../../shared/ui/Icon";
import { Select } from "../../shared/ui/Select";
import { isSendKey } from "./sendKey";
import { useVoiceInput } from "./useVoiceInput";
import { VoiceWaveform } from "./VoiceWaveform";
import { appendVoiceTranscript, voiceButtonLabel } from "./voice";
import { AttachmentCards } from "./upload-files/AttachmentCards";
import { useUploadFiles } from "./upload-files/useUploadFiles";
import "./Composer.css";

const MODEL_OPTION_STORAGE_KEY = "workbench.modelOptionId";
const MODEL_PICKER_PREFERENCE_STORAGE_KEY = "workbench.modelPickerLayout.v1";

export interface StoredModelPickerPreference {
  modelOptionId: string;
  displayName: string;
}

export type ComposerAction = "start" | "starting" | "steer" | "stop" | "submitting" | "stopping";

export function selectComposerAction({
  running,
  stopping,
  submitting,
  activeRunId,
  hasText,
}: {
  running: boolean;
  stopping: boolean;
  submitting: boolean;
  activeRunId: string | null;
  hasText: boolean;
}): ComposerAction {
  if (stopping) return "stopping";
  if (submitting) return "submitting";
  if (!running) return "start";
  if (!activeRunId) return "starting";
  return hasText ? "steer" : "stop";
}

interface ComposerProps {
  running: boolean;
  stopping: boolean;
  activeRunId?: string | null;
  restoreDraft?: { id: string; text: string } | null;
  ready?: boolean;
  modelOptions: ModelOption[];
  modelLoading: boolean;
  onRun: (req: RunRequest) => Promise<boolean>;
  onSteer?: (req: SteerRequest) => Promise<boolean>;
  onStop: () => void;
  project?: ProjectDescriptor;
  onAttachmentsChange?: (projectId: string | null, attachments: InputAttachmentDescriptor[]) => void;
  canvasContexts?: CanvasContextDescriptor[];
  onRemoveCanvasContext?: (contextId: string) => void;
  onClearCanvasContexts?: (contextIds: string[]) => void;
}

/** 只有最近一次模型发现仍返回的模型才能成为 Composer 的已恢复选择。 */
export function restoreStoredModelOptionId(storedId: string, modelOptions: ModelOption[]): string {
  const modelOptionId = storedId.trim();
  return modelOptions.some((model) => model.available && model.modelOptionId === modelOptionId) ? modelOptionId : "";
}

export function parseStoredModelPickerPreference(serialized: string | null, legacyModelOptionId: string | null): StoredModelPickerPreference {
  const legacyId = legacyModelOptionId?.trim() ?? "";
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized) as Partial<StoredModelPickerPreference>;
      const modelOptionId = typeof parsed.modelOptionId === "string" ? parsed.modelOptionId.trim() : "";
      const displayName = typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
      if (modelOptionId && displayName) {
        // 模型 ID 在切换时先写入，优先恢复最新选择。
        if (legacyId && legacyId !== modelOptionId) return { modelOptionId: legacyId, displayName: "" };
        return { modelOptionId, displayName };
      }
    } catch {
      // 缓存解析失败时使用独立保存的模型 ID。
    }
  }

  return { modelOptionId: legacyId, displayName: "" };
}

/** 对话框列：输入框 + 附件 + 模型选择 + 发送/停止。位于中间列（Column）的 auto 行。 */
export function Composer({ running, stopping, activeRunId = null, restoreDraft = null, ready = true, modelOptions, modelLoading, onRun, onSteer, onStop, project = { projectId: null, displayName: "Choose folder", canonicalPath: null }, onAttachmentsChange, canvasContexts = [], onRemoveCanvasContext, onClearCanvasContexts }: ComposerProps) {
  const t = useI18n();
  const [task, setTask] = useState("");
  const taskRevision = useRef(0);
  const setTaskDraft = useCallback((next: SetStateAction<string>): void => {
    taskRevision.current += 1;
    setTask(next);
  }, []);
  const [submitting, setSubmitting] = useState(false);
  const [narrowModelMenu, setNarrowModelMenu] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches);
  const { selectedModelOptionId, selectModel, storedPreference } = useSelectedModelOption(modelOptions, modelLoading);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelLabelRef = useRef<HTMLSpanElement>(null);
  const taskInputRef = useRef<HTMLTextAreaElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const modelSelectionChangedRef = useRef(false);
  const [modelTriggerWidth, setModelTriggerWidth] = useState<number | null>(null);
  const [animateModelWidth, setAnimateModelWidth] = useState(false);
  const selectedModel = modelOptions.find((option) => option.available && option.modelOptionId === selectedModelOptionId);
  const selectedModelName = selectedModel?.displayName;
  const selectableModels = modelOptions.filter((option) => option.available);
  const cachedModelDisplayName = storedPreference.modelOptionId === selectedModelOptionId
    ? storedPreference.displayName
    : "";
  const modelDisplayName = selectedModelName
    ?? (cachedModelDisplayName || t(modelLoading ? "Loading model…" : "Choose model"));

  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const update = () => setNarrowModelMenu(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const hasText = task.trim() !== "";
  const action = selectComposerAction({ running, stopping, submitting, activeRunId, hasText });
  const stopAction = action === "stop" || action === "stopping";

  useEffect(() => {
    if (!restoreDraft) return;
    setTaskDraft((current) => current ? `${current}\n${restoreDraft.text}` : restoreDraft.text);
    const frame = requestAnimationFrame(() => {
      const input = taskInputRef.current;
      if (!input) return;
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
      input.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [restoreDraft, setTaskDraft]);

  /**
   * 名称跨启动恢复，像素宽度按当前字体在绘制前测量；用户切换模型时启用宽度过渡。
   */
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
    const nextWidth = naturalWidth + 43;
    const shouldAnimate = modelSelectionChangedRef.current;
    modelSelectionChangedRef.current = false;
    setModelTriggerWidth(nextWidth);
    setAnimateModelWidth(shouldAnimate);
  }, [modelDisplayName, selectedModelOptionId]);

  useEffect(() => {
    if (selectedModelName !== undefined) {
      persistModelPickerPreference({ modelOptionId: selectedModelOptionId, displayName: selectedModelName });
    }
  }, [selectedModelName, selectedModelOptionId]);

  useEffect(() => {
    if (!animateModelWidth) return;
    const timer = window.setTimeout(() => setAnimateModelWidth(false), 220);
    return () => window.clearTimeout(timer);
  }, [animateModelWidth]);

  const submit = async (source: "button" | "keyboard"): Promise<void> => {
    if (!canSubmit || voiceBusy || uploads.hasPendingUpload()) return;
    const restoreInputFocus = source === "button" || document.activeElement === taskInputRef.current;
    const submittedTask = task.trim();
    const submittedRevision = taskRevision.current;
    const submittedAttachmentIds = uploads.attachments.map((attachment) => attachment.attachmentId);
    const submittedCanvasContextIds = canvasContexts.map((context) => context.contextId);
    setSubmitting(true);
    try {
      const accepted = running && activeRunId
        ? await onSteer!({ runId: activeRunId, projectId: project.projectId, inputId: crypto.randomUUID(), task: submittedTask })
        : await onRun({
            task: submittedTask,
            modelOptionId: selectedModelOptionId,
            attachmentIds: submittedAttachmentIds,
            canvasContextIds: submittedCanvasContextIds,
            projectId: project.projectId,
          } satisfies RunRequest);
      if (!accepted) return;
      if (taskRevision.current === submittedRevision) {
        setTaskDraft("");
        const input = taskInputRef.current;
        if (input) {
          input.style.height = "auto";
          input.style.overflowY = "hidden";
        }
      }
      if (!running) {
        uploads.removeAttachments(submittedAttachmentIds);
        onClearCanvasContexts?.(submittedCanvasContextIds);
      }
      if (restoreInputFocus) requestAnimationFrame(() => {
        const input = taskInputRef.current;
        if (input && !input.disabled && (document.activeElement === document.body || document.activeElement === actionButtonRef.current)) input.focus();
      });
    } finally {
      setSubmitting(false);
    }
  };

  const onTaskKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 输入法组字期间 Enter 确认候选并上屏（isComposing 为 true）；组字结束后再次 Enter 才提交任务。
    // 原生事件携带 isComposing，合成事件类型未声明该字段。
    if (isSendKey(e.key, e.shiftKey, e.nativeEvent.isComposing)) {
      e.preventDefault();
      void submit("keyboard");
    }
  };

  const updateTask = (element: HTMLTextAreaElement): void => {
    setTaskDraft(element.value);
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
    element.style.overflowY = element.scrollHeight > 180 ? "auto" : "hidden";
  };

  const voice = useVoiceInput({
    ready,
    running,
    submitting,
    scopeKey: project.projectId,
    onTranscript: (text) => {
      if (!text.trim()) return;
      setTaskDraft((current) => appendVoiceTranscript(current, text));
      requestAnimationFrame(() => {
        const input = taskInputRef.current;
        if (!input) return;
        input.style.height = "auto";
        input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
        input.style.overflowY = input.scrollHeight > 180 ? "auto" : "hidden";
        input.focus();
      });
    },
  });
  const voiceBusy = voice.state.phase !== "idle";
  const uploads = useUploadFiles({ scopeKey: project.projectId, disabled: running || stopping || submitting || !ready || voiceBusy });
  useEffect(() => onAttachmentsChange?.(project.projectId, uploads.attachments), [onAttachmentsChange, project.projectId, uploads.attachments]);
  const hasAttachments = uploads.attachments.length > 0;
  const canSubmit = ready && !uploads.busy && (action === "start"
    ? (hasText || hasAttachments) && Boolean(selectedModel?.available)
    : action === "steer" && hasText && Boolean(onSteer));
  const disabledReason = uploads.busy ? null
    : !hasText && !hasAttachments ? "Enter a task"
    : action === "stopping" ? "Stopping run"
    : action === "starting" ? "Starting run"
    : action === "start" && !selectedModel?.available ? "Choose an available model"
    : null;
  const voiceDisabled = !ready || submitting || (running && voice.state.phase === "idle");
  const submitDisabled = stopAction ? stopping : !canSubmit || voiceBusy;
  const sendTitle = uploads.busy ? "Send"
    : stopAction
    ? (stopping ? "Stopping" : "Stop run")
    : ready ? (disabledReason ?? "Send")
    : "Loading history";

  return (
    <footer className="composer">
      <div className={`composer-shell${uploads.dragging ? " is-file-dragging" : ""}`} data-drop-label={t("Drop files to attach")} {...uploads.dropHandlers}>
        <AttachmentCards attachments={uploads.attachments} onRemove={uploads.removeAttachment} disabled={uploads.disabled} />
        {canvasContexts.length > 0 && (
          <div className="composer-canvas-contexts" aria-label={t("Canvas references")}>
            {canvasContexts.map((context) => (
              <div className="composer-canvas-context" key={context.contextId}>
                <Icon name="line-squiggle" width="15" height="15" />
                <span><strong>{context.label}</strong><small>{t(context.hasVisual ? "Text + visual snapshot" : "Text snapshot")}</small></span>
                <button type="button" onClick={() => onRemoveCanvasContext?.(context.contextId)} disabled={running || !ready} aria-label={t("Remove {name}", { name: context.label })} title={t("Remove canvas reference")}><Icon name="close" width="14" height="14" /></button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taskInputRef}
          className="task-input"
          placeholder={t("What's up?")}
          value={task}
          disabled={!ready || submitting}
          onChange={(event) => updateTask(event.currentTarget)}
          onKeyDown={onTaskKeyDown}
          aria-label={t("Task")}
        />

        <div className="composer-toolbar">
          {voice.state.phase === "recording" ? (
            <>
              <button
                type="button"
                className="composer-icon-button composer-voice-button is-active"
                onClick={voice.stop}
                aria-label={t("Stop voice input")}
                aria-pressed="true"
                title={t("Stop voice input")}
              >
                <Icon name="stop" width={18} height={18} />
              </button>
              <div className="composer-voice-wave" aria-hidden="true">
                <VoiceWaveform analyser={voice.analyser} />
              </div>
              <button
                type="button"
                className="composer-icon-button composer-voice-cancel"
                onClick={voice.cancel}
                aria-label={t("Cancel voice input")}
                title={t("Cancel voice input")}
              >
                <Icon name="close" width={16} height={16} />
              </button>
            </>
          ) : (
            <>
              <div className="composer-left">
                <button type="button" className="composer-icon-button" onClick={() => void uploads.pickFiles()} disabled={uploads.disabled} aria-busy={uploads.busy || undefined} aria-label={t("Upload files")} title={t("Upload files")}><Icon name="plus" width="18" height="18" /></button>
                <button
                  type="button"
                  className={`composer-icon-button composer-voice-button ${voice.state.phase !== "idle" ? "is-active" : ""}`}
                  onClick={() => {
                    if (voice.state.phase === "idle") {
                      void voice.start();
                    } else {
                      voice.cancel();
                    }
                  }}
                  disabled={voiceDisabled}
                  aria-label={t(voiceButtonLabel(voice.state.phase))}
                  title={t(voiceButtonLabel(voice.state.phase))}
                >
                  <Icon name="microphone" width={17} height={17} />
                </button>
              </div>

              <div className="composer-right">
                <div className="model-picker">
                  <Select
                    id="composer-model"
                    label={t("Choose model")}
                    value={selectedModelOptionId}
                    options={selectableModels.map(model => ({ value: model.modelOptionId, label: model.displayName }))}
                    onValueChange={modelOptionId => {
                      if (modelOptionId !== selectedModelOptionId) modelSelectionChangedRef.current = true;
                      selectModel(modelOptionId);
                    }}
                    disabled={running || !ready || modelLoading}
                    displayValue={modelDisplayName}
                    emptyText={t("No available models")}
                    side="top"
                    align={narrowModelMenu ? "end" : "center"}
                    size="compact"
                    triggerRef={modelTriggerRef}
                    labelRef={modelLabelRef}
                    triggerProps={{ className: `model-picker-trigger ${animateModelWidth ? "is-width-animated" : ""}`, style: { width: modelTriggerWidth === null ? undefined : `${modelTriggerWidth}px`, transition: animateModelWidth ? undefined : "none" }, title: t(ready ? "Choose model" : "Loading history") }}
                    contentClassName="model-popover"
                  />
                </div>

                <button ref={actionButtonRef} type="button" className={`send-stop-button ${stopAction ? "is-stop" : "is-send"}`} onClick={stopAction ? onStop : () => void submit("button")} disabled={submitDisabled} aria-label={t(stopAction ? (stopping ? "Stopping" : "Stop run") : "Send")} title={t(sendTitle)} aria-busy={stopping || submitting || undefined}>
                  <span className="send-stop-icon" key={stopAction ? "stop" : "send"}><Icon name={stopAction ? "stop" : "arrow-up"} width={18} height={18} /></span>
                </button>
              </div>
            </>
          )}
        </div>
        {uploads.errors.length > 0 && (
          <div className="upload-files-errors" role="status">
            <ul>{uploads.errors.map((error, index) => <li key={index}>{error.name && `${error.name}: `}{t(error.message)}</li>)}</ul>
            <button type="button" onClick={uploads.dismissErrors} aria-label={t("Dismiss upload errors")} title={t("Dismiss")}><Icon name="close" width={12} height={12} /></button>
          </div>
        )}
        {voice.state.error && (
          <div className="composer-voice-error" role="status">
            <span>{t(voice.state.error)}</span>
            <button type="button" onClick={voice.dismissError} aria-label={t("Dismiss voice input error")} title={t("Dismiss")}><Icon name="close" width="12" height="12" /></button>
          </div>
        )}
        {disabledReason && !uploads.busy && (hasText || hasAttachments) && <span className="composer-hint" role="status">{t(disabledReason)}</span>}
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
      globalThis.localStorage?.getItem(MODEL_PICKER_PREFERENCE_STORAGE_KEY) ?? null,
      globalThis.localStorage?.getItem(MODEL_OPTION_STORAGE_KEY) ?? null,
    );
  } catch {
    return { modelOptionId: "", displayName: "" };
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
    globalThis.localStorage?.setItem(MODEL_PICKER_PREFERENCE_STORAGE_KEY, JSON.stringify(preference));
    globalThis.localStorage?.setItem(MODEL_OPTION_STORAGE_KEY, preference.modelOptionId);
  } catch {
    // 本地偏好不可写时，Composer 保持本次 Renderer 生命周期内的选择和名称。
  }
}

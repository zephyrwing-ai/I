import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type TransitionEvent } from "react";
import type { OutputFileDescriptor, OutputFilePreviewResult } from "../../../shell/shared/ipc";
import {
  OUTPUT_SIDEBAR_DEFAULT_WIDTH,
  OUTPUT_SIDEBAR_MAX_WIDTH,
  OUTPUT_SIDEBAR_MIN_WIDTH,
  OUTPUT_MAIN_COLUMN_MIN_WIDTH,
  shouldCollapseSidebar,
} from "../store/outputSidebarState";
import { Icon } from "./Icon";
import { useElasticScroll } from "../hooks/useElasticScroll";

type SidebarPhase = "closed" | "opening" | "open" | "dragging" | "closing";

interface OutputSidebarProps {
  open: boolean;
  files: OutputFileDescriptor[];
  onOpenChange: (open: boolean) => void;
}

const WIDTH_KEY = "workbench.outputSidebarWidth";

function maxWidth(): number {
  return Math.max(
    OUTPUT_SIDEBAR_MIN_WIDTH,
    Math.min(OUTPUT_SIDEBAR_MAX_WIDTH, window.innerWidth - OUTPUT_MAIN_COLUMN_MIN_WIDTH),
  );
}

function clampWidth(width: number): number {
  return Math.min(Math.max(width, OUTPUT_SIDEBAR_MIN_WIDTH), maxWidth());
}

function initialWidth(): number {
  const value = Number(localStorage.getItem(WIDTH_KEY));
  return clampWidth(Number.isFinite(value) && value > 0 ? value : OUTPUT_SIDEBAR_DEFAULT_WIDTH);
}

export function OutputSidebar({ open, files, onOpenChange }: OutputSidebarProps) {
  const [phase, setPhase] = useState<SidebarPhase>(open ? "open" : "closed");
  const [width, setWidth] = useState(initialWidth);
  const [dragWidth, setDragWidth] = useState(width);
  const [collapseReady, setCollapseReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(files[0]?.fileId ?? null);
  const [preview, setPreview] = useState<OutputFilePreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const shellRef = useRef<HTMLElement>(null);
  const dragRef = useRef({ startX: 0, startWidth: width, rawWidth: width });
  const frameRef = useRef<number | null>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const fileContentRef = useRef<HTMLDivElement>(null);
  useElasticScroll(fileListRef, fileContentRef);

  const selected = files.find((file) => file.fileId === selectedId) ?? files[0];
  const targetWidth = phase === "dragging" ? dragWidth : open ? clampWidth(width) : 0;

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPhase(open ? "open" : "closed");
      return;
    }
    setPhase((current) => {
      if (open && (current === "closed" || current === "closing")) return "opening";
      if (!open && current !== "closed") return "closing";
      return current;
    });
  }, [open]);

  useEffect(() => {
    if (shellRef.current) shellRef.current.inert = phase === "closed";
  }, [phase]);

  useEffect(() => {
    if (!files.length) {
      setSelectedId(null);
      setPreview(null);
      return;
    }
    if (!selectedId || !files.some((file) => file.fileId === selectedId)) setSelectedId(files[0].fileId);
  }, [files, selectedId]);

  const refreshPreview = async (): Promise<void> => {
    if (!selected) return;
    setPreviewLoading(true);
    setOpenError(null);
    try {
      setPreview(await window.agentAPI.previewOutputFile(selected.runId, selected.fileId));
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    void refreshPreview();
    // updatedAt is intentionally part of the identity so a completed tool refreshes the preview.
  }, [selected?.fileId, selected?.updatedAt]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const finishTransition = (event: TransitionEvent<HTMLElement>): void => {
    if (event.target !== shellRef.current || event.propertyName !== "width" || phase === "dragging") return;
    setPhase(open ? "open" : "closed");
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!open || phase === "opening" || phase === "closing") return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width, rawWidth: width };
    setDragWidth(width);
    setCollapseReady(false);
    setPhase("dragging");

    const move = (pointerEvent: PointerEvent): void => {
      const rawWidth = dragRef.current.startWidth - (pointerEvent.clientX - dragRef.current.startX);
      dragRef.current.rawWidth = rawWidth;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        setDragWidth(clampWidth(dragRef.current.rawWidth));
        setCollapseReady(shouldCollapseSidebar(dragRef.current.rawWidth));
      });
    };
    const finish = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("keydown", cancel);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (shouldCollapseSidebar(dragRef.current.rawWidth)) {
        setPhase("closing");
        onOpenChange(false);
        return;
      }
      const nextWidth = clampWidth(dragRef.current.rawWidth);
      setWidth(nextWidth);
      setDragWidth(nextWidth);
      localStorage.setItem(WIDTH_KEY, String(nextWidth));
      setCollapseReady(false);
      setPhase("open");
    };
    const cancel = (keyboardEvent: KeyboardEvent): void => {
      if (keyboardEvent.key !== "Escape") return;
      dragRef.current.rawWidth = dragRef.current.startWidth;
      setDragWidth(dragRef.current.startWidth);
      setCollapseReady(false);
      setPhase("open");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("keydown", cancel);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("keydown", cancel);
  };

  const resetWidth = (): void => {
    const nextWidth = clampWidth(OUTPUT_SIDEBAR_DEFAULT_WIDTH);
    setWidth(nextWidth);
    localStorage.setItem(WIDTH_KEY, String(nextWidth));
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowRight" && width <= OUTPUT_SIDEBAR_MIN_WIDTH) {
      onOpenChange(false);
      return;
    }
    const nextWidth = clampWidth(width + (event.key === "ArrowLeft" ? step : -step));
    setWidth(nextWidth);
    localStorage.setItem(WIDTH_KEY, String(nextWidth));
  };

  const openInSystem = async (): Promise<void> => {
    if (!selected) return;
    const result = await window.agentAPI.openOutputFile(selected.runId, selected.fileId);
    setOpenError(result.ok ? null : result.error);
  };

  const fileGroups = useMemo(() => files, [files]);

  return (
    <aside
      id="output-sidebar"
      ref={shellRef}
      className={`output-sidebar-shell phase-${phase} ${collapseReady ? "collapse-ready" : ""}`}
      style={{ width: targetWidth }}
      aria-hidden={phase === "closed"}
      onTransitionEnd={finishTransition}
    >
      <div className="output-resizer" role="separator" tabIndex={open ? 0 : -1} aria-orientation="vertical" aria-valuemin={OUTPUT_SIDEBAR_MIN_WIDTH} aria-valuemax={maxWidth()} aria-valuenow={Math.round(targetWidth)} onPointerDown={startDrag} onDoubleClick={resetWidth} onKeyDown={resizeWithKeyboard} />
      <div className="output-sidebar-content">
        <header className="output-sidebar-header"><div><span className="eyebrow">当前运行</span><h2>输出文件 <small>{files.length}</small></h2></div></header>

        <div ref={fileListRef} className="output-file-list" role="listbox" aria-label="输出文件">
          <div className="output-file-layout">
            <div ref={fileContentRef} className="output-file-content">
              {fileGroups.length === 0 && <div className="panel-empty"><Icon name="book-open" width="24" height="24" /><span>当前任务尚未生成文件</span></div>}
              {fileGroups.map((file) => (
                <button type="button" role="option" aria-selected={file.fileId === selected?.fileId} className={file.fileId === selected?.fileId ? "selected" : ""} key={file.fileId} onClick={() => setSelectedId(file.fileId)}>
                  <Icon name={file.mediaType.startsWith("image/") ? "image" : "book-open"} width="16" height="16" />
                  <span><strong>{file.name}</strong><small>{file.displayPath}</small></span><em>{file.operation === "created" ? "已创建" : "已更新"}</em>
                </button>
              ))}
            </div>
          </div>
        </div>

        <section className="output-preview" aria-label="文件预览">
          {selected && <header className="preview-header"><div><strong>{selected.name}</strong><span>{formatBytes(selected.byteSize)}</span></div><div><button type="button" onClick={() => void refreshPreview()} aria-label="刷新预览" title="刷新预览"><Icon name="refresh" width="15" height="15" /></button><button type="button" onClick={() => void openInSystem()} aria-label="在系统中打开" title="在系统中打开"><Icon name="external" width="15" height="15" /></button></div></header>}
          {previewLoading && <div className="preview-state">正在读取预览…</div>}
          {!previewLoading && preview?.ok && preview.kind === "text" && <><pre>{preview.content}</pre>{preview.truncated && <span className="preview-notice">文件较大，仅显示前 {formatBytes(512 * 1024)}</span>}</>}
          {!previewLoading && preview?.ok && preview.kind === "image" && <div className="image-preview"><img src={preview.dataUrl} alt={selected?.name ?? "输出图片"} /></div>}
          {!previewLoading && preview?.ok && preview.kind === "unsupported" && <div className="preview-state"><Icon name="image" width="28" height="28" /><span>暂不支持内嵌预览</span><small>{preview.mediaType}</small></div>}
          {!previewLoading && preview && !preview.ok && <div className="preview-state preview-error"><Icon name="warning" width="24" height="24" /><span>{preview.message}</span></div>}
          {!selected && <div className="preview-state">选择文件以预览内容</div>}
          {openError && <p className="preview-open-error" role="alert">{openError}</p>}
        </section>
      </div>
    </aside>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

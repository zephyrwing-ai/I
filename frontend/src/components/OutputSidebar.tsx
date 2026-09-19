import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type TransitionEvent } from "react";
import type { OutputFileDescriptor, OutputFilePreviewResult } from "../../../shell/shared/ipc";
import {
  canKeepOutputSidebarOpen,
  clampOutputSidebarWidth,
  OUTPUT_SIDEBAR_DEFAULT_WIDTH,
  OUTPUT_SIDEBAR_MIN_WIDTH,
  getOutputSidebarMaxWidth,
  shouldCollapseSidebar,
} from "../store/outputSidebarState";
import { Icon } from "./Icon";
import { useElasticScroll } from "../hooks/useElasticScroll";

type SidebarPhase = "closed" | "opening" | "open" | "dragging" | "closing";

interface OutputSidebarProps {
  open: boolean;
  files: OutputFileDescriptor[];
  onOpenChange: (open: boolean) => void;
  activePanel?: "outputs" | "canvas";
  canvas?: ReactNode;
}

const WIDTH_KEY = "workbench.outputSidebarWidth";

function clampWidth(width: number, viewportWidth: number): number {
  return clampOutputSidebarWidth(width, viewportWidth);
}

function initialWidth(): number {
  const value = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(value) && value > 0 ? value : OUTPUT_SIDEBAR_DEFAULT_WIDTH;
}

export function OutputSidebar({ open, files, onOpenChange, activePanel = "outputs", canvas }: OutputSidebarProps) {
  const [phase, setPhase] = useState<SidebarPhase>(open ? "open" : "closed");
  const [width, setWidth] = useState(initialWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
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
  const effectiveWidth = clampWidth(width, viewportWidth);
  const targetWidth = phase === "dragging"
    ? clampWidth(dragWidth, viewportWidth)
    : open
      ? effectiveWidth
      : 0;

  useEffect(() => {
    const handleResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (open && !canKeepOutputSidebarOpen(viewportWidth)) onOpenChange(false);
  }, [onOpenChange, open, viewportWidth]);

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
    dragRef.current = { startX: event.clientX, startWidth: effectiveWidth, rawWidth: effectiveWidth };
    setDragWidth(effectiveWidth);
    setCollapseReady(false);
    setPhase("dragging");

    const move = (pointerEvent: PointerEvent): void => {
      const rawWidth = dragRef.current.startWidth - (pointerEvent.clientX - dragRef.current.startX);
      dragRef.current.rawWidth = rawWidth;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        setDragWidth(clampWidth(dragRef.current.rawWidth, viewportWidth));
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
      const nextWidth = clampWidth(dragRef.current.rawWidth, viewportWidth);
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
    const nextWidth = clampWidth(OUTPUT_SIDEBAR_DEFAULT_WIDTH, viewportWidth);
    setWidth(nextWidth);
    localStorage.setItem(WIDTH_KEY, String(nextWidth));
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowRight" && effectiveWidth <= OUTPUT_SIDEBAR_MIN_WIDTH) {
      onOpenChange(false);
      return;
    }
    const nextWidth = clampWidth(effectiveWidth + (event.key === "ArrowLeft" ? step : -step), viewportWidth);
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
      id="right-sidebar"
      ref={shellRef}
      className={`output-sidebar-shell phase-${phase} ${collapseReady ? "collapse-ready" : ""}`}
      style={{ width: targetWidth }}
      aria-hidden={phase === "closed"}
      onTransitionEnd={finishTransition}
    >
      <div className="output-resizer" role="separator" tabIndex={open ? 0 : -1} aria-orientation="vertical" aria-valuemin={OUTPUT_SIDEBAR_MIN_WIDTH} aria-valuemax={getOutputSidebarMaxWidth(viewportWidth)} aria-valuenow={Math.round(targetWidth)} onPointerDown={startDrag} onDoubleClick={resetWidth} onKeyDown={resizeWithKeyboard} />
      <div className={`output-sidebar-content ${activePanel === "canvas" ? "is-canvas" : ""}`}>
        <div className="output-sidebar-header" aria-hidden="true" />

        {activePanel === "canvas" ? (
          <div className="right-sidebar-canvas">{phase === "closed" ? null : canvas}</div>
        ) : (
          <>
        <div ref={fileListRef} className="output-file-list" role="listbox" aria-label="Output files">
          <div className="output-file-layout">
            <div ref={fileContentRef} className="output-file-content">
              {fileGroups.length === 0 && <div className="panel-empty"><Icon name="book-open" width="24" height="24" /><span>No files generated for this task</span></div>}
              {fileGroups.map((file) => (
                <button type="button" role="option" aria-selected={file.fileId === selected?.fileId} className={file.fileId === selected?.fileId ? "selected" : ""} key={file.fileId} onClick={() => setSelectedId(file.fileId)}>
                  <Icon name={file.mediaType.startsWith("image/") ? "image" : "book-open"} width="16" height="16" />
                  <span><strong>{file.name}</strong><small>{file.displayPath}</small></span><em>{file.operation === "created" ? "Created" : "Updated"}</em>
                </button>
              ))}
            </div>
          </div>
        </div>

        <section className="output-preview" aria-label="File preview">
          {selected && <header className="preview-header"><div><strong>{selected.name}</strong><span>{formatBytes(selected.byteSize)}</span></div><div><button type="button" onClick={() => void refreshPreview()} aria-label="Refresh preview" title="Refresh preview"><Icon name="refresh" width="15" height="15" /></button><button type="button" onClick={() => void openInSystem()} aria-label="Open in system" title="Open in system"><Icon name="external" width="15" height="15" /></button></div></header>}
          {previewLoading && <div className="preview-state">Loading preview…</div>}
          {!previewLoading && preview?.ok && preview.kind === "text" && <><pre>{preview.content}</pre>{preview.truncated && <span className="preview-notice">File is large. Showing only the first {formatBytes(512 * 1024)}</span>}</>}
          {!previewLoading && preview?.ok && preview.kind === "image" && <div className="image-preview"><img src={preview.dataUrl} alt={selected?.name ?? "Output image"} /></div>}
          {!previewLoading && preview?.ok && preview.kind === "unsupported" && <div className="preview-state"><Icon name="image" width="28" height="28" /><span>Embedded preview not supported</span><small>{preview.mediaType}</small></div>}
          {!previewLoading && preview && !preview.ok && <div className="preview-state preview-error"><Icon name="warning" width="24" height="24" /><span>{preview.message}</span></div>}
          {!selected && <div className="preview-state">Select a file to preview its content</div>}
          {openError && <p className="preview-open-error" role="alert">{openError}</p>}
        </section>
          </>
        )}
      </div>
    </aside>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

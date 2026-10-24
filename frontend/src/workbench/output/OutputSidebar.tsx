import { useI18n } from "../../shared/i18n";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { OutputFileDescriptor } from "../../../../shell/shared/ipc";
import { OUTPUT_SIDEBAR_MIN_WIDTH, OUTPUT_SIDEBAR_POLICY } from "./outputSidebarState";
import { useResizableSidebar } from "../../shared/sidebar/useResizableSidebar";
import { Icon } from "../../shared/ui/Icon";
import { useElasticScroll } from "../../shared/scroll/useElasticScroll";
import { useOutputFilePreview } from "./useOutputFilePreview";

interface OutputSidebarProps {
  open: boolean;
  files: OutputFileDescriptor[];
  onOpenChange: (open: boolean) => void;
  activePanel?: "outputs" | "canvas";
  canvas?: ReactNode;
  canvasCanRelease?: boolean;
  workspaceRef?: RefObject<HTMLElement>;
}

const WIDTH_KEY = "workbench.outputSidebarWidth";
const CANVAS_KEEP_ALIVE_MS = 10 * 60 * 1000;

export function OutputSidebar({ open, files, onOpenChange, activePanel = "outputs", canvas, canvasCanRelease = true, workspaceRef }: OutputSidebarProps) {
  const t = useI18n();
  const [canvasMounted, setCanvasMounted] = useState(
    () => open && activePanel === "canvas",
  );
  const [selection, setSelection] = useState<Pick<OutputFileDescriptor, "runId" | "fileId"> | null>(
    () => files[0] ? { runId: files[0].runId, fileId: files[0].fileId } : null,
  );
  const { shellRef, phase, targetWidth, collapseReady, maximumWidth, finishTransition, startDrag, resetWidth, resizeWithKeyboard } = useResizableSidebar({
    open, onOpenChange, side: "right", storageKey: WIDTH_KEY, policy: OUTPUT_SIDEBAR_POLICY, workspaceRef,
  });
  const canvasReleaseTimerRef = useRef<number | null>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const fileContentRef = useRef<HTMLDivElement>(null);
  useElasticScroll(fileListRef, fileContentRef);

  const selected = files.find((file) => file.runId === selection?.runId && file.fileId === selection.fileId) ?? files[0];
  const { preview, loading: previewLoading, openError, refresh: refreshPreview, open: openInSystem } = useOutputFilePreview(selected);
  useEffect(() => {
    if (open && activePanel === "canvas") {
      if (canvasReleaseTimerRef.current !== null) {
        window.clearTimeout(canvasReleaseTimerRef.current);
        canvasReleaseTimerRef.current = null;
      }
      setCanvasMounted(true);
      return;
    }
    if (!canvasCanRelease) {
      if (canvasReleaseTimerRef.current !== null) window.clearTimeout(canvasReleaseTimerRef.current);
      canvasReleaseTimerRef.current = null;
      return;
    }

    if (open || !canvasMounted || canvasReleaseTimerRef.current !== null) {
      return;
    }

    canvasReleaseTimerRef.current = window.setTimeout(() => {
      canvasReleaseTimerRef.current = null;
      setCanvasMounted(false);
    }, CANVAS_KEEP_ALIVE_MS);
  }, [activePanel, canvasCanRelease, canvasMounted, open]);

  useEffect(() => {
    if (!files.length) {
      setSelection(null);
      return;
    }
    if (!selection || !files.some((file) => file.runId === selection.runId && file.fileId === selection.fileId)) {
      setSelection({ runId: files[0].runId, fileId: files[0].fileId });
    }
  }, [files, selection]);

  useEffect(() => () => {
    if (canvasReleaseTimerRef.current !== null) {
      window.clearTimeout(canvasReleaseTimerRef.current);
    }
  }, []);

  return (
    <aside
      id="right-sidebar"
      ref={shellRef}
      className={`output-sidebar-shell phase-${phase} ${collapseReady ? "collapse-ready" : ""}`}
      style={{ width: targetWidth }}
      aria-hidden={phase === "closed"}
      onTransitionEnd={finishTransition}
    >
      <div className="output-resizer" role="separator" tabIndex={open ? 0 : -1} aria-orientation="vertical" aria-valuemin={OUTPUT_SIDEBAR_MIN_WIDTH} aria-valuemax={maximumWidth} aria-valuenow={Math.round(targetWidth)} onPointerDown={startDrag} onDoubleClick={resetWidth} onKeyDown={resizeWithKeyboard} />
      <div className={`output-sidebar-content ${activePanel === "canvas" ? "is-canvas" : ""}`}>
        <div
          className={`right-sidebar-canvas ${activePanel === "canvas" && phase !== "closed" ? "is-active" : "is-hidden"}`}
          aria-hidden={activePanel !== "canvas" || phase === "closed"}
        >
          {canvasMounted ? canvas : null}
        </div>
        {activePanel !== "canvas" && (
          <>
        <div ref={fileListRef} className="output-file-list" role="listbox" aria-label={t("Output files")}>
          <div className="output-file-layout">
            <div ref={fileContentRef} className="output-file-content">
              {files.length === 0 && <div className="panel-empty"><Icon name="book-open" width="24" height="24" /><span>{t("No files generated for this task")}</span></div>}
              {files.map((file) => (
                <button type="button" role="option" aria-selected={file === selected} className={file === selected ? "selected" : ""} key={`${file.runId}:${file.fileId}`} onClick={() => setSelection({ runId: file.runId, fileId: file.fileId })}>
                  <Icon name={file.mediaType.startsWith("image/") ? "image" : "book-open"} width="16" height="16" />
                  <span><strong>{file.name}</strong><small>{file.displayPath}</small></span><em>{t(file.operation === "created" ? "Created" : "Updated")}</em>
                </button>
              ))}
            </div>
          </div>
        </div>

        <section className="output-preview" aria-label={t("File preview")}>
          {selected && <header className="preview-header"><div><strong>{selected.name}</strong><span>{formatBytes(selected.byteSize)}</span></div><div><button type="button" onClick={() => void refreshPreview()} aria-label={t("Refresh preview")} title={t("Refresh preview")}><Icon name="refresh" width="15" height="15" /></button><button type="button" onClick={() => void openInSystem()} aria-label={t("Open in system")} title={t("Open in system")}><Icon name="external" width="15" height="15" /></button></div></header>}
          {previewLoading && <div className="preview-state">{t("Loading preview…")}</div>}
          {!previewLoading && preview?.ok && preview.kind === "text" && <><pre>{preview.content}</pre>{preview.truncated && <span className="preview-notice">{t("File is large. Showing only the first {size}", { size: formatBytes(512 * 1024) })}</span>}</>}
          {!previewLoading && preview?.ok && preview.kind === "image" && <div className="image-preview"><img src={preview.dataUrl} alt={selected?.name ?? t("Output image")} /></div>}
          {!previewLoading && preview?.ok && preview.kind === "unsupported" && <div className="preview-state"><Icon name="image" width="28" height="28" /><span>{t("Embedded preview not supported")}</span><small>{preview.mediaType}</small></div>}
          {!previewLoading && preview && !preview.ok && <div className="preview-state preview-error"><Icon name="warning" width="24" height="24" /><span>{preview.message}</span></div>}
          {!selected && <div className="preview-state">{t("Select a file to preview its content")}</div>}
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

import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@agent-studio/canvas-editor/types";
import type { ExcalidrawElement } from "@agent-studio/canvas-editor/element/types";
import type {
  CanvasContextDescriptor,
  CanvasDocument,
  CanvasDocumentResult,
} from "../../shell/shared/ipc";
import "./CanvasSurface.css";

let canvasEditorPromise: Promise<typeof import("@agent-studio/canvas-editor")> | null = null;
let preloadedCanvasDocument: Promise<CanvasDocumentResult> | null = null;

export function preloadCanvasEditor(): Promise<typeof import("@agent-studio/canvas-editor")> {
  canvasEditorPromise ??= import("@agent-studio/canvas-editor").catch((error: unknown) => {
    canvasEditorPromise = null;
    throw error;
  });
  return canvasEditorPromise;
}

export function preloadCanvasDocument(): Promise<CanvasDocumentResult> {
  preloadedCanvasDocument ??= window.agentAPI.loadCanvasDocument().catch((error: unknown) => {
    preloadedCanvasDocument = null;
    throw error;
  });
  return preloadedCanvasDocument;
}

export function resetPreloadedCanvasDocument(): void {
  preloadedCanvasDocument = null;
}

class CanvasRenderErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  public state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Canvas renderer failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="canvas-panel-state canvas-panel-error" role="alert">
          <span>Canvas could not be loaded.</span>
          <button type="button" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function consumeCanvasDocument(): Promise<CanvasDocumentResult> {
  const promise = preloadedCanvasDocument ?? window.agentAPI.loadCanvasDocument();
  preloadedCanvasDocument = null;
  return promise;
}

const Excalidraw = lazy(async () => {
  const module = await preloadCanvasEditor();
  return { default: module.Excalidraw };
});

interface CanvasSurfaceProps {
  onContextPrepared: (descriptor: CanvasContextDescriptor) => void;
}

type SceneElements = readonly ExcalidrawElement[];
type SelectionActionPosition = {
  left: number;
  top: number;
  placement: "above" | "below";
};

type SelectionPositionSnapshot = {
  request: number;
  selectedElements: readonly ExcalidrawElement[];
  appState: Pick<AppState, "zoom" | "offsetLeft" | "offsetTop" | "scrollX" | "scrollY">;
};

export function CanvasSurface({ onContextPrepared }: CanvasSurfaceProps) {
  const [document, setDocument] = useState<CanvasDocument | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [selectionActionPosition, setSelectionActionPosition] =
    useState<SelectionActionPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [savingJSON, setSavingJSON] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sceneRef = useRef<CanvasDocument | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const selectionActionsRef = useRef<HTMLDivElement | null>(null);
  const selectionPositionRequestRef = useRef(0);
  const selectionPositionFrameRef = useRef<number | null>(null);
  const selectionPositionWorkInFlightRef = useRef(false);
  const pendingSelectionPositionRef = useRef<SelectionPositionSnapshot | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void consumeCanvasDocument().then((result) => {
      if (cancelled) return;
      setDocument(result.document);
      sceneRef.current = result.document;
      loadedRef.current = true;
      setLoading(false);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setNotice(error instanceof Error ? error.message : "Unable to load the canvas.");
      setDocument(emptyDocument());
      sceneRef.current = emptyDocument();
      loadedRef.current = true;
      setLoading(false);
    });
    return () => {
      cancelled = true;
      selectionPositionRequestRef.current += 1;
      pendingSelectionPositionRef.current = null;
      if (selectionPositionFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionPositionFrameRef.current);
      }
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      if (loadedRef.current && sceneRef.current) void window.agentAPI.saveCanvasDocument(sceneRef.current);
    };
  }, []);

  const initialData = useMemo(() => {
    if (!document) return null;
    const softwareBackground =
      window.getComputedStyle(window.document.documentElement).getPropertyValue("--bg").trim() ||
      "#f7f3ee";
    return {
      elements: document.elements as unknown as readonly ExcalidrawElement[],
      appState: {
        ...document.appState,
        viewBackgroundColor: softwareBackground,
      },
      files: document.files as unknown as BinaryFiles,
    };
  }, [document]);

  const uiOptions = useMemo(() => ({
    canvasActions: {
      saveToActiveFile: true,
      export: false,
      saveAsImage: true,
    },
  }), []);

  const scheduleSave = useCallback((next: CanvasDocument): void => {
    sceneRef.current = next;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      setSaving(true);
      void window.agentAPI.saveCanvasDocument(next).then(() => setSaving(false)).catch((error: unknown) => {
        setSaving(false);
        setNotice(error instanceof Error ? error.message : "Unable to save the canvas.");
      });
    }, 450);
  }, []);

  const scheduleSelectionPosition = useCallback((): void => {
    if (
      selectionPositionFrameRef.current !== null ||
      selectionPositionWorkInFlightRef.current ||
      !pendingSelectionPositionRef.current
    ) {
      return;
    }

    selectionPositionFrameRef.current = window.requestAnimationFrame(() => {
      selectionPositionFrameRef.current = null;
      const snapshot = pendingSelectionPositionRef.current;
      pendingSelectionPositionRef.current = null;
      if (!snapshot) return;

      selectionPositionWorkInFlightRef.current = true;
      void preloadCanvasEditor()
        .then((editor) => {
          if (snapshot.request !== selectionPositionRequestRef.current) return;
          const editorBounds = editorRef.current?.getBoundingClientRect();
          if (!editorBounds || snapshot.selectedElements.length === 0 || !snapshot.appState.zoom) return;

          const [minX, minY, maxX, maxY] = editor.getCommonBounds(snapshot.selectedElements);
          const transformPoint = (sceneY: number) => editor.sceneCoordsToViewportCoords(
            { sceneX: (minX + maxX) / 2, sceneY },
            {
              zoom: snapshot.appState.zoom!,
              offsetLeft: snapshot.appState.offsetLeft ?? 0,
              offsetTop: snapshot.appState.offsetTop ?? 0,
              scrollX: snapshot.appState.scrollX ?? 0,
              scrollY: snapshot.appState.scrollY ?? 0,
            },
          );
          const upperAnchor = transformPoint(minY);
          const lowerAnchor = transformPoint(maxY);
          const placeBelow = upperAnchor.y - editorBounds.top < 96;
          const anchor = placeBelow ? lowerAnchor : upperAnchor;
          const actionMargin = Math.min(
            editorBounds.width / 2,
            (selectionActionsRef.current?.offsetWidth ?? 280) / 2 + 8,
          );
          const left = Math.max(
            actionMargin,
            Math.min(editorBounds.width - actionMargin, anchor.x - editorBounds.left),
          );
          const top = Math.max(
            58,
            Math.min(
              editorBounds.height - 140,
              anchor.y - editorBounds.top + (placeBelow ? 10 : -10),
            ),
          );
          const nextPosition = { left, top, placement: placeBelow ? "below" as const : "above" as const };

          setSelectionActionPosition((current) => {
            if (
              current?.placement === nextPosition.placement &&
              Math.abs(current.left - nextPosition.left) < 1 &&
              Math.abs(current.top - nextPosition.top) < 1
            ) {
              return current;
            }
            return nextPosition;
          });
        })
        .catch((error: unknown) => {
          console.error("Unable to position Canvas selection actions", error);
        })
        .finally(() => {
          selectionPositionWorkInFlightRef.current = false;
          if (pendingSelectionPositionRef.current) scheduleSelectionPosition();
        });
    });
  }, []);

  const handleChange = useCallback((elements: SceneElements, appState: AppState, files: BinaryFiles): void => {
    if (!loadedRef.current) return;
    const selectedIds = Object.keys(appState.selectedElementIds ?? {});
    setSelectedCount(selectedIds.length);
    const request = ++selectionPositionRequestRef.current;
    if (selectedIds.length === 0) {
      pendingSelectionPositionRef.current = null;
      if (selectionPositionFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionPositionFrameRef.current);
        selectionPositionFrameRef.current = null;
      }
      setSelectionActionPosition(null);
    } else {
      const selectedIdSet = new Set(selectedIds);
      const selectedElements = elements.filter(
        (element) => selectedIdSet.has(element.id) && element.isDeleted !== true && element.deleted !== true,
      );
      pendingSelectionPositionRef.current = {
        request,
        selectedElements,
        appState: {
          zoom: appState.zoom,
          offsetLeft: appState.offsetLeft,
          offsetTop: appState.offsetTop,
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
        },
      };
      scheduleSelectionPosition();
    }
    scheduleSave({
      elements: [...elements] as unknown as Record<string, unknown>[],
      appState: pickPersistedAppState(appState),
      files: files as unknown as CanvasDocument["files"],
    });
  }, [scheduleSave, scheduleSelectionPosition]);

  const prepareSelectionContext = async (): Promise<void> => {
    if (!api || !sceneRef.current || busy) return;
    const allElements = api.getSceneElements() as readonly ExcalidrawElement[];
    const selectedIds = Object.keys(api.getAppState().selectedElementIds ?? {});
    if (selectedIds.length === 0) {
      setNotice("Select one or more canvas elements first.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const selectedIdSet = new Set(selectedIds);
      const selected = allElements.filter((element) => selectedIdSet.has(element.id));
      const excalidraw = await import("@agent-studio/canvas-editor");
      const blob = await excalidraw.exportToBlob({
        elements: selected,
        appState: api.getAppState(),
        files: api.getFiles(),
        mimeType: "image/png",
        exportPadding: 24,
      });
      const dataURL = await blobToDataURL(blob);
      const descriptor = await window.agentAPI.prepareCanvasContext({
        document: sceneRef.current,
        scope: "selection",
        selectedElementIds: selectedIds,
        visual: { mediaType: "image/png", dataURL },
      });
      onContextPrepared(descriptor);
      setNotice(`${descriptor.label} ready for the next message.`);
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : "Unable to prepare the canvas context.");
    } finally {
      setBusy(false);
    }
  };

  const saveCanvasJSON = async (): Promise<void> => {
    if (!api || savingJSON) return;
    setSavingJSON(true);
    setNotice(null);
    try {
      const editor = await import("@agent-studio/canvas-editor");
      const { fileHandle } = await editor.saveAsJSON(
        api.getSceneElements() as unknown as readonly ExcalidrawElement[],
        api.getAppState(),
        api.getFiles() as unknown as BinaryFiles,
        api.getName(),
      );
      api.updateScene({ appState: { fileHandle } });
      setNotice("Canvas JSON saved.");
    } catch (error: unknown) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice(error instanceof Error ? error.message : "Unable to export the canvas JSON.");
      }
    } finally {
      setSavingJSON(false);
    }
  };

  const openImageExport = (): void => {
    api?.updateScene({ appState: { openDialog: { name: "imageExport" } } });
  };

  return (
    <section className="canvas-panel" aria-label="Canvas workspace">
      <div className="canvas-panel-editor" ref={editorRef}>
        {loading || !initialData ? (
          <div className="canvas-panel-state">Loading canvas…</div>
        ) : (
          <CanvasRenderErrorBoundary>
            <Suspense fallback={<div className="canvas-panel-state">Loading drawing tools…</div>}>
              <Excalidraw
                initialData={initialData}
                excalidrawAPI={setApi}
                onChange={handleChange}
                handleKeyboardGlobally={false}
                aiEnabled={false}
                validateEmbeddable={false}
                UIOptions={uiOptions}
                autoFocus={false}
              />
            </Suspense>
          </CanvasRenderErrorBoundary>
        )}
        {selectionActionPosition && selectedCount > 0 && (
          <div
            ref={selectionActionsRef}
            className={`canvas-selection-actions placement-${selectionActionPosition.placement}`}
            style={{ left: selectionActionPosition.left, top: selectionActionPosition.top }}
            role="toolbar"
            aria-label="Canvas selection actions"
          >
            <button type="button" onClick={() => void prepareSelectionContext()} disabled={loading || !api || busy}>
              {busy ? "Preparing…" : "Use selection"}
            </button>
            <span className="canvas-selection-actions__divider" aria-hidden="true" />
            <button type="button" onClick={openImageExport} disabled={loading || !api || busy}>
              Save image
            </button>
            <span className="canvas-selection-actions__divider" aria-hidden="true" />
            <button type="button" onClick={() => void saveCanvasJSON()} disabled={loading || !api || savingJSON}>
              {savingJSON ? "Saving…" : "Save JSON"}
            </button>
          </div>
        )}
        {(saving || notice) && (
          <span className="canvas-panel-status" aria-live="polite">
            {saving ? "Saving…" : notice}
          </span>
        )}
      </div>
    </section>
  );
}

function pickPersistedAppState(appState: AppState): Record<string, unknown> {
  return {
    theme: appState.theme,
    viewBackgroundColor: appState.viewBackgroundColor,
    gridSize: appState.gridSize,
    gridStep: appState.gridStep,
    zoom: appState.zoom,
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
  };
}

function emptyDocument(): CanvasDocument {
  return { elements: [], appState: {}, files: {} };
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the canvas snapshot."));
    reader.readAsDataURL(blob);
  });
}

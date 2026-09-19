import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { CanvasContextDescriptor, CanvasDocument } from "../../../shell/shared/ipc";
import "./CanvasPanel.css";

const Excalidraw = lazy(async () => {
  await import("@excalidraw/excalidraw/index.css");
  const module = await import("@excalidraw/excalidraw");
  return { default: module.Excalidraw };
});

interface CanvasPanelProps {
  onContextPrepared: (descriptor: CanvasContextDescriptor) => void;
}

type SceneElements = readonly ExcalidrawElement[];

export function CanvasPanel({ onContextPrepared }: CanvasPanelProps) {
  const [document, setDocument] = useState<CanvasDocument | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const [elementCount, setElementCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sceneRef = useRef<CanvasDocument | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void window.agentAPI.loadCanvasDocument().then((result) => {
      if (cancelled) return;
      setDocument(result.document);
      sceneRef.current = result.document;
      setElementCount(result.document.elements.filter((element) => element.isDeleted !== true && element.deleted !== true).length);
      loadedRef.current = true;
      setLoading(false);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setNotice(error instanceof Error ? error.message : "Unable to load the canvas.");
      setDocument(emptyDocument());
      sceneRef.current = emptyDocument();
      setElementCount(0);
      loadedRef.current = true;
      setLoading(false);
    });
    return () => {
      cancelled = true;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      if (loadedRef.current && sceneRef.current) void window.agentAPI.saveCanvasDocument(sceneRef.current);
    };
  }, []);

  const initialData = useMemo(() => {
    if (!document) return null;
    return {
      elements: document.elements as unknown as readonly ExcalidrawElement[],
      appState: document.appState,
      files: document.files as unknown as BinaryFiles,
    };
  }, [document]);

  const scheduleSave = (next: CanvasDocument): void => {
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
  };

  const handleChange = (elements: SceneElements, appState: AppState, files: BinaryFiles): void => {
    if (!loadedRef.current) return;
    const selected = Object.keys(appState.selectedElementIds ?? {});
    setSelectedCount(selected.length);
    setElementCount(elements.filter((element) => element.isDeleted !== true).length);
    scheduleSave({
      elements: [...elements] as unknown as Record<string, unknown>[],
      appState: pickPersistedAppState(appState),
      files: files as unknown as CanvasDocument["files"],
    });
  };

  const prepareContext = async (scope: "selection" | "document"): Promise<void> => {
    if (!api || !sceneRef.current || busy) return;
    const allElements = api.getSceneElements() as readonly ExcalidrawElement[];
    const selectedIds = Object.keys(api.getAppState().selectedElementIds ?? {});
    if (scope === "selection" && selectedIds.length === 0) {
      setNotice("Select one or more canvas elements first.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const selected = scope === "selection"
        ? allElements.filter((element) => selectedIds.includes(element.id))
        : allElements;
      const excalidraw = await import("@excalidraw/excalidraw");
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
        scope,
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

  return (
    <section className="canvas-panel" aria-label="Canvas workspace">
      <div className="canvas-panel-toolbar">
        <div className="canvas-panel-status">
          <strong>Canvas</strong>
          <span>{saving ? "Saving…" : selectedCount > 0 ? `${selectedCount} selected` : "Select to reference"}</span>
        </div>
        <div className="canvas-panel-actions">
          <button type="button" onClick={() => void prepareContext("selection")} disabled={loading || !api || busy || selectedCount === 0}>
            {busy ? "Preparing…" : "Use selection"}
          </button>
          <button type="button" className="canvas-panel-secondary-action" onClick={() => void prepareContext("document")} disabled={loading || !api || busy || elementCount === 0}>
            Use canvas
          </button>
        </div>
      </div>
      <div className="canvas-panel-editor">
        {loading || !initialData ? (
          <div className="canvas-panel-state">Loading canvas…</div>
        ) : (
          <Suspense fallback={<div className="canvas-panel-state">Loading drawing tools…</div>}>
            <Excalidraw
              initialData={initialData}
              excalidrawAPI={setApi}
              onChange={handleChange}
              handleKeyboardGlobally={false}
              validateEmbeddable={false}
              UIOptions={{
                canvasActions: {
                  loadScene: false,
                  saveToActiveFile: false,
                  export: false,
                  saveAsImage: false,
                },
              }}
              autoFocus={false}
            />
          </Suspense>
        )}
      </div>
      {notice && <p className="canvas-panel-notice" role="status">{notice}</p>}
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

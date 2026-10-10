import {
  Component,
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { AppState, BinaryFiles, CanvasEditorImperativeAPI } from "@agent-studio/canvas-editor/types";
import type { CanvasEditorElement } from "@agent-studio/canvas-editor/element/types";
import type {
  CanvasContextDescriptor,
  CanvasDocument,
  CanvasDocumentResult,
  CanvasPersistenceVersion,
} from "../../shell/shared/ipc";
import type { CanvasEditOutcome, CanvasEditRequest, CanvasEditResult } from "../commands/types";
import { CanvasSaveCoordinator, CanvasSaveConflictError, type CanvasSaveState } from "../persistence/CanvasSaveCoordinator";
import { shouldPersistCanvasChange } from "./scenePersistence";
import "./CanvasSurface.css";

let canvasEditorPromise: Promise<typeof import("@agent-studio/canvas-editor")> | null = null;
let loadedCanvasEditor: typeof import("@agent-studio/canvas-editor") | null = null;
const preloadedCanvasDocuments = new Map<string, Promise<CanvasDocumentResult>>();

function canvasScopeKey(projectId: string | null): string {
  return projectId ?? "__unprojected__";
}

export function preloadCanvasEditor(): Promise<typeof import("@agent-studio/canvas-editor")> {
  canvasEditorPromise ??= import("@agent-studio/canvas-editor")
    .then((module) => {
      loadedCanvasEditor = module;
      return module;
    })
    .catch((error: unknown) => {
      canvasEditorPromise = null;
      loadedCanvasEditor = null;
      throw error;
    });
  return canvasEditorPromise;
}

export function preloadCanvasDocument(projectId: string | null): Promise<CanvasDocumentResult> {
  const key = canvasScopeKey(projectId);
  const existing = preloadedCanvasDocuments.get(key);
  if (existing) return existing;
  const pending = window.agentAPI.loadCanvasDocument(projectId).catch((error: unknown) => {
    preloadedCanvasDocuments.delete(key);
    throw error;
  });
  preloadedCanvasDocuments.set(key, pending);
  return pending;
}

export function resetPreloadedCanvasDocument(): void {
  preloadedCanvasDocuments.clear();
}

class CanvasRenderErrorBoundary extends Component<
  { children: ReactNode; onError?: (error: Error) => void },
  { error: Error | null }
> {
  public state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Canvas renderer failed", error, info.componentStack);
    this.props.onError?.(error);
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

function consumeCanvasDocument(projectId: string | null): Promise<CanvasDocumentResult> {
  const key = canvasScopeKey(projectId);
  const promise = preloadedCanvasDocuments.get(key) ?? window.agentAPI.loadCanvasDocument(projectId);
  preloadedCanvasDocuments.delete(key);
  return promise;
}

const CanvasEditor = lazy(async () => {
  const module = await preloadCanvasEditor();
  return { default: module.CanvasEditor };
});

interface CanvasSurfaceProps {
  projectId: string | null;
  pendingEdit?: CanvasEditRequest | null;
  onEditResult?: (result: CanvasEditResult) => void;
  onContextPrepared: (descriptor: CanvasContextDescriptor) => void;
  onCanReleaseChange?: (canRelease: boolean) => void;
}

export interface CanvasSurfaceHandle {
  flush: () => Promise<void>;
}

type SceneElements = readonly CanvasEditorElement[];
type SelectionActionPosition = {
  left: number;
  top: number;
  placement: "above" | "below";
};

type SelectionPositionSnapshot = {
  request: number;
  selectedElements: readonly CanvasEditorElement[];
  appState: Pick<AppState, "zoom" | "offsetLeft" | "offsetTop" | "scrollX" | "scrollY">;
};

const SELECTION_ACTION_HANDLE_GAP = 10;

export const CanvasSurface = forwardRef<CanvasSurfaceHandle, CanvasSurfaceProps>(function CanvasSurface({ projectId, pendingEdit = null, onEditResult, onContextPrepared, onCanReleaseChange }, ref) {
  const [document, setDocument] = useState<CanvasDocument | null>(null);
  const [api, setApi] = useState<CanvasEditorImperativeAPI | null>(null);
  const [selectionActionPosition, setSelectionActionPosition] =
    useState<SelectionActionPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [editorReady, setEditorReady] = useState(false);
  const [saveState, setSaveState] = useState<CanvasSaveState | null>(null);
  const [selectedCount, setSelectedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [savingJSON, setSavingJSON] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const sceneProjectIdRef = useRef<string | null>(projectId);
  const saveCoordinatorRef = useRef<CanvasSaveCoordinator | null>(null);
  const pendingVersionRef = useRef<{ projectId: string | null; version: CanvasPersistenceVersion } | null>(null);
  const lastDocumentVersionRef = useRef<number | undefined>(undefined);
  const apiRef = useRef<CanvasEditorImperativeAPI | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const selectionActionsRef = useRef<HTMLDivElement | null>(null);
  const selectionPositionRequestRef = useRef(0);
  const selectionPositionFrameRef = useRef<number | null>(null);
  const selectionPositionWorkInFlightRef = useRef(false);
  const pendingSelectionPositionRef = useRef<SelectionPositionSnapshot | null>(null);
  const loadedRef = useRef(false);
  const canReleaseRef = useRef(true);
  const activeEditRequestRef = useRef<string | null>(null);
  const saving = saveState?.phase === "saving";
  const saveError = saveState?.error ?? null;
  const saveConflict = saveState?.phase === "conflict";

  const reportCanRelease = useCallback((canRelease: boolean): void => {
    if (canReleaseRef.current === canRelease) return;
    canReleaseRef.current = canRelease;
    onCanReleaseChange?.(canRelease);
  }, [onCanReleaseChange]);

  const receiveAPI = useCallback((next: CanvasEditorImperativeAPI | null): void => {
    apiRef.current = next;
    setApi(next);
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    await saveCoordinatorRef.current?.flush();
  }, []);

  useImperativeHandle(ref, () => ({ flush }), [flush]);

  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    pendingVersionRef.current = null;
    setEditorReady(false);
    setLoading(true);
    setLoadError(null);
    setSaveState(null);
    setNotice(null);
    setSelectedCount(0);
    setSelectionActionPosition(null);
    if (apiRef.current && sceneProjectIdRef.current !== projectId) {
      apiRef.current.replaceScene({ elements: [], appState: {}, files: {} });
    }

    void consumeCanvasDocument(projectId).then((result) => {
      if (cancelled) return;
      const softwareBackground =
        window.getComputedStyle(window.document.documentElement).getPropertyValue("--bg").trim() ||
        "#f7f3ee";
      const nextAppState = { ...result.document.appState, viewBackgroundColor: softwareBackground };
      sceneProjectIdRef.current = projectId;
      pendingVersionRef.current = { projectId, version: result.version };
      setDocument(result.document);
      if (apiRef.current) {
        apiRef.current.replaceScene({
          elements: result.document.elements,
          appState: nextAppState,
          files: result.document.files as unknown as BinaryFiles,
        });
      }
    }).catch((error: unknown) => {
      if (cancelled) return;
      setLoadError(error instanceof Error ? error.message : "Unable to load the canvas.");
      setLoading(false);
    });
    return () => {
      cancelled = true;
      loadedRef.current = false;
      pendingVersionRef.current = null;
      selectionPositionRequestRef.current += 1;
      pendingSelectionPositionRef.current = null;
      if (selectionPositionFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionPositionFrameRef.current);
      }
      const retiringCoordinator = saveCoordinatorRef.current;
      saveCoordinatorRef.current = null;
      if (retiringCoordinator) {
        void retiringCoordinator.flush().catch(() => undefined).finally(() => retiringCoordinator.dispose());
      }
    };
  }, [projectId, reloadVersion, reportCanRelease]);

  useEffect(() => {
    if (!pendingEdit || !onEditResult || activeEditRequestRef.current) return;
    const respond = (result: Omit<CanvasEditResult, "requestId" | "runId" | "projectId">): void => {
      onEditResult({
        requestId: pendingEdit.requestId,
        runId: pendingEdit.runId,
        projectId: pendingEdit.projectId,
        ...result,
      });
    };

    if (pendingEdit.projectId !== projectId) {
      respond({ ok: false, error: "project_changed" });
      return;
    }
    if (Date.now() >= pendingEdit.deadlineAt) {
      respond({ ok: false, error: "deadline_expired" });
      return;
    }
    if (loadError) {
      respond({ ok: false, error: "canvas_load_failed" });
      return;
    }
    const editorAPI = apiRef.current;
    const editCoordinator = saveCoordinatorRef.current;
    if (!editorReady || !loadedRef.current || !editorAPI || editorAPI.getAppState().isLoading || !editCoordinator) return;
    if (editCoordinator.state.phase === "conflict") {
      respond({ ok: false, error: "persistence_conflict" });
      return;
    }

    activeEditRequestRef.current = pendingEdit.requestId;
    let unsubscribe = (): void => undefined;
    let timeout: number | null = null;
    let cancelPendingWait = (): void => undefined;
    let settled = false;
    let appliedOutcome: CanvasEditOutcome | null = null;
    let stage: "apply" | "scene" | "save" = "apply";
    const changeObserved = new Promise<void>((resolve) => {
      unsubscribe = editorAPI.onChange(() => resolve());
    });
    const deadlineReached = new Promise<never>((_resolve, reject) => {
      timeout = window.setTimeout(
        () => reject(new Error("outcome_unknown")),
        Math.max(0, pendingEdit.deadlineAt - Date.now()),
      );
      cancelPendingWait = () => reject(new Error("canvas_edit_cancelled"));
    });
    // A parent cancellation removes the request. Handle that promise even if
    // the renderer has already begun a save and can no longer roll it back.
    void deadlineReached.catch(() => undefined);

    const apply = async (): Promise<void> => {
      try {
        const outcome = editorAPI.applyCanvasEdit(
          pendingEdit.operations,
          pendingEdit.sourceElements,
          pendingEdit.imageFiles,
        );
        appliedOutcome = outcome;
        if (!outcome.ok) {
          setNotice("Canvas edit needs attention. See the tool result in the conversation.");
          respond(outcome);
          return;
        }
        if (outcome.changed !== false) {
          stage = "scene";
          await Promise.race([changeObserved, deadlineReached]);
        }
        stage = "save";
        await Promise.race([editCoordinator.flush(), deadlineReached]);
        setNotice("Canvas updated by the Agent.");
        respond(outcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : "canvas_edit_failed";
        const outcomeUnknown = message === "outcome_unknown" || message === "canvas_edit_cancelled";
        const persistenceFailed = appliedOutcome?.ok === true && stage === "save" && !outcomeUnknown;
        const persistenceConflict = error instanceof CanvasSaveConflictError;
        if (persistenceFailed && !persistenceConflict) setNotice("Canvas edit is visible but could not be saved. Retry saving the canvas.");
        respond({
          ...(appliedOutcome ?? {}),
          ok: false,
          error: persistenceConflict ? "persistence_conflict" : persistenceFailed ? "persistence_failed" : outcomeUnknown ? "outcome_unknown" : message,
        });
      } finally {
        settled = true;
        unsubscribe();
        if (timeout !== null) window.clearTimeout(timeout);
        activeEditRequestRef.current = null;
      }
    };

    void apply();
    return () => {
      if (!settled && activeEditRequestRef.current === pendingEdit.requestId) {
        cancelPendingWait();
      }
      unsubscribe();
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [api, editorReady, loadError, onEditResult, pendingEdit, projectId]);

  const initialData = useMemo(() => {
    if (!document) return null;
    const softwareBackground =
      window.getComputedStyle(window.document.documentElement).getPropertyValue("--bg").trim() ||
      "#f7f3ee";
    return {
      elements: document.elements as unknown as readonly CanvasEditorElement[],
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
          const actionHeight = selectionActionsRef.current?.offsetHeight ?? 36;
          const rotationClearance =
            editor.getRotationHandleTopOffset("mouse") + SELECTION_ACTION_HANDLE_GAP;
          const placeBelow =
            upperAnchor.y - editorBounds.top -
              rotationClearance - actionHeight < 58;
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
            placeBelow ? 58 : 58 + actionHeight,
            Math.min(
              editorBounds.height - 140,
              anchor.y - editorBounds.top +
                (placeBelow ? 10 : -rotationClearance),
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
    if (sceneProjectIdRef.current !== projectId || appState.isLoading) return;
    const nextAppState = pickPersistedAppState(appState);
    const documentVersion = apiRef.current?.getDocumentVersion();
    if (!loadedRef.current) {
      const baseline = pendingVersionRef.current;
      if (!baseline || baseline.projectId !== projectId || documentVersion === undefined) return;
      const coordinator = new CanvasSaveCoordinator({
        projectId,
        initial: {
          version: baseline.version,
          document: {
            elements: [...elements] as unknown as CanvasDocument["elements"],
            appState: nextAppState,
            files: files as unknown as CanvasDocument["files"],
          },
        },
        save: (request) => window.agentAPI.saveCanvasDocument(request),
        onStateChange: (state) => {
          if (saveCoordinatorRef.current !== coordinator) return;
          setSaveState(state);
          reportCanRelease(!state.dirty);
        },
      });
      saveCoordinatorRef.current = coordinator;
      pendingVersionRef.current = null;
      lastDocumentVersionRef.current = documentVersion;
      loadedRef.current = true;
      setSaveState(coordinator.state);
      setEditorReady(true);
      setLoading(false);
      reportCanRelease(true);
    }
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
    const shouldSave = shouldPersistCanvasChange(
      lastDocumentVersionRef.current,
      documentVersion,
      saveCoordinatorRef.current?.document.appState,
      nextAppState,
    );
    lastDocumentVersionRef.current = documentVersion;
    if (!shouldSave) return;
    const nextDocument: CanvasDocument = {
      elements: [...elements] as unknown as Record<string, unknown>[],
      appState: nextAppState,
      files: files as unknown as CanvasDocument["files"],
    };
    saveCoordinatorRef.current?.update(nextDocument);
  }, [projectId, reportCanRelease, scheduleSelectionPosition]);

  const prepareSelectionContext = async (): Promise<void> => {
    if (!api || !loadedRef.current || busy) return;
    const capturedProjectId = sceneProjectIdRef.current;
    const allElements = api.getSceneElements() as readonly CanvasEditorElement[];
    const selectedIds = Object.keys(api.getAppState().selectedElementIds ?? {});
    if (selectedIds.length === 0) {
      setNotice("Select one or more canvas elements first.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const selectedIdSet = new Set(selectedIds);
      const selected = allElements.filter((element) => selectedIdSet.has(element.id) && !element.isDeleted);
      const editor = loadedCanvasEditor;
      if (!editor) throw new Error("Canvas editor is still loading.");
      const [minX, minY, maxX, maxY] = editor.getCommonBounds(
        selected,
        new Map(allElements.map((element) => [element.id, element])),
      );
      const selectionBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      const files = api.getFiles();
      const selectedFiles: BinaryFiles = Object.create(null);
      for (const element of selected) {
        const fileId = typeof element.fileId === "string" ? element.fileId : null;
        if (element.type !== "image" || !fileId || !files[fileId]) continue;
        const { dataURL: _dataURL, ...metadata } = files[fileId];
        selectedFiles[fileId] = metadata;
      }
      const serializedJSON = editor.serializeAsJSON(selected, api.getAppState(), selectedFiles, "local");
      let visual: { mediaType: "image/png"; dataURL: string } | undefined;
      if (selected.some((element) => element.type === "image")) {
        const blob = await editor.exportToBlob({
          elements: selected,
          appState: api.getAppState(),
          files,
          mimeType: "image/png",
          exportPadding: 24,
        });
        visual = { mediaType: "image/png", dataURL: await blobToDataURL(blob) };
      }
      if (sceneProjectIdRef.current !== capturedProjectId || !loadedRef.current) return;
      const descriptor = await window.agentAPI.prepareCanvasContext({
        projectId: capturedProjectId,
        scope: "selection",
        selectedElementIds: selectedIds,
        serializedJSON,
        coordinateSpace: "scene",
        selectionBounds,
        ...(visual ? { visual } : {}),
      });
      if (sceneProjectIdRef.current === capturedProjectId && loadedRef.current) onContextPrepared(descriptor);
    } catch (error: unknown) {
      if (sceneProjectIdRef.current === capturedProjectId) {
        setNotice(error instanceof Error ? error.message : "Unable to prepare the canvas context.");
      }
    } finally {
      setBusy(false);
    }
  };

  const saveCanvasJSON = async (asDraft = false): Promise<void> => {
    if (!api || savingJSON) return;
    setSavingJSON(true);
    setNotice(null);
    try {
      const editor = await import("@agent-studio/canvas-editor");
      const exportState = api.getAppState();
      const { fileHandle } = await editor.saveAsJSON(
        api.getSceneElements() as unknown as readonly CanvasEditorElement[],
        asDraft ? { ...exportState, fileHandle: null } : exportState,
        api.getFiles() as unknown as BinaryFiles,
        asDraft ? `${api.getName()}-draft` : api.getName(),
      );
      if (!asDraft) api.updateScene({ appState: { fileHandle } });
      setNotice(asDraft ? "Canvas draft exported." : "Canvas JSON saved.");
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
        {initialData && (
          <CanvasRenderErrorBoundary onError={() => {
            if (pendingEdit) {
              onEditResult?.({
                requestId: pendingEdit.requestId,
                runId: pendingEdit.runId,
                projectId: pendingEdit.projectId,
                ok: false,
                error: "canvas_renderer_failed",
              });
            }
          }}>
            <Suspense fallback={<div className="canvas-panel-state">Loading drawing tools…</div>}>
              <CanvasEditor
                initialData={initialData}
                canvasAPI={receiveAPI}
                onChange={handleChange}
                handleKeyboardGlobally={false}
                UIOptions={uiOptions}
                autoFocus={false}
              />
            </Suspense>
          </CanvasRenderErrorBoundary>
        )}
        {(loading || loadError) && (
          <div className="canvas-panel-state canvas-panel-loading" role={loadError ? "alert" : "status"}>
            {loadError ? (
              <>
                <span>{loadError}</span>
                <button type="button" onClick={() => setReloadVersion((current) => current + 1)}>Retry</button>
              </>
            ) : "Loading canvas…"}
          </div>
        )}
        {!loading && !loadError && selectionActionPosition && selectedCount > 0 && (
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
        {(saving || saveError || notice) && (
          <div className={`canvas-panel-status${saveError ? " has-action" : ""}`} role={saveError ? "alert" : "status"} aria-live="polite">
            <span>{saving ? "Saving…" : saveError ?? notice}</span>
            {saveError && (saveConflict ? (
              <>
                <button type="button" onClick={() => void saveCanvasJSON(true)} disabled={savingJSON}>Export draft</button>
                <button type="button" onClick={() => {
                  resetPreloadedCanvasDocument();
                  setReloadVersion((current) => current + 1);
                }}>Reload saved</button>
              </>
            ) : <button type="button" onClick={() => void flush().catch(() => undefined)}>Retry</button>)}
          </div>
        )}
      </div>
    </section>
  );
});

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

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the canvas snapshot."));
    reader.readAsDataURL(blob);
  });
}

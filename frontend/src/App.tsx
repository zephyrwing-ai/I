import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Column } from "./middle-column/Column";
import { MessageStream, type MessageStreamHandle } from "./middle-column/message-stream/MessageStream";
import { StreamRegion } from "./middle-column/message-stream/StreamScrollbar";
import { Composer } from "./middle-column/composer/Composer";
import { TopBar, SearchPopover } from "./components/TopBar";
import { ConfigPanel } from "./components/ConfigPanel";
import { OutputSidebar } from "./components/OutputSidebar";
import {
  CanvasSurface,
  type CanvasSurfaceHandle,
  preloadCanvasDocument,
  preloadCanvasEditor,
  resetPreloadedCanvasDocument,
} from "../../canvas/ui/CanvasSurface";
import { useFloatingPanel } from "./hooks/useFloatingPanel";
import { useSessionHistory } from "./hooks/useSessionHistory";
import { useGlobalSearch } from "./hooks/useGlobalSearch";
import { agentReducer, initialAgentState } from "./store/agentReducer";
import { useProviderCatalog } from "./store/providerCatalog";
import type { AgentEvent, CanvasContextDescriptor, ProjectDescriptor, RunRequest, SteerRequest } from "../../shell/shared/ipc";
import type { CanvasEditCancel, CanvasEditRequest, CanvasEditResult } from "../../canvas/commands/types";

export default function App() {
  const [state, dispatch] = useReducer(agentReducer, initialAgentState);
  const catalog = useProviderCatalog();
  const [configOpen, setConfigOpen] = useState(false);
  const [sidebarPanel, setSidebarPanel] = useState<"outputs" | "canvas" | null>(null);
  const [canvasContexts, setCanvasContexts] = useState<CanvasContextDescriptor[]>([]);
  const [pendingCanvasEdit, setPendingCanvasEdit] = useState<CanvasEditRequest | null>(null);
  const [canvasCanRelease, setCanvasCanRelease] = useState(true);
  const [project, setProject] = useState<ProjectDescriptor>({ projectId: null, displayName: "Choose folder", canonicalPath: null });
  const canvasSurfaceRef = useRef<CanvasSurfaceHandle>(null);
  const projectRequestEpochRef = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [restoreDraft, setRestoreDraft] = useState<{ id: string; text: string } | null>(null);
  const eventQueue = useRef<AgentEvent[]>([]);
  const hydrationEventQueue = useRef<AgentEvent[]>([]);
  const historyReadyRef = useRef(false);
  const eventFrame = useRef<number | null>(null);
  const streamRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchPanelRef = useRef<HTMLDivElement>(null);
  const messageStreamRef = useRef<MessageStreamHandle>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsPanel = useFloatingPanel(configOpen, settingsButtonRef);
  const running = state.status === "running" || state.status === "starting" || state.status === "stopping";
  const stopping = state.status === "stopping";
  const currentRun = state.currentRunId ? state.runs[state.currentRunId] : undefined;
  const outputFiles = currentRun?.outputFileOrder.map((id) => currentRun.outputFiles[id]).filter(Boolean) ?? [];
  const outputOpen = sidebarPanel === "outputs";
  const canvasOpen = sidebarPanel === "canvas";
  useEffect(() => {
    if (!window.agentAPI || typeof window.agentAPI.onEvent !== "function") return;
    const offEvent = window.agentAPI.onEvent((event) => {
      if (!historyReadyRef.current) {
        hydrationEventQueue.current.push(event);
        return;
      }
      eventQueue.current.push(event);
      if (eventFrame.current !== null) return;
      eventFrame.current = requestAnimationFrame(() => {
        const queued = eventQueue.current;
        eventQueue.current = [];
        eventFrame.current = null;
        queued.forEach((queuedEvent) => {
          dispatch({ type: "event", event: queuedEvent });
        });
      });
    });
    return () => {
      offEvent();
      if (eventFrame.current !== null) cancelAnimationFrame(eventFrame.current);
      eventFrame.current = null;
      eventQueue.current = [];
    };
  }, []);

  useEffect(() => {
    if (typeof window.agentAPI?.onCanvasEditRequest !== "function") return;
    const stopRequests = window.agentAPI.onCanvasEditRequest((request: CanvasEditRequest) => {
      setPendingCanvasEdit(request);
      setSidebarPanel("canvas");
    });
    const stopCancellations = window.agentAPI.onCanvasEditCancel((cancel: CanvasEditCancel) => {
      setPendingCanvasEdit((current) => current?.requestId === cancel.requestId ? null : current);
    });
    return () => {
      stopRequests();
      stopCancellations();
    };
  }, []);

  const completeCanvasEdit = useCallback((result: CanvasEditResult): void => {
    window.agentAPI.completeCanvasEdit(result);
    setPendingCanvasEdit((current) => current?.requestId === result.requestId ? null : current);
  }, []);

  const history = useSessionHistory(state, dispatch);
  const search = useGlobalSearch(state, history.loadSearch);
  const showEmptyState = history.hydrated && state.runOrder.length === 0 && !history.loadingOlder && !history.error;

  useEffect(() => {
    void preloadCanvasEditor().catch(() => undefined);
    const requestEpoch = projectRequestEpochRef.current;
    void window.agentAPI.getActiveProject().then((activeProject) => {
      if (requestEpoch !== projectRequestEpochRef.current) return;
      setProject(activeProject);
      void preloadCanvasDocument(activeProject.projectId).catch(() => undefined);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!history.hydrated || historyReadyRef.current) return;
    historyReadyRef.current = true;
    const pending = hydrationEventQueue.current;
    hydrationEventQueue.current = [];
    pending.forEach((event) => dispatch({ type: "event", event }));
  }, [history.hydrated]);

  useEffect(() => {
    if (!configOpen) return;
    const close = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (settingsPanel.panelRef.current?.contains(target) || settingsButtonRef.current?.contains(target)) return;
      setConfigOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [configOpen, settingsPanel.panelRef]);

  useEffect(() => {
    if (!searchOpen) return;
    const close = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (searchPanelRef.current?.contains(target) || searchButtonRef.current?.contains(target)) return;
      setSearchOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [searchOpen]);

  // 底部占位高度 = Composer 实时高度（外壳 116px + 输入/附件增减同步），见设计文档「滚动条-底部占位」
  useLayoutEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    const measure = (): void => setComposerHeight(element.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 处于底部时 Composer 变高导致内容与占位间出现空隙，跟随吸底；用户在中途则保持不动
  useEffect(() => {
    const element = streamRef.current;
    if (!element) return;
    const max = element.scrollHeight - element.clientHeight;
    if (max - element.scrollTop < 8) element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
  }, [composerHeight]);

  useEffect(() => {
    if (!searchOpen || !search.activeBlockId) return;
    void messageStreamRef.current?.revealBlock(search.activeBlockId);
  }, [search.activeBlockId, search.selectionVersion, searchOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        search.clear();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [search.clear, searchOpen]);

  const handleRun = async (req: RunRequest): Promise<boolean> => {
    dispatch({ type: "runRequested" });
    try {
      const ack = await window.agentAPI.run(req);
      if (!ack.ok) {
        dispatch({ type: "runRejected", error: ack.error });
        return false;
      }
      // 任务发送时间由 Renderer 侧观察（事件不带时间戳），仅供用户消息时间戳行展示。
      dispatch({ type: "runAccepted", runId: ack.runId, inputId: ack.inputId, projectId: req.projectId ?? null, task: req.task, taskAt: Date.now() });
      return true;
    } catch (error) {
      dispatch({ type: "runRejected", error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  const handleSteer = async (req: SteerRequest): Promise<boolean> => {
    try {
      const ack = await window.agentAPI.steer(req);
      if (!ack.ok) {
        dispatch({ type: "steerRejected", error: ack.error });
        return false;
      }
      dispatch({ type: "steerAccepted", runId: ack.runId, projectId: ack.projectId, inputId: ack.inputId, task: req.task, acceptOrder: ack.acceptOrder, acceptedAt: ack.acceptedAt });
      return true;
    } catch (error) {
      dispatch({ type: "steerRejected", error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  const handleResendInput = (runId: string, inputId: string): void => {
    const input = state.runs[runId]?.inputs[inputId];
    if (input?.status === "interrupted") setRestoreDraft({ id: crypto.randomUUID(), text: input.task });
  };

  const handleStop = (): void => {
    dispatch({ type: "stopRequested" });
    window.agentAPI.stop();
  };

  const handleSelectProject = async (): Promise<void> => {
    if (running) return;
    try {
      projectRequestEpochRef.current += 1;
      await canvasSurfaceRef.current?.flush();
      resetPreloadedCanvasDocument();
      const selected = await window.agentAPI.selectProject();
      if (!selected) return;
      setProject(selected);
      setCanvasContexts([]);
      void preloadCanvasDocument(selected.projectId).catch(() => undefined);
      await history.reload(selected.projectId);
    } catch (error) {
      dispatch({ type: "runRejected", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleClearProject = async (): Promise<void> => {
    if (running) return;
    try {
      projectRequestEpochRef.current += 1;
      await canvasSurfaceRef.current?.flush();
      resetPreloadedCanvasDocument();
      const cleared = await window.agentAPI.clearProject();
      setProject(cleared);
      setCanvasContexts([]);
      void preloadCanvasDocument(cleared.projectId).catch(() => undefined);
      await history.reload(cleared.projectId);
    } catch (error) {
      dispatch({ type: "runRejected", error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <div className="app">
      <TopBar
        outputOpen={outputOpen}
        outputCount={outputFiles.length}
        canvasOpen={canvasOpen}
        searchOpen={searchOpen}
        settingsOpen={configOpen}
        searchButtonRef={searchButtonRef}
        settingsButtonRef={settingsButtonRef}
        onOutput={() => setSidebarPanel((value) => value === "outputs" ? null : "outputs")}
        onCanvas={() => setSidebarPanel((value) => value === "canvas" ? null : "canvas")}
        onSearch={() => setSearchOpen((value) => !value)}
        onSettings={() => setConfigOpen((value) => !value)}
      />
      {searchOpen && (
        <SearchPopover
          query={search.query}
          onQueryChange={search.setQuery}
          results={search.results}
          activeBlockId={search.activeBlockId}
          loadingHistory={search.loadingHistory}
          hydrated={search.hydrated}
          hasMoreHistory={search.hasMoreHistory}
          error={search.error}
          panelRef={searchPanelRef}
          onSelect={search.selectResult}
          onRetry={search.retryHistory}
        />
      )}
      <div className="workspace">
        <section className="main-column">
          <Column>
            <StreamRegion scrollRef={streamRef}>
              {state.error && <div className="error-banner">{state.error}</div>}
              <MessageStream
                ref={messageStreamRef}
                projectId={state.history.projectId}
                historyGeneration={state.history.requestGeneration}
                historyHydrationVersion={state.history.hydrationVersion}
                historyReady={history.hydrated}
                order={state.runOrder}
                runs={state.runs}
                scrollRef={streamRef}
                hasMore={history.hasMore}
                loadingOlder={history.loadingOlder}
                historyError={history.error}
                onLoadOlder={history.loadOlder}
                activeSearchBlockId={search.activeBlockId}
                onResendInput={handleResendInput}
              />
              <div style={{ height: composerHeight }} />
            </StreamRegion>
            {showEmptyState && (
              <div className="column-empty-state" style={{ bottom: composerHeight }}>
                What can I do for you ?
              </div>
            )}
            <div ref={composerRef} className="composer-inner">
              <Composer
                running={running}
                stopping={stopping}
                activeRunId={running ? state.currentRunId : null}
                restoreDraft={restoreDraft}
                ready={history.hydrated}
                modelOptions={catalog.modelOptions}
                modelLoading={catalog.loading}
                project={project}
                onSelectProject={() => void handleSelectProject()}
                onClearProject={() => void handleClearProject()}
                onRun={handleRun}
                onSteer={handleSteer}
                onStop={handleStop}
                canvasContexts={canvasContexts}
                onRemoveCanvasContext={(contextId) => setCanvasContexts((current) => current.filter((context) => context.contextId !== contextId))}
                onClearCanvasContexts={(contextIds) => {
                  const consumed = new Set(contextIds);
                  setCanvasContexts((current) => current.filter((context) => !consumed.has(context.contextId)));
                }}
              />
            </div>
          </Column>
        </section>
      </div>
      <OutputSidebar
        open={sidebarPanel !== null}
        activePanel={sidebarPanel ?? "outputs"}
        files={outputFiles}
        canvasCanRelease={canvasCanRelease}
        onOpenChange={(open) => { if (!open) setSidebarPanel(null); }}
        canvas={<CanvasSurface ref={canvasSurfaceRef} projectId={project.projectId} pendingEdit={pendingCanvasEdit} onEditResult={completeCanvasEdit} onContextPrepared={(descriptor) => {
          if (descriptor.projectId === project.projectId) setCanvasContexts((current) => [...current, descriptor]);
        }} onCanReleaseChange={setCanvasCanRelease} />}
      />

      {settingsPanel.mounted && (
        <div ref={settingsPanel.panelRef} className={`config-floating phase-${settingsPanel.phase}`} onTransitionEnd={settingsPanel.onTransitionEnd}>
          <ConfigPanel profiles={catalog.profiles} loading={catalog.loading} error={catalog.error} disabled={running} onClose={() => setConfigOpen(false)} onRefresh={catalog.refresh} />
        </div>
      )}
    </div>
  );
}

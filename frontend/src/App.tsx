import { useEffect, useReducer, useRef, useState } from "react";
import { Column } from "./middle-column/Column";
import { MessageStream, type MessageStreamHandle } from "./middle-column/message-stream/MessageStream";
import { StreamRegion } from "./middle-column/message-stream/StreamScrollbar";
import type { RunTiming } from "./middle-column/message-stream/RunProcess";
import { Composer } from "./middle-column/composer/Composer";
import { TopBar, SearchPopover } from "./components/TopBar";
import { ConfigPanel } from "./components/ConfigPanel";
import { OutputSidebar } from "./components/OutputSidebar";
import { useFloatingPanel } from "./hooks/useFloatingPanel";
import { useSessionHistory } from "./hooks/useSessionHistory";
import { useGlobalSearch } from "./hooks/useGlobalSearch";
import { agentReducer, initialAgentState } from "./store/agentReducer";
import { useProviderCatalog } from "./store/providerCatalog";
import type { AgentEvent, RunRequest } from "../../shell/shared/ipc";

export default function App() {
  const [state, dispatch] = useReducer(agentReducer, initialAgentState);
  const catalog = useProviderCatalog();
  const [configOpen, setConfigOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const eventQueue = useRef<AgentEvent[]>([]);
  const hydrationEventQueue = useRef<AgentEvent[]>([]);
  const historyReadyRef = useRef(false);
  const eventFrame = useRef<number | null>(null);
  // 计时是 Renderer 侧对事件的观察（事件本身不带时间戳）；reducer 保持纯函数，不写入时间。
  // run 级总时长：runStarted → runCompleted（含全部回合与工具调用）；回合级时间不展示。
  const runTimings = useRef<Record<string, RunTiming>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
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
  // 消息流跨 run 累积：滚动依赖统计全部 run 的回合/工具活动，而不是只盯当前 run。
  const totalTurnCount = state.runOrder.reduce((sum, runId) => sum + (state.runs[runId]?.turnOrder.length ?? 0), 0);
  const toolActivityHash = state.runOrder
    .map((runId) => {
      const run = state.runs[runId];
      return run ? run.turnOrder.map((turnId) => run.turns[turnId]?.toolOrder.length ?? 0).join(",") : "";
    })
    .join("|");
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
        const now = Date.now();
        queued.forEach((queuedEvent) => {
          if (queuedEvent.type === "runStarted") {
            runTimings.current[queuedEvent.runId] = { startedAt: now };
          } else if (queuedEvent.type === "runCompleted") {
            const timing = runTimings.current[queuedEvent.runId];
            runTimings.current[queuedEvent.runId] = timing
              ? { ...timing, completedAt: now }
              : { startedAt: now, completedAt: now };
          }
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

  const history = useSessionHistory(state, dispatch);
  const search = useGlobalSearch(state, history.loadSearch);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.currentRunId, state.history.hydrated, totalTurnCount, toolActivityHash]);

  // 底部占位高度 = Composer 实时高度（外壳 116px + 输入/附件增减同步），见设计文档「滚动条-底部占位」
  useEffect(() => {
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
    if (max - element.scrollTop < 8) element.scrollTop = element.scrollHeight;
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

  const handleRun = async (req: RunRequest): Promise<void> => {
    dispatch({ type: "runRequested" });
    const ack = await window.agentAPI.run(req);
    if (!ack.ok) {
      dispatch({ type: "runRejected", error: ack.error });
      return;
    }
    // 任务发送时间由 Renderer 侧观察（事件不带时间戳），仅供用户消息时间戳行展示。
    dispatch({ type: "runAccepted", runId: ack.runId, task: req.task, taskAt: Date.now() });
  };

  const handleStop = (): void => {
    dispatch({ type: "stopRequested" });
    window.agentAPI.stop();
  };

  return (
    <div className="app">
      <TopBar
        outputOpen={outputOpen}
        outputCount={outputFiles.length}
        searchOpen={searchOpen}
        settingsOpen={configOpen}
        searchButtonRef={searchButtonRef}
        settingsButtonRef={settingsButtonRef}
        onOutput={() => setOutputOpen((value) => !value)}
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
                order={state.runOrder}
                runs={state.runs}
                runTimings={runTimings.current}
                scrollRef={streamRef}
                hasMore={history.hasMore}
                loadingOlder={history.loadingOlder}
                historyError={history.error}
                onLoadOlder={history.loadOlder}
                activeSearchBlockId={search.activeBlockId}
              />
              <div ref={bottomRef} style={{ height: composerHeight }} />
            </StreamRegion>
            <div ref={composerRef} className="composer-inner">
              <Composer
                running={running}
                stopping={stopping}
                ready={history.hydrated}
                modelOptions={catalog.modelOptions}
                modelLoading={catalog.loading}
                onRun={handleRun}
                onStop={handleStop}
              />
            </div>
          </Column>
        </section>
      </div>
      <OutputSidebar open={outputOpen} files={outputFiles} onOpenChange={setOutputOpen} />

      {settingsPanel.mounted && (
        <div ref={settingsPanel.panelRef} className={`config-floating phase-${settingsPanel.phase}`} onTransitionEnd={settingsPanel.onTransitionEnd}>
          <ConfigPanel profiles={catalog.profiles} loading={catalog.loading} error={catalog.error} disabled={running} onClose={() => setConfigOpen(false)} onRefresh={catalog.refresh} />
        </div>
      )}
    </div>
  );
}

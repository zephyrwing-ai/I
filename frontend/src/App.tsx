import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Column } from "./middle-column/Column";
import { MessageStream, type MessageStreamHandle } from "./middle-column/message-stream/MessageStream";
import { StreamRegion } from "./middle-column/message-stream/StreamScrollbar";
import { Composer } from "./middle-column/composer/Composer";
import { TopBar } from "./workbench/titlebar/TopBar";
import { SearchPopover } from "./workbench/titlebar/search/SearchPopover";
import { SettingsPage, type SettingsSection } from "./workbench/settings/SettingsPage";
import { WorkbenchSidebar, type SidebarSurface } from "./workbench/sidebar/WorkbenchSidebar";
import type { SidebarAttachment } from "./workbench/sidebar/SidebarResources";
import { ProjectNavigation } from "./workbench/navigation/ProjectNavigation";
import { ProjectsPanel } from "./workbench/project/ProjectsPanel";
import {
  CanvasSurface,
  type CanvasSurfaceHandle,
  preloadCanvasDocument,
  preloadCanvasEditor,
  resetPreloadedCanvasDocument,
} from "../../canvas/ui/CanvasSurface";
import { useSessionHistory } from "./hooks/useSessionHistory";
import { useProjects } from "./workbench/project/useProjects";
import { useGlobalSearch } from "./workbench/titlebar/search/useGlobalSearch";
import { agentReducer, initialAgentState } from "./store/agentReducer";
import { useProviderCatalog } from "./workbench/settings/providers/providerCatalog";
import { UiPreferencesProvider, useUiPreferences } from "./shared/preferences/uiPreferences";
import { useI18n } from "./shared/i18n";
import type { AgentEvent, CanvasContextDescriptor, InputAttachmentDescriptor, ProjectActionRequest, ProjectDescriptor, RunRequest, SteerRequest } from "../../shell/shared/ipc";
import type { CanvasEditCancel, CanvasEditRequest, CanvasEditResult } from "../../canvas/commands/types";

export default function App() {
  return <UiPreferencesProvider><Workbench /></UiPreferencesProvider>;
}

function Workbench() {
  const t = useI18n();
  const { theme, language } = useUiPreferences();
  const [state, dispatch] = useReducer(agentReducer, initialAgentState);
  const catalog = useProviderCatalog();
  const [activePage, setActivePage] = useState<"workbench" | "settings">("workbench");
  const settingsOpen = activePage === "settings";
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [sidebarPanel, setSidebarPanel] = useState<SidebarSurface | null>(null);
  const [canvasContexts, setCanvasContexts] = useState<CanvasContextDescriptor[]>([]);
  const [pendingCanvasEdit, setPendingCanvasEdit] = useState<CanvasEditRequest | null>(null);
  const [canvasCanRelease, setCanvasCanRelease] = useState(true);
  const [project, setProject] = useState<ProjectDescriptor>({ projectId: null, displayName: "Choose folder", canonicalPath: null });
  const activeScope = useRef(project.projectId);
  activeScope.current = project.projectId;
  const [draftAttachments, setDraftAttachments] = useState<{ projectId: string | null; attachments: InputAttachmentDescriptor[] }>({ projectId: null, attachments: [] });
  const publishDraftAttachments = useCallback((projectId: string | null, attachments: InputAttachmentDescriptor[]): void => {
    if (activeScope.current !== projectId) return;
    setDraftAttachments((current) => current.projectId === projectId && current.attachments === attachments ? current : { projectId, attachments });
  }, []);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [selectedView, setSelectedView] = useState<"ordinary" | "projects" | null>(null);
  const projectView = selectedView === "projects" || (selectedView === null && project.projectId !== null);
  const projectList = useProjects();
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectOperation, setProjectOperation] = useState<string | null>(null);
  const projectTransitionRef = useRef(false);
  const retryProjectActionRef = useRef<(() => void) | null>(null);
  const canvasSurfaceRef = useRef<CanvasSurfaceHandle>(null);
  const projectRequestEpochRef = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [restoreDraft, setRestoreDraft] = useState<{ id: string; text: string } | null>(null);
  const eventQueue = useRef<AgentEvent[]>([]);
  const hydrationEventQueue = useRef<AgentEvent[]>([]);
  const historyReadyRef = useRef(false);
  const eventFrame = useRef<number | null>(null);
  const streamRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchPanelRef = useRef<HTMLDivElement>(null);
  const messageStreamRef = useRef<MessageStreamHandle>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const running = state.status === "running" || state.status === "starting" || state.status === "stopping";
  const stopping = state.status === "stopping";
  const sidebarFiles = useMemo(() => state.runOrder.flatMap((runId) => {
    const run = state.runs[runId];
    if (!run || run.projectId !== project.projectId) return [];
    return run.outputFileOrder.map((id) => run.outputFiles[id]).filter(Boolean);
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [project.projectId, state.runOrder, state.runs]);
  const sidebarAttachments = useMemo(() => {
    const attachments = new Map<string, SidebarAttachment>();
    if (draftAttachments.projectId === project.projectId) {
      draftAttachments.attachments.forEach((attachment) => attachments.set(attachment.attachmentId, { attachment, pending: true }));
    }
    for (const runId of state.runOrder) {
      const run = state.runs[runId];
      if (run.projectId !== project.projectId) continue;
      for (const input of Object.values(run.inputs)) {
        input.attachments?.forEach((attachment) => attachments.set(attachment.attachmentId, { attachment, pending: false }));
      }
    }
    return [...attachments.values()];
  }, [draftAttachments, project.projectId, state.runOrder, state.runs]);
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

  useEffect(() => {
    if (typeof window.agentAPI?.onPrepareToQuit !== "function") return;
    return window.agentAPI.onPrepareToQuit(({ requestId }) => {
      void (async () => {
        try {
          await canvasSurfaceRef.current?.flush();
          window.agentAPI.completeQuitPreparation({ requestId });
        } catch (error) {
          window.agentAPI.completeQuitPreparation({ requestId, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
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
    if (settingsOpen) return;
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
  }, [search.clear, searchOpen, settingsOpen]);

  const handleRun = async (req: RunRequest): Promise<boolean> => {
    if (projectTransitionRef.current) return false;
    dispatch({ type: "runRequested" });
    try {
      const ack = await window.agentAPI.run(req);
      if (!ack.ok) {
        dispatch({ type: "runRejected", error: ack.error });
        return false;
      }
      // Main's admission timestamp is shared with the persisted user entry.
      dispatch({ type: "runAccepted", runId: ack.runId, inputId: ack.inputId, projectId: req.projectId ?? null, task: req.task, taskAt: ack.createdAt, attachments: ack.attachments });
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

  const applyProjectDescriptor = (selected: ProjectDescriptor): Promise<void> | undefined => {
    setProject(selected);
    if (selected.projectId === project.projectId) return;
    setSidebarPanel((current) => current === null ? null : "home");
    setCanvasContexts([]);
    resetPreloadedCanvasDocument();
    setRestoreDraft(null);
    search.clear();
    void preloadCanvasDocument(selected.projectId).catch(() => undefined);
    return history.reload(selected.projectId);
  };

  const switchProject = async (
    operation: string,
    activate: () => Promise<ProjectDescriptor | null>,
    closeProjects = false,
  ): Promise<void> => {
    if (running || projectTransitionRef.current) return;
    projectTransitionRef.current = true;
    projectRequestEpochRef.current += 1;
    setProjectOperation(operation);
    setProjectError(null);
    let historyRequest: Promise<void> | undefined;
    try {
      await canvasSurfaceRef.current?.flush();
      const selected = await activate();
      if (!selected) return;
      setSidebarPanel((current) => current === null ? null : "home");
      if (closeProjects) {
        setProjectsOpen(false);
        setSelectedView("ordinary");
      }
      else setSelectedView("projects");
      // Main also consumes canvas references when an existing folder is added again.
      if (selected.projectId === project.projectId) setCanvasContexts([]);
      historyRequest = applyProjectDescriptor(selected);
      if (operation === "add") await projectList.refresh();
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      projectTransitionRef.current = false;
      setProjectOperation(null);
    }
    // Allow another choice while the current history page is loading.
    await historyRequest;
  };

  const handleOrdinary = (): void => {
    if (running || projectTransitionRef.current) return;
    if (project.projectId === null) {
      setProjectsOpen(false);
      setSelectedView("ordinary");
      setProjectError(null);
      setSidebarPanel((current) => current === null ? null : "home");
      return;
    }
    retryProjectActionRef.current = handleOrdinary;
    void switchProject("ordinary", () => window.agentAPI.clearProject(), true);
  };

  const handleActivateProject = (projectId: string): void => {
    if (projectId === project.projectId || running || projectTransitionRef.current) return;
    retryProjectActionRef.current = () => handleActivateProject(projectId);
    void switchProject(projectId, () => window.agentAPI.activateProject(projectId));
  };

  const handleAddProject = (): void => {
    retryProjectActionRef.current = handleAddProject;
    void switchProject("add", () => window.agentAPI.selectProject());
  };

  const handleProjectAction = async (request: ProjectActionRequest): Promise<void> => {
    if (running || projectTransitionRef.current) return;
    projectTransitionRef.current = true;
    projectRequestEpochRef.current += 1;
    setProjectOperation(`action:${request.projectId}`);
    setProjectError(null);
    retryProjectActionRef.current = () => void handleProjectAction(request);
    let historyRequest: Promise<void> | undefined;
    try {
      if (request.action === "delete" && request.projectId === project.projectId) {
        await canvasSurfaceRef.current?.flush();
      }
      const result = await window.agentAPI.performProjectAction(request);
      if (result.projects) projectList.replace(result.projects);
      historyRequest = applyProjectDescriptor(result.activeProject);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      projectTransitionRef.current = false;
      setProjectOperation(null);
    }
    await historyRequest;
  };

  const openProjectDirectory = async (): Promise<string | null> => {
    if (!project.projectId) return null;
    try {
      await window.agentAPI.performProjectAction({ projectId: project.projectId, action: "reveal" });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const handleProjects = (): void => {
    setProjectsOpen((open) => !open);
    if (!projectsOpen) void projectList.ensureLoaded();
  };

  const handleProjectNavigation = (): void => {
    if (running || projectTransitionRef.current) {
      setSelectedView("projects");
      setProjectsOpen(true);
      void projectList.ensureLoaded();
      return;
    }
    setSelectedView("projects");
    setProjectsOpen(true);
    retryProjectActionRef.current = handleProjectNavigation;
    void switchProject("default", async () => {
      const projects = await projectList.ensureLoaded();
      if (!projects) throw new Error(t("Could not load projects."));
      const first = projects.find((entry) => entry.projectId !== null);
      if (!first?.projectId) {
        setSidebarPanel((current) => current === null ? null : "home");
        return null;
      }
      return first.projectId === project.projectId ? first : window.agentAPI.activateProject(first.projectId);
    });
  };

  const openSettings = (): void => {
    setSearchOpen(false);
    setActivePage("settings");
  };

  const closeSettings = (): void => {
    setActivePage("workbench");
    requestAnimationFrame(() => settingsButtonRef.current?.focus());
  };

  return (
    <div className={`app${projectsOpen ? " projects-open" : ""}`}>
      <div className="workbench-page" hidden={settingsOpen}>
        <ProjectNavigation
          selected={projectView ? "projects" : "ordinary"}
          projectsOpen={projectsOpen}
          settingsOpen={settingsOpen}
          settingsButtonRef={settingsButtonRef}
          disabled={running || projectOperation !== null}
          onOrdinary={handleOrdinary}
          onProjects={handleProjectNavigation}
          onSettings={openSettings}
        />
        <div className="workbench-frame">
          <TopBar
            projectMode={projectView}
            projectsOpen={projectsOpen}
            onProjects={handleProjects}
            sidebarOpen={sidebarPanel !== null}
            searchOpen={searchOpen}
            searchButtonRef={searchButtonRef}
            onSidebar={() => setSidebarPanel((value) => value === null ? "home" : null)}
            onSearch={() => setSearchOpen((value) => !value)}
          />
          <ProjectsPanel
            open={projectsOpen}
            onToggle={handleProjects}
            onOpenChange={setProjectsOpen}
            workspaceRef={workspaceRef}
            projects={projectList.projects}
            activeProjectId={project.projectId}
            loading={projectList.loading}
            error={projectError ?? projectList.error}
            disabled={running || projectOperation !== null}
            adding={projectOperation === "add"}
            selectingProjectId={projectOperation}
            onAdd={handleAddProject}
            onSelect={handleActivateProject}
            onAction={handleProjectAction}
            onRetry={() => projectError ? retryProjectActionRef.current?.() : void projectList.refresh()}
          />
          <section ref={workspaceRef} className="workspace">
            <section className="main-column">
              <Column>
                <StreamRegion scrollRef={streamRef}>
                  {state.error && <div className="error-banner">{state.error}</div>}
                  {!projectsOpen && projectError && (
                    <div className="error-banner" role="alert">
                      {projectError} <button type="button" onClick={() => retryProjectActionRef.current?.()}>{t("Try again")}</button>
                    </div>
                  )}
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
                    ready={history.hydrated && projectOperation === null}
                    modelOptions={catalog.modelOptions}
                    modelLoading={catalog.loading}
                    project={project}
                    onAttachmentsChange={publishDraftAttachments}
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
          </section>
          <WorkbenchSidebar
            workspaceRef={workspaceRef}
            surface={sidebarPanel}
            onSurfaceChange={setSidebarPanel}
            project={project}
            projectMode={projectView}
            projectPending={projectOperation !== null && !projectOperation.startsWith("action:")}
            projectError={projectError}
            onRetryProject={() => retryProjectActionRef.current?.()}
            onAddProject={handleAddProject}
            onOpenProjectDirectory={openProjectDirectory}
            attachments={sidebarAttachments}
            files={sidebarFiles}
            canvasCanRelease={canvasCanRelease}
            canvas={<CanvasSurface ref={canvasSurfaceRef} theme={theme} language={language} projectId={project.projectId} pendingEdit={pendingCanvasEdit} onEditResult={completeCanvasEdit} onContextPrepared={(descriptor) => {
              if (descriptor.projectId === project.projectId) setCanvasContexts((current) => [...current, descriptor]);
            }} onCanReleaseChange={setCanvasCanRelease} />}
          />
        </div>

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
      </div>
      {settingsOpen && (
        <SettingsPage
          section={settingsSection}
          profiles={catalog.profiles}
          loading={catalog.loading}
          error={catalog.error}
          disabled={running}
          onSectionChange={setSettingsSection}
          onBack={closeSettings}
          onRefresh={catalog.refresh}
        />
      )}
    </div>
  );
}

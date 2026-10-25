import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { OutputFileDescriptor, ProjectDescriptor } from "../../../../shell/shared/ipc";
import { useI18n } from "../../shared/i18n";
import { Icon } from "../../shared/ui/Icon";
import { useResizableSidebar } from "../../shared/sidebar/useResizableSidebar";
import { WORKBENCH_SIDEBAR_MIN_WIDTH, WORKBENCH_SIDEBAR_POLICY } from "./sidebarState";
import { createProjectDirectory, type ProjectDirectory } from "./projectDirectory";
import { ProjectFileTree } from "./ProjectFileTree";
import { SidebarResources, SidebarResourcePreview, type SidebarAttachment, type SidebarResource } from "./SidebarResources";
import "./sidebar.css";

export type SidebarSurface = "home" | "files" | "canvas" | "resource";

interface WorkbenchSidebarProps {
  surface: SidebarSurface | null;
  onSurfaceChange: (surface: SidebarSurface | null) => void;
  project: ProjectDescriptor;
  projectMode: boolean;
  projectPending: boolean;
  projectError: string | null;
  onRetryProject: () => void;
  onAddProject: () => void;
  onOpenProjectDirectory: () => Promise<string | null>;
  attachments: SidebarAttachment[];
  files: OutputFileDescriptor[];
  canvas: ReactNode;
  canvasCanRelease: boolean;
  workspaceRef: RefObject<HTMLElement>;
}

const CANVAS_KEEP_ALIVE_MS = 10 * 60 * 1000;

export function WorkbenchSidebar({ surface, onSurfaceChange, project, projectMode, projectPending, projectError, onRetryProject, onAddProject, onOpenProjectDirectory, attachments, files, canvas, canvasCanRelease, workspaceRef }: WorkbenchSidebarProps) {
  const t = useI18n();
  const open = surface !== null;
  const { shellRef, phase, targetWidth, collapseReady, maximumWidth, finishTransition, startDrag, resetWidth, resizeWithKeyboard } = useResizableSidebar({
    open, onOpenChange: (next) => { if (!next) onSurfaceChange(null); }, side: "right", storageKey: "workbench.outputSidebarWidth", policy: WORKBENCH_SIDEBAR_POLICY, workspaceRef,
  });
  const models = useRef(new Map<string, ProjectDirectory>());
  const directory = useMemo(() => {
    if (!project.projectId) return null;
    let model = models.current.get(project.projectId);
    if (!model) {
      model = createProjectDirectory(project.projectId, { listProjectDirectory: (request) => window.agentAPI.listProjectDirectory(request) });
      models.current.set(project.projectId, model);
    }
    return model;
  }, [project.projectId]);
  useEffect(() => () => models.current.forEach((model) => model.dispose()), []);
  const [resourceTarget, setResourceTarget] = useState<{ scope: string | null; resource: SidebarResource } | null>(null);
  const resource = resourceTarget?.scope === project.projectId ? resourceTarget.resource : null;
  const [canvasMounted, setCanvasMounted] = useState(surface === "canvas");
  useEffect(() => {
    if (surface === "canvas") { setCanvasMounted(true); return; }
    if (open || !canvasMounted || !canvasCanRelease) return;
    const timer = window.setTimeout(() => setCanvasMounted(false), CANVAS_KEEP_ALIVE_MS);
    return () => window.clearTimeout(timer);
  }, [surface, open, canvasMounted, canvasCanRelease]);
  useEffect(() => {
    if (!open && shellRef.current?.contains(document.activeElement)) document.getElementById("workbench-sidebar-toggle")?.focus();
  }, [open, shellRef]);

  const back = (): void => {
    onSurfaceChange("home");
    requestAnimationFrame(() => shellRef.current?.querySelector<HTMLButtonElement>(".sidebar-launch-card, .sidebar-canvas-entry")?.focus());
  };
  const openResource = (target: SidebarResource): void => {
    setResourceTarget({ scope: project.projectId, resource: target });
    onSurfaceChange("resource");
  };
  const activeSurface = projectPending || projectError ? "home" : surface;

  return <aside id="right-sidebar" ref={shellRef} className={`workbench-sidebar${projectMode ? "" : " is-ordinary"} phase-${phase}${collapseReady ? " collapse-ready" : ""}`} style={{ width: targetWidth }} aria-hidden={!open} onTransitionEnd={finishTransition}>
    <div className="sidebar-resizer workbench-divider workbench-divider--vertical" role="separator" tabIndex={open ? 0 : -1} aria-label={t("Resize sidebar")} aria-orientation="vertical" aria-valuemin={WORKBENCH_SIDEBAR_MIN_WIDTH} aria-valuemax={maximumWidth} aria-valuenow={Math.round(targetWidth)} onPointerDown={startDrag} onDoubleClick={resetWidth} onKeyDown={resizeWithKeyboard} />
    <div className="sidebar-content">
      {activeSurface === "canvas" && <button type="button" className="sidebar-floating-back" onClick={back} aria-label={t("Back to sidebar")} title={t("Back to sidebar")}><Icon name="chevron-right" width="18" height="18" /></button>}
      <div className="sidebar-surface sidebar-home" hidden={activeSurface !== "home"}>
        {projectPending ? <p className="sidebar-empty" role="status">{t("Loading project…")}</p>
          : projectError ? <div className="sidebar-error" role="alert"><p>{projectError}</p><button type="button" onClick={onRetryProject}>{t("Try again")}</button></div>
          : projectMode && !project.projectId ? <div className="sidebar-empty"><p>{t("Add a project to start a project conversation.")}</p><button type="button" onClick={onAddProject}>{t("Add project")}</button></div>
          : project.projectId ? <div className="sidebar-launcher">
              <button type="button" className="sidebar-launch-card" onClick={() => onSurfaceChange("files")}>
                <span className="sidebar-launch-icon"><Icon name="folder" width="24" height="24" strokeWidth={2} /></span>
                <span><strong>{t("Open workspace files")}</strong></span>
              </button>
              <button type="button" className="sidebar-launch-card" onClick={() => onSurfaceChange("canvas")}>
                <span className="sidebar-launch-icon"><Icon name="line-squiggle" width="24" height="24" strokeWidth={2} /></span>
                <span><strong>{t("Open canvas")}</strong></span>
              </button>
            </div>
          : <SidebarResources attachments={attachments} files={files} onOpen={openResource} onOpenCanvas={() => onSurfaceChange("canvas")} />}
      </div>
      {directory && <div className="sidebar-surface sidebar-file-surface" hidden={activeSurface !== "files"}><ProjectFileTree key={project.projectId} directory={directory} active={open && activeSurface === "files"} onBack={back} onOpenProjectDirectory={onOpenProjectDirectory} /></div>}
      {activeSurface === "resource" && resource && <div className="sidebar-resource-surface"><button type="button" className="sidebar-floating-back" onClick={back} aria-label={t("Back to sidebar")} title={t("Back to sidebar")}><Icon name="chevron-right" width="18" height="18" /></button><SidebarResourcePreview key={resource.kind === "output" ? `${resource.file.runId}:${resource.file.fileId}` : resource.attachment.attachmentId} resource={resource} /></div>}
      <div className="sidebar-canvas" hidden={activeSurface !== "canvas"}>{canvasMounted ? canvas : null}</div>
    </div>
  </aside>;
}

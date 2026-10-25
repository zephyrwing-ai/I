import { useI18n } from "../../shared/i18n";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ProjectActionRequest, ProjectDescriptor } from "../../../../shell/shared/ipc";
import { Icon } from "../../shared/ui/Icon";
import { PROJECT_SIDEBAR_TOGGLE_ID, ProjectSidebarToggle } from "./ProjectSidebarToggle";
import { useResizableSidebar } from "../../shared/sidebar/useResizableSidebar";
import { PROJECTS_SIDEBAR_POLICY } from "./projectSidebarState";
import "./ProjectsPanel.css";

export interface ProjectsPanelProps {
  open: boolean;
  projects: ProjectDescriptor[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;
  disabled?: boolean;
  adding?: boolean;
  selectingProjectId?: string | null;
  onAdd: () => void;
  onToggle: () => void;
  onOpenChange: (open: boolean) => void;
  workspaceRef?: RefObject<HTMLElement>;
  onSelect: (projectId: string) => void;
  onAction: (request: ProjectActionRequest) => Promise<void>;
  onRetry: () => void;
}

interface ProjectMenu {
  projectId: string;
  x: number;
  y: number;
}

export function ProjectsPanel({
  open,
  projects,
  activeProjectId,
  loading,
  error,
  disabled = false,
  adding = false,
  selectingProjectId = null,
  onAdd,
  onToggle,
  onOpenChange,
  workspaceRef,
  onSelect,
  onAction,
  onRetry,
}: ProjectsPanelProps) {
  const t = useI18n();
  const entries = projects.filter((project): project is ProjectDescriptor & { projectId: string } => project.projectId !== null);
  const [menu, setMenu] = useState<ProjectMenu | null>(null);
  const [rename, setRename] = useState<{ projectId: string; name: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { shellRef, phase, effectiveWidth, targetWidth, collapseReady, maximumWidth, finishTransition, startDrag, resetWidth, resizeWithKeyboard } = useResizableSidebar({
    open, onOpenChange, side: "left", storageKey: "workbench.projectsSidebarWidth",
    policy: PROJECTS_SIDEBAR_POLICY, workspaceRef, collapseWhenNarrow: false,
  });
  const renameInputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreProjectFocusRef = useRef<string | null>(null);
  const menuProject = entries.find((project) => project.projectId === menu?.projectId);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (!open) {
      if (shell.contains(document.activeElement) || menuRef.current?.contains(document.activeElement)) {
        (document.getElementById(PROJECT_SIDEBAR_TOGGLE_ID) ?? document.getElementById("project-navigation-projects"))?.focus();
      }
      restoreProjectFocusRef.current = null;
      setMenu(null);
      setRename(null);
    }
  }, [open]);

  const closeMenu = (restoreFocus = false): void => {
    setMenu(null);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`;
    element.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const close = (): void => setMenu(null);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  useEffect(() => {
    if (disabled || (menu && !menuProject)) setMenu(null);
    if (disabled || (rename && !entries.some((project) => project.projectId === rename.projectId))) setRename(null);
  }, [disabled, projects, menu?.projectId, rename?.projectId]);

  useEffect(() => {
    if (!open || !rename) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [open, rename?.projectId]);

  useLayoutEffect(() => {
    const projectId = restoreProjectFocusRef.current;
    if (!open || rename || projectId === null) return;
    restoreProjectFocusRef.current = null;
    document.getElementById(`project-${projectId}`)?.focus();
  }, [open, rename]);

  const openMenu = (event: MouseEvent<HTMLButtonElement>, projectId: string): void => {
    event.preventDefault();
    if (disabled) return;
    triggerRef.current = event.currentTarget;
    setMenu({ projectId, x: event.clientX, y: event.clientY });
  };

  const onProjectKeyDown = (event: KeyboardEvent<HTMLButtonElement>, projectId: string): void => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    if (disabled) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    triggerRef.current = event.currentTarget;
    setMenu({ projectId, x: bounds.left + 12, y: bounds.bottom });
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      closeMenu(true);
      return;
    }
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
    else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  const performAction = (action: ProjectActionRequest["action"]): void => {
    if (!menuProject || disabled) return;
    closeMenu(true);
    if (action === "rename") setRename({ projectId: menuProject.projectId, name: menuProject.displayName });
    else void onAction({ projectId: menuProject.projectId, action });
  };

  const cancelRename = (): void => {
    restoreProjectFocusRef.current = rename?.projectId ?? null;
    setRename(null);
  };

  return (
    <aside ref={shellRef} id="projects-panel" className={`projects-panel phase-${phase}${collapseReady ? " collapse-ready" : ""}`} style={{ width: targetWidth }} aria-labelledby="projects-panel-title" aria-hidden={!open} onTransitionEnd={finishTransition}>
      <div className="projects-resizer workbench-divider workbench-divider--vertical" role="separator" tabIndex={open ? 0 : -1} aria-label={t("Resize projects sidebar")} aria-orientation="vertical" aria-valuemin={PROJECTS_SIDEBAR_POLICY.minimumWidth} aria-valuemax={maximumWidth} aria-valuenow={Math.round(targetWidth)} onPointerDown={startDrag} onDoubleClick={resetWidth} onKeyDown={resizeWithKeyboard} />
      <div className="projects-panel-body" style={{ width: phase === "dragging" ? targetWidth : effectiveWidth }}>
        <header className="projects-panel-header">
          <h2 id="projects-panel-title">{t("Projects")}</h2>
          <div className="projects-panel-actions">
            <button
              type="button"
              className="projects-panel-add"
              onClick={onAdd}
              disabled={disabled || adding}
              aria-label={t("Add project")}
              aria-busy={adding || undefined}
              title={t("Add project")}
            >
              <Icon name="plus" width="18" height="18" />
            </button>
            {open && <ProjectSidebarToggle open onToggle={onToggle} />}
          </div>
        </header>
        <div className="projects-panel-content" aria-busy={loading || undefined} onScroll={() => setMenu(null)}>
          {loading && <p className="projects-panel-status" role="status">{t("Loading projects…")}</p>}
          {error && (
            <div className="projects-panel-error" role="alert">
              <p>{error}</p>
              <button type="button" onClick={onRetry} disabled={disabled || loading}>{t("Try again")}</button>
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <p className="projects-panel-empty">{t("Add a project to start a project conversation.")}</p>
          )}
          {entries.length > 0 && (
            <ul className="projects-panel-list" aria-label={t("Projects")}>
              {entries.map((project) => (
                <li key={project.projectId}>
                  {rename?.projectId === project.projectId ? (
                    <form className="projects-panel-rename" onSubmit={(event) => {
                      event.preventDefault();
                      const name = rename.name.trim();
                      if (!name || disabled) return;
                      restoreProjectFocusRef.current = project.projectId;
                      setRename(null);
                      if (name !== project.displayName) void onAction({ projectId: project.projectId, action: "rename", name });
                    }}>
                      <input
                        ref={renameInputRef}
                        aria-label={t("Session name")}
                        value={rename.name}
                        maxLength={200}
                        disabled={disabled}
                        onChange={(event) => setRename({ projectId: project.projectId, name: event.target.value })}
                        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelRename(); } }}
                      />
                      <button type="submit" aria-label={t("Save session name")} disabled={disabled || !rename.name.trim()}><Icon name="check" width="16" height="16" /></button>
                      <button type="button" aria-label={t("Cancel rename")} onClick={cancelRename} disabled={disabled}><Icon name="close" width="16" height="16" /></button>
                    </form>
                  ) : <button
                    type="button"
                    className="projects-panel-item"
                    id={`project-${project.projectId}`}
                    data-project-id={project.projectId}
                    aria-current={project.projectId === activeProjectId ? "page" : undefined}
                    aria-busy={project.projectId === selectingProjectId || undefined}
                    title={project.canonicalPath ?? project.displayName}
                    disabled={disabled}
                    onClick={() => onSelect(project.projectId)}
                    onContextMenu={(event) => openMenu(event, project.projectId)}
                    onKeyDown={(event) => onProjectKeyDown(event, project.projectId)}
                    aria-haspopup="menu"
                    aria-expanded={menu?.projectId === project.projectId || undefined}
                  >
                    <span>{project.displayName}</span>
                    {project.pinned && <Icon name="pin" className="projects-panel-pinned" width="13" height="13" />}
                  </button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {menu && menuProject && createPortal(
        <div
          ref={menuRef}
          className="projects-panel-menu"
          role="menu"
          aria-label={t("Actions for {name}", { name: menuProject.displayName })}
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={onMenuKeyDown}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" disabled={disabled} onClick={() => performAction(menuProject.pinned ? "unpin" : "pin")}><Icon name="pin" /><span>{t(menuProject.pinned ? "Unpin" : "Pin")}</span></button>
          <button type="button" role="menuitem" disabled={disabled} onClick={() => performAction("reveal")}><Icon name="folder" /><span>{t("Reveal in Finder")}</span></button>
          <button type="button" role="menuitem" disabled={disabled} onClick={() => performAction("rename")}><Icon name="edit" /><span>{t("Rename session")}</span></button>
          <button type="button" role="menuitem" disabled={disabled} className="is-destructive" onClick={() => performAction("delete")}><Icon name="trash" /><span>{t("Delete session")}</span></button>
        </div>, document.body,
      )}
    </aside>
  );
}

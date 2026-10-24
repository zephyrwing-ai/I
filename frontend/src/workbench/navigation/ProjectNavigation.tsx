import { useI18n } from "../../shared/i18n";
import { Icon } from "../../shared/ui/Icon";
import { AppMark } from "./AppMark";
import "./ProjectNavigation.css";
import type { RefObject } from "react";

export interface ProjectNavigationProps {
  selected: "ordinary" | "projects";
  projectsOpen: boolean;
  settingsOpen: boolean;
  settingsButtonRef: RefObject<HTMLButtonElement>;
  disabled?: boolean;
  onOrdinary: () => void;
  onProjects: () => void;
  onSettings: () => void;
}

export function ProjectNavigation({
  selected,
  projectsOpen,
  settingsOpen,
  settingsButtonRef,
  disabled = false,
  onOrdinary,
  onProjects,
  onSettings,
}: ProjectNavigationProps) {
  const t = useI18n();
  return (
    <nav className="project-navigation" aria-label={t("Workspace navigation")}>
      <button
        type="button"
        className="project-navigation-item"
        aria-label="I"
        aria-current={selected === "ordinary" ? "page" : undefined}
        title="I"
        disabled={disabled}
        onClick={onOrdinary}
      >
        <AppMark className="project-navigation-brand" />
        <span>I</span>
      </button>
      <button
        type="button"
        className="project-navigation-item"
        id="project-navigation-projects"
        aria-label={t("Project")}
        aria-current={selected === "projects" ? "page" : undefined}
        aria-expanded={projectsOpen}
        aria-controls="projects-panel"
        title={t("Project")}
        onClick={onProjects}
      >
        <Icon name="folder" width="22" height="22" />
        <span>{t("Project")}</span>
      </button>
      <button
        ref={settingsButtonRef}
        type="button"
        className={`project-navigation-item project-navigation-settings${settingsOpen ? " active" : ""}`}
        aria-label={t("Settings")}
        aria-expanded={settingsOpen}
        title={t("Settings")}
        onClick={onSettings}
      >
        <Icon name="settings" width="22" height="22" strokeWidth={2} />
      </button>
    </nav>
  );
}

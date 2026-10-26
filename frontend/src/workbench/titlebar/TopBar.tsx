import { useI18n } from "../../shared/i18n";
import type { RefObject } from "react";
import { Icon } from "../../shared/ui/Icon";
import { ProjectSidebarToggle } from "../project/ProjectSidebarToggle";
import applicationMetadata from "../../../../package.json";

interface TopBarProps {
  projectMode: boolean;
  projectsOpen: boolean;
  sidebarOpen: boolean;
  searchOpen: boolean;
  searchButtonRef: RefObject<HTMLButtonElement>;
  onProjects: () => void;
  onSidebar: () => void;
  onSearch: () => void;
}

export function TopBar({ projectMode, projectsOpen, sidebarOpen, searchOpen, searchButtonRef, onProjects, onSidebar, onSearch }: TopBarProps) {
  const t = useI18n();
  return (
    <header className={`topbar${projectMode ? " is-project-mode workbench-divider workbench-divider--horizontal" : ""}`}>
      <h1 className="sr-only">{applicationMetadata.productName}</h1>
      {projectMode && !projectsOpen && <ProjectSidebarToggle open={false} onToggle={onProjects} className="topbar-projects-toggle" />}
      <div className="topbar-actions">
        <button id="workbench-sidebar-toggle" className={`icon-button ${sidebarOpen ? "active" : ""}`} onClick={onSidebar} title={t(sidebarOpen ? "Hide sidebar" : "Show sidebar")} aria-label={t(sidebarOpen ? "Hide sidebar" : "Show sidebar")} aria-expanded={sidebarOpen} aria-controls="right-sidebar">
          <Icon name={sidebarOpen ? "sidebar" : "sidebar-collapsed"} width="18" height="18" strokeWidth={2} />
        </button>
        <button ref={searchButtonRef} className={`icon-button ${searchOpen ? "active" : ""}`} onClick={onSearch} title={t("Search all content")} aria-label={t("Search all content")} aria-expanded={searchOpen} aria-controls="search-popover">
          <Icon name="search" width="18" height="18" strokeWidth={2} />
        </button>
      </div>
    </header>
  );
}


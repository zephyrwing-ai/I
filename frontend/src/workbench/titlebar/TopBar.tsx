import { useI18n } from "../../shared/i18n";
import type { RefObject } from "react";
import { Icon } from "../../shared/ui/Icon";
import { ProjectSidebarToggle } from "../project/ProjectSidebarToggle";
import applicationMetadata from "../../../../package.json";

interface TopBarProps {
  projectMode: boolean;
  projectsOpen: boolean;
  outputOpen: boolean;
  outputCount: number;
  canvasOpen?: boolean;
  searchOpen: boolean;
  searchButtonRef: RefObject<HTMLButtonElement>;
  onProjects: () => void;
  onOutput: () => void;
  onCanvas?: () => void;
  onSearch: () => void;
}

export function TopBar({ projectMode, projectsOpen, outputOpen, outputCount, canvasOpen = false, searchOpen, searchButtonRef, onProjects, onOutput, onCanvas = () => undefined, onSearch }: TopBarProps) {
  const t = useI18n();
  return (
    <header className={`topbar${projectMode ? " is-project-mode" : ""}`}>
      <h1 className="sr-only">{applicationMetadata.productName}</h1>
      {projectMode && !projectsOpen && <ProjectSidebarToggle open={false} onToggle={onProjects} className="topbar-projects-toggle" />}
      <div className="topbar-actions">
        <button className={`icon-button ${outputOpen ? "active" : ""}`} onClick={onOutput} title={t(outputOpen ? "Hide output files" : "Show output files")} aria-label={t(outputOpen ? "Hide output files" : "Show output files")} aria-expanded={outputOpen} aria-controls="right-sidebar">
          <Icon name={outputOpen ? "sidebar" : "sidebar-collapsed"} width="18" height="18" strokeWidth={2} />
          {!outputOpen && !canvasOpen && outputCount > 0 && <span className="icon-badge">{outputCount > 9 ? "9+" : outputCount}</span>}
        </button>
        <button className={`icon-button ${canvasOpen ? "active" : ""}`} onClick={onCanvas} title={t(canvasOpen ? "Hide canvas" : "Show canvas")} aria-label={t(canvasOpen ? "Hide canvas" : "Show canvas")} aria-expanded={canvasOpen} aria-controls="right-sidebar">
          <Icon name="line-squiggle" width="18" height="18" strokeWidth={2} />
        </button>
        <button ref={searchButtonRef} className={`icon-button ${searchOpen ? "active" : ""}`} onClick={onSearch} title={t("Search all content")} aria-label={t("Search all content")} aria-expanded={searchOpen} aria-controls="search-popover">
          <Icon name="search" width="18" height="18" strokeWidth={2} />
        </button>
      </div>
    </header>
  );
}


import { useI18n } from "../../shared/i18n";
import type { MouseEvent } from "react";
import { Icon } from "../../shared/ui/Icon";

export const PROJECT_SIDEBAR_TOGGLE_ID = "projects-sidebar-toggle";

interface ProjectSidebarToggleProps {
  open: boolean;
  onToggle: () => void;
  className?: string;
}

/** One control moves between the project header and the frame toolbar. */
export function ProjectSidebarToggle({ open, onToggle, className = "" }: ProjectSidebarToggleProps) {
  const t = useI18n();
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    const trigger = event.currentTarget;
    const transferFocus = document.activeElement === trigger;
    onToggle();
    if (transferFocus) {
      requestAnimationFrame(() => {
        if (document.activeElement === document.body || document.activeElement === trigger) {
          document.getElementById(PROJECT_SIDEBAR_TOGGLE_ID)?.focus();
        }
      });
    }
  };

  return (
    <button
      id={PROJECT_SIDEBAR_TOGGLE_ID}
      type="button"
      className={`icon-button project-sidebar-toggle${open ? " active" : ""}${className ? ` ${className}` : ""}`}
      onClick={handleClick}
      title={t(open ? "Hide projects" : "Show projects")}
      aria-label={t(open ? "Hide projects" : "Show projects")}
      aria-expanded={open}
      aria-controls="projects-panel"
    >
      <Icon name={open ? "sidebar" : "sidebar-collapsed"} width="18" height="18" strokeWidth={2} style={{ transform: "scaleX(-1)" }} />
    </button>
  );
}

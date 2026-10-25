import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { ProjectDirectoryEntry } from "../../../../shell/shared/ipc";
import { useI18n } from "../../shared/i18n";
import { Icon } from "../../shared/ui/Icon";
import type { ProjectDirectory, ProjectDirectoryState } from "./projectDirectory";

interface TreeRow { entry: ProjectDirectoryEntry; level: number }

function visibleRows(state: ProjectDirectoryState, path = "", level = 1): TreeRow[] {
  const query = state.filter.trim().toLocaleLowerCase();
  return (state.directories[path]?.entries ?? []).flatMap((entry): TreeRow[] => {
    const children = entry.kind === "directory" && (query || state.expanded.has(entry.relativePath))
      ? visibleRows(state, entry.relativePath, level + 1) : [];
    if (query && !entry.name.toLocaleLowerCase().includes(query) && children.length === 0) return [];
    return [{ entry, level }, ...children];
  });
}

export function ProjectFileTree({ directory, active, onBack, onOpenProjectDirectory }: {
  directory: ProjectDirectory;
  active: boolean;
  onBack: () => void;
  onOpenProjectDirectory: () => Promise<string | null>;
}) {
  const t = useI18n();
  const state = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
  const treeRef = useRef<HTMLDivElement>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const root = state.directories[""];
  const rows = visibleRows(state);
  const selectedVisible = rows.some(({ entry }) => entry.relativePath === state.selectedPath);
  useEffect(() => {
    if (!active) return;
    if (!root) void directory.load("");
    for (const path of state.expanded) {
      if (!state.directories[path]) void directory.load(path);
    }
  }, [active, directory, root, state.expanded, state.directories]);

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, row: TreeRow, index: number): void => {
    let targetIndex: number | undefined;
    if (event.key === "ArrowDown") targetIndex = Math.min(rows.length - 1, index + 1);
    if (event.key === "ArrowUp") targetIndex = Math.max(0, index - 1);
    if (event.key === "Home") targetIndex = 0;
    if (event.key === "End") targetIndex = rows.length - 1;
    if (targetIndex !== undefined) {
      event.preventDefault();
      treeRef.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')[targetIndex]?.focus();
    } else if (event.key === "ArrowRight" && row.entry.kind === "directory" && !state.expanded.has(row.entry.relativePath)) {
      event.preventDefault(); directory.toggle(row.entry.relativePath);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.entry.kind === "directory" && state.expanded.has(row.entry.relativePath)) directory.toggle(row.entry.relativePath);
      else {
        const parent = row.entry.relativePath.split("/").slice(0, -1).join("/");
        const parentIndex = rows.findIndex(({ entry }) => entry.relativePath === parent);
        if (parentIndex >= 0) treeRef.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')[parentIndex]?.focus();
      }
    }
  };
  const pageStatus = (path: string, level: number) => {
    const page = state.directories[path];
    return <div className="sidebar-directory-status" style={{ paddingLeft: 12 + (level - 1) * 16 }}>
      {page?.loading && <span role="status">{t("Loading files…")}</span>}
      {page?.error && <div role="alert"><span>{page.error}</span><button type="button" onClick={() => void directory.load(path)}>{t("Try again")}</button></div>}
      {page && !page.loading && !page.error && page.entries.length === 0 && <span>{t("Empty folder")}</span>}
      {page?.nextCursor && !page.loading && !page.error && <button type="button" onClick={() => void directory.load(path, true)}>{t("Load more files")}</button>}
    </div>;
  };

  return <div className="sidebar-files">
    <button type="button" className="sidebar-floating-back" onClick={onBack} aria-label={t("Back to sidebar")} title={t("Back to sidebar")}><Icon name="chevron-right" width="18" height="18" /></button>
    <div className="sidebar-file-toolbar">
      <input type="search" value={state.filter} placeholder={t("Filter files")} aria-label={t("Filter loaded files")} onChange={(event) => directory.filter(event.target.value)} />
      <button type="button" onClick={directory.refresh} aria-label={t("Refresh files")} title={t("Refresh files")}><Icon name="refresh" width="16" height="16" /></button>
      <button type="button" onClick={() => void onOpenProjectDirectory().then(setOpenError)} aria-label={t("Open project folder")} title={t("Open project folder")}><Icon name="external" width="16" height="16" /></button>
    </div>
    {openError && <p className="sidebar-error" role="alert">{openError}</p>}
    <div ref={treeRef} className="sidebar-file-tree" role="tree" aria-label={t("Workspace files")}>
      {rows.map((row, index) => <div key={row.entry.relativePath} role="none">
        <button type="button" role="treeitem" aria-level={row.level} aria-selected={state.selectedPath === row.entry.relativePath} aria-expanded={row.entry.kind === "directory" ? Boolean(state.filter || state.expanded.has(row.entry.relativePath)) : undefined}
          tabIndex={state.selectedPath === row.entry.relativePath || (!selectedVisible && index === 0) ? 0 : -1}
          className={`sidebar-file-row${state.selectedPath === row.entry.relativePath ? " is-selected" : ""}`}
          style={{ paddingLeft: 8 + (row.level - 1) * 16 }} title={row.entry.kind === "symlink" ? t("Symbolic link") : row.entry.relativePath}
          onKeyDown={(event) => keyDown(event, row, index)}
          onClick={() => row.entry.kind === "directory" ? directory.toggle(row.entry.relativePath) : directory.select(row.entry.relativePath)}>
          <span className={`sidebar-tree-chevron${state.expanded.has(row.entry.relativePath) ? " is-open" : ""}`}>{row.entry.kind === "directory" && <Icon name="chevron-right" width="14" height="14" />}</span>
          <Icon name={row.entry.kind === "directory" ? "folder" : row.entry.kind === "symlink" ? "external" : "book-open"} width="16" height="16" />
          <span>{row.entry.name}</span>
        </button>
        {row.entry.kind === "directory" && state.expanded.has(row.entry.relativePath) && pageStatus(row.entry.relativePath, row.level + 1)}
      </div>)}
      {pageStatus("", 1)}
      {state.filter && root && !root.loading && rows.length === 0 && <p className="sidebar-empty">{t("No matching files")}</p>}
    </div>
    {state.selectedPath && <footer className="sidebar-selected-file" title={state.selectedPath}>{state.selectedPath}</footer>}
  </div>;
}

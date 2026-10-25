import type { AgentAPI, ProjectDirectoryEntry } from "../../../../shell/shared/ipc";

interface DirectoryPage {
  entries: ProjectDirectoryEntry[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

export interface ProjectDirectoryState {
  directories: Record<string, DirectoryPage>;
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  filter: string;
}

/** Each project owns its cache and in-flight requests, independently of the active pane. */
export function createProjectDirectory(projectId: string, api: Pick<AgentAPI, "listProjectDirectory">) {
  let state: ProjectDirectoryState = { directories: {}, expanded: new Set(), selectedPath: null, filter: "" };
  const listeners = new Set<() => void>();
  const requests = new Map<string, number>();
  let version = 0;
  let disposed = false;
  const publish = (next: ProjectDirectoryState): void => {
    if (disposed) return;
    state = next;
    listeners.forEach((listener) => listener());
  };
  const load = async (path: string, more = false): Promise<void> => {
    if (disposed) return;
    const previous = state.directories[path];
    if (previous?.loading || (more && !previous?.nextCursor)) return;
    const request = ++version;
    requests.set(path, request);
    const page: DirectoryPage = previous ?? { entries: [], nextCursor: null, loading: false, error: null };
    publish({ ...state, directories: { ...state.directories, [path]: { ...page, loading: true, error: null } } });
    try {
      const result = await api.listProjectDirectory({ projectId, relativePath: path, ...(more ? { cursor: page.nextCursor! } : {}) });
      if (disposed || requests.get(path) !== request) return;
      if (!result.ok) throw new Error(result.message);
      if (result.projectId !== projectId || result.relativePath !== path) throw new Error("The directory response belongs to another location.");
      const byPath = new Map((more ? page.entries : []).map((entry) => [entry.relativePath, entry]));
      result.entries.forEach((entry) => byPath.set(entry.relativePath, entry));
      publish({ ...state, directories: { ...state.directories, [path]: {
        entries: [...byPath.values()], nextCursor: result.nextCursor, loading: false, error: null,
      } } });
    } catch (error) {
      if (disposed || requests.get(path) !== request) return;
      publish({ ...state, directories: { ...state.directories, [path]: {
        ...page, loading: false, error: error instanceof Error ? error.message : "Failed to load this directory.",
      } } });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load,
    toggle: (path: string): void => {
      const expanded = new Set(state.expanded);
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      publish({ ...state, expanded, selectedPath: path });
      if (expanded.has(path) && !state.directories[path]) void load(path);
    },
    select: (path: string) => publish({ ...state, selectedPath: path }),
    filter: (filter: string) => publish({ ...state, filter }),
    refresh: (): void => {
      requests.clear();
      publish({ ...state, directories: {} });
      void load("");
    },
    dispose: (): void => { disposed = true; requests.clear(); listeners.clear(); },
  };
}

export type ProjectDirectory = ReturnType<typeof createProjectDirectory>;

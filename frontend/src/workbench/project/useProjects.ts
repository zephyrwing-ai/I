import { useCallback, useRef, useState } from "react";
import type { ProjectDescriptor } from "../../../../shell/shared/ipc";

interface ProjectListState {
  projects: ProjectDescriptor[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

/** One renderer snapshot, refreshed after changes to the persisted project list. */
export function useProjects() {
  const [state, setState] = useState<ProjectListState>({ projects: [], loaded: false, loading: false, error: null });
  const loaded = useRef(false);
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  const read = useCallback((refresh: boolean): Promise<void> => {
    if (!refresh && inFlight.current) return inFlight.current;
    if (!refresh && loaded.current) return Promise.resolve();
    const requestGeneration = ++generation.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    const operation = Promise.resolve().then(async () => {
      try {
        const projects = await window.agentAPI.listProjects();
        if (generation.current !== requestGeneration) return;
        loaded.current = true;
        setState({ projects, loaded: true, loading: false, error: null });
      } catch (error) {
        if (generation.current !== requestGeneration) return;
        setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (generation.current === requestGeneration) inFlight.current = null;
      }
    });
    inFlight.current = operation;
    return operation;
  }, []);

  const replace = useCallback((projects: ProjectDescriptor[]): void => {
    generation.current += 1;
    inFlight.current = null;
    loaded.current = true;
    setState({ projects, loaded: true, loading: false, error: null });
  }, []);

  const ensureLoaded = useCallback(() => read(false), [read]);
  const refresh = useCallback(() => read(true), [read]);
  return { ...state, ensureLoaded, refresh, replace };
}

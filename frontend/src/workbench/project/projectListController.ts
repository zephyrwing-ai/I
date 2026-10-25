import type { AgentAPI, ProjectDescriptor } from "../../../../shell/shared/ipc";

export interface ProjectListState {
  projects: ProjectDescriptor[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

export const initialProjectListState: ProjectListState = {
  projects: [], loaded: false, loading: false, error: null,
};

/** Owns the committed list and request lifetime independently of React renders. */
export function createProjectListController(
  api: Pick<AgentAPI, "listProjects">,
  publish: (state: ProjectListState) => void,
) {
  let state = initialProjectListState;
  let generation = 0;
  let inFlight: Promise<ProjectDescriptor[] | null> | null = null;

  const commit = (next: ProjectListState): void => {
    state = next;
    publish(next);
  };

  const read = (refresh: boolean): Promise<ProjectDescriptor[] | null> => {
    if (!refresh && inFlight) return inFlight;
    if (!refresh && state.loaded) return Promise.resolve(state.projects);
    const requestGeneration = ++generation;
    commit({ ...state, loading: true, error: null });
    const operation = Promise.resolve().then(async () => {
      try {
        const projects = await api.listProjects();
        if (generation !== requestGeneration) return null;
        commit({ projects, loaded: true, loading: false, error: null });
        return projects;
      } catch (error) {
        if (generation !== requestGeneration) return null;
        commit({ ...state, loading: false, error: error instanceof Error ? error.message : String(error) });
        return null;
      } finally {
        if (generation === requestGeneration) inFlight = null;
      }
    });
    inFlight = operation;
    return operation;
  };

  const replace = (projects: ProjectDescriptor[]): void => {
    generation += 1;
    inFlight = null;
    commit({ projects, loaded: true, loading: false, error: null });
  };

  return {
    ensureLoaded: (): Promise<ProjectDescriptor[] | null> => read(false),
    refresh: (): Promise<ProjectDescriptor[] | null> => read(true),
    replace,
  };
}

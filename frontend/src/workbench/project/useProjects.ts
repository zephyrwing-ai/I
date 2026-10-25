import { useState } from "react";
import { createProjectListController, initialProjectListState } from "./projectListController";

/** Awaited reads return the committed list in API order, or null on failure/supersession. */
export function useProjects() {
  const [state, setState] = useState(initialProjectListState);
  const [controller] = useState(() => createProjectListController({
    listProjects: () => window.agentAPI.listProjects(),
  }, setState));
  return { ...state, ...controller };
}

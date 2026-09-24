import { useCallback, useEffect, useRef } from "react";
import type { HistoryPageResult } from "../../../shell/shared/ipc";
import type { AgentAction, AgentState } from "../store/agentReducer";

interface InFlightHistoryPage {
  generation: number;
  promise: Promise<void>;
}

export function useSessionHistory(
  state: AgentState,
  dispatch: (action: AgentAction) => void,
): {
  hydrated: boolean;
  loadingInitial: boolean;
  loadingOlder: boolean;
  loadingSearch: boolean;
  hasMore: boolean;
  error: string | null;
  loadOlder: () => Promise<void>;
  loadSearch: () => Promise<void>;
  reload: (projectId: string | null) => Promise<void>;
} {
  const requestGeneration = useRef(state.history.requestGeneration);
  const olderPageInFlight = useRef<InFlightHistoryPage | null>(null);

  const reload = useCallback(async (projectId: string | null): Promise<void> => {
    const generation = ++requestGeneration.current;
    olderPageInFlight.current = null;
    dispatch({ type: "historyScopeLoadStarted", projectId, generation });
    try {
      const page = await window.agentAPI.loadHistoryPage({ cursor: null, limit: 100 });
      if (page.projectId !== projectId) {
        throw new Error("The active project changed while history was loading. Choose the project again.");
      }
      dispatch({ type: "historyHydrated", page, generation });
    } catch (error) {
      dispatch({
        type: "historyLoadFailed",
        scope: "initial",
        generation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [dispatch]);

  const loadOlderPage = useCallback(async (scope: "older" | "search"): Promise<void> => {
    const history = state.history;
    if (!history.hydrated || history.loadingOlder || history.loadingSearch || !history.hasMore || !history.nextCursor) return;
    const generation = history.requestGeneration;
    const inFlight = olderPageInFlight.current;
    if (inFlight?.generation === generation) return inFlight.promise;

    const cursor = history.nextCursor;
    dispatch({ type: "historyLoadStarted", scope, generation });
    const operation = (async (): Promise<void> => {
      try {
        const page: HistoryPageResult = await window.agentAPI.loadHistoryPage({ cursor, limit: 100 });
        if (page.projectId !== history.projectId) {
          throw new Error("The active project changed while history was loading. Choose the project again.");
        }
        dispatch({ type: "olderHistoryLoaded", page, generation });
      } catch (error) {
        dispatch({
          type: "historyLoadFailed",
          scope,
          generation,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    const current = { generation, promise: operation };
    olderPageInFlight.current = current;
    void operation.then(() => {
      if (olderPageInFlight.current === current) olderPageInFlight.current = null;
    });
    return operation;
  }, [dispatch, state.history]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (!state.history.hydrated) {
      if (!state.history.loadingInitial) await reload(state.history.projectId);
      return;
    }
    await loadOlderPage("older");
  }, [loadOlderPage, reload, state.history]);

  const loadSearch = useCallback(async (): Promise<void> => {
    await loadOlderPage("search");
  }, [loadOlderPage]);

  useEffect(() => {
    void reload(null);
  }, [reload]);

  return {
    hydrated: state.history.hydrated,
    loadingInitial: state.history.loadingInitial,
    loadingOlder: state.history.loadingOlder,
    loadingSearch: state.history.loadingSearch,
    hasMore: state.history.hasMore,
    error: state.history.error,
    loadOlder,
    loadSearch,
    reload,
  };
}

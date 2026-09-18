import { useCallback, useEffect, useRef } from "react";
import type { SessionPageResult } from "../../../shell/shared/ipc";
import type { AgentAction, AgentState } from "../store/agentReducer";

export function useSessionHistory(
  state: AgentState,
  dispatch: (action: AgentAction) => void,
): {
  hydrated: boolean;
  loadingOlder: boolean;
  loadingSearch: boolean;
  hasMore: boolean;
  error: string | null;
  loadOlder: () => Promise<void>;
  loadSearch: () => Promise<void>;
} {
  const olderPageInFlight = useRef<Promise<void> | null>(null);

  const loadInitial = useCallback(async (): Promise<void> => {
    dispatch({ type: "historyLoadStarted", scope: "initial" });
    try {
      const page = await window.agentAPI.loadSessionPage({ cursor: null, limit: 100 });
      dispatch({ type: "sessionHydrated", page });
    } catch (error) {
      dispatch({ type: "historyLoadFailed", scope: "initial", error: error instanceof Error ? error.message : String(error) });
    }
  }, [dispatch]);

  const loadOlderPage = useCallback(async (scope: "older" | "search"): Promise<void> => {
    if (olderPageInFlight.current) return olderPageInFlight.current;
    const history = state.history;
    if (!history.hydrated || history.loadingOlder || history.loadingSearch || !history.hasMore || !history.nextCursor) return;
    const cursor = history.nextCursor;
    const operation = (async (): Promise<void> => {
      dispatch({ type: "historyLoadStarted", scope });
      try {
        const page: SessionPageResult = await window.agentAPI.loadSessionPage({ cursor, limit: 100 });
        dispatch({ type: "olderHistoryLoaded", page });
      } catch (error) {
        dispatch({ type: "historyLoadFailed", scope, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    olderPageInFlight.current = operation;
    void operation.then(() => {
      if (olderPageInFlight.current === operation) olderPageInFlight.current = null;
    });
    return operation;
  }, [dispatch, state.history]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (!state.history.hydrated) {
      if (!state.history.loadingInitial) await loadInitial();
      return;
    }
    await loadOlderPage("older");
  }, [loadInitial, loadOlderPage, state.history.hydrated, state.history.loadingInitial]);

  const loadSearch = useCallback(async (): Promise<void> => {
    await loadOlderPage("search");
  }, [loadOlderPage]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  return {
    hydrated: state.history.hydrated,
    loadingOlder: state.history.loadingOlder,
    loadingSearch: state.history.loadingSearch,
    hasMore: state.history.hasMore,
    error: state.history.error,
    loadOlder,
    loadSearch,
  };
}

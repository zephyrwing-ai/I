import { useCallback, useEffect } from "react";
import type { SessionPageResult } from "../../../shell/shared/ipc";
import type { AgentAction, AgentState } from "../store/agentReducer";

export function useSessionHistory(
  state: AgentState,
  dispatch: (action: AgentAction) => void,
): { hydrated: boolean; loadingOlder: boolean; hasMore: boolean; error: string | null; loadOlder: () => Promise<void> } {
  const loadInitial = useCallback(async (): Promise<void> => {
    dispatch({ type: "historyLoadStarted", scope: "initial" });
    try {
      const page = await window.agentAPI.loadSessionPage({ cursor: null, limit: 100 });
      dispatch({ type: "sessionHydrated", page });
    } catch (error) {
      dispatch({ type: "historyLoadFailed", scope: "initial", error: error instanceof Error ? error.message : String(error) });
    }
  }, [dispatch]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const history = state.history;
    if (!history.hydrated) {
      if (!history.loadingInitial) await loadInitial();
      return;
    }
    if (!history.hydrated || history.loadingOlder || !history.hasMore || !history.nextCursor) return;
    dispatch({ type: "historyLoadStarted", scope: "older" });
    try {
      const page: SessionPageResult = await window.agentAPI.loadSessionPage({ cursor: history.nextCursor, limit: 100 });
      dispatch({ type: "olderHistoryLoaded", page });
    } catch (error) {
      dispatch({ type: "historyLoadFailed", scope: "older", error: error instanceof Error ? error.message : String(error) });
    }
  }, [dispatch, loadInitial, state.history]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  return {
    hydrated: state.history.hydrated,
    loadingOlder: state.history.loadingOlder,
    hasMore: state.history.hasMore,
    error: state.history.error,
    loadOlder,
  };
}

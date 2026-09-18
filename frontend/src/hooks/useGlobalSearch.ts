import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentState } from "../store/agentReducer";
import { buildSearchIndex, searchMessageBlocks, type SearchResult } from "../store/search";

const SEARCH_HISTORY_DEBOUNCE_MS = 120;

export interface GlobalSearchState {
  query: string;
  results: SearchResult[];
  activeBlockId: string | null;
  selectionVersion: number;
  loadingHistory: boolean;
  hydrated: boolean;
  hasMoreHistory: boolean;
  error: string | null;
  setQuery: (query: string) => void;
  selectResult: (result: SearchResult) => void;
  clear: () => void;
  retryHistory: () => Promise<void>;
}

export function useGlobalSearch(
  state: AgentState,
  loadSearchPage: () => Promise<void>,
): GlobalSearchState {
  const [query, setQueryState] = useState("");
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const searchableBlocks = useMemo(
    () => buildSearchIndex(state),
    [state.runOrder, state.runs],
  );
  const results = useMemo(
    () => searchMessageBlocks(searchableBlocks, query),
    [query, searchableBlocks],
  );

  const setQuery = useCallback((nextQuery: string): void => {
    setQueryState(nextQuery);
    setActiveBlockId(null);
  }, []);

  const selectResult = useCallback((result: SearchResult): void => {
    setActiveBlockId(result.blockId);
    setSelectionVersion((value) => value + 1);
  }, []);

  const clear = useCallback((): void => {
    setQueryState("");
    setActiveBlockId(null);
  }, []);

  useEffect(() => {
    if (activeBlockId && !results.some((result) => result.blockId === activeBlockId)) {
      setActiveBlockId(null);
    }
  }, [activeBlockId, results]);

  useEffect(() => {
    if (!query.trim() || !state.history.hydrated || !state.history.hasMore || state.history.loadingSearch) return;
    const timer = window.setTimeout(() => {
      void loadSearchPage();
    }, SEARCH_HISTORY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [loadSearchPage, query, state.history.hasMore, state.history.hydrated, state.history.loadingSearch, state.history.nextCursor]);

  return {
    query,
    results,
    activeBlockId,
    selectionVersion,
    loadingHistory: state.history.loadingSearch,
    hydrated: state.history.hydrated,
    hasMoreHistory: state.history.hasMore,
    error: state.history.error,
    setQuery,
    selectResult,
    clear,
    retryHistory: loadSearchPage,
  };
}

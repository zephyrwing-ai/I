import type { HistoryPageEntry, HistoryPageResult } from "../../../shell/shared/ipc";

export interface HistoryState {
  projectId: string | null;
  entriesById: Record<string, HistoryPageEntry>;
  entryOrder: string[];
  nextCursor: string | null;
  hasMore: boolean;
  snapshotOrder: number;
  requestGeneration: number;
  hydrationVersion: number;
  loadingInitial: boolean;
  loadingOlder: boolean;
  loadingSearch: boolean;
  hydrated: boolean;
  error: string | null;
}

export const initialHistoryState: HistoryState = {
  projectId: null,
  entriesById: {},
  entryOrder: [],
  nextCursor: null,
  hasMore: false,
  snapshotOrder: 0,
  requestGeneration: 0,
  hydrationVersion: 0,
  loadingInitial: true,
  loadingOlder: false,
  loadingSearch: false,
  hydrated: false,
  error: null,
};

export function mergeHistoryEntries(
  state: HistoryState,
  entries: HistoryPageEntry[],
  page: HistoryPageResult,
): HistoryState {
  const sameScope = state.projectId === page.projectId;
  const entriesById = sameScope ? { ...state.entriesById } : {};
  for (const entry of entries) {
    const previous = entriesById[entry.entryId];
    if (!previous || entry.revision >= previous.revision) entriesById[entry.entryId] = entry;
  }
  const entryOrder = Object.values(entriesById)
    .sort((left, right) => left.entryOrder - right.entryOrder)
    .map((entry) => entry.entryId);
  return {
    ...state,
    projectId: page.projectId,
    entriesById,
    entryOrder,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    snapshotOrder: sameScope ? Math.max(state.snapshotOrder, page.snapshotOrder) : page.snapshotOrder,
    loadingInitial: false,
    loadingOlder: false,
    loadingSearch: false,
    hydrated: true,
    error: null,
  };
}

import type { SessionHistoryEntry } from "../../../shell/shared/ipc";

export interface SessionHistoryState {
  sessionId: string | null;
  entriesById: Record<string, SessionHistoryEntry>;
  entryOrder: string[];
  nextCursor: string | null;
  hasMore: boolean;
  snapshotSeq: number;
  loadingInitial: boolean;
  loadingOlder: boolean;
  hydrated: boolean;
  error: string | null;
}

export const initialSessionHistoryState: SessionHistoryState = {
  sessionId: null,
  entriesById: {},
  entryOrder: [],
  nextCursor: null,
  hasMore: false,
  snapshotSeq: 0,
  loadingInitial: true,
  loadingOlder: false,
  hydrated: false,
  error: null,
};

export function mergeHistoryEntries(
  state: SessionHistoryState,
  entries: SessionHistoryEntry[],
  page: { sessionId: string; nextCursor: string | null; hasMore: boolean; snapshotSeq: number },
): SessionHistoryState {
  const entriesById = { ...state.entriesById };
  for (const entry of entries) {
    const previous = entriesById[entry.entryId];
    if (!previous || entry.revision >= previous.revision) entriesById[entry.entryId] = entry;
  }
  const entryOrder = Object.values(entriesById)
    .sort((left, right) => left.sessionSeq - right.sessionSeq)
    .map((entry) => entry.entryId);
  return {
    ...state,
    sessionId: page.sessionId,
    entriesById,
    entryOrder,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    snapshotSeq: Math.max(state.snapshotSeq, page.snapshotSeq),
    loadingInitial: false,
    loadingOlder: false,
    hydrated: true,
    error: null,
  };
}

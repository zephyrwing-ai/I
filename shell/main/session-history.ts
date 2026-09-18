import type { SessionEntry, SessionRepository } from "../../agent/memory/index.js";
import type {
  SessionHistoryEntry,
  SessionPageRequest,
  SessionPageResult,
} from "../shared/ipc.js";

export const DEFAULT_SESSION_HISTORY_PAGE_LIMIT = 100;
export const MAX_SESSION_HISTORY_PAGE_LIMIT = 200;

export class SessionHistoryError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_request" | "not_found" | "storage",
  ) {
    super(message);
    this.name = "SessionHistoryError";
  }
}

interface NormalizedPageRequest {
  cursor: string | null;
  beforeSeq: number | null;
  limit: number;
}

function normalizePageRequest(request: unknown): NormalizedPageRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new SessionHistoryError("The history page request format is invalid.", "invalid_request");
  }
  const candidate = request as Partial<SessionPageRequest>;
  const cursor = candidate.cursor === undefined ? null : candidate.cursor;
  if (cursor !== null && (typeof cursor !== "string" || !/^[1-9]\d*$/.test(cursor))) {
    throw new SessionHistoryError("The history page cursor is invalid.", "invalid_request");
  }
  const beforeSeq = cursor === null ? null : Number(cursor);
  if (beforeSeq !== null && !Number.isSafeInteger(beforeSeq)) {
    throw new SessionHistoryError("The history page cursor is outside the safe range.", "invalid_request");
  }
  const limit = candidate.limit ?? DEFAULT_SESSION_HISTORY_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_SESSION_HISTORY_PAGE_LIMIT) {
    throw new SessionHistoryError(
      `The history page size must be between 1 and ${MAX_SESSION_HISTORY_PAGE_LIMIT}.`,
      "invalid_request",
    );
  }
  return { cursor, beforeSeq, limit };
}

function toHistoryEntry(entry: SessionEntry): SessionHistoryEntry {
  return {
    entryId: entry.id,
    sessionSeq: entry.sessionSeq,
    type: entry.type,
    status: entry.status,
    runId: entry.runId,
    turnId: entry.turnId,
    toolCallId: entry.toolCallId,
    revision: entry.revision,
    payload: entry.payload,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/**
 * Main-process read service for the single active desktop session.
 * Renderer supplies only a cursor and limit, so it cannot enumerate arbitrary
 * sessions or access Repository/database details.
 */
export class SessionHistoryService {
  private readonly inFlight = new Map<string, Promise<SessionPageResult>>();

  constructor(
    private readonly activeSessionId: string,
    private readonly repository: SessionRepository,
  ) {}

  async loadPage(request: unknown): Promise<SessionPageResult> {
    const normalized = normalizePageRequest(request);
    const requestKey = `${normalized.cursor ?? "latest"}:${normalized.limit}`;
    const existing = this.inFlight.get(requestKey);
    if (existing) return existing;

    const operation = this.readPage(normalized).finally(() => {
      if (this.inFlight.get(requestKey) === operation) this.inFlight.delete(requestKey);
    });
    this.inFlight.set(requestKey, operation);
    return operation;
  }

  private async readPage(request: NormalizedPageRequest): Promise<SessionPageResult> {
    const session = await this.repository.getSession(this.activeSessionId);
    if (!session) throw new SessionHistoryError("The current session does not exist.", "not_found");

    const fetchLimit = request.limit + 1;
    const descendingEntries = request.beforeSeq === null
      ? await this.repository.listLatestEntries(this.activeSessionId, fetchLimit)
      : await this.repository.listEntriesBefore(this.activeSessionId, request.beforeSeq, fetchLimit);
    const hasMore = descendingEntries.length > request.limit;
    const pageDescending = hasMore ? descendingEntries.slice(0, request.limit) : descendingEntries;
    const entries = pageDescending.slice().reverse();
    const nextCursor = hasMore && entries.length > 0 ? String(entries[0]!.sessionSeq) : null;

    if (nextCursor !== null && request.beforeSeq !== null && Number(nextCursor) >= request.beforeSeq) {
      throw new SessionHistoryError("The history page cursor did not advance to older records.", "storage");
    }

    return {
      sessionId: this.activeSessionId,
      entries: entries.map(toHistoryEntry),
      nextCursor,
      hasMore,
      snapshotSeq: Math.max(0, session.nextEntrySeq - 1),
    };
  }
}

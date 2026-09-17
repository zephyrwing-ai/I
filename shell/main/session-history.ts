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
    throw new SessionHistoryError("历史分页请求格式无效。", "invalid_request");
  }
  const candidate = request as Partial<SessionPageRequest>;
  const cursor = candidate.cursor === undefined ? null : candidate.cursor;
  if (cursor !== null && (typeof cursor !== "string" || !/^[1-9]\d*$/.test(cursor))) {
    throw new SessionHistoryError("历史分页游标无效。", "invalid_request");
  }
  const beforeSeq = cursor === null ? null : Number(cursor);
  if (beforeSeq !== null && !Number.isSafeInteger(beforeSeq)) {
    throw new SessionHistoryError("历史分页游标超出安全范围。", "invalid_request");
  }
  const limit = candidate.limit ?? DEFAULT_SESSION_HISTORY_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_SESSION_HISTORY_PAGE_LIMIT) {
    throw new SessionHistoryError(
      `历史分页数量必须在 1 到 ${MAX_SESSION_HISTORY_PAGE_LIMIT} 之间。`,
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
    if (!session) throw new SessionHistoryError("当前会话不存在。", "not_found");

    const fetchLimit = request.limit + 1;
    const descendingEntries = request.beforeSeq === null
      ? await this.repository.listLatestEntries(this.activeSessionId, fetchLimit)
      : await this.repository.listEntriesBefore(this.activeSessionId, request.beforeSeq, fetchLimit);
    const hasMore = descendingEntries.length > request.limit;
    const pageDescending = hasMore ? descendingEntries.slice(0, request.limit) : descendingEntries;
    const entries = pageDescending.slice().reverse();
    const nextCursor = hasMore && entries.length > 0 ? String(entries[0]!.sessionSeq) : null;

    if (nextCursor !== null && request.beforeSeq !== null && Number(nextCursor) >= request.beforeSeq) {
      throw new SessionHistoryError("历史分页游标没有向更早记录推进。", "storage");
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

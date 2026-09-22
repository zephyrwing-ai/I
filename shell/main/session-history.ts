import type { HistoryEntry, HistoryRepository, HistoryScope } from "../../agent/memory/index.js";
import type {
  HistoryPageEntry,
  HistoryPageRequest,
  HistoryPageResult,
} from "../shared/ipc.js";

export const DEFAULT_HISTORY_PAGE_LIMIT = 100;
export const MAX_HISTORY_PAGE_LIMIT = 200;

export class HistoryError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_request" | "not_found" | "storage",
  ) {
    super(message);
    this.name = "HistoryError";
  }
}

interface NormalizedPageRequest {
  beforeOrder: number | null;
  limit: number;
}

function normalizePageRequest(request: unknown): NormalizedPageRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new HistoryError("The history page request format is invalid.", "invalid_request");
  }
  const candidate = request as Partial<HistoryPageRequest>;
  const cursor = candidate.cursor === undefined ? null : candidate.cursor;
  if (cursor !== null && (typeof cursor !== "string" || !/^[1-9]\d*$/.test(cursor))) {
    throw new HistoryError("The history page cursor is invalid.", "invalid_request");
  }
  const beforeOrder = cursor === null ? null : Number(cursor);
  if (beforeOrder !== null && !Number.isSafeInteger(beforeOrder)) {
    throw new HistoryError("The history page cursor is outside the safe range.", "invalid_request");
  }
  const limit = candidate.limit ?? DEFAULT_HISTORY_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_HISTORY_PAGE_LIMIT) {
    throw new HistoryError(`The history page size must be between 1 and ${MAX_HISTORY_PAGE_LIMIT}.`, "invalid_request");
  }
  return { beforeOrder, limit };
}

function toHistoryEntry(entry: HistoryEntry): HistoryPageEntry {
  return {
    entryId: entry.id,
    entryOrder: entry.entryOrder,
    projectId: entry.projectId,
    type: entry.type,
    status: entry.status,
    runId: entry.runId,
    turnId: entry.turnId,
    toolCallId: entry.toolCallId,
    revision: entry.revision,
    payload: entry.payload,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    completedAt: entry.completedAt,
  };
}

export class HistoryService {
  private readonly inFlight = new Map<string, Promise<HistoryPageResult>>();

  constructor(
    private readonly getActiveScope: () => HistoryScope,
    private readonly repository: HistoryRepository,
  ) {}

  async loadPage(request: unknown): Promise<HistoryPageResult> {
    const normalized = normalizePageRequest(request);
    const scope = this.getActiveScope();
    const scopeKey = scope ?? "unprojected";
    const requestKey = `${scopeKey}:${normalized.beforeOrder ?? "latest"}:${normalized.limit}`;
    const existing = this.inFlight.get(requestKey);
    if (existing) return existing;

    const operation = this.readPage(scope, normalized).finally(() => {
      if (this.inFlight.get(requestKey) === operation) this.inFlight.delete(requestKey);
    });
    this.inFlight.set(requestKey, operation);
    return operation;
  }

  private async readPage(scope: HistoryScope, request: NormalizedPageRequest): Promise<HistoryPageResult> {
    const fetchLimit = request.limit + 1;
    const descendingEntries = request.beforeOrder === null
      ? await this.repository.listLatestEntries(scope, fetchLimit)
      : await this.repository.listEntriesBefore(scope, request.beforeOrder, fetchLimit);
    const hasMore = descendingEntries.length > request.limit;
    const pageDescending = hasMore ? descendingEntries.slice(0, request.limit) : descendingEntries;
    const entries = pageDescending.slice().reverse();
    const nextCursor = hasMore && entries.length > 0 ? String(entries[0]!.entryOrder) : null;
    if (nextCursor !== null && request.beforeOrder !== null && Number(nextCursor) >= request.beforeOrder) {
      throw new HistoryError("The history page cursor did not advance to older records.", "storage");
    }
    const latest = await this.repository.listLatestEntries(scope, 1);
    return {
      projectId: scope,
      entries: entries.map(toHistoryEntry),
      nextCursor,
      hasMore,
      snapshotOrder: latest[0]?.entryOrder ?? 0,
    };
  }
}

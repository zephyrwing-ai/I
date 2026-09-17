import assert from "node:assert/strict";
import test from "node:test";
import { SqliteSessionRepository } from "../../../agent/memory/index.js";
import {
  MAX_SESSION_HISTORY_PAGE_LIMIT,
  SessionHistoryError,
  SessionHistoryService,
} from "../../../shell/main/session-history.js";

async function createHistory(entryCount = 5): Promise<{
  repository: SqliteSessionRepository;
  service: SessionHistoryService;
}> {
  const repository = new SqliteSessionRepository(":memory:");
  const session = await repository.createSession({ scopeKey: "desktop:test" });
  for (let index = 1; index <= entryCount; index += 1) {
    await repository.appendEntry(session.id, {
      id: `entry-${index}`,
      type: "user_message",
      status: "completed",
      runId: `run-${index}`,
      payload: { role: "user", content: `message-${index}` },
    });
  }
  return { repository, service: new SessionHistoryService(session.id, repository) };
}

test("SessionHistoryService returns ascending pages and stable backward cursors", async () => {
  const { repository, service } = await createHistory();
  try {
    const latest = await service.loadPage({ cursor: null, limit: 2 });
    assert.deepEqual(latest.entries.map((entry) => entry.sessionSeq), [4, 5]);
    assert.equal(latest.nextCursor, "4");
    assert.equal(latest.hasMore, true);
    assert.equal(latest.snapshotSeq, 5);

    const older = await service.loadPage({ cursor: latest.nextCursor, limit: 2 });
    assert.deepEqual(older.entries.map((entry) => entry.sessionSeq), [2, 3]);
    assert.equal(older.nextCursor, "2");
    assert.equal(older.hasMore, true);

    const oldest = await service.loadPage({ cursor: older.nextCursor, limit: 2 });
    assert.deepEqual(oldest.entries.map((entry) => entry.sessionSeq), [1]);
    assert.equal(oldest.nextCursor, null);
    assert.equal(oldest.hasMore, false);
  } finally {
    repository.close();
  }
});

test("SessionHistoryService validates cursors and enforces the page limit", async () => {
  const { repository, service } = await createHistory(1);
  try {
    for (const cursor of ["0", "04", "-1", "1.5", "not-a-cursor"]) {
      await assert.rejects(
        service.loadPage({ cursor, limit: 100 }),
        (error: unknown) => error instanceof SessionHistoryError && error.code === "invalid_request",
      );
    }
    await assert.rejects(
      service.loadPage({ cursor: null, limit: MAX_SESSION_HISTORY_PAGE_LIMIT + 1 }),
      (error: unknown) => error instanceof SessionHistoryError && error.code === "invalid_request",
    );
  } finally {
    repository.close();
  }
});

test("SessionHistoryService coalesces duplicate in-flight cursor requests", async () => {
  const { repository, service } = await createHistory(3);
  const original = repository.listLatestEntries.bind(repository);
  let calls = 0;
  repository.listLatestEntries = async (sessionId, limit) => {
    calls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    return original(sessionId, limit);
  };
  try {
    const [left, right] = await Promise.all([
      service.loadPage({ cursor: null, limit: 2 }),
      service.loadPage({ cursor: null, limit: 2 }),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(left, right);
  } finally {
    repository.close();
  }
});

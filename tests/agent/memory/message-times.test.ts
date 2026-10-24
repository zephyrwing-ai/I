import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../../../agent/loop.js";
import { RepositoryError, SCHEMA_VERSION, SqliteHistoryRepository, createHistoryRecorder } from "../../../agent/memory/index.js";

test("message timestamp migration preserves identities and dates across v8 and v9", () => {
  for (const version of [8, 9]) {
    const directory = mkdtempSync(join(tmpdir(), "message-times-migration-"));
    const path = join(directory, "history.sqlite");
    try {
      const database = new DatabaseSync(path);
      database.exec(`
        CREATE TABLE entries (
          id TEXT PRIMARY KEY, project_id TEXT, entry_order INTEGER NOT NULL UNIQUE,
          type TEXT NOT NULL, status TEXT NOT NULL, run_id TEXT NOT NULL, turn_id TEXT,
          tool_call_id TEXT, revision INTEGER NOT NULL, payload_version INTEGER NOT NULL,
          payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          duration_ms INTEGER ${version === 8 ? ", completed_at INTEGER" : ""}
        );
        PRAGMA user_version = ${version};
      `);
      const insert = database.prepare(`INSERT INTO entries VALUES (${Array(version === 8 ? 15 : 14).fill("?").join(",")})`);
      const fixtures = [
        ["user", "user_message", "completed", 1_000, 1_000],
        ["answer", "assistant_message", "completed", 1_100, 2_000],
        ["draft", "assistant_message", "streaming", 1_200, 2_100],
        ["interrupted", "assistant_message", "interrupted", 1_300, 2_200],
        ["failed", "assistant_message", "failed", 1_400, 2_300],
      ] as const;
      for (const [index, [id, type, status, createdAt, updatedAt]] of fixtures.entries()) {
        insert.run(id, null, index + 1, type, status, "run", type === "assistant_message" ? id : null, null,
          index, 1, JSON.stringify({ role: type === "user_message" ? "user" : "assistant", content: id }),
          createdAt, updatedAt, version === 9 && id === "answer" ? 900 : null,
          ...(version === 8 ? [id === "answer" ? 1_800 : null] : []));
      }
      database.close();
      const repository = new SqliteHistoryRepository(path);
      const rows = repository.database.prepare("SELECT * FROM entries ORDER BY entry_order").all();
      assert.deepEqual(rows.map((row) => row.id), fixtures.map(([id]) => id));
      assert.deepEqual(rows.map((row) => row.created_at), fixtures.map(([, , , createdAt]) => createdAt));
      assert.deepEqual(rows.map((row) => row.revision), [0, 1, 2, 3, 4]);
      assert.deepEqual(rows.map((row) => row.completed_at), [null, version === 8 ? 1_800 : 2_000, null, null, null]);
      assert.equal(rows[1].duration_ms, version === 8 ? 800 : 900);
      assert.deepEqual(rows.map((row) => JSON.parse(String(row.payload_json)).content), fixtures.map(([id]) => id));
      const columns = repository.database.prepare("PRAGMA table_info(entries)").all().map((column) => column.name);
      assert.ok(columns.includes("completed_at"));
      assert.ok(!columns.includes("updated_at"));
      assert.equal(repository.database.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
      assert.ok(!repository.database.prepare("PRAGMA table_info(tool_invocations)").all().some((column) => column.name === "updated_at"));
      repository.close();
      const reopened = new SqliteHistoryRepository(path);
      assert.deepEqual(reopened.database.prepare("SELECT * FROM entries ORDER BY entry_order").all(), rows);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("startup recovery preserves draft creation time and completed answer time", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  await repository.appendEntry(null, {
    id: "draft", type: "assistant_message", status: "streaming", runId: "old", turnId: "draft-turn",
    payload: { role: "assistant", content: "partial" }, createdAt: 1_000,
  });
  await repository.appendEntry(null, {
    id: "answer", type: "assistant_message", status: "completed", runId: "done", turnId: "answer-turn",
    payload: { role: "assistant", content: "done" }, createdAt: 1_100, completedAt: 2_000,
  });
  const recorder = await createHistoryRecorder(repository, null);
  try {
    const draft = await repository.getEntry("draft");
    assert.equal(draft?.status, "interrupted");
    assert.equal(draft?.createdAt, 1_000);
    assert.equal(draft?.completedAt, null);
    const answer = (await repository.getEntry("answer"))!;
    const revised = await repository.updateEntry(answer.id, answer.revision, { completedAt: 9_000 });
    assert.equal(revised.createdAt, 1_100);
    assert.equal(revised.completedAt, 2_000);
    await recorder.finalizeAnswerDuration("answer-turn", 1_500);
    assert.equal((await repository.getEntry("answer"))?.completedAt, 2_000);
  } finally {
    await recorder.close();
    repository.close();
  }
});

test("repeated assistant completion preserves one entry and its original completion time", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  try {
    const context = { runId: "run", turnId: "turn", turnOrdinal: 1 };
    const message = { role: "assistant" as const, content: "answer" };
    await recorder.finishAssistantAttempt({ ...context, completedAt: 2_000 }, "completed", message);
    await recorder.finishAssistantAttempt({ ...context, completedAt: 9_000 }, "completed", message);
    const entries = await repository.listEntries(null);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].completedAt, 2_000);
    assert.equal(recorder.snapshot().length, 1);
  } finally {
    await recorder.close();
    repository.close();
  }
});

test("local commit retries and live delivery reuse the persisted completion timestamp", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const commit = repository.commitAssistantAttempt.bind(repository);
  let now = 1_000;
  const attemptedTimes: Array<number | null | undefined> = [];
  const deliveries: number[] = [];
  repository.commitAssistantAttempt = async (scope, assistant, plans) => {
    const { entry } = assistant;
    if (entry.status === "completed") {
      attemptedTimes.push(entry.completedAt);
      now += 500;
      if (attemptedTimes.length < 3) throw new RepositoryError("busy", "storage", { retryable: true });
    }
    return commit(scope, assistant, plans);
  };
  try {
    const result = await run("task", { provider: "openai", model: "fake" }, {
      runId: "run", initialUserEntryId: "input", initialUserCreatedAt: 900,
      recorder, clock: () => now, commitRetry: { baseDelayMs: 0 }, cwd: "/tmp", systemPrompt: "", tools: new Map(),
      responseImpl: async function* () {
        now = 2_000;
        yield { type: "completed", content: "answer", toolCalls: [], stopReason: "stop" };
      },
    }, { onAssistantCompleted: (_response, context) => deliveries.push(context.completedAt) });
    assert.equal(result.status, "completed");
    assert.deepEqual(attemptedTimes, [2_000, 2_000, 2_000]);
    assert.deepEqual(deliveries, [2_000]);
    const [user, assistant] = await repository.listEntries(null);
    assert.equal(user.createdAt, 900);
    assert.equal(user.completedAt, null);
    assert.equal(assistant.completedAt, deliveries[0]);
    assert.equal(assistant.durationMs, 2_500);
  } finally {
    await recorder.close();
    repository.close();
  }
});

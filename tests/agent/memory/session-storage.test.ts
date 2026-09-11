import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RepositoryError,
  SqliteSessionRepository,
  createSessionRecorder,
} from "../../../agent/memory/index.js";

test("SQLite session storage keeps ordered entries and enforces revision updates", async () => {
  const repository = new SqliteSessionRepository(":memory:");
  const session = await repository.createSession({ scopeKey: "test" });
  assert.equal(session.nextEntrySeq, 1);
  assert.equal(session.revision, 0);
  const user = await repository.appendEntry(session.id, {
    id: "user-1",
    type: "user_message",
    status: "completed",
    runId: "run-1",
    payload: { role: "user", content: "hello" },
  });
  const assistant = await repository.appendEntry(session.id, {
    id: "assistant-1",
    type: "assistant_message",
    status: "streaming",
    runId: "run-1",
    turnId: "turn-1",
    payload: { role: "assistant", content: "hel" },
  });
  assert.equal(user.sessionSeq, 1);
  assert.equal(assistant.sessionSeq, 2);
  assert.equal((await repository.getSession(session.id))?.nextEntrySeq, 3);

  const completed = await repository.updateEntry(assistant.id, assistant.revision, {
    status: "completed",
    payload: { role: "assistant", content: "hello" },
  });
  assert.equal(completed.revision, assistant.revision + 1);
  await assert.rejects(
    repository.updateEntry(assistant.id, assistant.revision, { status: "failed" }),
    (error: unknown) => error instanceof RepositoryError && error.code === "conflict",
  );
  assert.deepEqual((await repository.listEntries(session.id)).map((entry) => entry.sessionSeq), [1, 2]);
  repository.close();
});

test("SessionRecorder coalesces deltas into one assistant entry and restores it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-"));
  const databasePath = join(directory, "session.sqlite");
  try {
    const firstRepository = new SqliteSessionRepository(databasePath);
    const session = await firstRepository.createSession({ scopeKey: "test" });
    const first = await createSessionRecorder(firstRepository, session.id);
    await first.commitUser({ role: "user", content: "hello" }, { runId: "run-1" });
    first.recordAssistantDelta("text", "hel", { runId: "run-1", turnId: "turn-1", turnOrdinal: 1 });
    first.recordAssistantDelta("text", "lo", { runId: "run-1", turnId: "turn-1", turnOrdinal: 1 });
    first.recordAssistantDelta("reasoning", "thinking", { runId: "run-1", turnId: "turn-1", turnOrdinal: 1 });
    await first.commitAssistant({ role: "assistant", content: "hello", reasoning: "thinking" }, { runId: "run-1", turnId: "turn-1", turnOrdinal: 1 });
    await first.commitToolResult({ role: "tool", content: "result", toolCallId: "call-1", toolName: "read" }, { runId: "run-1", turnId: "turn-1", turnOrdinal: 1, toolCallId: "call-1" });
    assert.deepEqual(first.snapshot().map((message) => message.role), ["user", "assistant", "tool"]);
    await first.close();
    firstRepository.close();

    const secondRepository = new SqliteSessionRepository(databasePath);
    const second = await createSessionRecorder(secondRepository, session.id);
    const entries = await secondRepository.listEntries(session.id);
    assert.deepEqual(entries.map((entry) => [entry.type, entry.status, entry.sessionSeq]), [
      ["user_message", "completed", 1],
      ["assistant_message", "completed", 2],
      ["tool_result", "completed", 3],
    ]);
    assert.equal(second.snapshot()[1]?.content, "hello");
    await second.close();
    secondRepository.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

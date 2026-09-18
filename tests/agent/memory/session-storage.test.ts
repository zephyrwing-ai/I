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

test("SQLite history queries page backward with a strict sessionSeq cursor", async () => {
  const repository = new SqliteSessionRepository(":memory:");
  const session = await repository.createSession({ scopeKey: "history" });
  for (let index = 1; index <= 5; index += 1) {
    await repository.appendEntry(session.id, {
      id: `entry-${index}`,
      type: "user_message",
      status: "completed",
      runId: `run-${index}`,
      payload: { role: "user", content: `message-${index}` },
    });
  }

  assert.deepEqual(
    (await repository.listLatestEntries(session.id, 2)).map((entry) => entry.sessionSeq),
    [5, 4],
  );
  assert.deepEqual(
    (await repository.listEntriesBefore(session.id, 4, 2)).map((entry) => entry.sessionSeq),
    [3, 2],
  );
  await assert.rejects(
    repository.listEntriesBefore(session.id, 0, 2),
    (error: unknown) => error instanceof RepositoryError && error.code === "invalid",
  );
  repository.close();
});

test("tool invocation ledger advances through durable phases and reuses its result identity", async () => {
  const repository = new SqliteSessionRepository(":memory:");
  const session = await repository.createSession({ scopeKey: "tools" });
  const invocation = await repository.registerToolInvocation({
    sessionId: session.id,
    runId: "run-tool",
    turnId: "turn-tool",
    cwd: process.cwd(),
    assistantEntryId: "assistant-tool",
    toolCallId: "call-tool",
    ordinal: 0,
    toolName: "read",
    toolVersion: "1",
    inputJson: '{"path":"a.txt"}',
    inputHash: "hash-a",
    recoveryModeSnapshot: "safe",
    resultEntryId: "entry-tool",
  });
  assert.equal(invocation.phase, "planned");
  assert.equal(invocation.attemptCount, 0);

  const pending = await repository.beginToolAttempt(invocation.id);
  assert.equal(pending.phase, "effect_pending");
  assert.equal(pending.attemptCount, 1);

  const outcome = await repository.saveToolOutcome(invocation.id, {
    status: "failed",
    outcome: { ok: false, output: "missing", returncode: -1, truncated: false, error: "not_found" },
  });
  assert.equal(outcome.phase, "outcome_ready");
  assert.equal(outcome.outcomeStatus, "failed");

  const completed = await repository.completeToolInvocation(invocation.id, "entry-tool");
  assert.equal(completed.phase, "completed");
  assert.equal(completed.resultEntryId, "entry-tool");
  assert.equal((await repository.getToolInvocation(session.id, "call-tool"))?.phase, "completed");
  assert.deepEqual(await repository.listOpenToolInvocations(session.id), []);
  repository.close();
});

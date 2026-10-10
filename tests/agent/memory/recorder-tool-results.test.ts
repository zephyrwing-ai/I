import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHistoryRecorder } from "../../../agent/memory/session-recorder.js";
import { SqliteHistoryRepository } from "../../../agent/memory/sqlite-repository.js";
import { RepositoryError, type ToolCommitContext } from "../../../agent/memory/types.js";
import type { ModelMessage } from "../../../agent/model/types.js";

async function setup(t: TestContext) {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  t.after(async () => {
    try {
      await recorder.close();
    } finally {
      repository.close();
    }
  });
  return { repository, recorder };
}

function toolMessage(content = "result", toolCallId = "call"): ModelMessage {
  return { role: "tool", content, toolCallId, toolName: "read" };
}

function toolContext(runId: string, entryId?: string, toolCallId = "call"): ToolCommitContext {
  return { runId, entryId, turnId: `${runId}-turn`, turnOrdinal: 1, toolCallId };
}

for (const sameContent of [false, true]) {
  test(`repeated call IDs in separate runs persist ${sameContent ? "identical" : "different"} results independently`, async (t) => {
    const { repository, recorder } = await setup(t);
    const messages = [toolMessage("first"), toolMessage(sameContent ? "first" : "second")];
    await recorder.commitToolResult(messages[0]!, toolContext("run-a", "result-a"));
    await recorder.commitToolResult(messages[1]!, toolContext("run-b", "result-b"));

    const entries = await repository.listEntries(null);
    assert.deepEqual(entries.map((entry) => [entry.id, entry.runId, entry.toolCallId, entry.payload]), [
      ["result-a", "run-a", "call", messages[0]],
      ["result-b", "run-b", "call", messages[1]],
    ]);
    assert.deepEqual(recorder.snapshot(), messages);
  });
}

test("run and call IDs containing separators keep distinct identities", async (t) => {
  const { repository, recorder } = await setup(t);
  const messages = [toolMessage("first", "call"), toolMessage("second", "part:call")];
  await recorder.commitToolResult(messages[0]!, toolContext("run:part", "result-a", "call"));
  await recorder.commitToolResult(messages[1]!, toolContext("run", "result-b", "part:call"));

  assert.deepEqual((await repository.listEntries(null)).map((entry) => [entry.runId, entry.toolCallId]), [
    ["run:part", "call"],
    ["run", "part:call"],
  ]);
  assert.deepEqual(recorder.snapshot(), messages);
});

test("concurrent commits for one invocation append once and publish after persistence", async (t) => {
  const { repository, recorder } = await setup(t);
  const append = repository.commitToolResult.bind(repository);
  let releaseAppend!: () => void;
  let signalAppendStarted!: () => void;
  const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
  const appendStarted = new Promise<void>((resolve) => { signalAppendStarted = resolve; });
  const appendSpy = t.mock.method(repository, "commitToolResult", async (...args: Parameters<typeof append>) => {
    signalAppendStarted();
    await appendGate;
    return append(...args);
  });
  const message = toolMessage();
  const commits = Promise.all([
    recorder.commitToolResult(message, toolContext("run", "result")),
    recorder.commitToolResult(message, toolContext("run")),
  ]);
  try {
    await appendStarted;
    assert.equal(appendSpy.mock.callCount(), 1);
    assert.equal(await repository.getEntry("result"), null);
    assert.deepEqual(recorder.snapshot(), []);
  } finally {
    releaseAppend();
    await commits;
  }

  assert.equal(appendSpy.mock.callCount(), 1);
  assert.deepEqual((await repository.listEntries(null)).map((entry) => entry.id), ["result"]);
  assert.deepEqual(recorder.snapshot(), [message]);
});

for (const concurrent of [false, true]) {
  test(`${concurrent ? "concurrent" : "subsequent"} commits with a different entry ID conflict for one invocation`, async (t) => {
    const { repository, recorder } = await setup(t);
    const message = toolMessage();
    const first = recorder.commitToolResult(message, toolContext("run", "result-a"));
    if (!concurrent) await first;
    const second = recorder.commitToolResult(message, toolContext("run", "result-b"));
    await Promise.all([
      first,
      assert.rejects(second, (error: unknown) => error instanceof RepositoryError && error.code === "conflict"),
    ]);

    assert.deepEqual((await repository.listEntries(null)).map((entry) => entry.id), ["result-a"]);
    assert.equal(await repository.getEntry("result-b"), null);
    assert.deepEqual(recorder.snapshot(), [message]);
  });
}

test("a different message conflicts without replacing an invocation's saved result", async (t) => {
  const { repository, recorder } = await setup(t);
  const context = toolContext("run", "result");
  const message = toolMessage();
  await recorder.commitToolResult(message, context);
  await assert.rejects(
    recorder.commitToolResult(toolMessage("changed"), context),
    (error: unknown) => error instanceof RepositoryError && error.code === "conflict",
  );

  assert.deepEqual((await repository.getEntry("result"))?.payload, message);
  assert.deepEqual(recorder.snapshot(), [message]);
});

for (const queuedRetry of [false, true]) {
  test(`an append failure permits ${queuedRetry ? "an already queued retry" : "a later retry"} with the same Recorder and entry ID`, async (t) => {
    const { repository, recorder } = await setup(t);
    const append = repository.commitToolResult.bind(repository);
    const failure = new RepositoryError("Injected append failure", "storage");
    const attemptedIds: string[] = [];
    t.mock.method(repository, "commitToolResult", async (...args: Parameters<typeof append>) => {
      attemptedIds.push(args[1].id);
      if (attemptedIds.length === 1) throw failure;
      return append(...args);
    });
    const message = toolMessage();
    const context = toolContext("run", "result");
    const rejected = assert.rejects(recorder.commitToolResult(message, context), (error: unknown) => error === failure);
    if (queuedRetry) {
      await Promise.all([rejected, recorder.commitToolResult(message, context)]);
    } else {
      await rejected;
      assert.equal(await repository.getEntry("result"), null);
      assert.deepEqual(await repository.listEntries(null), []);
      assert.deepEqual(recorder.snapshot(), []);
      await recorder.commitToolResult(message, context);
    }

    assert.deepEqual(attemptedIds, ["result", "result"]);
    const entries = await repository.listEntries(null);
    assert.equal(entries.length, 1);
    assert.deepEqual([entries[0]!.id, entries[0]!.status, entries[0]!.payload], ["result", "completed", message]);
    assert.deepEqual(recorder.snapshot(), [message]);
    await recorder.commitToolResult(message, context);
    assert.equal(attemptedIds.length, 2);
    assert.deepEqual(recorder.snapshot(), [message]);
  });
}

test("a rebuilt Recorder deduplicates and validates each historical run/call identity", async (t) => {
  const { repository, recorder } = await setup(t);
  const messages = [toolMessage("first"), toolMessage("second")];
  const contexts = [toolContext("run-a", "result-a"), toolContext("run-b", "result-b")];
  for (const [index, context] of contexts.entries()) {
    await repository.appendEntry(null, {
      id: context.entryId!, type: "tool_result", status: "completed", runId: context.runId,
      turnId: context.turnId, toolCallId: context.toolCallId, payload: messages[index]!,
    });
  }
  await recorder.close();
  const restored = await createHistoryRecorder(repository, null);
  t.after(() => restored.close());
  const appendSpy = t.mock.method(repository, "commitToolResult", repository.commitToolResult.bind(repository));
  assert.deepEqual(restored.snapshot(), messages);

  for (const [index, context] of contexts.entries()) {
    const message = messages[index]!;
    await restored.commitToolResult(message, context);
    await restored.commitToolResult(message, { ...context, entryId: undefined });
    await assert.rejects(
      restored.commitToolResult(message, { ...context, entryId: "changed-entry" }),
      (error: unknown) => error instanceof RepositoryError && error.code === "conflict",
    );
    await assert.rejects(
      restored.commitToolResult(toolMessage("changed"), context),
      (error: unknown) => error instanceof RepositoryError && error.code === "conflict",
    );
  }
  assert.equal(appendSpy.mock.callCount(), 0);
  assert.equal((await repository.listEntries(null)).length, 2);
  assert.deepEqual(restored.snapshot(), messages);

  await restored.commitToolResult(messages[1]!, toolContext("run-c", "result-c"));
  assert.equal(appendSpy.mock.callCount(), 1);
  assert.deepEqual((await repository.listEntries(null)).map((entry) => entry.id), ["result-a", "result-b", "result-c"]);
  assert.deepEqual(restored.snapshot(), [...messages, messages[1]]);
});

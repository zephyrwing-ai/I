import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { SCHEMA_VERSION } from "../../../agent/memory/schema.js";
import { SqliteHistoryRepository } from "../../../agent/memory/sqlite-repository.js";
import { RepositoryError, type HistoryEntry, type HistoryScope, type SaveContextSnapshotInput } from "../../../agent/memory/types.js";
import { toolInputHash } from "../../../agent/tools/identity.js";
import { toolResultMessage } from "../../../agent/tools/result.js";

function setup(t: TestContext): SqliteHistoryRepository {
  const repository = new SqliteHistoryRepository(":memory:");
  t.after(() => repository.close());
  return repository;
}

async function exchange(repository: SqliteHistoryRepository, projectId: HistoryScope, prefix: string): Promise<HistoryEntry[]> {
  const user = await repository.appendEntry(projectId, {
    id: `${prefix}-user`, type: "user_message", status: "completed", runId: prefix,
    payload: { role: "user", content: `Request ${prefix}` },
  });
  const assistant = await repository.appendEntry(projectId, {
    id: `${prefix}-assistant`, type: "assistant_message", status: "completed", runId: prefix, turnId: `${prefix}-turn`,
    payload: { role: "assistant", content: `Answer ${prefix}` },
  });
  return [user, assistant];
}

async function snapshotInput(repository: SqliteHistoryRepository, projectId: HistoryScope, entries: HistoryEntry[]): Promise<SaveContextSnapshotInput> {
  const lastOrder = entries.at(-1)!.entryOrder;
  return {
    projectId, expectedVersion: null, summary: "The requested work is complete.",
    coveredThroughOrder: lastOrder, baselineThroughOrder: lastOrder,
    sourceVersion: await repository.getContextSourceVersion(projectId, lastOrder),
    policyVersion: "context-v1", modelId: "test-model", baselineTokens: 240,
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60, totalTokens: 120 },
  };
}

const conflict = (error: unknown): boolean => error instanceof RepositoryError && error.code === "conflict";

test("project and General snapshots survive restart with separate coverage and growth baselines", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-snapshots-"));
  const path = join(directory, "history.sqlite");
  let repository = new SqliteHistoryRepository(path);
  try {
    const project = await repository.createProject({ canonicalPath: "/tmp/context-project", displayName: "context-project" });
    const general = await exchange(repository, null, "general");
    const projectEntries = await exchange(repository, project.id, "project");
    const tail = await repository.appendEntry(null, {
      id: "general-next", type: "user_message", status: "completed", runId: "general-next",
      payload: { role: "user", content: "Continue the task" },
    });
    const generalInput = await snapshotInput(repository, null, [...general, tail]);
    const generalSnapshot = await repository.saveContextSnapshot({ ...generalInput, coveredThroughOrder: general.at(-1)!.entryOrder });
    const projectSnapshot = await repository.saveContextSnapshot(await snapshotInput(repository, project.id, projectEntries));
    const original = await repository.listEntries(null);
    repository.close();
    repository = new SqliteHistoryRepository(path);
    assert.deepEqual(await repository.getLatestContextSnapshot(null), generalSnapshot);
    assert.deepEqual(await repository.getLatestContextSnapshot(project.id), projectSnapshot);
    assert.equal(generalSnapshot.version, 1);
    assert.equal(projectSnapshot.version, 1);
    assert.ok(generalSnapshot.coveredThroughOrder < generalSnapshot.baselineThroughOrder);
    assert.deepEqual(await repository.listEntries(null), original);
    assert.deepEqual((await repository.listEntries(null, generalSnapshot.coveredThroughOrder)).map((entry) => entry.id), [tail.id]);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source revisions invalidate a saved snapshot while later appends preserve it", async (t) => {
  const repository = setup(t);
  const first = await exchange(repository, null, "first");
  const input = await snapshotInput(repository, null, first);
  const saved = await repository.saveContextSnapshot(input);
  const later = await exchange(repository, null, "later");
  assert.deepEqual(await repository.getLatestContextSnapshot(null), saved);
  await repository.updateEntry(first[0]!.id, first[0]!.revision, { payload: { role: "user", content: "Corrected original request" } });
  assert.equal(await repository.getLatestContextSnapshot(null), null);
  await assert.rejects(repository.saveContextSnapshot({ ...input, id: "stale" }), conflict);
  const refreshed = await repository.saveContextSnapshot(await snapshotInput(repository, null, [...first, ...later]));
  assert.equal(refreshed.version, 2);
  assert.deepEqual(await repository.getLatestContextSnapshot(null), refreshed);
  assert.equal((await repository.listEntries(null)).length, 4);
  assert.deepEqual(Object.keys(refreshed.sourceVersion).sort(), ["entryCount", "revisionHash"]);
  assert.equal(refreshed.sourceVersion.revisionHash.length, 64);
});

test("snapshot publication rejects stale generations and omitted completed source entries", async (t) => {
  const repository = setup(t);
  const entries = await exchange(repository, null, "source");
  const input = await snapshotInput(repository, null, entries);
  await repository.updateEntry(entries[0]!.id, entries[0]!.revision, { payload: { role: "user", content: "Changed during summarization" } });
  await assert.rejects(repository.saveContextSnapshot(input), conflict);
  const current = await snapshotInput(repository, null, entries);
  await assert.rejects(repository.saveContextSnapshot({ ...current, sourceVersion: { ...current.sourceVersion, entryCount: 1 } }), conflict);
  assert.equal(await repository.getLatestContextSnapshot(null), null);
});

test("successive snapshots retain revision validation for the entire original source prefix", async (t) => {
  const repository = setup(t);
  const first = await exchange(repository, null, "original");
  const original = await repository.saveContextSnapshot(await snapshotInput(repository, null, first));
  const later = await exchange(repository, null, "extension");
  const updatedInput = await snapshotInput(repository, null, [...first, ...later]);
  const updated = await repository.saveContextSnapshot({ ...updatedInput, expectedVersion: original.version });
  assert.equal(updated.sourceVersion.entryCount, 4);
  assert.equal(updated.version, 2);
  await repository.updateEntry(first[0]!.id, first[0]!.revision, { payload: { role: "user", content: "Revised before both summaries" } });
  assert.equal(await repository.getLatestContextSnapshot(null), null);
});

test("version checks serialize competing publications from separate database connections", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-snapshot-cas-"));
  const path = join(directory, "history.sqlite");
  const first = new SqliteHistoryRepository(path);
  const second = new SqliteHistoryRepository(path);
  try {
    const entries = await exchange(first, null, "cas");
    const input = await snapshotInput(first, null, entries);
    const initial = await first.saveContextSnapshot(input);
    const results = await Promise.allSettled([
      first.saveContextSnapshot({ ...input, expectedVersion: initial.version, summary: "First generation" }),
      second.saveContextSnapshot({ ...input, expectedVersion: initial.version, summary: "Second generation" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && conflict(rejected.reason));
    assert.equal((await second.getLatestContextSnapshot(null))?.version, 2);
    assert.equal(first.database.prepare("SELECT COUNT(*) AS count FROM context_snapshots").get()?.count, 2);
  } finally {
    first.close(); second.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("publication retries reuse snapshot identity and reject changed content", async (t) => {
  const repository = setup(t);
  const input = { ...await snapshotInput(repository, null, await exchange(repository, null, "retry")), id: "stable-snapshot" };
  const saved = await repository.saveContextSnapshot(input);
  assert.deepEqual(await repository.saveContextSnapshot(input), saved);
  await assert.rejects(repository.saveContextSnapshot({ ...input, summary: "Different summary" }), conflict);
  assert.equal(repository.database.prepare("SELECT COUNT(*) AS count FROM context_snapshots").get()?.count, 1);
});

test("coverage and baseline cuts retain complete tool batches and their execution ledger", async (t) => {
  const repository = setup(t);
  const calls = ["a", "b"].map((id) => ({ id, name: "read", input: {}, inputComplete: true }));
  const assistant = await repository.appendEntry(null, {
    id: "tool-assistant", type: "assistant_message", status: "completed", runId: "tool-run", turnId: "tool-turn",
    payload: { role: "assistant", content: "", toolCalls: calls },
  });
  const results: HistoryEntry[] = [];
  for (const [ordinal, call] of calls.entries()) {
    const invocation = await repository.registerToolInvocation({
      projectId: null, runId: "tool-run", turnId: "tool-turn", cwd: "/tmp", assistantEntryId: assistant.id,
      toolCallId: call.id, ordinal, toolName: call.name, toolVersion: "1", inputJson: "{}",
      inputHash: toolInputHash("read", "1", {}), recoveryModeSnapshot: "safe", resultEntryId: `result-${call.id}`,
    });
    await repository.beginToolAttempt(invocation.id);
    const result = { ok: true, output: `${call.id} result`, returncode: 0, truncated: false };
    await repository.saveToolOutcome(invocation.id, { status: "succeeded", outcome: result });
    results.push(await repository.commitToolResult(null, {
      id: `result-${call.id}`, type: "tool_result", status: "completed", runId: "tool-run", turnId: "tool-turn",
      toolCallId: call.id, payload: toolResultMessage(call, result),
    }, invocation.id));
  }
  const input = await snapshotInput(repository, null, [assistant, ...results]);
  const ledger = repository.database.prepare("SELECT * FROM tool_invocations ORDER BY ordinal").all();
  await assert.rejects(repository.saveContextSnapshot({ ...input, coveredThroughOrder: assistant.entryOrder }), conflict);
  await assert.rejects(repository.saveContextSnapshot({ ...input, coveredThroughOrder: results[0]!.entryOrder }), conflict);
  await assert.rejects(repository.saveContextSnapshot({
    ...input, coveredThroughOrder: assistant.entryOrder, baselineThroughOrder: results[0]!.entryOrder,
    sourceVersion: await repository.getContextSourceVersion(null, results[0]!.entryOrder),
  }), conflict);
  const saved = await repository.saveContextSnapshot(input);
  assert.equal(saved.coveredThroughOrder, results[1]!.entryOrder);
  assert.deepEqual(repository.database.prepare("SELECT * FROM tool_invocations ORDER BY ordinal").all(), ledger);
  assert.deepEqual((await repository.listEntries(null)).map((entry) => entry.id), [assistant.id, ...results.map((entry) => entry.id)]);
});

test("source boundaries belong to their scope and completed state", async (t) => {
  const repository = setup(t);
  const general = await exchange(repository, null, "general-boundary");
  const project = await repository.createProject({ canonicalPath: "/tmp/context-other", displayName: "other" });
  const foreign = await exchange(repository, project.id, "foreign-boundary");
  const streaming = await repository.appendEntry(null, {
    id: "streaming-boundary", type: "assistant_message", status: "streaming", runId: "pending", turnId: "pending-turn",
    payload: { role: "assistant", content: "partial" },
  });
  const input = await snapshotInput(repository, null, general);
  await assert.rejects(repository.saveContextSnapshot({ ...input, baselineThroughOrder: foreign.at(-1)!.entryOrder }), conflict);
  await assert.rejects(repository.saveContextSnapshot({ ...input, baselineThroughOrder: streaming.entryOrder }), conflict);
  await assert.rejects(repository.saveContextSnapshot({ ...input, projectId: project.id }), conflict);
  assert.equal(await repository.getLatestContextSnapshot(null), null);
});

test("failed snapshot commits leave the prior generation and original history intact", async (t) => {
  const repository = setup(t);
  const entries = await exchange(repository, null, "rollback");
  const input = await snapshotInput(repository, null, entries);
  const saved = await repository.saveContextSnapshot(input);
  repository.database.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON context_snapshots BEGIN SELECT RAISE(ABORT, 'snapshot rejected'); END");
  await assert.rejects(repository.saveContextSnapshot({ ...input, expectedVersion: saved.version }), conflict);
  assert.deepEqual(await repository.getLatestContextSnapshot(null), saved);
  assert.deepEqual(await repository.listEntries(null), entries);
});

test("schema 11 upgrades snapshots without changing existing project history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-snapshot-migration-"));
  const path = join(directory, "history.sqlite");
  let repository = new SqliteHistoryRepository(path);
  try {
    const project = await repository.createProject({ canonicalPath: "/tmp/context-migration", displayName: "migration" });
    const entries = await exchange(repository, project.id, "migrated");
    repository.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE context_snapshots; PRAGMA user_version = 11");
    legacy.close();
    repository = new SqliteHistoryRepository(path);
    assert.equal(repository.database.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
    assert.deepEqual(await repository.listEntries(project.id), entries);
    assert.equal(await repository.getLatestContextSnapshot(project.id), null);
    assert.equal((await repository.saveContextSnapshot(await snapshotInput(repository, project.id, entries))).version, 1);
  } finally {
    repository.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("streaming recovery reads only the requested scope and original stream order", async (t) => {
  const repository = setup(t);
  const project = await repository.createProject({ canonicalPath: "/tmp/context-streaming", displayName: "streaming" });
  await exchange(repository, null, "complete");
  for (const [index, scope] of [null, project.id, null].entries()) {
    await repository.appendEntry(scope, {
      id: `stream-${index}`, type: "assistant_message", status: "streaming", runId: `stream-${index}`, turnId: `turn-${index}`,
      payload: { role: "assistant", content: `draft-${index}` },
    });
  }
  assert.deepEqual((await repository.listStreamingEntries(null)).map((entry) => entry.id), ["stream-0", "stream-2"]);
  assert.deepEqual((await repository.listStreamingEntries(project.id)).map((entry) => entry.id), ["stream-1"]);
});

test("snapshot metadata rejects invalid token counts and empty summaries", async (t) => {
  const repository = setup(t);
  const input = await snapshotInput(repository, null, await exchange(repository, null, "invalid"));
  for (const patch of [{ summary: "  " }, { baselineTokens: -1 }, { usage: { inputTokens: Number.NaN } }, { usage: { outputTokens: 0.5 } }]) {
    await assert.rejects(repository.saveContextSnapshot({ ...input, ...patch }), (error: unknown) => error instanceof RepositoryError && error.code === "invalid");
  }
  assert.equal(await repository.getLatestContextSnapshot(null), null);
});

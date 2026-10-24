import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SCHEMA_VERSION, SqliteHistoryRepository } from "../../../agent/memory/index.js";
import { toolInputHash } from "../../../agent/tools/identity.js";

const scopedTables = ["entries", "tool_invocations", "pending_run_inputs", "run_cancellations", "project_context", "context_snapshots"];

async function seedProjectHistory(repository: SqliteHistoryRepository, projectId: string): Promise<void> {
  const runId = `${projectId}-run`;
  const user = await repository.appendEntry(projectId, {
    id: `${projectId}-user`, type: "user_message", status: "completed", runId,
    payload: { role: "user", content: "Read project" },
  });
  const call = { id: `${projectId}-call`, name: "read", input: { path: "README.md" }, inputComplete: true };
  await repository.commitAssistantAttempt(projectId, {
    entry: {
      id: `${projectId}-assistant`, type: "assistant_message", status: "completed", runId, turnId: `${projectId}-turn`,
      payload: { role: "assistant", content: "Reading project", toolCalls: [call] },
    },
    expectedRevision: null,
  }, [{
    runId, turnId: `${projectId}-turn`, cwd: "/tmp", ordinal: 0, toolCallId: call.id,
    toolName: "read", toolVersion: "1", inputJson: JSON.stringify(call.input),
    inputHash: toolInputHash("read", "1", call.input), recoveryModeSnapshot: "safe",
  }]);
  await repository.acceptRunInput(projectId, { inputId: `${projectId}-input`, runId, content: "Continue" });
  await repository.requestRunCancellation(projectId, runId);
  await repository.saveProjectContext(projectId, { treeJson: "{}", treeHash: "tree", scanPolicyVersion: "test", complete: true });
  await repository.saveContextSnapshot({
    projectId, expectedVersion: null, summary: "A project summary", policyVersion: "test", modelId: "test", baselineTokens: 1,
    coveredThroughOrder: user.entryOrder, baselineThroughOrder: user.entryOrder,
    sourceVersion: await repository.getContextSourceVersion(projectId, user.entryOrder),
  });
}

test("project metadata keeps stable creation order, pin priority and renamed labels across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "project-navigation-"));
  const path = join(directory, "history.sqlite");
  let repository = new SqliteHistoryRepository(path);
  try {
    await repository.createProject({ id: "first", canonicalPath: "/first", displayName: "Z", createdAt: 1 });
    await repository.createProject({ id: "second", canonicalPath: "/second", displayName: "A", createdAt: 2 });
    await repository.touchProject("first", 999);
    assert.deepEqual((await repository.listProjects()).map((item) => item.id), ["first", "second"]);
    await repository.updateProject("second", { pinned: true, displayName: "  Research  " });
    repository.close();
    repository = new SqliteHistoryRepository(path);
    assert.deepEqual((await repository.listProjects()).map((item) => item.id), ["second", "first"]);
    assert.deepEqual(await repository.getProject("second"), {
      id: "second", canonicalPath: "/second", displayName: "Research", pinned: true, createdAt: 2, lastOpenedAt: 2,
    });
    await repository.updateProject("second", { pinned: false });
    assert.deepEqual((await repository.listProjects()).map((item) => item.id), ["first", "second"]);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema version 12 upgrades existing project metadata with an unpinned default", async () => {
  const directory = mkdtempSync(join(tmpdir(), "project-navigation-migration-"));
  const path = join(directory, "history.sqlite");
  let repository = new SqliteHistoryRepository(path);
  try {
    const project = await repository.createProject({ canonicalPath: "/legacy", displayName: "Legacy" });
    repository.database.exec("ALTER TABLE projects DROP COLUMN pinned; PRAGMA user_version = 12;");
    repository.close();
    repository = new SqliteHistoryRepository(path);
    assert.deepEqual(await repository.getProject(project.id), project);
    assert.equal(repository.database.prepare("PRAGMA user_version").get()?.user_version, SCHEMA_VERSION);
    assert.deepEqual(repository.database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deleting a project removes all scoped history without exposing it in ordinary or another project history", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const deleted = await repository.createProject({ canonicalPath: "/deleted", displayName: "Deleted" });
    const retained = await repository.createProject({ canonicalPath: "/retained", displayName: "Retained" });
    await seedProjectHistory(repository, deleted.id);
    await seedProjectHistory(repository, retained.id);
    await repository.appendEntry(null, { id: "ordinary", type: "user_message", status: "completed", runId: "ordinary-run", payload: { role: "user", content: "ordinary" } });
    const retainedHistory = await repository.listEntries(retained.id);
    await repository.deleteProject(deleted.id);
    for (const table of scopedTables) {
      assert.equal(repository.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(deleted.id)?.count, 0, table);
      assert.equal(repository.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(retained.id)?.count, table === "entries" ? 2 : 1, table);
    }
    assert.equal(await repository.getProject(deleted.id), null);
    assert.deepEqual((await repository.listEntries(null)).map((entry) => entry.id), ["ordinary"]);
    assert.deepEqual(await repository.listEntries(retained.id), retainedHistory);
    assert.deepEqual(repository.database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { repository.close(); }
});

test("a rejected project deletion rolls back the scoped facts and project metadata together", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const project = await repository.createProject({ canonicalPath: "/rollback", displayName: "Rollback" });
    await seedProjectHistory(repository, project.id);
    repository.database.exec("CREATE TRIGGER reject_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
    await assert.rejects(repository.deleteProject(project.id), /storage failure/);
    assert.deepEqual(await repository.getProject(project.id), project);
    for (const table of scopedTables) {
      assert.equal(repository.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(project.id)?.count, table === "entries" ? 2 : 1, table);
    }
  } finally { repository.close(); }
});

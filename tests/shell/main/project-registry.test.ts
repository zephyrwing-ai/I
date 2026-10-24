import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteHistoryRepository } from "../../../agent/memory/index.js";
import { ProjectRegistry } from "../../../shell/main/project-registry.js";

test("ProjectRegistry creates and restores a canonical project with a bounded context cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-project-"));
  try {
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "README.md"), "hello", "utf8");
    const repository = new SqliteHistoryRepository(":memory:");
    const registry = new ProjectRegistry(repository);

    const first = await registry.selectPath(directory);
    const second = await registry.selectPath(directory);
    assert.ok(first.descriptor.projectId);
    assert.equal(second.descriptor.projectId, first.descriptor.projectId);
    assert.equal(first.descriptor.displayName, directory.split("/").at(-1));
    assert.match(first.projectContext[0]?.content ?? "", /README\.md/);

    const projects = await repository.listProjects();
    assert.equal(projects.length, 1);
    assert.equal((await repository.getProjectContext(first.descriptor.projectId!))?.dirty, false);
    repository.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ProjectRegistry lists registered project metadata without opening their directories", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-project-list-"));
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const firstPath = join(directory, "first");
    const secondPath = join(directory, "second");
    mkdirSync(firstPath);
    mkdirSync(secondPath);
    const registry = new ProjectRegistry(repository);
    const first = await registry.selectPath(firstPath);
    const second = await registry.selectPath(secondPath);
    const registeredOrder = await registry.list();
    await repository.touchProject(first.descriptor.projectId!, 100);
    await repository.touchProject(second.descriptor.projectId!, 200);
    rmSync(firstPath, { recursive: true });

    assert.deepEqual(await registry.list(), registeredOrder);
    assert.equal(registry.activeScope, second.descriptor.projectId);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ProjectRegistry persists names and pins while keeping the directory and activation order stable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-project-navigation-"));
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const firstPath = join(directory, "first");
    const secondPath = join(directory, "second");
    mkdirSync(firstPath);
    mkdirSync(secondPath);
    const registry = new ProjectRegistry(repository);
    const first = await registry.selectPath(firstPath);
    const second = await registry.selectPath(secondPath);
    const registeredOrder = (await registry.list()).map((item) => item.projectId);
    await registry.activate(first.descriptor.projectId!);
    assert.deepEqual((await registry.list()).map((item) => item.projectId), registeredOrder);

    await registry.update(second.descriptor.projectId!, { pinned: true, displayName: "  Research  " });
    assert.deepEqual((await registry.list()).map((item) => item.projectId), [second.descriptor.projectId, first.descriptor.projectId]);
    assert.equal((await registry.getDescriptor(second.descriptor.projectId!)).canonicalPath, second.descriptor.canonicalPath);
    assert.equal((await registry.getDescriptor(second.descriptor.projectId!)).displayName, "Research");
    await registry.update(second.descriptor.projectId!, { pinned: false });
    assert.deepEqual((await registry.list()).map((item) => item.projectId), registeredOrder);
    await assert.rejects(registry.update(first.descriptor.projectId!, { displayName: "  " }), /1 to 200/);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ProjectRegistry clears a deleted active scope after storage commits and preserves project files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-project-delete-"));
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    writeFileSync(join(directory, "README.md"), "keep this project", "utf8");
    const registry = new ProjectRegistry(repository);
    const active = await registry.selectPath(directory);
    repository.database.exec("CREATE TRIGGER reject_project_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
    await assert.rejects(registry.delete(active.descriptor.projectId!), /storage failure/);
    assert.equal(registry.activeScope, active.descriptor.projectId);
    repository.database.exec("DROP TRIGGER reject_project_delete");
    await registry.delete(active.descriptor.projectId!);
    assert.equal(registry.activeScope, null);
    assert.equal((await registry.getActiveDescriptor()).projectId, null);
    const reopened = await registry.selectPath(directory);
    assert.notEqual(reopened.descriptor.projectId, active.descriptor.projectId);
    assert.match(reopened.projectContext[0]!.content, /README.md/);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ProjectRegistry activates an existing ID and prepares its recorder before publishing the scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-project-activate-"));
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    writeFileSync(join(directory, "README.md"), "project", "utf8");
    const registry = new ProjectRegistry(repository);
    const registered = await registry.selectPath(directory);
    registry.clear();
    let prepared = false;
    const active = await registry.activate(registered.descriptor.projectId!, async (context) => {
      assert.equal(registry.activeScope, null);
      assert.equal(context.descriptor.projectId, registered.descriptor.projectId);
      assert.match(context.projectContext[0]!.content, /README\.md/);
      prepared = true;
    });

    assert.equal(prepared, true);
    assert.deepEqual(active.descriptor, registered.descriptor);
    assert.equal(registry.activeScope, registered.descriptor.projectId);
    assert.equal((await registry.list()).length, 1);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ProjectRegistry keeps the original scope and ordering when activation preparation fails", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-project-failure-"));
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const firstPath = join(directory, "first");
    const secondPath = join(directory, "second");
    mkdirSync(firstPath);
    mkdirSync(secondPath);
    const registry = new ProjectRegistry(repository);
    const first = await registry.selectPath(firstPath);
    const second = await registry.selectPath(secondPath);
    await repository.touchProject(first.descriptor.projectId!, 100);

    await assert.rejects(registry.activate(first.descriptor.projectId!, async () => {
      throw new Error("Recorder recovery failed");
    }), /Recorder recovery failed/);
    assert.equal(registry.activeScope, second.descriptor.projectId);
    assert.equal((await repository.getProject(first.descriptor.projectId!))?.lastOpenedAt, 100);

    await assert.rejects(registry.selectPath(firstPath, async () => {
      throw new Error("Recorder recovery failed");
    }), /Recorder recovery failed/);
    assert.equal(registry.activeScope, second.descriptor.projectId);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ProjectRegistry rejects unknown projects and missing directories while retaining the active scope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-project-invalid-"));
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const firstPath = join(directory, "first");
    const secondPath = join(directory, "second");
    mkdirSync(firstPath);
    mkdirSync(secondPath);
    const registry = new ProjectRegistry(repository);
    const first = await registry.selectPath(firstPath);
    const second = await registry.selectPath(secondPath);
    await registry.activate(first.descriptor.projectId!);
    rmSync(secondPath, { recursive: true });

    await assert.rejects(registry.activate("unknown"), /not registered/);
    await assert.rejects(registry.activate(""), /identity is invalid/);
    await assert.rejects(registry.activate(second.descriptor.projectId!));
    assert.equal(registry.activeScope, first.descriptor.projectId);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

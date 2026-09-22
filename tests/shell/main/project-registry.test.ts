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

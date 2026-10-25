import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SqliteHistoryRepository } from "../../../agent/memory/index.js";
import { PROJECT_DIRECTORY_PAGE_SIZE, ProjectFilesService } from "../../../shell/main/project-files.js";
import { ProjectRegistry } from "../../../shell/main/project-registry.js";
import type { ProjectDirectoryResult } from "../../../shell/shared/ipc.js";

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), "i-project-files-"));
  const directory = await realpath(temporary);
  const root = join(directory, "project");
  await mkdir(root);
  const repository = new SqliteHistoryRepository(":memory:");
  t.after(async () => {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const projects = new ProjectRegistry(repository);
  const { descriptor } = await projects.selectPath(root);
  const projectId = descriptor.projectId!;
  return { directory, root, projects, projectId, service: new ProjectFilesService(projects) };
}

function success(result: ProjectDirectoryResult): asserts result is Extract<ProjectDirectoryResult, { ok: true }> {
  assert.equal(result.ok, true, !result.ok ? result.message : undefined);
}

function failure(result: ProjectDirectoryResult, error: string) {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("Expected a directory error");
  assert.equal(result.error, error);
  assert.ok(result.message.length > 0);
  assert.deepEqual(Object.keys(result).sort(), ["error", "message", "ok"]);
}

async function populate(directory: string, count: number) {
  await Promise.all(Array.from({ length: count }, (_, index) => (
    writeFile(join(directory, `file-${String(index).padStart(3, "0")}.txt`), "file content stays on disk")
  )));
}

test("project directories expose one level of metadata, including hidden/generated entries, without activation", async (t) => {
  const { root, projects, projectId, service } = await fixture(t);
  projects.clear();
  const empty = await service.listProjectDirectory({ projectId, relativePath: "" });
  assert.deepEqual(empty, { ok: true, projectId, relativePath: "", entries: [], nextCursor: null });
  await mkdir(join(root, "z-src"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "z-src", "nested.txt"), "nested");
  await writeFile(join(root, "B.md"), "private content");
  await writeFile(join(root, "a.md"), "other private content");

  const listing = await service.listProjectDirectory({ projectId, relativePath: "" });
  assert.deepEqual(listing, {
    ok: true, projectId, relativePath: "", nextCursor: null,
    entries: [
      { name: ".git", relativePath: ".git", kind: "directory" },
      { name: "node_modules", relativePath: "node_modules", kind: "directory" },
      { name: "z-src", relativePath: "z-src", kind: "directory" },
      { name: "B.md", relativePath: "B.md", kind: "file" },
      { name: "a.md", relativePath: "a.md", kind: "file" },
    ],
  });
  assert.deepEqual(await service.listProjectDirectory({ projectId, relativePath: "z-src" }), {
    ok: true, projectId, relativePath: "z-src", nextCursor: null,
    entries: [{ name: "nested.txt", relativePath: "z-src/nested.txt", kind: "file" }],
  });
  assert.equal(projects.activeScope, null);
});

test("directory requests validate untrusted payloads before consulting the project registry", async () => {
  let lookups = 0;
  const service = new ProjectFilesService({ getDescriptor: async () => {
    lookups += 1;
    throw new Error("Unexpected registry access");
  } });
  const invalidPaths: unknown[] = [
    undefined, null, 1, "/tmp", "//server/share", "C:\\temp", "C:/temp", "C:temp", "\\\\server\\share",
    ".", "..", "../project-sibling", "src/../../outside", "src/../safe", "./src", "src/./child",
    "src//child", "src/", "src\\child", "src\0child", "a".repeat(4_097), "界".repeat(1_400),
  ];
  for (const relativePath of invalidPaths) failure(await service.listProjectDirectory({ projectId: "project", relativePath }), "invalid_request");
  for (const payload of [null, [], {}, "project", { projectId: null, relativePath: "" }, { projectId: " ", relativePath: "" }, { projectId: "a".repeat(257), relativePath: "" }]) {
    failure(await service.listProjectDirectory(payload), "invalid_request");
  }
  for (const cursor of [null, 123, "", "!", "x".repeat(16_385), Buffer.from("{}").toString("base64url"), Buffer.from("null").toString("base64url")]) {
    failure(await service.listProjectDirectory({ projectId: "project", relativePath: "", cursor }), "invalid_request");
  }
  assert.equal(lookups, 0);
});

test("project IDs are resolved through getDescriptor on every page, including after deletion", async (t) => {
  const { root, projects, projectId, service } = await fixture(t);
  failure(await service.listProjectDirectory({ projectId: "unknown", relativePath: "" }), "not_found");
  await populate(root, 201);
  const first = await service.listProjectDirectory({ projectId, relativePath: "" });
  success(first);
  assert.ok(first.nextCursor);
  await projects.delete(projectId);
  failure(await service.listProjectDirectory({ projectId, relativePath: "", cursor: first.nextCursor }), "not_found");
});

test("symlinks remain display-only, including internal aliases, broken links, and sibling-prefix escapes", async (t) => {
  const { directory, root, projectId, service } = await fixture(t);
  const outside = join(directory, "project-sibling");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "external contents");
  await mkdir(join(root, "real"));
  await writeFile(join(root, "real", "inside.txt"), "inside");
  await symlink(outside, join(root, "escape"), "dir");
  await symlink(join(root, "real"), join(root, "alias"), "dir");
  await symlink(join(outside, "secret.txt"), join(root, "file-link"));
  await symlink(join(directory, "missing"), join(root, "broken"));
  await symlink(root, join(root, "self"), "dir");
  await symlink("loop", join(root, "loop"));

  const listing = await service.listProjectDirectory({ projectId, relativePath: "" });
  success(listing);
  assert.deepEqual(listing.entries.map(({ name, kind }) => [name, kind]), [
    ["real", "directory"], ["alias", "symlink"], ["broken", "symlink"], ["escape", "symlink"],
    ["file-link", "symlink"], ["loop", "symlink"], ["self", "symlink"],
  ]);
  for (const relativePath of ["escape", "escape/secret.txt", "file-link"]) {
    failure(await service.listProjectDirectory({ projectId, relativePath }), "outside_project");
  }
  for (const relativePath of ["alias", "alias/inside.txt", "self", "self/real", "loop"]) {
    failure(await service.listProjectDirectory({ projectId, relativePath }), "symlink_not_allowed");
  }
  failure(await service.listProjectDirectory({ projectId, relativePath: "broken" }), "not_found");
});

test("a registered root replaced by a symlink is rejected before enumeration", async (t) => {
  const { directory, root, projectId, service } = await fixture(t);
  const moved = join(directory, "moved-project");
  await rename(root, moved);
  await writeFile(join(moved, "hidden.txt"), "keep private");
  await symlink(moved, root, "dir");
  failure(await service.listProjectDirectory({ projectId, relativePath: "" }), "project_changed");
});

test("missing directories and regular files produce safe structured errors while dot-prefixed names work", async (t) => {
  const { root, projectId, service } = await fixture(t);
  await writeFile(join(root, "file.txt"), "data");
  await mkdir(join(root, "..safe"));
  failure(await service.listProjectDirectory({ projectId, relativePath: "missing" }), "not_found");
  failure(await service.listProjectDirectory({ projectId, relativePath: "file.txt" }), "not_directory");
  failure(await service.listProjectDirectory({ projectId, relativePath: "file.txt/child" }), "not_directory");
  const listing = await service.listProjectDirectory({ projectId, relativePath: "..safe" });
  success(listing);
  assert.deepEqual(listing.entries, []);
});

test("bounded pages preserve global directory-first order without omissions or duplicates", async (t) => {
  const { root, projectId, service } = await fixture(t);
  const path = join(root, "nested");
  await mkdir(path);
  const directories = Array.from({ length: 230 }, (_, index) => `z-dir-${String(index).padStart(3, "0")}`);
  const files = Array.from({ length: 210 }, (_, index) => `a-file-${String(index).padStart(3, "0")}`);
  await Promise.all([
    ...directories.slice().reverse().map((name) => mkdir(join(path, name))),
    ...files.slice().reverse().map((name) => writeFile(join(path, name), "data")),
  ]);
  const allEntries = [];
  let cursor: string | undefined;
  const pageSizes = [];
  do {
    const result = await service.listProjectDirectory({ projectId, relativePath: "nested", cursor });
    success(result);
    assert.ok(result.entries.length <= PROJECT_DIRECTORY_PAGE_SIZE);
    assert.equal(result.relativePath, "nested");
    assert.equal(result.projectId, projectId);
    assert.deepEqual(await service.listProjectDirectory({ projectId, relativePath: "nested", cursor }), result);
    allEntries.push(...result.entries);
    pageSizes.push(result.entries.length);
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(pageSizes, [200, 200, 40]);
  assert.deepEqual(allEntries.map((entry) => entry.name), [...directories, ...files]);
  assert.equal(new Set(allEntries.map((entry) => entry.relativePath)).size, 440);
  assert.ok(allEntries.every((entry) => entry.relativePath === `nested/${entry.name}`));
});

test("an exactly full page ends with a null cursor", async (t) => {
  const { root, projectId, service } = await fixture(t);
  await populate(root, 200);
  const result = await service.listProjectDirectory({ projectId, relativePath: "" });
  success(result);
  assert.equal(result.entries.length, 200);
  assert.equal(result.nextCursor, null);
});

test("directory changes invalidate pagination and allow a fresh first-page retry", async (t) => {
  for (const change of ["add", "remove", "rename", "replace-directory"] as const) {
    await t.test(change, async (t) => {
      const { root, projectId, service } = await fixture(t);
      const path = join(root, "paged");
      await mkdir(path);
      await populate(path, 201);
      const first = await service.listProjectDirectory({ projectId, relativePath: "paged" });
      success(first);
      assert.ok(first.nextCursor);
      if (change === "add") await writeFile(join(path, "added.txt"), "new");
      if (change === "remove") await rm(join(path, "file-200.txt"));
      if (change === "rename") await rename(join(path, "file-200.txt"), join(path, "renamed.txt"));
      if (change === "replace-directory") {
        await rename(path, join(root, "old-paged"));
        await mkdir(path);
        await populate(path, 201);
      }
      // Make the version change deterministic on filesystems with coarse timestamp precision.
      await utimes(path, new Date("2030-01-01"), new Date("2030-01-01"));
      const stale = await service.listProjectDirectory({ projectId, relativePath: "paged", cursor: first.nextCursor });
      failure(stale, "stale_cursor");
      if (!stale.ok) assert.match(stale.message, /Retry from the first page/);
      success(await service.listProjectDirectory({ projectId, relativePath: "paged" }));
    });
  }
});

test("pagination cursors are bound to both project identity and relative directory", async (t) => {
  const { directory, root, projects, projectId, service } = await fixture(t);
  await mkdir(join(root, "other"));
  await populate(root, 201);
  const first = await service.listProjectDirectory({ projectId, relativePath: "" });
  success(first);
  assert.ok(first.nextCursor);
  failure(await service.listProjectDirectory({ projectId, relativePath: "other", cursor: first.nextCursor }), "stale_cursor");
  const otherRoot = join(directory, "other-project");
  await mkdir(otherRoot);
  const { descriptor } = await projects.selectPath(otherRoot);
  failure(await service.listProjectDirectory({ projectId: descriptor.projectId!, relativePath: "", cursor: first.nextCursor }), "stale_cursor");
  // Even two project identities resolving to the same physical directory cannot share cursors.
  const aliasService = new ProjectFilesService({ getDescriptor: async (id) => ({ projectId: id, canonicalPath: root, displayName: id }) });
  failure(await aliasService.listProjectDirectory({ projectId: "alias-id", relativePath: "", cursor: first.nextCursor }), "stale_cursor");
});

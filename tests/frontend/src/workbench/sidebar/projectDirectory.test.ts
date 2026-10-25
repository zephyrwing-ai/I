import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectDirectoryResult } from "../../../../../shell/shared/ipc.js";
import { createProjectDirectory } from "../../../../../frontend/src/workbench/sidebar/projectDirectory.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function page(relativePath: string, entries: Extract<ProjectDirectoryResult, { ok: true }>["entries"], nextCursor: string | null = null): ProjectDirectoryResult {
  return { ok: true, projectId: "project-a", relativePath, entries, nextCursor };
}

test("directory pages load once per path and append a cursor page without duplicates", async () => {
  const first = deferred<ProjectDirectoryResult>();
  const second = deferred<ProjectDirectoryResult>();
  const requests: Array<{ relativePath: string; cursor?: string }> = [];
  const directory = createProjectDirectory("project-a", {
    listProjectDirectory: (request) => {
      requests.push({ relativePath: request.relativePath, cursor: request.cursor });
      return request.cursor ? second.promise : first.promise;
    },
  });

  const initial = directory.load("");
  await directory.load("");
  assert.equal(requests.length, 1);
  assert.equal(directory.getSnapshot().directories[""]?.loading, true);

  first.resolve(page("", [
    { name: "docs", relativePath: "docs", kind: "directory" },
    { name: "a.md", relativePath: "a.md", kind: "file" },
  ], "next"));
  await initial;
  assert.deepEqual(directory.getSnapshot().directories[""]?.entries.map((entry) => entry.relativePath), ["docs", "a.md"]);

  const more = directory.load("", true);
  assert.equal(requests.at(-1)?.cursor, "next");
  second.resolve(page("", [
    { name: "a.md", relativePath: "a.md", kind: "file" },
    { name: "b.md", relativePath: "b.md", kind: "file" },
  ]));
  await more;
  assert.deepEqual(directory.getSnapshot().directories[""]?.entries.map((entry) => entry.relativePath), ["docs", "a.md", "b.md"]);
});

test("refresh invalidates an in-flight child page while preserving filter, expansion and selection", async () => {
  const child = deferred<ProjectDirectoryResult>();
  const refreshedRoot = deferred<ProjectDirectoryResult>();
  let rootReads = 0;
  const directory = createProjectDirectory("project-a", {
    listProjectDirectory: (request) => {
      if (request.relativePath === "") {
        rootReads += 1;
        return rootReads === 1
          ? Promise.resolve(page("", [{ name: "docs", relativePath: "docs", kind: "directory" }]))
          : refreshedRoot.promise;
      }
      return child.promise;
    },
  });

  await directory.load("");
  directory.filter("guide");
  directory.toggle("docs");
  assert.equal(directory.getSnapshot().directories.docs?.loading, true);

  directory.refresh();
  assert.equal(directory.getSnapshot().directories.docs, undefined);
  assert.equal(directory.getSnapshot().filter, "guide");
  assert.equal(directory.getSnapshot().selectedPath, "docs");
  assert.equal(directory.getSnapshot().expanded.has("docs"), true);

  child.resolve(page("docs", [{ name: "guide.md", relativePath: "docs/guide.md", kind: "file" }]));
  await Promise.resolve();
  assert.equal(directory.getSnapshot().directories.docs, undefined);

  refreshedRoot.resolve(page("", [{ name: "docs", relativePath: "docs", kind: "directory" }]));
  await directory.load("");
  assert.deepEqual(directory.getSnapshot().directories[""]?.entries.map((entry) => entry.relativePath), ["docs"]);
});

test("responses for another project or directory reject instead of entering the current cache", async () => {
  const directory = createProjectDirectory("project-a", {
    listProjectDirectory: async (request) => ({
      ok: true,
      projectId: "project-b",
      relativePath: request.relativePath,
      entries: [{ name: "foreign.md", relativePath: "foreign.md", kind: "file" }],
      nextCursor: null,
    }),
  });

  await directory.load("");
  const state = directory.getSnapshot().directories[""];
  assert.equal(state?.entries.length, 0);
  assert.match(state?.error ?? "", /another location/);
});

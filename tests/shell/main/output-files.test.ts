import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OutputFileRegistry } from "../../../shell/main/output-files.js";

test("OutputFileRegistry registers created files and previews updates by opaque id", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-studio-output-"));
  const directory = await realpath(temporary);
  try {
    const path = join(directory, "result.md");
    await writeFile(path, "# first\n", "utf8");
    const registry = new OutputFileRegistry();
    const [created] = registry.register("run-1", directory, [{
      path,
      operation: "created",
      mediaType: "text/markdown",
      byteSize: 8,
      updatedAt: new Date().toISOString(),
    }]);
    assert.equal(created.displayPath, "result.md");

    const preview = await registry.preview("run-1", created.fileId);
    assert.equal(preview.ok, true);
    assert.equal(preview.ok && preview.kind, "text");
    assert.equal(preview.ok && preview.kind === "text" && preview.content, "# first\n");

    await writeFile(path, "# second\n", "utf8");
    const [updated] = registry.register("run-1", directory, [{
      path,
      operation: "updated",
      mediaType: "text/markdown",
      byteSize: 9,
      updatedAt: new Date().toISOString(),
    }]);
    assert.equal(updated.fileId, created.fileId);
    assert.equal(updated.operation, "updated");

    const unrelated = registry.register("run-1", directory, [{
      path: join(directory, "not-registered.txt"),
      operation: "updated",
      mediaType: "text/plain",
      byteSize: 1,
      updatedAt: new Date().toISOString(),
    }]);
    assert.deepEqual(unrelated, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

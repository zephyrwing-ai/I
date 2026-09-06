import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { composeTaskWithAttachments, InputAttachmentRegistry } from "../../../shell/main/input-attachments.js";

test("input attachments expose opaque ids and resolve only Main-registered files", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-studio-attachment-"));
  const directory = await realpath(temporary);
  try {
    const path = join(directory, "brief.md");
    await writeFile(path, "# brief\n", "utf8");
    const registry = new InputAttachmentRegistry();
    const [descriptor] = await registry.register([path]);
    assert.equal(descriptor.name, "brief.md");
    assert.equal(descriptor.mediaType, "text/markdown");
    assert.equal("path" in descriptor, false);

    const [resolved] = await registry.resolve([descriptor.attachmentId]);
    assert.equal(resolved.path, path);
    const task = composeTaskWithAttachments("summarize", [resolved]);
    assert.match(task, /summarize/);
    assert.match(task, /brief\.md/);
    assert.match(task, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await assert.rejects(() => registry.resolve(["unknown-id"]), /附件不存在或已经失效/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

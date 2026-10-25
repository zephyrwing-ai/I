import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttachmentStore } from "../../../shell/main/attachments/store.js";
import { createAttachmentProcessor } from "../../../shell/main/attachments/processors.js";
import { attachmentResourceResponse } from "../../../shell/main/attachments/resources.js";
import { createAttachmentReadTool } from "../../../agent/tools/attachment-read.js";

test("directory access creates and returns the configured empty store before any upload", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "attachment-directory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storeDirectory = join(directory, "configured", "assets");
  const store = new AttachmentStore(storeDirectory, createAttachmentProcessor({ runtimeDirectory: directory, workerPath: "unused" }));

  await assert.rejects(readdir(storeDirectory), { code: "ENOENT" });
  assert.equal(await store.ensureDirectory(), storeDirectory);
  assert.deepEqual(await readdir(storeDirectory), []);
  assert.equal(await store.ensureDirectory(), storeDirectory);
  assert.deepEqual(await readdir(storeDirectory), []);
});

test("attachments own original bytes, deduplicate, and survive source removal and restart", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "i-attachment-"));
  const directory = await realpath(temporary);
  try {
    const path = join(directory, "brief.md");
    await writeFile(path, "# brief\n", "utf8");
    const storeDirectory = join(directory, "store");
    const processor = createAttachmentProcessor({ runtimeDirectory: directory, workerPath: "unused.py" });
    const registry = new AttachmentStore(storeDirectory, processor);
    const { attachments: [descriptor], errors } = await registry.register([path, path]);
    assert.deepEqual(errors, []);
    assert.equal(descriptor.name, "brief.md");
    assert.equal(descriptor.mediaType, "text/markdown");
    assert.equal("path" in descriptor, false);

    const [resolved] = await registry.resolve([descriptor.attachmentId]);
    assert.notEqual(resolved.path, path);
    assert.match(resolved.input.text, /1 \| # brief/);
    assert.equal(resolved.input.text.includes(directory), false);
    await rm(path);
    const restarted = new AttachmentStore(storeDirectory, processor);
    const [restored] = await restarted.resolve([descriptor.attachmentId]);
    assert.deepEqual(restored.input, resolved.input);
    const originalPath = await restarted.originalPath(descriptor.attachmentId);
    assert.equal(await readFile(originalPath, "utf8"), "# brief\n");
    const page = await restarted.read({ attachmentId: descriptor.attachmentId, limit: 1 });
    assert.equal(page.ok, true);
    assert.match(page.output, /nextOffset/);
    assert.equal(page.truncated, true);
    await assert.rejects(() => registry.resolve(["unknown-id"]), /identity is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an import reports per-file errors while retaining successful files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "attachment-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AttachmentStore(join(directory, "assets"), createAttachmentProcessor({ runtimeDirectory: directory, workerPath: "unused" }));
  const result = await store.import([
    { path: join(directory, "missing.txt") },
    { name: "valid.txt", bytes: Buffer.from("valid") },
    { name: "binary.bin", bytes: Buffer.from([0, 1, 255]) },
  ]);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.errors.length, 2);
  assert.equal(result.attachments[0].name, "valid.txt");
});

test("prepared images resolve outside history payloads and support safe media range requests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "attachment-image-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AttachmentStore(join(directory, "assets"), async ({ outputDirectory }) => {
    await writeFile(join(outputDirectory, "image.jpg"), Buffer.from([255, 216, 255, 217]));
    return { text: "image", images: [{ fileName: "image.jpg", mediaType: "image/jpeg", label: "Image" }], previewFile: "image.jpg", truncated: false };
  });
  const { attachments: [descriptor] } = await store.import([{ name: "example.jpg", bytes: Buffer.from([255, 216, 255, 217]) }]);
  const [resolved] = await store.resolve([descriptor.attachmentId]);
  assert.equal(JSON.stringify(resolved.input).includes("base64"), false);
  const images = await store.resolveModelImages(resolved.input);
  assert.equal(images[0].dataUrl, "data:image/jpeg;base64,/9j/2Q==");
  const tool = createAttachmentReadTool(store.read);
  const output = await tool.execute({ attachmentId: descriptor.attachmentId, imageIndex: 0 }, { cwd: directory });
  assert.deepEqual(output.media, images[0]);
  const range = await attachmentResourceResponse(store, new Request(descriptor.mediaUrl!, { headers: { Range: "bytes=1-2" } }));
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("Content-Range"), "bytes 1-2/4");
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.from([216, 255]));
  const invalid = await attachmentResourceResponse(store, new Request(descriptor.mediaUrl!, { headers: { Range: "bytes=8-9" } }));
  assert.equal(invalid.status, 416);
  assert.equal((await attachmentResourceResponse(store, new Request(`attachment://${descriptor.attachmentId}/manifest.json`))).status, 404);
  assert.equal((await attachmentResourceResponse(store, new Request(descriptor.previewUrl!, { method: "HEAD" }))).headers.get("Content-Length"), "4");
});

test("shutdown aborts admitted preparation and waits for staging cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "attachment-shutdown-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let notify!: () => void;
  const started = new Promise<void>((resolve) => { notify = resolve; });
  const store = new AttachmentStore(join(directory, "assets"), async (_input, signal) => {
    notify();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("Preparation cancelled")), { once: true }));
    throw new Error("Unreachable");
  });
  const importing = store.import([{ name: "wait.txt", bytes: Buffer.from("source") }]);
  await started;
  await store.dispose();
  const result = await importing;
  assert.match(result.errors[0].message, /cancelled/);
  assert.deepEqual(await readdir(join(directory, "assets")), []);
  await assert.rejects(store.import([]), /shutting down/);
});

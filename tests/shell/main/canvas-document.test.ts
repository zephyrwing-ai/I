import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CanvasDocument } from "../../../shell/shared/ipc.js";
import { CanvasDocumentStore } from "../../../shell/main/canvas-document.js";
import { CanvasContextRegistry } from "../../../shell/main/canvas-context.js";

const image = "data:image/png;base64,AA==";

function document(): CanvasDocument {
  return {
    elements: [{ id: "text-1", type: "text", x: 10, y: 20, text: "Canvas note" }],
    appState: { viewBackgroundColor: "#fff" },
    files: { "image-1": { id: "image-1", mimeType: "image/png", dataURL: image, created: 1 } },
  };
}

test("CanvasDocumentStore persists scene metadata and image assets separately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-canvas-"));
  try {
    const store = new CanvasDocumentStore(directory, "session-test");
    const revision = await store.save(document());
    assert.equal(revision, 1);
    const scenePath = join(directory, "canvases", "session-test", "scene.json");
    const scene = await readFile(scenePath, "utf8");
    assert.doesNotMatch(scene, /data:image\/png/);
    await stat(join(directory, "canvases", "session-test", "image-1.png"));

    const restored = await new CanvasDocumentStore(directory, "session-test").load();
    assert.equal(restored.revision, 1);
    assert.equal(restored.document.files["image-1"]?.dataURL, image);
    assert.equal(restored.document.elements[0]?.text, "Canvas note");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasContextRegistry creates a bounded reference and consumes it once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-canvas-context-"));
  try {
    const registry = new CanvasContextRegistry(new CanvasDocumentStore(directory, "session-test"));
    const descriptor = await registry.prepare({
      document: document(),
      scope: "selection",
      selectedElementIds: ["text-1"],
      visual: { mediaType: "image/png", dataURL: image },
    });
    assert.equal(descriptor.elementCount, 1);
    assert.equal(descriptor.hasVisual, true);
    const [context] = registry.takeMany([descriptor.contextId]);
    assert.match(context.text, /Canvas note/);
    assert.equal(context.visual?.dataURL, image);
    assert.throws(() => registry.takeMany([descriptor.contextId]), /expired/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

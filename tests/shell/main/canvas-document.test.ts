import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CanvasContextInput, CanvasDocument } from "../../../shell/shared/ipc.js";
import { CanvasDocumentStore } from "../../../canvas/persistence/CanvasDocumentStore.js";
import { CanvasContextRegistry } from "../../../canvas/context/CanvasContextRegistry.js";

const image = "data:image/png;base64,AA==";
const selectionLocation = {
  coordinateSpace: "scene" as const,
  selectionBounds: { x: -10.5, y: 20.25, width: 95.75, height: 0 },
};

function document(text = "Canvas note"): CanvasDocument {
  return {
    elements: [{ id: "text-1", type: "text", x: 10, y: 20, text }],
    appState: { viewBackgroundColor: "#fff" },
    files: { "image-1": { id: "image-1", mimeType: "image/png", dataURL: image, created: 1 } },
  };
}

function selectionJSON(elements: Record<string, unknown>[], files: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements, appState: {}, files });
}

test("CanvasDocumentStore keeps each project's scene and immutable image asset together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-canvas-"));
  try {
    const store = new CanvasDocumentStore(directory);
    assert.equal(await store.save("project-a", document()), 1);
    assert.equal(await store.save("project-b", document("Other project")), 1);

    const scenePath = join(directory, "canvases", "project-a", "scene.json");
    const scene = JSON.parse(await readFile(scenePath, "utf8")) as {
      files: Record<string, { assetName: string }>;
    };
    assert.ok(scene.files["image-1"]?.assetName);
    await stat(join(directory, "canvases", "project-a", scene.files["image-1"].assetName));
    assert.doesNotMatch(await readFile(scenePath, "utf8"), /data:image\/png/);

    const restoredA = await new CanvasDocumentStore(directory).load("project-a");
    const restoredB = await store.load("project-b");
    assert.equal(restoredA.revision, 1);
    assert.equal(restoredA.document.files["image-1"]?.dataURL, image);
    assert.equal(restoredA.document.elements[0]?.text, "Canvas note");
    assert.equal(restoredB.document.elements[0]?.text, "Other project");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore serializes overlapping writes and makes load wait for the latest scene", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-canvas-queue-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const first = store.save("project-a", document("First"));
    const second = store.save("project-a", document("Second"));
    const loaded = store.load("project-a");
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.equal((await loaded).document.elements[0]?.text, "Second");
    assert.equal((await loaded).revision, 2);
    assert.throws(() => store.save("../project-b", document()), /identity is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore reads legacy image filenames and migrates them on the next save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-canvas-legacy-"));
  try {
    const projectDirectory = join(directory, "canvases", "project-a");
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(projectDirectory, "image-1.png"), Buffer.from([0]));
    await writeFile(join(projectDirectory, "scene.json"), JSON.stringify({
      revision: 3,
      elements: [{ id: "image-element", type: "image", fileId: "image-1" }],
      appState: {},
      files: { "image-1": { id: "image-1", mimeType: "image/png", created: 1 } },
    }));
    const store = new CanvasDocumentStore(directory);
    const loaded = await store.load("project-a");
    assert.equal(loaded.revision, 3);
    assert.equal(loaded.document.files["image-1"]?.dataURL, image);
    assert.equal(await store.save("project-a", loaded.document), 4);
    const stored = JSON.parse(await readFile(join(projectDirectory, "scene.json"), "utf8"));
    assert.match(stored.files["image-1"].assetName, /^image-1\.[a-f0-9]{64}\.png$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore accepts a later save after one project write fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-canvas-retry-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const missingImage = document("Missing asset");
    delete missingImage.files["image-1"]!.dataURL;
    await assert.rejects(store.save("project-a", missingImage), /ENOENT/);
    assert.equal(await store.save("project-a", document("Recovered")), 1);
    assert.equal((await store.load("project-a")).document.elements[0]?.text, "Recovered");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasContextRegistry freezes selected JSON without writing a scene", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-canvas-context-"));
  try {
    const registry = new CanvasContextRegistry();
    const descriptor = await registry.prepare({
      ...selectionLocation,
      projectId: "project-a",
      scope: "selection",
      selectedElementIds: ["text-1"],
      serializedJSON: selectionJSON([{ id: "text-1", type: "text", x: 10, y: 20, text: "Canvas note" }]),
    });
    assert.equal(descriptor.elementCount, 1);
    assert.equal(descriptor.hasVisual, false);
    assert.equal((await new CanvasDocumentStore(directory).load("project-a")).revision, 0);

    const [context] = registry.peekMany([descriptor.contextId], "project-a");
    assert.equal(JSON.parse(context.text).elements[0].text, "Canvas note");
    assert.deepEqual(JSON.parse(context.text).canvasContext, selectionLocation);
    assert.equal(registry.peekMany([descriptor.contextId], "project-a").length, 1);
    assert.throws(() => registry.peekMany([descriptor.contextId], "project-b"), /another project/);
    registry.consumeMany([descriptor.contextId]);
    assert.throws(() => registry.peekMany([descriptor.contextId], "project-a"), /expired/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasContextRegistry validates selection identity and keeps image binary outside JSON", async () => {
  const registry = new CanvasContextRegistry();
  const serializedJSON = selectionJSON(
    [{ id: "image-element", type: "image", fileId: "image-1" }],
    { "image-1": { id: "image-1", mimeType: "image/png", dataURL: image } },
  );
  const descriptor = await registry.prepare({
    ...selectionLocation,
    projectId: null,
    scope: "selection",
    selectedElementIds: ["image-element"],
    serializedJSON,
    visual: { mediaType: "image/png", dataURL: image },
  });
  const [context] = registry.peekMany([descriptor.contextId], null);
  assert.equal(descriptor.hasVisual, true);
  assert.equal(context.visual?.dataURL, image);
  assert.equal(JSON.parse(context.text).files["image-1"].dataURL, undefined);

  await assert.rejects(
    registry.prepare({
      ...selectionLocation,
      projectId: null,
      scope: "selection",
      selectedElementIds: ["another-element"],
      serializedJSON,
    }),
    /does not match/,
  );
  await assert.rejects(
    registry.prepare({
      ...selectionLocation,
      projectId: null,
      scope: "document" as CanvasContextInput["scope"],
      selectedElementIds: [],
      serializedJSON,
    }),
    /scope is invalid/,
  );
  await assert.rejects(
    registry.prepare({
      ...selectionLocation,
      projectId: null,
      scope: "selection",
      selectedElementIds: ["text-1"],
      serializedJSON: selectionJSON([{ id: "text-1", type: "text", text: "Direct text" }]),
      visual: { mediaType: "image/png", dataURL: image },
    }),
    /visual snapshot is invalid/,
  );
  await assert.rejects(
    registry.prepare({
      ...selectionLocation,
      selectionBounds: { x: 0, y: 0, width: -1, height: 20 },
      projectId: null,
      scope: "selection",
      selectedElementIds: ["image-element"],
      serializedJSON,
    }),
    /selection bounds are invalid/,
  );
});

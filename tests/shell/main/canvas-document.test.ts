import assert from "node:assert/strict";
import test from "node:test";
import { promises as filesystem } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const savedA = await store.save("project-a", document(), (await store.load("project-a")).version);
    const savedB = await store.save("project-b", document("Other project"), (await store.load("project-b")).version);
    assert.equal(savedA.status, "saved");
    assert.equal(savedA.version.revision, 1);
    assert.equal(savedB.status, "saved");
    assert.equal(savedB.version.revision, 1);

    const scenePath = join(directory, "canvases", "project-a", "scene.json");
    const scene = JSON.parse(await readFile(scenePath, "utf8")) as {
      files: Record<string, { assetName: string }>;
    };
    assert.ok(scene.files["image-1"]?.assetName);
    await stat(join(directory, "canvases", "project-a", scene.files["image-1"].assetName));
    assert.doesNotMatch(await readFile(scenePath, "utf8"), /data:image\/png/);

    const restoredA = await new CanvasDocumentStore(directory).load("project-a");
    const restoredB = await store.load("project-b");
    assert.deepEqual(restoredA.version, savedA.version);
    assert.equal(restoredA.document.files["image-1"]?.dataURL, image);
    assert.equal(restoredA.document.elements[0]?.text, "Canvas note");
    assert.equal(restoredB.document.elements[0]?.text, "Other project");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore serializes overlapping writes and rejects a queued stale baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-queue-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const initialVersion = (await store.load("project-a")).version;
    const first = store.save("project-a", document("First"), initialVersion);
    const second = store.save("project-a", document("Second"), initialVersion);
    const loaded = store.load("project-a");
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.status, "saved");
    assert.equal(secondResult.status, "conflict");
    assert.deepEqual(secondResult.version, firstResult.version);
    assert.equal((await loaded).document.elements[0]?.text, "First");
    assert.equal((await loaded).version.revision, 1);
    assert.throws(() => store.save("../project-b", document(), initialVersion), /identity is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore reads legacy image filenames and migrates them on the next save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-legacy-"));
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
    assert.equal(loaded.version.revision, 3);
    assert.equal(loaded.document.files["image-1"]?.dataURL, image);
    const saved = await store.save("project-a", loaded.document, loaded.version);
    assert.equal(saved.status, "saved");
    assert.equal(saved.version.revision, 4);
    const stored = JSON.parse(await readFile(join(projectDirectory, "scene.json"), "utf8"));
    assert.match(stored.files["image-1"].assetName, /^image-1\.[a-f0-9]{64}\.png$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore accepts a later save after one project write fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-retry-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const initialVersion = (await store.load("project-a")).version;
    const missingImage = document("Missing asset");
    delete missingImage.files["image-1"]!.dataURL;
    await assert.rejects(store.save("project-a", missingImage, initialVersion), /ENOENT/);
    const recovered = await store.save("project-a", document("Recovered"), initialVersion);
    assert.equal(recovered.status, "saved");
    assert.equal(recovered.version.revision, 1);
    assert.equal((await store.load("project-a")).document.elements[0]?.text, "Recovered");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore keeps external same-revision edits when stale editor memory saves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-conflict-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const initialVersion = (await store.load("project-a")).version;
    const first = await store.save("project-a", document("User rectangle"), initialVersion);
    const scenePath = join(directory, "canvases", "project-a", "scene.json");
    const externalScene = JSON.parse(await readFile(scenePath, "utf8"));
    externalScene.elements.push({ id: "model-circle", type: "ellipse", x: 30, y: 40 });
    await writeFile(scenePath, JSON.stringify(externalScene));

    const result = await store.save("project-a", document("User moved rectangle"), first.version);
    assert.equal(result.status, "conflict");
    assert.equal(result.version.revision, first.version.revision);
    assert.notEqual(result.version.fingerprint, first.version.fingerprint);
    assert.deepEqual(JSON.parse(await readFile(scenePath, "utf8")), externalScene);
    assert.deepEqual((await store.load("project-a")).version, result.version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore checks the scene again after preparing image assets", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-commit-check-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const first = await store.save("project-a", document(), (await store.load("project-a")).version);
    const scenePath = join(directory, "canvases", "project-a", "scene.json");
    const externalScene = JSON.parse(await readFile(scenePath, "utf8"));
    externalScene.elements.push({ id: "external-element", type: "ellipse", x: 30, y: 40 });
    const assetPath = join(directory, "canvases", "project-a", externalScene.files["image-1"].assetName);
    const originalStat = filesystem.stat;
    let changedDuringPreparation = false;
    context.mock.method(filesystem, "stat", async (path: string) => {
      if (path === assetPath && !changedDuringPreparation) {
        changedDuringPreparation = true;
        await writeFile(scenePath, JSON.stringify(externalScene));
      }
      return originalStat(path);
    });
    syncBuiltinESMExports();

    const result = await store.save("project-a", document("Pending user save"), first.version);
    assert.equal(changedDuringPreparation, true);
    assert.equal(result.status, "conflict");
    assert.deepEqual(JSON.parse(await readFile(scenePath, "utf8")), externalScene);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore replaces content-addressed image assets after the scene commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-assets-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const first = await store.save("project-a", document(), (await store.load("project-a")).version);
    const projectDirectory = join(directory, "canvases", "project-a");
    const scenePath = join(projectDirectory, "scene.json");
    const firstScene = JSON.parse(await readFile(scenePath, "utf8"));
    const updated = document();
    updated.files["image-1"]!.dataURL = "data:image/png;base64,AQ==";
    const second = await store.save("project-a", updated, first.version);
    assert.equal(second.status, "saved");
    assert.equal(second.version.revision, 2);
    const secondScene = JSON.parse(await readFile(scenePath, "utf8"));
    assert.notEqual(secondScene.files["image-1"].assetName, firstScene.files["image-1"].assetName);
    assert.deepEqual(await readFile(join(projectDirectory, secondScene.files["image-1"].assetName)), Buffer.from([1]));
    await assert.rejects(stat(join(projectDirectory, firstScene.files["image-1"].assetName)), /ENOENT/);
    assert.equal((await store.load("project-a")).document.files["image-1"]!.dataURL, updated.files["image-1"]!.dataURL);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore acknowledges identical retries and captures each queued input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-idempotent-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const initial = await store.load("project-a");
    const initialVersion = initial.version;
    assert.deepEqual((await new CanvasDocumentStore(directory).load("project-a")).version, initialVersion);
    assert.deepEqual(await store.save("project-a", initial.document, initialVersion), { status: "saved", version: initialVersion });
    const first = store.save("project-a", document("Saved scene"), initialVersion);
    const queuedDocument = document("Saved scene");
    const queuedVersion = { ...initialVersion };
    const duplicate = store.save("project-a", queuedDocument, queuedVersion);
    queuedDocument.elements[0]!.text = "Mutation after enqueue";
    queuedVersion.revision = 99;
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    assert.deepEqual(duplicateResult, firstResult);
    assert.equal(firstResult.version.revision, 1);
    const loaded = await store.load("project-a");
    assert.equal(loaded.document.elements[0]?.text, "Saved scene");

    const scenePath = join(directory, "canvases", "project-a", "scene.json");
    const serialized = await readFile(scenePath, "utf8");
    assert.deepEqual(await store.save("project-a", loaded.document, loaded.version), firstResult);
    assert.equal(await readFile(scenePath, "utf8"), serialized);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore fingerprints normalized content and resource metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-fingerprint-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const initialVersion = (await store.load("project-a")).version;
    const first = await store.save("project-a", document(), initialVersion);
    const scenePath = join(directory, "canvases", "project-a", "scene.json");
    const scene = JSON.parse(await readFile(scenePath, "utf8"));
    const reordered = {
      files: scene.files,
      appState: scene.appState,
      elements: scene.elements.map((element: Record<string, unknown>) => Object.fromEntries(Object.entries(element).reverse())),
      revision: scene.revision,
    };
    await writeFile(scenePath, JSON.stringify(reordered, null, 2));
    assert.deepEqual((await store.load("project-a")).version, first.version);

    scene.files["image-1"].lastRetrieved = 2;
    await writeFile(scenePath, JSON.stringify(scene));
    const result = await store.save("project-a", document("Changed text"), first.version);
    assert.equal(result.status, "conflict");
    assert.notEqual(result.version.fingerprint, first.version.fingerprint);
    assert.deepEqual(JSON.parse(await readFile(scenePath, "utf8")), scene);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore preserves malformed stored documents and rejects their save baselines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-malformed-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const initialVersion = (await store.load("project-a")).version;
    const projectDirectory = join(directory, "canvases", "project-a");
    await mkdir(projectDirectory, { recursive: true });
    const scenePath = join(projectDirectory, "scene.json");
    const empty = { revision: 0, elements: [], appState: {}, files: {} };
    const malformedDocuments = [
      null,
      [],
      { ...empty, revision: "0" },
      { ...empty, revision: -1 },
      { ...empty, elements: "Externally edited content" },
      { ...empty, elements: null },
      { ...empty, elements: [null] },
      { ...empty, appState: null },
      { ...empty, files: [] },
      { ...empty, files: { "image-1": null } },
      { ...empty, files: { "image-1": { id: "image-1", mimeType: "image/png", created: null } } },
      { ...empty, files: { "image-1": { id: "image-1", mimeType: "image/png", created: 1, assetName: "../image.png" } } },
    ];
    for (const malformed of malformedDocuments) {
      const serialized = JSON.stringify(malformed, null, 2);
      await writeFile(scenePath, serialized);
      await assert.rejects(store.load("project-a"), /canvas/);
      await assert.rejects(store.save("project-a", document("New user draft"), initialVersion), /canvas/);
      assert.equal(await readFile(scenePath, "utf8"), serialized, "malformed disk content survives a stale save attempt");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore restores missing legacy fields with explicit empty defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-legacy-defaults-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const missingVersion = (await store.load("project-a")).version;
    const projectDirectory = join(directory, "canvases", "project-a");
    await mkdir(projectDirectory, { recursive: true });
    const scenePath = join(projectDirectory, "scene.json");
    await writeFile(scenePath, "{}");
    const loaded = await store.load("project-a");
    assert.deepEqual(loaded.document.elements, []);
    assert.deepEqual(loaded.document.appState, {});
    assert.deepEqual(Object.keys(loaded.document.files), []);
    assert.deepEqual(loaded.version, missingVersion);
    const saved = await store.save("project-a", document("Legacy recovery"), loaded.version);
    assert.equal(saved.status, "saved");
    assert.equal(saved.version.revision, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore round-trips image identifiers that match object prototype properties", async () => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-resource-id-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const files = JSON.parse(JSON.stringify({
      ["__proto__"]: { id: "__proto__", mimeType: "image/png", dataURL: image, created: 1 },
      constructor: { id: "constructor", mimeType: "image/png", dataURL: image, created: 1 },
    }));
    const incoming: CanvasDocument = {
      elements: [{ id: "image-element", type: "image", fileId: "__proto__" }], appState: {}, files,
    };
    const saved = await store.save("project-a", incoming, (await store.load("project-a")).version);
    assert.equal(saved.status, "saved");
    const stored = JSON.parse(await readFile(join(directory, "canvases", "project-a", "scene.json"), "utf8"));
    assert.deepEqual(Object.keys(stored.files).sort(), ["__proto__", "constructor"]);
    const restored = await store.load("project-a");
    assert.deepEqual(Object.keys(restored.document.files).sort(), ["__proto__", "constructor"]);
    assert.equal(restored.document.files["__proto__"]!.dataURL, image);
    assert.equal(restored.document.files["constructor"]!.dataURL, image);
    assert.deepEqual(await store.save("project-a", restored.document, restored.version), saved);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore verifies and rebuilds missing assets before acknowledging identical scenes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-noop-assets-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const initialVersion = (await store.load("project-a")).version;
    const first = await store.save("project-a", document(), initialVersion);
    const projectDirectory = join(directory, "canvases", "project-a");
    const scenePath = join(projectDirectory, "scene.json");
    const serialized = await readFile(scenePath, "utf8");
    const stored = JSON.parse(serialized);
    const assetPath = join(projectDirectory, stored.files["image-1"].assetName);
    await rm(assetPath);
    const duplicate = await store.save("project-a", document(), initialVersion);
    assert.deepEqual(duplicate, first, "lost acknowledgements retain the committed revision after asset repair");
    assert.deepEqual(await readFile(assetPath), Buffer.from([0]));
    assert.equal(await readFile(scenePath, "utf8"), serialized);

    const withoutBytes = document();
    delete withoutBytes.files["image-1"]!.dataURL;
    await rm(assetPath);
    await assert.rejects(store.save("project-a", withoutBytes, first.version), /ENOENT/);
    assert.equal(await readFile(scenePath, "utf8"), serialized);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasDocumentStore detects disk edits during identical-scene asset verification", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-noop-conflict-"));
  try {
    const store = new CanvasDocumentStore(directory);
    const initialVersion = (await store.load("project-a")).version;
    const first = await store.save("project-a", document(), initialVersion);
    const scenePath = join(directory, "canvases", "project-a", "scene.json");
    const externalScene = JSON.parse(await readFile(scenePath, "utf8"));
    externalScene.elements.push({ id: "external-element", type: "ellipse", x: 30, y: 40 });
    const assetPath = join(directory, "canvases", "project-a", externalScene.files["image-1"].assetName);
    const originalStat = filesystem.stat;
    let changedDuringVerification = false;
    context.mock.method(filesystem, "stat", async (path: string) => {
      if (path === assetPath && !changedDuringVerification) {
        changedDuringVerification = true;
        await writeFile(scenePath, JSON.stringify(externalScene));
      }
      return originalStat(path);
    });
    syncBuiltinESMExports();

    const retry = await store.save("project-a", document(), initialVersion);
    assert.equal(changedDuringVerification, true);
    assert.equal(retry.status, "conflict");
    assert.equal(retry.version.revision, first.version.revision);
    assert.notEqual(retry.version.fingerprint, first.version.fingerprint);
    assert.deepEqual(JSON.parse(await readFile(scenePath, "utf8")), externalScene);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("CanvasContextRegistry freezes selected JSON without writing a scene", async () => {
  const directory = await mkdtemp(join(tmpdir(), "i-canvas-context-"));
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
    assert.equal((await new CanvasDocumentStore(directory).load("project-a")).version.revision, 0);

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

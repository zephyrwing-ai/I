import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CanvasDocumentStore } from "../../canvas/persistence/CanvasDocumentStore.js";
import { CanvasSaveCoordinator, CanvasSaveConflictError } from "../../canvas/persistence/CanvasSaveCoordinator.js";
import type { CanvasDocument } from "../../shell/shared/ipc.js";

function scene(text: string): CanvasDocument {
  return { elements: [{ id: "text-1", type: "text", text }], appState: {}, files: {} };
}

test("Renderer save coordination and Main storage preserve both drafts on an external same-revision edit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canvas-save-pipeline-"));
  const store = new CanvasDocumentStore(directory);
  let calls = 0;
  const coordinator = new CanvasSaveCoordinator({
    projectId: "project-a", initial: await store.load("project-a"), debounceMs: 60_000,
    save: (request) => {
      calls += 1;
      return store.save(request.projectId, request.document, request.expectedVersion);
    },
  });
  try {
    coordinator.update(scene("Saved user content"));
    await coordinator.flush();
    coordinator.update(scene("New user content"));
    await coordinator.flush();
    const path = join(directory, "canvases", "project-a", "scene.json");
    const external = JSON.parse(await readFile(path, "utf8"));
    external.elements.push({ id: "external-rectangle", type: "rectangle", x: 100, y: 100 });
    await writeFile(path, JSON.stringify(external));
    coordinator.update(scene("Local draft after the external edit"));
    await assert.rejects(coordinator.flush(), CanvasSaveConflictError);
    assert.equal(calls, 3);
    assert.equal(coordinator.state.phase, "conflict");
    assert.equal(coordinator.document.elements[0].text, "Local draft after the external edit");
    const preserved = await store.load("project-a");
    assert.equal(preserved.document.elements[0].text, "New user content");
    assert.equal(preserved.document.elements[1].id, "external-rectangle");
    assert.equal(preserved.version.revision, external.revision);
    await assert.rejects(coordinator.flush(), CanvasSaveConflictError);
    assert.equal(calls, 3, "conflict acknowledgement stops repeated stale submissions");
  } finally {
    coordinator.dispose();
    await store.waitForIdle();
    await rm(directory, { recursive: true, force: true });
  }
});

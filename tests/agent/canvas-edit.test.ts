import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasEditTool, type CanvasEditExecutor } from "../../agent/tools/canvas-edit.js";
import type { CanvasEditResult } from "../../canvas/commands/types.js";

const context = { cwd: process.cwd() };
const create = { operations: [{ action: "create", element: { type: "rectangle", x: 10, y: 20, width: 120, height: 80 } }] };

test("Canvas creation without selection uses the bound editor executor and waits for confirmation", async () => {
  let confirm!: (result: CanvasEditResult) => void;
  let dispatched = false;
  const execute: CanvasEditExecutor = async (owner, body) => {
    dispatched = true;
    assert.equal(owner, 42);
    assert.equal(body.projectId, "project-a");
    assert.equal(body.runId, "run-a");
    assert.deepEqual(body.sourceElements, []);
    assert.deepEqual(body.operations, create.operations);
    return new Promise((resolve) => { confirm = resolve; });
  };
  const tool = createCanvasEditTool({ runId: "run-a", projectId: "project-a", ownerWebContentsId: 42, sourceElements: [], execute });
  let completed = false;
  const pending = tool.execute({ ...create, projectId: "model-project", ownerWebContentsId: 999 }, context)
    .then((result) => { completed = true; return result; });
  assert.equal(dispatched, true);
  await Promise.resolve();
  assert.equal(completed, false);
  confirm({ requestId: "edit-a", runId: "run-a", projectId: "project-a", ok: true, createdIds: ["new-rectangle"], appliedElements: [{ id: "new-rectangle", type: "rectangle", x: 10, y: 20 }] });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output).createdIds, ["new-rectangle"]);
});

test("Canvas existing-element edits require a referenced or previously created target", async () => {
  let requests = 0;
  const tool = createCanvasEditTool({
    runId: "run-a", projectId: null, ownerWebContentsId: 42, sourceElements: [],
    execute: async (_owner, body) => {
      requests += 1;
      if (requests === 2) assert.equal(body.sourceElements[0]?.id, "created-1");
      return { requestId: String(requests), runId: "run-a", projectId: null, ok: true, createdIds: requests === 1 ? ["created-1"] : [], appliedElements: [{ id: "created-1", type: "rectangle", x: requests * 10, y: 20 }] };
    },
  });
  const unauthorized = await tool.execute({ operations: [{ action: "delete", id: "unreferenced" }] }, context);
  assert.equal(unauthorized.error, "unauthorized_element");
  assert.equal(requests, 0);
  assert.equal((await tool.execute(create, context)).ok, true);
  assert.equal((await tool.execute({ operations: [{ action: "update", id: "created-1", changes: { x: 20 } }] }, context)).ok, true);
  assert.equal(requests, 2);
});

test("Canvas persistence conflicts report visible edits as unsaved instead of success", async () => {
  const tool = createCanvasEditTool({
    runId: "run-a", projectId: "project-a", ownerWebContentsId: 42, sourceElements: [],
    execute: async () => ({ requestId: "edit-a", runId: "run-a", projectId: "project-a", ok: false, error: "persistence_conflict", createdIds: ["created-1"], appliedElements: [{ id: "created-1", type: "rectangle", x: 10, y: 20 }] }),
  });
  const result = await tool.execute(create, context);
  assert.equal(result.ok, false);
  assert.equal(result.error, "persistence_conflict");
  const feedback = JSON.parse(result.output);
  assert.equal(feedback.status, "conflict");
  assert.equal(feedback.error, "persistence_conflict");
  assert.equal(feedback.appliedInMemory, true);
  assert.deepEqual(feedback.createdIds, ["created-1"]);
});

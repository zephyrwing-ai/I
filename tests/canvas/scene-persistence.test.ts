import assert from "node:assert/strict";
import test from "node:test";
import { shouldPersistCanvasChange } from "../../canvas/ui/scenePersistence.js";

const view = { zoom: { value: 1 }, scrollX: 0, scrollY: 0, viewBackgroundColor: "#fff" };

test("selection-only editor updates skip persistent scene saves", () => {
  const selectedView = { ...view, selectedElementIds: { "text-1": true }, activeTool: { type: "selection" } };
  assert.equal(shouldPersistCanvasChange(10, 10, view, selectedView), false);
});

test("element updates and viewport moves schedule persistent scene saves", () => {
  assert.equal(shouldPersistCanvasChange(10, 11, view, view), true);
  assert.equal(shouldPersistCanvasChange(10, 10, view, { ...view, scrollX: 40 }), true);
});

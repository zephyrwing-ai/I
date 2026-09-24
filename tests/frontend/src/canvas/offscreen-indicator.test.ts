import assert from "node:assert/strict";
import test from "node:test";
import {
  getOffscreenContentTarget,
  getOffscreenIndicatorPoint,
} from "../../../../canvas/engine/editor/scene/offscreenIndicatorGeometry";

const viewport = {
  width: 1000,
  height: 800,
  scrollX: 0,
  scrollY: 0,
  zoom: 1,
};

test("the indicator points at offscreen content on each viewport edge", () => {
  const right = getOffscreenIndicatorPoint({ x: 1400, y: 400 }, viewport);
  const left = getOffscreenIndicatorPoint({ x: -400, y: 400 }, viewport);
  const top = getOffscreenIndicatorPoint({ x: 500, y: -400 }, viewport);
  const bottom = getOffscreenIndicatorPoint({ x: 500, y: 1400 }, viewport);

  assert.equal(right?.left, 972);
  assert.equal(left?.left, 28);
  assert.equal(top?.top, 28);
  assert.equal(bottom?.top, 772);
  assert.equal(bottom?.left, 500);
});

test("an upper-right target can use the edge behind the TopBar action group", () => {
  const point = getOffscreenIndicatorPoint({ x: 1580, y: -600 }, viewport);

  assert.equal(point?.top, 28);
  assert.ok((point?.left ?? 0) > viewport.width - 159);
});

test("a selection outside the viewport wins even while other scene content is visible", () => {
  assert.deepEqual(
    getOffscreenContentTarget({
      selectedBounds: [1400, 300, 1600, 500],
      sceneFallbackTarget: null,
      sceneHasNoVisibleElements: false,
      editingText: false,
      viewport,
    }),
    { x: 1500, y: 400 },
  );
});

test("the nearest-scene fallback is used only when the whole scene is outside", () => {
  const sceneFallbackTarget = { x: -300, y: 500 };
  const input = {
    selectedBounds: null,
    sceneFallbackTarget,
    editingText: false,
    viewport,
  };

  assert.equal(
    getOffscreenContentTarget({
      ...input,
      sceneHasNoVisibleElements: false,
    }),
    null,
  );
  assert.deepEqual(
    getOffscreenContentTarget({
      ...input,
      sceneHasNoVisibleElements: true,
    }),
    sceneFallbackTarget,
  );
});

test("text editing suppresses the offscreen indicator", () => {
  assert.equal(
    getOffscreenContentTarget({
      selectedBounds: [1400, 300, 1600, 500],
      sceneFallbackTarget: { x: -300, y: 500 },
      sceneHasNoVisibleElements: true,
      editingText: true,
      viewport,
    }),
    null,
  );
});

test("selection visibility uses the same absolute viewport offsets as the renderer", () => {
  const offsetViewport = {
    ...viewport,
    offsetLeft: 100,
    offsetTop: 60,
  };

  assert.equal(
    getOffscreenContentTarget({
      selectedBounds: [0, 0, 40, 40],
      sceneFallbackTarget: null,
      sceneHasNoVisibleElements: false,
      editingText: false,
      viewport: offsetViewport,
    }),
    null,
  );
  assert.deepEqual(
    getOffscreenContentTarget({
      selectedBounds: [-220, 0, -180, 40],
      sceneFallbackTarget: null,
      sceneHasNoVisibleElements: false,
      editingText: false,
      viewport: offsetViewport,
    }),
    { x: -200, y: 20 },
  );
});

test("partial selections do not replace the general target and edge placement ignores UI safe zones", () => {
  assert.deepEqual(
    getOffscreenContentTarget({
      selectedBounds: [-100, 100, 100, 300],
      sceneFallbackTarget: null,
      sceneHasNoVisibleElements: false,
      editingText: false,
      viewport,
    }),
    null,
  );

  const point = getOffscreenIndicatorPoint(
    { x: 250, y: 1200 },
    { width: 500, height: 800 },
  );
  assert.ok(point);
  assert.equal(point.left, 250);
  assert.equal(point.top, 772);
});

test("zero-sized viewports do not produce an indicator position", () => {
  assert.equal(
    getOffscreenIndicatorPoint({ x: 1200, y: 300 }, { width: 0, height: 0 }),
    null,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  OUTPUT_SIDEBAR_COLLAPSE_DISTANCE,
  OUTPUT_SIDEBAR_MIN_WIDTH,
  shouldCollapseSidebar,
} from "../../../../frontend/src/store/outputSidebarState.js";

test("output sidebar only collapses after crossing the 48px threshold below its minimum", () => {
  const threshold = OUTPUT_SIDEBAR_MIN_WIDTH - OUTPUT_SIDEBAR_COLLAPSE_DISTANCE;
  assert.equal(shouldCollapseSidebar(OUTPUT_SIDEBAR_MIN_WIDTH), false);
  assert.equal(shouldCollapseSidebar(threshold + 1), false);
  assert.equal(shouldCollapseSidebar(threshold), true);
  assert.equal(shouldCollapseSidebar(threshold - 1), true);
});

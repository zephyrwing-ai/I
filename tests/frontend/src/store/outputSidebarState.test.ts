import assert from "node:assert/strict";
import test from "node:test";
import {
  canKeepOutputSidebarOpen,
  OUTPUT_SIDEBAR_COLLAPSE_DISTANCE,
  OUTPUT_SIDEBAR_MIN_WIDTH,
  getOutputSidebarMaxWidth,
  shouldCollapseSidebar,
} from "../../../../frontend/src/store/outputSidebarState.js";

test("output sidebar only collapses after crossing the 48px threshold below its minimum", () => {
  const threshold = OUTPUT_SIDEBAR_MIN_WIDTH - OUTPUT_SIDEBAR_COLLAPSE_DISTANCE;
  assert.equal(shouldCollapseSidebar(OUTPUT_SIDEBAR_MIN_WIDTH), false);
  assert.equal(shouldCollapseSidebar(threshold + 1), false);
  assert.equal(shouldCollapseSidebar(threshold), true);
  assert.equal(shouldCollapseSidebar(threshold - 1), true);
});

test("sidebar maximum is derived from the viewport and the minimum message column", () => {
  assert.equal(getOutputSidebarMaxWidth(1_440), 1_080);
  assert.equal(getOutputSidebarMaxWidth(640), 280);
  assert.equal(getOutputSidebarMaxWidth(520), 280);
});

test("sidebar remains open only when the minimum sidebar and message widths fit together", () => {
  assert.equal(canKeepOutputSidebarOpen(640), true);
  assert.equal(canKeepOutputSidebarOpen(639), false);
});

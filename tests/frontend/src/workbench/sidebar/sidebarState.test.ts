import assert from "node:assert/strict";
import test from "node:test";
import {
  sidebarFits,
  sidebarMaximumWidth,
  sidebarShouldCollapse,
} from "../../../../../frontend/src/shared/sidebar/sidebarGeometry.js";
import {
  WORKBENCH_SIDEBAR_COLLAPSE_DISTANCE,
  WORKBENCH_SIDEBAR_MIN_WIDTH,
  WORKBENCH_SIDEBAR_POLICY,
} from "../../../../../frontend/src/workbench/sidebar/sidebarState.js";

test("workbench sidebar reserves the minimum message column in its effective maximum", () => {
  assert.equal(sidebarMaximumWidth(WORKBENCH_SIDEBAR_POLICY, 1_440), 1_080);
  assert.equal(sidebarMaximumWidth(WORKBENCH_SIDEBAR_POLICY, 640), 280);
  assert.equal(sidebarMaximumWidth(WORKBENCH_SIDEBAR_POLICY, 520), 280);
});

test("workbench sidebar fits only when both minimum columns remain available", () => {
  assert.equal(sidebarFits(WORKBENCH_SIDEBAR_POLICY, 640), true);
  assert.equal(sidebarFits(WORKBENCH_SIDEBAR_POLICY, 639), false);
});

test("workbench sidebar collapses after crossing the configured threshold", () => {
  const threshold = WORKBENCH_SIDEBAR_MIN_WIDTH - WORKBENCH_SIDEBAR_COLLAPSE_DISTANCE;
  assert.equal(sidebarShouldCollapse(WORKBENCH_SIDEBAR_POLICY, WORKBENCH_SIDEBAR_MIN_WIDTH), false);
  assert.equal(sidebarShouldCollapse(WORKBENCH_SIDEBAR_POLICY, threshold + 1), false);
  assert.equal(sidebarShouldCollapse(WORKBENCH_SIDEBAR_POLICY, threshold), true);
  assert.equal(sidebarShouldCollapse(WORKBENCH_SIDEBAR_POLICY, threshold - 1), true);
});

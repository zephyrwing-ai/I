import assert from "node:assert/strict";
import test from "node:test";
import { shouldCollapseSidebar } from "../../../../frontend/src/store/outputSidebarState.js";

test("output sidebar only collapses after crossing the 48px threshold below its minimum", () => {
  assert.equal(shouldCollapseSidebar(280), false);
  assert.equal(shouldCollapseSidebar(233), false);
  assert.equal(shouldCollapseSidebar(232), true);
  assert.equal(shouldCollapseSidebar(220), true);
});

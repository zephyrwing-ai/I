import assert from "node:assert/strict";
import test from "node:test";
import {
  formatZoomPercentage,
  parseZoomPercentage,
} from "../../canvas/engine/editor/actions/zoomInput";

test("zoom display rounds to a whole percentage and includes the suffix", () => {
  assert.equal(formatZoomPercentage(0.234), "23%");
  assert.equal(formatZoomPercentage(0.235), "24%");
  assert.equal(formatZoomPercentage(1), "100%");
});

test("zoom input accepts a number with an optional percent suffix", () => {
  assert.equal(parseZoomPercentage("23"), 23);
  assert.equal(parseZoomPercentage("23%"), 23);
  assert.equal(parseZoomPercentage(" 23.5 % "), 23.5);
  assert.equal(parseZoomPercentage(".5"), 0.5);
});

test("zoom input rejects malformed values", () => {
  for (const value of ["", "23abc", "%23", "23%%", "1e2", "NaN"]) {
    assert.equal(parseZoomPercentage(value), null, value);
  }
});

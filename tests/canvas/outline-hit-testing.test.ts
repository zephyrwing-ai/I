import assert from "node:assert/strict";
import test from "node:test";
import { ellipse, ellipseDistanceFromPoint, ellipseTouchesPoint } from "../../canvas/engine/math/ellipse";
import { pointFrom } from "../../canvas/engine/math/point";
import type { LocalPoint } from "../../canvas/engine/math/types";

const point = (x: number, y: number) => pointFrom<LocalPoint>(x, y);

test("ellipse and circle centers retain their distance from the outline", () => {
  for (const [a, b] of [[60, 50], [50, 60], [50, 50]]) {
    const shape = ellipse(point(120, -80), a, b);
    assert.equal(ellipseDistanceFromPoint(shape.center, shape), Math.min(a, b));
    assert.equal(ellipseTouchesPoint(shape.center, shape, 2), false);
  }
});

test("ellipse outline distances remain symmetric on both axes", () => {
  const shape = ellipse(point(0, 0), 60, 50);
  for (const [x, y] of [[10, 0], [0, 10], [20, 15]]) {
    const distance = ellipseDistanceFromPoint(point(x, y), shape);
    assert.ok(distance > 2, "interior points are outside the outline hit tolerance");
    assert.equal(ellipseDistanceFromPoint(point(-x, y), shape), distance);
    assert.equal(ellipseDistanceFromPoint(point(x, -y), shape), distance);
  }
});

test("ellipse boundary and adjacent outside points remain selectable", () => {
  const shape = ellipse(point(0, 0), 60, 50);
  for (const boundary of [point(60, 0), point(-60, 0), point(0, 50), point(0, -50)]) {
    assert.ok(ellipseDistanceFromPoint(boundary, shape) < 0.01);
    assert.equal(ellipseTouchesPoint(boundary, shape, 2), true);
  }
  assert.equal(ellipseTouchesPoint(point(61, 0), shape, 2), true);
  assert.equal(ellipseTouchesPoint(point(70, 0), shape, 2), false);
});

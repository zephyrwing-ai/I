import assert from "node:assert/strict";
import test from "node:test";

const {
  boundaryKind,
  offsetFromPull,
  pullFromOffset,
  springStep,
  ELASTIC_MAX,
  ELASTIC_SATURATION,
  ELASTIC_OMEGA,
  ELASTIC_ZETA,
  ELASTIC_WHEEL_IDLE,
} = await import("../../../../frontend/src/hooks/useElasticScroll.js");

test("offsetFromPull：初始跟手带阻尼（400px 拉力时位移恰好过半），极限收敛于 max 之下", () => {
  const halfway = offsetFromPull(ELASTIC_SATURATION, ELASTIC_SATURATION, ELASTIC_MAX, 1);
  assert.equal(halfway, ELASTIC_MAX * 0.5);
  const nearLimit = offsetFromPull(10_000, ELASTIC_SATURATION, ELASTIC_MAX, 1);
  assert.ok(nearLimit > halfway && nearLimit < ELASTIC_MAX, `nearLimit=${nearLimit}`);
  assert.ok(offsetFromPull(100, ELASTIC_SATURATION, ELASTIC_MAX, 1) > 0);
});

test("offsetFromPull：方向由符号决定，正负互反", () => {
  const up = offsetFromPull(200, ELASTIC_SATURATION, ELASTIC_MAX, -1);
  const down = offsetFromPull(200, ELASTIC_SATURATION, ELASTIC_MAX, 1);
  assert.equal(up, -down);
});

test("pullFromOffset 与 offsetFromPull 互逆：回弹途中再次越界输入从当前位移接入", () => {
  const pull = 200;
  const offset = offsetFromPull(pull, ELASTIC_SATURATION, ELASTIC_MAX, 1);
  const restored = pullFromOffset(offset, ELASTIC_SATURATION, ELASTIC_MAX);
  assert.ok(Math.abs(restored - pull) < 0.5, `restored=${restored}`);
});

test("springStep：30/60/120Hz 下，连同 wheel 静默在500ms内达到归位判据", () => {
  for (const hz of [30, 60, 120]) {
    let x = ELASTIC_MAX;
    let v = 0;
    let elapsed = ELASTIC_WHEEL_IDLE;
    while (elapsed + 1000 / hz <= 500) {
      [x, v] = springStep(x, v, 1 / hz, ELASTIC_OMEGA, ELASTIC_ZETA);
      elapsed += 1000 / hz;
      assert.ok(x > -ELASTIC_MAX * 0.05, `过冲低于5%，hz=${hz}, x=${x}`);
      if (Math.abs(x) < 0.3 && Math.abs(v) < 5) break;
    }
    assert.ok(Math.abs(x) < 0.3 && Math.abs(v) < 5, `hz=${hz}, elapsed=${elapsed}, x=${x}, v=${v}`);
  }
});

test("springStep：分帧与整段时间步进得到同一状态", () => {
  const expected = springStep(ELASTIC_MAX, 0, 0.25, ELASTIC_OMEGA, ELASTIC_ZETA);
  let [x, v] = [ELASTIC_MAX, 0];
  for (let i = 0; i < 30; i += 1) [x, v] = springStep(x, v, 1 / 120, ELASTIC_OMEGA, ELASTIC_ZETA);
  assert.ok(Math.abs(x - expected[0]) < 1e-9);
  assert.ok(Math.abs(v - expected[1]) < 1e-9);
});

test("boundaryKind：顶部越界、底部越界、边界内、切入边界内与不可滚动整体可拖动", () => {
  const max = 500;
  assert.equal(boundaryKind(0, max, -10), "outward");
  assert.equal(boundaryKind(0, max, 10), "inland");
  assert.equal(boundaryKind(250, max, 10), "within");
  assert.equal(boundaryKind(499.8, max, 10), "outward");
  assert.equal(boundaryKind(500, max, 10), "outward");
  assert.equal(boundaryKind(0, 1, -10), "outward");
  assert.equal(boundaryKind(0, 1, 10), "outward");
  assert.equal(boundaryKind(0, max, 0), "within");
});

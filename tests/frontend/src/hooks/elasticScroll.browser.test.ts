import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "vite";

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL("../../elastic-scroll/", import.meta.url));
const electron: string = createRequire(import.meta.url)("electron");

type Sample = {
  scrollHeight: number;
  scrollTop: number;
  viewportHeight: number;
  offset: number;
  thumbTop: number;
  thumbHeight: number;
  fillScale: number;
  fillTopGap: number;
  fillBottomGap: number;
  disabled: string;
  consumed?: boolean;
};

test("Electron 中的弹性滚动保持布局与动画连续", { timeout: 40_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "elastic-scroll-regression-"));
  try {
    await build({
      configFile: false,
      root: fixture,
      base: "./",
      logLevel: "silent",
      esbuild: { jsx: "automatic" },
      build: { outDir: join(temporary, "page"), emptyOutDir: true },
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await execute(electron, [join(fixture, "electron.cjs"), join(temporary, "page/index.html"), join(temporary, "profile")], {
      env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const line = stdout.split("\n").find((value) => value.startsWith("ELASTIC_SCROLL_RESULTS="));
    assert.ok(line, `Electron returns regression results: ${stdout}`);
    const result = JSON.parse(line.slice("ELASTIC_SCROLL_RESULTS=".length)) as {
      bottom: { baseline: Sample; samples: Sample[]; settled: Sample; settledAfter: number };
      sustained: { at: number; offset: number; fillScale: number }[];
      top: { baseline: Sample; samples: Sample[] };
      returning: { beforeResume: Sample; resumed: Sample; beforeReverse: Sample; reversed: Sample };
      remainder: Sample;
      shortSamples: Sample[];
      shortened: Sample;
      nestedSamples: Sample[];
      touch: { started: Sample; held: Sample; ended: Sample };
    };

    for (const edge of ["bottom", "top"] as const) {
      await t.test(`${edge}：连续输入保持几何稳定、位移递增与滑块不变形`, () => {
        const { baseline, samples } = result[edge];
        assert.equal(baseline.viewportHeight, 400);
        assert.equal(baseline.scrollHeight, 1260);
        let magnitude = 0;
        for (const sample of samples) {
          assert.equal(sample.scrollHeight, baseline.scrollHeight, "content transform preserves scrollHeight");
          assert.equal(sample.scrollTop, baseline.scrollTop, "content transform preserves scrollTop");
          assert.equal(sample.thumbTop, baseline.thumbTop, "thumb track position remains stable");
          assert.equal(sample.thumbHeight, baseline.thumbHeight, "thumb layout height remains stable");
          assert.ok(edge === "bottom" ? sample.offset < 0 : sample.offset > 0, `direction: ${sample.offset}`);
          assert.ok(Math.abs(sample.offset) > magnitude, `continuous displacement: ${sample.offset}`);
          assert.equal(sample.fillScale, 1, `thumb stays undeformed: ${sample.fillScale}`);
          assert.ok(Math.abs((edge === "bottom" ? sample.fillBottomGap : sample.fillTopGap) - 2) < 0.1, "thumb remains anchored 2px from edge");
          assert.equal(sample.consumed, true);
          magnitude = Math.abs(sample.offset);
        }
      });
    }

    await t.test("持续越界输入超过跟手上限后开始回弹，滑块始终不变形", () => {
      const samples = result.sustained;
      assert.ok(samples.length >= 10, `samples=${samples.length}`);
      for (const sample of samples) {
        assert.equal(sample.fillScale, 1, `thumb stays undeformed at ${sample.at}ms`);
      }
      const peak = samples.reduce((max, sample) => (Math.abs(sample.offset) > Math.abs(max.offset) ? sample : max));
      assert.ok(peak.at < 320, `displacement peaks at ${peak.at}ms`);
      const last = samples[samples.length - 1];
      assert.ok(Math.abs(last.offset) < Math.abs(peak.offset), `late offset ${last.offset} vs peak ${peak.offset}`);
    });

    await t.test("最后输入后约 500ms 回到原位", () => {
      assert.ok(result.bottom.settledAfter < 550, `sampled at ${result.bottom.settledAfter}ms`);
      assert.ok(Math.abs(result.bottom.settled.offset) <= 0.3, `offset=${result.bottom.settled.offset}`);
      assert.ok(Math.abs(result.bottom.settled.fillScale - 1) < 0.002);
    });

    await t.test("反向增量先抵消拉力，剩余增量接续内容滚动", () => {
      assert.equal(result.remainder.offset, 0);
      assert.equal(result.remainder.scrollTop, 840, "80px pull consumes 80px of the 100px reverse input");
      assert.equal(result.remainder.consumed, true);
    });

    await t.test("回弹时的同向和反向输入从当前位移继续", () => {
      const { beforeResume, resumed, beforeReverse, reversed } = result.returning;
      assert.ok(beforeResume.offset > 0.3, "sample occurs during spring return");
      assert.ok(resumed.offset > beforeResume.offset && resumed.offset - beforeResume.offset < 8);
      assert.ok(beforeReverse.offset > 0.3);
      assert.ok(reversed.offset > 0 && reversed.offset < beforeReverse.offset, `reverse ${beforeReverse.offset} -> ${reversed.offset}`);
      assert.ok(beforeReverse.offset - reversed.offset < 8);
    });

    await t.test("短内容向两个方向拉动与换向保持连续", () => {
      const samples = result.shortSamples;
      for (const sample of samples) {
        assert.equal(sample.scrollHeight, 400);
        assert.equal(sample.scrollTop, 0);
      }
      assert.ok(samples[0].offset > 0 && samples[1].offset > samples[0].offset);
      assert.ok(samples[2].offset > 0 && samples[2].offset < samples[1].offset);
      assert.ok(Math.abs(samples[3].offset) <= 0.01);
      assert.ok(samples[4].offset < 0);
    });

    await t.test("长内容变短后滑块尺寸与位置恢复初始值", () => {
      assert.equal(result.shortened.scrollHeight, 400);
      assert.equal(result.shortened.thumbHeight, 72);
      assert.equal(result.shortened.thumbTop, 2);
      assert.equal(result.shortened.disabled, "true");
    });

    await t.test("嵌套滚动区域有余量时接收自己的输入", () => {
      for (const sample of result.nestedSamples) {
        assert.equal(sample.offset, 0);
        assert.equal(sample.consumed, false);
      }
    });

    await t.test("触摸保持时维持位移，松手后回弹", () => {
      assert.ok(result.touch.started.offset > 0);
      assert.equal(result.touch.held.offset, result.touch.started.offset);
      assert.equal(result.touch.ended.offset, 0);
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

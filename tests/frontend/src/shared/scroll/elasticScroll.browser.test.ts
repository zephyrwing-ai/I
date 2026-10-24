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
const fixture = fileURLToPath(new URL("../../../elastic-scroll/", import.meta.url));
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

type LabelGeometry = {
  text: string; width: number; contentWidth: number; ellipsis: string; whiteSpace: string; overflow: string;
};

type LifecycleSample = {
  status: string; outerOpen: boolean; outerInert: boolean; groupsOpen: boolean[]; groupsInert: boolean[];
  groupRows: string[][]; runningToolIds: string[]; flowTexts: string[]; finalText: string | null; finalOutside: boolean; reasoningHidden: boolean;
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
      activityTrace: {
        initiallyClosed: boolean; closedFocusBlocked: boolean; openFocusAllowed: boolean; reasoningHidden: boolean; commandVisible: boolean; finalOutside: boolean;
        individualDisclosures: number; expandedHeight: number; sequence: string[]; rows: string[]; headers: string[];
        noHorizontalOverflow: boolean; collapsedAgain: boolean; retainedOutput: number;
        detailsInitiallyUnmounted: boolean; firstRowExpanded: boolean; independentExpansion: boolean; independentCollapse: boolean;
        fullCommandInput: boolean; fullCommandOutput: boolean; reasoningHiddenWithDetails: boolean; detailsUnmountedAgain: boolean; completeLabels: boolean;
        wideShort: LabelGeometry; wideCommand: LabelGeometry; narrowShort: LabelGeometry; narrowCommand: LabelGeometry; narrowLong: LabelGeometry;
        groupScroll: { maxHeight: string; overflowY: string; height: number; contentHeight: number; scrollTop: number };
      };
      pureProgress: {
        initiallyClosed: boolean; closedFocusBlocked: boolean; toggleFocusAllowed: boolean; openedByClick: boolean; openFocusAllowed: boolean;
        progressInside: boolean; finalOutside: boolean; metadataOutside: boolean; noTools: boolean; noRawEvidence: boolean; workedLabel: string;
        collapsedAgain: boolean; legacyNotice: string; legacyClickable: boolean; legacyNoRawEvidence: boolean;
        waitingAutoOpen: boolean; waitingClickable: boolean; waitingStatus: string; waitingHasNoProse: boolean; streamedWhileOpen: boolean;
      };
      activityLifecycle: Record<string, LifecycleSample>;
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

    await t.test("活动正文按回合排列，工具显示实际命令与路径，折叠限制焦点", () => {
      const activity = result.activityTrace;
      for (const field of ["initiallyClosed", "closedFocusBlocked", "openFocusAllowed", "reasoningHidden", "commandVisible", "finalOutside", "noHorizontalOverflow", "collapsedAgain"] as const) {
        assert.equal(activity[field], true, field);
      }
      assert.equal(activity.individualDisclosures, activity.rows.length);
      assert.ok(activity.expandedHeight > 100);
      assert.deepEqual(activity.sequence, ["先检查上下文管理实现", "Read files, ran commands", "然后检查历史读取逻辑", "Read files"]);
      assert.deepEqual(activity.headers, ["Read files, ran commands", "Read files"]);
      assert.equal(activity.rows[0], "Read agent/context/config.ts");
      assert.equal(activity.rows[1], "Ran pwd");
      assert.equal(activity.rows.at(-1), "Read agent/tools/history-read.ts");
      assert.ok(activity.retainedOutput > 10_000);
    });

    await t.test("工具行仅在宽度不足时省略，DOM 保留完整命令，工具组限制 320px 内部滚动", () => {
      const activity = result.activityTrace;
      for (const sample of [activity.wideShort, activity.wideCommand, activity.narrowShort, activity.narrowCommand, activity.narrowLong]) {
        assert.equal(sample.ellipsis, "ellipsis", JSON.stringify(sample));
        assert.equal(sample.whiteSpace, "nowrap", JSON.stringify(sample));
        assert.equal(sample.overflow, "hidden", JSON.stringify(sample));
      }
      assert.equal(activity.wideShort.text, "Ran pwd");
      assert.equal(activity.narrowShort.text, "Ran pwd");
      assert.ok(activity.wideShort.contentWidth <= activity.wideShort.width, JSON.stringify(activity.wideShort));
      assert.ok(activity.narrowShort.contentWidth <= activity.narrowShort.width, JSON.stringify(activity.narrowShort));
      assert.ok(activity.wideCommand.contentWidth <= activity.wideCommand.width, JSON.stringify(activity.wideCommand));
      assert.ok(activity.narrowCommand.contentWidth > activity.narrowCommand.width, JSON.stringify(activity.narrowCommand));
      assert.equal(activity.wideCommand.text, activity.narrowCommand.text);
      assert.ok(activity.narrowLong.contentWidth > activity.narrowLong.width, JSON.stringify(activity.narrowLong));
      assert.ok(activity.narrowLong.text.length > 1_000);
      assert.equal(activity.completeLabels, true);
      assert.equal(activity.groupScroll.maxHeight, "320px");
      assert.equal(activity.groupScroll.overflowY, "auto");
      assert.equal(activity.groupScroll.height, 320);
      assert.ok(activity.groupScroll.contentHeight > activity.groupScroll.height, JSON.stringify(activity.groupScroll));
      assert.ok(activity.groupScroll.scrollTop > 0, JSON.stringify(activity.groupScroll));
    });

    await t.test("工具行独立展开完整输入与结果，关闭时移除详情，原始推理始终隐藏", () => {
      const activity = result.activityTrace;
      for (const field of ["detailsInitiallyUnmounted", "firstRowExpanded", "independentExpansion", "independentCollapse", "fullCommandInput", "fullCommandOutput", "reasoningHiddenWithDetails", "detailsUnmountedAgain"] as const) {
        assert.equal(activity[field], true, field);
      }
    });

    await t.test("无工具回答的箭头实际展开过程，焦点与最终答案保留各自边界", () => {
      const progress = result.pureProgress;
      for (const field of ["initiallyClosed", "closedFocusBlocked", "toggleFocusAllowed", "openedByClick", "openFocusAllowed", "progressInside", "finalOutside", "metadataOutside", "noTools", "noRawEvidence", "collapsedAgain"] as const) {
        assert.equal(progress[field], true, field);
      }
      assert.equal(progress.workedLabel, "Worked for 0.9s");
    });

    await t.test("历史缺失说明和生成等待状态均可展开，进度到达后替换等待提示", () => {
      const progress = result.pureProgress;
      assert.equal(progress.legacyClickable, true);
      assert.equal(progress.legacyNoRawEvidence, true);
      assert.equal(progress.legacyNotice, "原始推理已保存，公开正文见下方回答。");
      assert.equal(progress.waitingAutoOpen, true);
      assert.equal(progress.waitingClickable, true);
      assert.equal(progress.waitingStatus, "正在等待过程说明。");
      assert.equal(progress.waitingHasNoProse, true);
      assert.equal(progress.streamedWhileOpen, true);
    });

    const checkLifecycle = (step: string, expected: Partial<LifecycleSample>) => {
      const actual = result.activityLifecycle[step];
      assert.ok(actual, `Missing lifecycle checkpoint ${step}`);
      for (const [field, value] of Object.entries(expected)) {
        assert.deepEqual(actual[field as keyof LifecycleSample], value, `${step}.${field}: ${JSON.stringify(actual)}`);
      }
      assert.equal(actual.reasoningHidden, true, `${step}: reasoning stays hidden`);
    };

    await t.test("运行中自动展开，原生正文增量留在流程，多工具与待执行工具属于同一组", () => {
      checkLifecycle("running", { outerOpen: true, outerInert: false, groupsOpen: [], finalText: null });
      checkLifecycle("nativeContent", { outerOpen: true, flowTexts: ["先检查上下文管理实现"], finalText: null });
      checkLifecycle("batchOpened", { outerOpen: true, groupsOpen: [true], groupsInert: [false], groupRows: [["first-read", "first-command", "pending-command"]] });
      checkLifecycle("manualGroupClosed", { groupsOpen: [false], groupsInert: [true], runningToolIds: ["first-command", "pending-command"] });
      checkLifecycle("pendingKeepsOpen", { outerOpen: true, groupsOpen: [true], runningToolIds: ["pending-command"] });
      checkLifecycle("manualOuterClosed", { outerOpen: false, outerInert: true, groupsOpen: [true], runningToolIds: ["pending-command"] });
    });

    await t.test("全部工具完成后内层自动收起，下一回合重新展开，最终身份由运行完成确认", () => {
      checkLifecycle("allToolsDone", { outerOpen: true, groupsOpen: [false], groupsInert: [true], runningToolIds: [], finalText: null });
      checkLifecycle("nextTurnOpened", { outerOpen: true, groupsOpen: [false, true], groupRows: [["first-read", "first-command", "pending-command"], ["second-read", "second-command"]] });
      checkLifecycle("secondPartiallyDone", { groupsOpen: [false, true], runningToolIds: ["second-command"] });
      checkLifecycle("secondAllDone", { outerOpen: true, groupsOpen: [false, false], runningToolIds: [] });
      const flowTexts = ["先检查上下文管理实现", "然后检查历史读取逻辑", "接下来汇总核验结果", "最终中文结论"];
      checkLifecycle("answerStreamingInFlow", { outerOpen: true, groupsOpen: [false, false], flowTexts, finalText: null });
      checkLifecycle("answerWaitingForRunCompleted", { outerOpen: true, groupsOpen: [false, false], flowTexts, finalText: null });
      checkLifecycle("runCompleted", { status: "completed", outerOpen: false, outerInert: true, groupsOpen: [false, false], flowTexts: flowTexts.slice(0, -1), finalText: "最终中文结论", finalOutside: true });
    });

    await t.test("手动重开完成的折叠后，再次运行并完成会清除上一阶段的选择", () => {
      checkLifecycle("doneManuallyReopened", { outerOpen: true, groupsOpen: [true, false] });
      checkLifecycle("sameGroupWorkingAgain", { status: "running", outerOpen: true, groupsOpen: [true, false], runningToolIds: ["first-read"], finalText: null });
      checkLifecycle("sameGroupDoneAgain", { outerOpen: true, groupsOpen: [false, false], runningToolIds: [] });
      checkLifecycle("doneAgainReset", { status: "completed", outerOpen: false, outerInert: true, groupsOpen: [false, false], finalText: "最终中文结论", finalOutside: true });
    });

    await t.test("停止请求完成取消和直接取消时，外层与工具组随终态收起", () => {
      checkLifecycle("beforeStop", { outerOpen: true, groupsOpen: [true] });
      checkLifecycle("stopRequested", { status: "stopping", finalText: null });
      checkLifecycle("stopped", { status: "cancelled", outerOpen: false, outerInert: true, groupsOpen: [false], groupsInert: [true], finalText: null });
      checkLifecycle("beforeCancel", { outerOpen: true, groupsOpen: [true] });
      checkLifecycle("cancelled", { status: "cancelled", outerOpen: false, outerInert: true, groupsOpen: [false], groupsInert: [true], finalText: null });
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

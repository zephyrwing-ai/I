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
const fixture = fileURLToPath(new URL("./editor-layout/", import.meta.url));
const repository = fileURLToPath(new URL("../../", import.meta.url));
const electron: string = createRequire(import.meta.url)("electron");
type Bounds = { x: number; y: number; width: number; height: number; right: number; bottom: number };
type Sample = {
  width: number;
  viewportWidth: number;
  sameToolbar: boolean;
  sameFooter: boolean;
  sameButtons: boolean;
  toolbar: Bounds;
  footer: Bounds;
  sidebar: Bounds;
  buttons: (Bounds & { label: string })[];
  mobileContainers: number;
  pageScrollWidth: number;
  pageWidth: number;
  pageScrollHeight: number;
  pageHeight: number;
  sceneUnchanged: boolean;
  zoom: number;
  scroll: number[];
  buttonSizeToken: string;
};
type NavigationState = {
  tool: string;
  locked: boolean;
  checkedTools: string[];
  cursor: string;
  selectedIds: string[];
  scroll: number[];
};

test("真实 Canvas 编辑器在桌面侧栏缩放时保持底部布局与场景", { timeout: 90_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "canvas-layout-regression-"));
  try {
    await build({
      configFile: false,
      root: fixture,
      base: "./",
      logLevel: "silent",
      esbuild: { jsx: "automatic" },
      // Keep React lifecycle diagnostics active in the real editor regression.
      define: { "process.env.IS_PREACT": "false", "process.env.NODE_ENV": '"development"' },
      resolve: {
        alias: {
          "@i/canvas-editor": join(repository, "canvas/engine/editor"),
          "@i/canvas-utils": join(repository, "canvas/engine/utils"),
          "@i/canvas-math": join(repository, "canvas/engine/math"),
        },
      },
      css: { preprocessorOptions: { scss: { quietDeps: true, silenceDeprecations: ["import"] } } },
      build: { outDir: join(temporary, "page"), emptyOutDir: true, minify: false },
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await execute(electron, [join(fixture, "electron.cjs"), join(temporary, "page/index.html"), join(temporary, "profile")], {
      env,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const line = stdout.split("\n").find((value) => value.startsWith("CANVAS_LAYOUT_RESULTS="));
    assert.ok(line, `Electron returns regression results: ${stdout}`);
    const result = JSON.parse(line.slice("CANVAS_LAYOUT_RESULTS=".length)) as {
      samples: Sample[];
      initialZoom: number;
      initialScroll: number[];
      errors: string[];
      outlineRendering: Array<{ type: string; hasLegacyFill: boolean; paintedPixels: number; center: number[]; fillSets: number; redSvgFill: boolean; interiorHit: boolean | null; arrowhead: string | null; arrowShapes: number | null }>;
      documentChanges: { documentVersion: number; versionAfterFocus: number; versionAfterEdit: number; versionAfterResourceAdd: number; editSucceeded: boolean; createdIds: string[]; previousElementPreserved: boolean; elementCount: number; resourceOwnKey: boolean };
      persistence: {
        coldStart: { ok: boolean; savedElements: number; requests: number; canRelease: boolean };
        focusSaved: boolean;
        conflict: { code: string; localX: number; diskX: number; externalPreserved: boolean; actions: string[]; canRelease: boolean };
        conflictRetried: boolean;
        recovered: { ok: boolean; elements: number; canRelease: boolean };
        replacement: { requestId: string; ok: boolean; supersededErrors: string[]; callbackRefreshProducedResult: boolean; originalX: number; elements: number };
      };
      codecs: {
        json: { valid: boolean; type: string; version: number; id: string };
        clipboard: { type: string; ids: string[] };
        png: { type: string; keyword: string; sceneType: string; ids: string[] };
        svg: { sceneType: string; ids: string[] };
      };
      textInput: { text: string | null; fontFamily: number | null };
      textFonts: Array<{ fontFamily: number; restoredFamily: number; pngType: string; paintedPixels: number; pngText: string; pngFamily: number; svgText: string; svgFontFamily: string; embeddedFamilies: string[]; embeddedFontData: boolean }>;
      languageFallback: Array<{ requested: string; current: string; documentLanguage: string; direction: string; label: string }>;
      capabilities: { toolAfterFrameShortcut: string; toolAfterUnsupportedAPI: string; libraryAPI: boolean; generationAPI: boolean; legacy: Array<{ type: string; visible: boolean; activeDOM: boolean }> };
      editProtection: {
        independentGesture: { ok: boolean; sameStroke: boolean; initialPoints: number; continuedPoints: number; afterHumanUndo: { aX: number; strokePresent: boolean }; afterAgentUndo: { aX: number; strokePresent: boolean } };
        independentUndo: { beforeUndoX: number; afterUndoX: number; waitedBeforeUndo: boolean; ok: boolean; aPositionAfterUndo: number[]; selectionBeforeUndo: string[]; selectionAfterUndo: string[]; afterAgentCommit: { aPosition: number[]; aLocked: boolean; bX: number }; afterLockUndo: { aPosition: number[]; aLocked: boolean; bX: number }; afterGestureUndo: { aPosition: number[]; aLocked: boolean; bX: number } };
        pendingDrag: { waitedForDrag: boolean; deleteRejected: boolean; cutRejected: boolean; ok: boolean; error: string; userPosition: number[]; finalPosition: number[] };
        composition: { waitedForComposition: boolean; sameInput: boolean; ok: boolean; error: string; text: string };
        replacement: { waitedBeforeReplacement: boolean; ok: boolean; error: string; ids: string[] };
        binding: { waitedForEndpoint: boolean; ok: boolean; endpoint: string; affectedEndpoint: boolean };
        boundReorder: { ok: boolean; error?: string; neighbourPreserved: boolean; ids: string[] };
      };
      handSelection: {
        coldStart: NavigationState;
        sceneReplacement: NavigationState;
        handPan: NavigationState & { unchanged: boolean };
        commandPressed: NavigationState;
        commandSelected: NavigationState;
        commandMoved: NavigationState & { position: number[] };
        commandReleased: NavigationState;
        shortcuts: { copyIds: string[]; positionAfterUndo: number[]; toolAfterUndo: string };
        commandDuringPan: NavigationState;
        commandAfterPan: NavigationState;
        afterDeferredPan: NavigationState;
        explicitSelectionMoved: NavigationState & { position: number[] };
        explicitSelectionAfterRelease: NavigationState;
        pastes: Array<NavigationState & { kind: string; releasedBeforeInsert: boolean; toolAfterInsertion: string }>;
        releaseDuringDrag: NavigationState;
        releaseAfterDrag: NavigationState & { position: number[] };
        originalToolOverridden: NavigationState;
        secondCommandStillHeld: NavigationState;
        rectangleAfterRelease: NavigationState;
        spacePan: NavigationState & { unchanged: boolean };
        commandOutsideCanvas: NavigationState;
        commandOutsidePointerUp: NavigationState;
        commandHeldOnEntry: NavigationState;
        commandHeldOnPointerDown: NavigationState;
        explicitToolSwitch: NavigationState;
        heldPointerAfterExplicitSwitch: NavigationState;
        explicitToolAfterRelease: NavigationState;
        explicitHandClick: NavigationState;
        explicitHandAfterRelease: NavigationState;
        beforeLockClick: NavigationState;
        explicitLockClick: NavigationState;
        explicitLockAfterRelease: NavigationState;
        ignoredInputs: Array<NavigationState & { tagName: string }>;
        afterBlur: NavigationState;
        afterHeldSceneReplacement: NavigationState;
        afterRemount: NavigationState;
      };
    };
    assert.deepEqual(result.errors, [], "renderer has no runtime errors");
    assert.deepEqual(result.samples.map((sample) => sample.width), [1200, 800, 729, 500, 320, 1200]);
    const baseline = result.samples[0];
    assert.equal(baseline.buttons.length, 12, "lock, hand and ten drawing tools remain present");
    for (const sample of result.samples) {
      await t.test(`${sample.width}px：固定 DOM、按钮与底部基线，更新 viewport`, () => {
        assert.equal(sample.viewportWidth, sample.width);
        assert.equal(sample.sameToolbar, true);
        assert.equal(sample.sameFooter, true);
        assert.equal(sample.sameButtons, true);
        assert.equal(sample.mobileContainers, 0);
        assert.equal(sample.sceneUnchanged, true);
        assert.equal(sample.zoom, result.initialZoom);
        assert.deepEqual(sample.scroll, result.initialScroll);
        assert.equal(sample.pageScrollWidth, sample.pageWidth);
        assert.equal(sample.pageScrollHeight, sample.pageHeight);
        assert.equal(sample.buttonSizeToken, "2rem", "host button sizing is connected to the renamed editor root");
        assert.deepEqual(sample.buttons.map(({ label, width, height }) => ({ label, width, height })), baseline.buttons.map(({ label, width, height }) => ({ label, width, height })));
        for (const button of sample.buttons) {
          assert.ok(Math.abs(button.y - sample.buttons[0].y) < 1, "drawing tools stay in one row");
          assert.equal(button.height, 32, "desktop tool hit area retains host size");
        }
        assert.ok(sample.toolbar.y > sample.sidebar.height / 2, "toolbar remains at the bottom");
        assert.ok(Math.abs(sample.sidebar.bottom - sample.toolbar.bottom - 16) <= 1, "toolbar keeps the bottom inset");
        assert.ok(Math.abs(sample.toolbar.bottom - sample.footer.bottom) <= 1, "footer and drawing tools share a baseline");
        assert.ok(sample.footer.right <= sample.toolbar.x, `footer ${sample.footer.right} does not overlap toolbar ${sample.toolbar.x}`);
      });
    }
    await t.test("JSON、剪贴板与 PNG/SVG 元数据保持有效协议", () => {
      const { json, clipboard, png, svg } = result.codecs;
      assert.equal(json.valid, true);
      assert.equal(json.type, "excalidraw");
      assert.equal(json.version, 2);
      assert.ok(json.id.length > 0);
      assert.deepEqual(clipboard, { type: "excalidraw/clipboard", ids: [json.id] });
      assert.deepEqual(png, { type: "image/png", keyword: "application/vnd.excalidraw+json", sceneType: "excalidraw", ids: [json.id] });
      assert.deepEqual(svg, { sceneType: "excalidraw", ids: [json.id] });
    });
    await t.test("图形填充退出场景、栅格、SVG 和命中检测，文字与图片保持可绘制", () => {
      const outlines = new Set(["rectangle", "diamond", "ellipse", "line", "freedraw"]);
      assert.deepEqual(result.outlineRendering.map(({ type }) => type), ["rectangle", "diamond", "ellipse", "line", "freedraw", "arrow", "text", "image"]);
      for (const sample of result.outlineRendering) {
        assert.equal(sample.hasLegacyFill, false, `${sample.type}: legacy fill fields are removed`);
        assert.equal(sample.fillSets, 0, `${sample.type}: no background fill geometry`);
        assert.equal(sample.redSvgFill, false, `${sample.type}: SVG has no legacy background`);
        assert.ok(sample.paintedPixels > 0, `${sample.type}: actual pixels remain visible`);
        if (outlines.has(sample.type)) {
          assert.equal(sample.center[3], 0, `${sample.type}: center remains transparent`);
          assert.equal(sample.interiorHit, false, `${sample.type}: empty interior is not a filled hit area`);
        }
      }
      assert.deepEqual(result.outlineRendering.find(({ type }) => type === "image")?.center, [0, 170, 0, 255], "image pixel content is retained");
      const arrow = result.outlineRendering.find(({ type }) => type === "arrow")!;
      assert.equal(arrow.arrowhead, "arrow", "legacy filled arrowheads normalize to the supported outline arrow");
      assert.equal(arrow.arrowShapes, 3, "arrow body and two outline head strokes remain present");
    });
    await t.test("焦点重绘保持文档版本，Agent 命令更新实时场景并保留已有元素", () => {
      const change = result.documentChanges;
      assert.equal(change.versionAfterFocus, change.documentVersion);
      assert.ok(change.versionAfterEdit > change.documentVersion);
      assert.ok(change.versionAfterResourceAdd > change.versionAfterEdit);
      assert.equal(change.editSucceeded, true);
      assert.equal(change.createdIds.length, 1);
      assert.equal(change.previousElementPreserved, true);
      assert.equal(change.elementCount, 2);
      assert.equal(change.resourceOwnKey, true, "resource IDs remain own keys across editor and storage");
    });
    await t.test("Agent 修改 A 时 B 的实时自由绘制继续，并形成独立撤销步骤", () => {
      const state = result.editProtection.independentGesture;
      assert.equal(state.ok, true, JSON.stringify(state));
      assert.equal(state.sameStroke, true, "unrelated active gesture retains its live object instance");
      assert.ok(state.continuedPoints > state.initialPoints, "the same gesture accepts subsequent path points");
      assert.deepEqual(state.afterHumanUndo, { aX: 180, strokePresent: false });
      assert.deepEqual(state.afterAgentUndo, { aX: 120, strokePresent: false });
    });
    await t.test("目标拖动先完成，等待期间删除与剪切受控，基线变化返回冲突", () => {
      const state = result.editProtection.pendingDrag;
      assert.equal(state.waitedForDrag, true, JSON.stringify(state));
      assert.equal(state.deleteRejected, true);
      assert.equal(state.cutRejected, true);
      assert.equal(state.ok, false);
      assert.equal(state.error, "conflict");
      assert.deepEqual(state.userPosition, [145, 135]);
      assert.deepEqual(state.finalPosition, state.userPosition);
    });
    await t.test("Agent 等待 A 时 B 的独立撤销步骤继续执行", () => {
      const state = result.editProtection.independentUndo;
      assert.equal(state.beforeUndoX, 470);
      assert.equal(state.afterUndoX, 450, JSON.stringify(state));
      assert.equal(state.waitedBeforeUndo, true);
      assert.equal(state.ok, true);
      assert.deepEqual(state.aPositionAfterUndo, [130, 130]);
      assert.deepEqual(state.selectionAfterUndo, state.selectionBeforeUndo, "history preserves the in-progress gesture selection");
      assert.deepEqual(state.afterAgentCommit, { aPosition: [150, 150], aLocked: true, bX: 450 });
      assert.deepEqual(state.afterLockUndo, { aPosition: [150, 150], aLocked: false, bX: 450 });
      assert.deepEqual(state.afterGestureUndo, { aPosition: [120, 120], aLocked: false, bX: 450 }, "A's full gesture, including before B's undo, remains one step");
    });
    await t.test("新增绑定箭头保护已有端点，端点交接后更新绑定元数据", () => {
      assert.deepEqual(result.editProtection.binding, { waitedForEndpoint: true, ok: true, endpoint: "protection-A", affectedEndpoint: true });
    });
    await t.test("隔离场景按传入绑定关系重排图层，并保留独立邻居实例", () => {
      const state = result.editProtection.boundReorder;
      assert.equal(state.ok, true, JSON.stringify(state));
      assert.equal(state.neighbourPreserved, true);
      assert.deepEqual(state.ids, ["reorder-neighbour", "reorder-container", "reorder-label"]);
    });
    await t.test("输入法组合等待目标交接，取消 Agent 请求后保留人工文字会话", () => {
      const state = result.editProtection.composition;
      assert.equal(state.waitedForComposition, true, JSON.stringify(state));
      assert.equal(state.sameInput, true);
      assert.equal(state.ok, false);
      assert.match(state.error, /cancel|abort/i);
      assert.equal(state.text, "用户正在输入 😀");
    });
    await t.test("场景替换使旧等待请求失效，旧指针收尾保持新场景", () => {
      const state = result.editProtection.replacement;
      assert.equal(state.waitedBeforeReplacement, true, JSON.stringify(state));
      assert.equal(state.ok, false);
      assert.equal(state.error, "project_changed");
      assert.deepEqual(state.ids, ["replacement-scene"]);
    });
    await t.test("CanvasSurface 冷启动提交、焦点、保存冲突和重载沿同一持久化链路", () => {
      const state = result.persistence;
      assert.deepEqual(state.coldStart, { ok: true, savedElements: 2, requests: 1, canRelease: true });
      assert.equal(state.focusSaved, false);
      assert.deepEqual(state.conflict, { code: "persistence_conflict", localX: 200, diskX: 100, externalPreserved: true, actions: ["Export draft", "Reload saved"], canRelease: false });
      assert.equal(state.conflictRetried, false);
      assert.deepEqual(state.recovered, { ok: true, elements: 4, canRelease: true });
      assert.deepEqual(state.replacement, {
        requestId: "successor-create", ok: true, supersededErrors: ["canvas_edit_cancelled"], callbackRefreshProducedResult: false, originalX: 100, elements: 5,
      }, "the successor executes while the superseded target remains in its human gesture");
    });
    await t.test("中文和 emoji 经文字输入提交，历史字体保持 PNG/SVG 导出", () => {
      assert.deepEqual(result.textInput, { text: "中文输入 😀 👩‍💻", fontFamily: 2 });
      const fontNames: Record<number, string> = { 1: "Virgil", 2: "Helvetica", 3: "Cascadia", 5: "Excalifont", 6: "Nunito", 7: "Lilita One", 8: "Comic Shanns", 9: "Helvetica" };
      assert.deepEqual(result.textFonts.map((sample) => sample.fontFamily), [1, 2, 3, 5, 6, 7, 8, 9]);
      for (const sample of result.textFonts) {
        const expectedFamily = sample.fontFamily === 9 ? 2 : sample.fontFamily;
        assert.equal(sample.restoredFamily, expectedFamily);
        assert.equal(sample.pngFamily, expectedFamily);
        assert.equal(sample.pngType, "image/png");
        assert.ok(sample.paintedPixels > 0, `${fontNames[sample.fontFamily]}: exported PNG contains text pixels`);
        assert.equal(sample.pngText, "Canvas 画布 😀 👩‍💻");
        assert.equal(sample.svgText, "Canvas 画布 😀 👩‍💻");
        assert.ok(sample.svgFontFamily.includes(fontNames[sample.fontFamily]));
        if (expectedFamily === 2) {
          assert.deepEqual(sample.embeddedFamilies, [], "system UI fonts stay local");
        } else {
          assert.ok(sample.embeddedFamilies.includes(fontNames[sample.fontFamily]), `historical text font is embedded in SVG: ${JSON.stringify(sample)}`);
          assert.equal(sample.embeddedFontData, true);
        }
        if (expectedFamily === 5) assert.ok(sample.embeddedFamilies.includes("Xiaolai"), "CJK fallback glyphs remain embedded");
      }
    });
    await t.test("已有语言配置统一使用产品英语界面", () => {
      assert.deepEqual(result.languageFallback, ["zh-CN", "ar-SA"].map((requested) => ({ requested, current: "en", documentLanguage: "en", direction: "ltr", label: "Move canvas" })));
    });
    await t.test("产品工具边界与历史嵌入元素的静态兼容保持一致", () => {
      assert.deepEqual(result.capabilities, {
        toolAfterFrameShortcut: "selection", toolAfterUnsupportedAPI: "selection", libraryAPI: false, generationAPI: false,
        legacy: ["iframe", "embeddable", "magicframe"].map((type) => ({ type, visible: true, activeDOM: false })),
      });
    });
    await t.test("冷启动与项目场景替换默认抓手，主键拖动只平移视口", () => {
      const state = result.handSelection;
      for (const sample of [state.coldStart, state.sceneReplacement, state.handPan]) {
        assert.equal(sample.tool, "hand");
        assert.deepEqual(sample.checkedTools, ["hand"]);
        assert.equal(sample.cursor, "grab", JSON.stringify(sample));
      }
      assert.equal(state.handPan.unchanged, true);
      assert.deepEqual(state.handPan.selectedIds, []);
      assert.deepEqual(state.handPan.scroll, [50, 30]);
    });
    await t.test("静止 Command 切换真实选择工具，可选中和移动已有选区，释放保留选区", () => {
      const state = result.handSelection;
      assert.equal(state.commandPressed.tool, "selection");
      assert.deepEqual(state.commandPressed.checkedTools, ["selection"]);
      assert.equal(state.commandPressed.cursor, "auto");
      for (const sample of [state.commandSelected, state.commandMoved]) {
        assert.equal(sample.tool, "selection");
        assert.deepEqual(sample.selectedIds, ["navigation-rectangle"]);
        assert.deepEqual(sample.scroll, [0, 0]);
      }
      assert.deepEqual(state.commandMoved.position, [220, 170]);
      assert.equal(state.commandReleased.tool, "hand");
      assert.deepEqual(state.commandReleased.checkedTools, ["hand"]);
      assert.equal(state.commandReleased.cursor, "grab");
      assert.deepEqual(state.commandReleased.selectedIds, ["navigation-rectangle"]);
      assert.deepEqual(state.shortcuts.copyIds, ["navigation-rectangle"]);
      assert.deepEqual(state.shortcuts.positionAfterUndo, [180, 140]);
      assert.equal(state.shortcuts.toolAfterUndo, "hand");
      assert.deepEqual(state.explicitSelectionMoved.position, [220, 170], "Command keeps ordinary drag semantics after choosing the selection tool explicitly");
      for (const sample of [state.explicitSelectionMoved, state.explicitSelectionAfterRelease]) {
        assert.deepEqual(sample.selectedIds, ["navigation-rectangle"]);
        assert.deepEqual(sample.scroll, [0, 0]);
      }
      assert.equal(state.explicitSelectionMoved.tool, "selection");
      assert.equal(state.explicitSelectionAfterRelease.tool, "selection");
      assert.deepEqual(state.explicitSelectionAfterRelease.checkedTools, ["selection"]);
      assert.equal(state.pastes.length, 4);
      for (const sample of state.pastes) {
        assert.equal(sample.toolAfterInsertion, sample.releasedBeforeInsert ? "hand" : "selection", JSON.stringify(sample));
        assert.equal(sample.tool, "hand", JSON.stringify(sample));
        assert.deepEqual(sample.checkedTools, ["hand"]);
        assert.equal(sample.cursor, "grab");
        assert.equal(sample.selectedIds.length, 1, "pasted content remains selected after Command release");
      }
    });
    await t.test("手势内按下或释放 Command 保持当前手势，pointerup 后应用待切换", () => {
      const state = result.handSelection;
      assert.equal(state.commandDuringPan.tool, "hand");
      assert.equal(state.commandAfterPan.tool, "selection");
      assert.deepEqual(state.commandAfterPan.scroll, [25, 15]);
      assert.equal(state.afterDeferredPan.tool, "hand");
      assert.equal(state.releaseDuringDrag.tool, "selection");
      assert.equal(state.releaseAfterDrag.tool, "hand", JSON.stringify(state.releaseAfterDrag));
      assert.deepEqual(state.releaseAfterDrag.position, [210, 160]);
      assert.deepEqual(state.releaseAfterDrag.selectedIds, ["navigation-rectangle"]);
    });
    await t.test("Command 松开恢复原工具并识别另一侧 Command，Space 保持平移", () => {
      const state = result.handSelection;
      for (const sample of [state.originalToolOverridden, state.secondCommandStillHeld]) {
        assert.equal(sample.tool, "selection");
        assert.deepEqual(sample.checkedTools, ["selection"]);
      }
      assert.equal(state.rectangleAfterRelease.tool, "rectangle");
      assert.deepEqual(state.rectangleAfterRelease.checkedTools, ["rectangle"]);
      assert.equal(state.spacePan.tool, "rectangle");
      assert.equal(state.spacePan.cursor, "crosshair");
      assert.equal(state.spacePan.unchanged, true);
      assert.deepEqual(state.spacePan.scroll, [20, 10]);
      for (const sample of [state.explicitToolSwitch, state.heldPointerAfterExplicitSwitch, state.explicitToolAfterRelease]) {
        assert.equal(sample.tool, "ellipse", "explicit user tool choice owns the interaction session");
        assert.deepEqual(sample.checkedTools, ["ellipse"]);
      }
      for (const sample of [state.explicitHandClick, state.explicitHandAfterRelease]) {
        assert.equal(sample.tool, "hand", "the hand toolbar choice replaces the temporary selection session");
        assert.deepEqual(sample.checkedTools, ["hand"]);
      }
      assert.equal(state.beforeLockClick.locked, false);
      for (const sample of [state.explicitLockClick, state.explicitLockAfterRelease]) {
        assert.equal(sample.tool, "selection");
        assert.equal(sample.locked, true, "the toolbar lock choice survives releasing Command");
      }
    });
    await t.test("输入控件保持文字快捷键，blur、项目切换与卸载释放临时选择状态", () => {
      const state = result.handSelection;
      assert.equal(state.commandOutsideCanvas.tool, "hand");
      assert.equal(state.commandOutsidePointerUp.tool, "hand", "pointerup outside Canvas does not start a Canvas selection session");
      assert.equal(state.commandHeldOnEntry.tool, "selection");
      assert.deepEqual(state.commandHeldOnEntry.checkedTools, ["selection"]);
      assert.equal(state.commandHeldOnPointerDown.tool, "selection");
      assert.deepEqual(state.commandHeldOnPointerDown.selectedIds, ["navigation-rectangle"]);
      assert.deepEqual(state.ignoredInputs.map(({ tagName }) => tagName), ["input", "textarea"]);
      for (const sample of [...state.ignoredInputs, state.afterBlur, state.afterHeldSceneReplacement, state.afterRemount]) {
        assert.equal(sample.tool, "hand");
        assert.deepEqual(sample.checkedTools, ["hand"]);
        assert.equal(sample.cursor, "grab", JSON.stringify(sample));
        assert.deepEqual(sample.selectedIds, []);
      }
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

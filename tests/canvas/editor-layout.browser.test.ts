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

test("真实 Canvas 编辑器在桌面侧栏缩放时保持底部布局与场景", { timeout: 90_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "canvas-layout-regression-"));
  try {
    await build({
      configFile: false,
      root: fixture,
      base: "./",
      logLevel: "silent",
      esbuild: { jsx: "automatic" },
      define: { "process.env.IS_PREACT": "false" },
      resolve: {
        alias: {
          "@agent-studio/canvas-editor": join(repository, "canvas/engine/editor"),
          "@agent-studio/canvas-utils": join(repository, "canvas/engine/utils"),
          "@agent-studio/canvas-math": join(repository, "canvas/engine/math"),
        },
      },
      css: { preprocessorOptions: { scss: { quietDeps: true, silenceDeprecations: ["import"] } } },
      build: { outDir: join(temporary, "page"), emptyOutDir: true },
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await execute(electron, [join(fixture, "electron.cjs"), join(temporary, "page/index.html"), join(temporary, "profile")], {
      env,
      timeout: 40_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const line = stdout.split("\n").find((value) => value.startsWith("CANVAS_LAYOUT_RESULTS="));
    assert.ok(line, `Electron returns regression results: ${stdout}`);
    const result = JSON.parse(line.slice("CANVAS_LAYOUT_RESULTS=".length)) as {
      samples: Sample[];
      initialZoom: number;
      initialScroll: number[];
      errors: string[];
      codecs: {
        json: { valid: boolean; type: string; version: number; id: string };
        clipboard: { type: string; ids: string[] };
        png: { type: string; keyword: string; sceneType: string; ids: string[] };
        svg: { sceneType: string; ids: string[] };
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
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

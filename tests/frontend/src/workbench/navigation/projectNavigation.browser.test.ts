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
const fixture = fileURLToPath(new URL("../../../project-navigation/", import.meta.url));
const electron: string = createRequire(import.meta.url)("electron");

test("Electron navigation reuses scoped history for ordinary, registered and added projects", { timeout: 45000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "project-navigation-regression-"));
  try {
    await build({
      configFile: false, root: fixture, base: "./", logLevel: "silent", esbuild: { jsx: "automatic" },
      plugins: [{ name: "canvas-lifecycle-fixture", enforce: "pre", resolveId: (source) => /\/canvas\/ui\/CanvasSurface(?:\.[jt]sx?)?$/.test(source) ? join(fixture, "canvas.tsx") : undefined }],
      build: { outDir: join(temporary, "page"), emptyOutDir: true },
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await execute(electron, [join(fixture, "electron.cjs"), join(temporary, "page/index.html"), join(temporary, "profile"), process.env.PROJECT_NAVIGATION_SCREENSHOT ?? "", process.env.PROJECT_NAVIGATION_DARK_SCREENSHOT ?? ""], { env, timeout: 35000, maxBuffer: 1024 * 1024 });
    const line = stdout.split("\n").find((value) => value.startsWith("PROJECT_NAVIGATION_RESULTS="));
    assert.ok(line, stdout);
    const result = JSON.parse(line.slice("PROJECT_NAVIGATION_RESULTS=".length));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.settings, { gap: 8, backRegion: "no-drag", draftRetained: true });
    assert.ok(result.historyReads.includes(null));
    assert.ok(result.historyReads.includes("alpha"));
    assert.ok(result.historyReads.includes("added"));
    assert.equal(result.pickerCalls, 2);
    assert.ok(result.mainWidth >= 360);
    assert.ok(result.narrow.mainWidth >= 360, JSON.stringify(result.narrow));
    assert.ok(result.narrow.scrollWidth <= result.narrow.viewportWidth, JSON.stringify(result.narrow));
    assert.equal(result.narrow.sidebarHidden, "true");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

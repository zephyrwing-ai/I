import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "vite";

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL("./application-lifecycle/", import.meta.url));
const electron: string = createRequire(import.meta.url)("electron");

test("Electron quit and SIGTERM flush drafts and exit even when a renderer cancels normal unload", { timeout: 40000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "application-lifecycle-"));
  try {
    await build({
      configFile: false, logLevel: "silent",
      build: {
        outDir: join(temporary, "bundle"), emptyOutDir: true,
        lib: { entry: join(fixture, "entry.ts"), formats: ["cjs"], fileName: () => "lifecycle.cjs" },
        rollupOptions: { external: ["node:crypto"] },
      },
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const mode of ["legacy-cancelled-quit", "quit", "signal", "close-and-reactivate"]) {
      const profile = join(temporary, mode);
      await mkdir(profile);
      const { stdout } = await execute(electron, [join(fixture, "electron.cjs"), join(temporary, "bundle/lifecycle.cjs"), profile, mode], { env, timeout: 10000 });
      const line = stdout.split("\n").find((value) => value.startsWith("LIFECYCLE_RESULT="));
      assert.ok(line, `${mode}: ${stdout}`);
      const result = JSON.parse(line.slice("LIFECYCLE_RESULT=".length));
      if (mode === "legacy-cancelled-quit") {
        assert.equal(result.stillOpen, true);
        assert.match(result.error, /database is not open/);
      } else {
        assert.equal(result.closes, 1, mode);
        assert.equal(result.rejected, true, mode);
        assert.equal(result.phase, "terminating", mode);
        assert.equal(result.reopened, mode === "close-and-reactivate", mode);
        assert.deepEqual(result.saved, mode === "close-and-reactivate" ? ["admitted write"] : ["admitted write", "renderer draft"], mode);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

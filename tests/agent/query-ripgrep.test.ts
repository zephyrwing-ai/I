import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { rgPath } from "@vscode/ripgrep";
import { createQueryTools } from "../../agent/tools/query.js";
import { runRipgrep } from "../../agent/tools/ripgrep.js";

const tools = new Map(createQueryTools().map((tool) => [tool.definition.name, tool]));
const nativeSpawn = childProcess.spawn;

async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "query-rg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function query(name: "find_files" | "search_content", cwd: string, input: Record<string, unknown>, signal?: AbortSignal) {
  return tools.get(name)!.execute(input, { cwd, signal });
}

function substituteProcess(t: TestContext, script: string, onSpawn?: (child: ReturnType<typeof nativeSpawn>) => void) {
  let child: ReturnType<typeof nativeSpawn> | undefined;
  t.mock.method(childProcess, "spawn", (_binary: string, _args: string[], options: Parameters<typeof nativeSpawn>[2]) => {
    child = nativeSpawn(process.execPath, ["--eval", script], options);
    onSpawn?.(child);
    return child;
  });
  return () => child!;
}

function matchFrame(content = "needle\n", line = 1) {
  return `${JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, lines: { text: content }, line_number: line } })}\n`;
}

test("Query runs the installed binary with argument arrays and isolated ripgrep config", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "a.ts"), "--hello.*[世界]\n");
  const calls: Array<{ binary: string; args: string[]; options: Parameters<typeof nativeSpawn>[2] }> = [];
  t.mock.method(childProcess, "spawn", (binary: string, args: string[], options: Parameters<typeof nativeSpawn>[2]) => {
    calls.push({ binary, args, options });
    return nativeSpawn(binary, args, options);
  });
  const previousPath = process.env.PATH;
  const previousConfig = process.env.RIPGREP_CONFIG_PATH;
  process.env.PATH = "";
  process.env.RIPGREP_CONFIG_PATH = join(root, "missing-config");
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previousConfig;
  });
  const result = await query("search_content", root, { text: "--hello.*[世界]" });
  assert.equal(result.ok, true);
  assert.match(result.output, /a\.ts:1: --hello\.\*\[世界\]/);
  assert.equal(calls[0]!.binary, rgPath);
  assert.equal(calls[0]!.args[0], "--no-config");
  assert.ok(calls[0]!.args.includes("--fixed-strings"));
  assert.deepEqual(calls[0]!.args.slice(-2), ["--", "."]);
  assert.equal(calls[0]!.options?.shell, false);
});

test("literal paths, names, case, extensions and metacharacters preserve Query semantics", async (t) => {
  const root = await workspace(t);
  const folder = "--张三 [project]";
  await mkdir(join(root, folder));
  await writeFile(join(root, folder, "Alex [a].TS"), "Needle.*[甲]\nneedle.*[甲]\nNeedleXYZ甲\n");
  await writeFile(join(root, folder, "other.md"), "needle.*[甲]\n");
  await writeFile(join(root, folder, "special.[x]"), "needle.*[甲]\n");
  const files = await query("find_files", root, { path: folder, pattern: "ALEX [A]" });
  assert.equal(files.ok, true);
  assert.match(files.output, /Alex \[a\]\.TS/);
  const insensitive = await query("search_content", root, { path: folder, text: "NEEDLE.*[甲]", types: [".ts"] });
  assert.equal(insensitive.ok, true);
  assert.match(insensitive.output, /Alex \[a\]\.TS:1:/);
  assert.match(insensitive.output, /Alex \[a\]\.TS:2:/);
  assert.doesNotMatch(insensitive.output, /:3:|other\.md/);
  const sensitive = await query("search_content", root, { path: folder, text: "Needle.*[甲]", types: ["TS"], caseSensitive: true });
  assert.match(sensitive.output, /:1:/);
  assert.doesNotMatch(sensitive.output, /:2:/);
  const literalType = await query("search_content", root, { path: folder, text: "needle", types: ["[x]"] });
  assert.match(literalType.output, /special\.\[x\]:1:/);
  assert.doesNotMatch(literalType.output, /Alex/);
  const multiline = await query("search_content", root, { path: folder, text: "Needle\nneedle" });
  assert.equal(multiline.truncated, false);
  assert.match(multiline.output, /No matching content/);
});

test("native context covers every match and deduplicates overlapping lines", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "a.ts"), "before\nneedle needle\nNEEDLE\nafter\ngap\nfar-before\nneedle\nfar-after\n");
  const exact = await query("search_content", root, { text: "needle", contextLines: 1 });
  assert.equal(exact.truncated, false);
  const rows = exact.output.split("\n").filter((row) => row.startsWith("a.ts:"));
  assert.equal(rows.length, 7);
  assert.equal(new Set(rows).size, 7);
  assert.ok(rows.includes("a.ts:8: far-after"));
});

test("gitignore, fixed ignored directories, hidden files and symlinks follow search rules", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, ".gitignore"), "ignored.ts\nignored/\n");
  await writeFile(join(root, "ignored.ts"), "needle");
  await writeFile(join(root, ".visible.ts"), "needle");
  await writeFile(join(root, "build"), "needle");
  for (const folder of ["ignored", "node_modules/pkg", "src/dist", ".git", ".cache", ".superpowers", ".next", "out", "coverage", "venv", ".venv", ".hg", ".svn", ".turbo"]) {
    await mkdir(join(root, folder), { recursive: true });
    await writeFile(join(root, folder, "hidden.ts"), "needle");
  }
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", ".gitignore"), "nested.ts\n");
  await writeFile(join(root, "src", "nested.ts"), "needle");
  await symlink(join(root, ".visible.ts"), join(root, "alias.ts"));
  for (const input of [{ pattern: ".ts" }, { text: "needle" }, { text: "needle", types: ["TS"] }]) {
    const name = "pattern" in input ? "find_files" : "search_content";
    const result = await query(name, root, input);
    assert.equal(result.ok, true);
    assert.equal(result.truncated, false);
    assert.match(result.output, /\.visible\.ts/);
    assert.doesNotMatch(result.output, /hidden\.ts|ignored\.ts|nested\.ts|alias\.ts/);
    if (name === "search_content" && !("types" in input)) assert.match(result.output, /build:1: needle/);
  }
});

test("exit one is a complete empty result and matching searches return every result", async (t) => {
  const root = await workspace(t);
  for (const name of ["find_files", "search_content"] as const) {
    const empty = await query(name, root, name === "find_files" ? { pattern: "needle" } : { text: "needle" });
    assert.equal(empty.ok, true);
    assert.equal(empty.returncode, 0);
    assert.equal(empty.truncated, false);
    assert.match(empty.output, /No matching/);
  }
  await writeFile(join(root, "needle.ts"), "needle\nneedle\n");
  await writeFile(join(root, "other.ts"), "unrelated\n");
  await writeFile(join(root, "needle-2.ts"), "unrelated\n");
  const files = await query("find_files", root, { pattern: "needle" });
  const content = await query("search_content", root, { text: "needle" });
  assert.equal(files.truncated, false);
  assert.equal(content.truncated, false);
  assert.deepEqual(files.output.split("\n").slice(1), ["needle-2.ts", "needle.ts"]);
  assert.deepEqual(content.output.split("\n").slice(1), ["needle.ts:1: needle", "needle.ts:2: needle"]);
});

test("search schemas expose no result limit and legacy parameters cannot truncate results", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "many.ts"), "needle\n".repeat(1001));
  const all = await query("search_content", root, { text: "needle" });
  assert.equal(all.ok, true);
  assert.equal(all.truncated, false);
  assert.equal(all.output.split("\n").filter((row) => row.startsWith("many.ts:")).length, 1001);
  for (const name of ["find_files", "search_content"] as const) {
    assert.equal(Object.hasOwn(tools.get(name)!.definition.parameters.properties, "limit"), false);
    assert.doesNotMatch(tools.get(name)!.definition.description, /limit/i);
  }
  const many = await query("search_content", root, { text: "needle", limit: 1 });
  assert.equal(many.truncated, false);
  assert.equal(many.output, all.output);
  const filenames = Array.from({ length: 129 }, (_, i) => `needle-${String(i).padStart(3, "0")}.ts`);
  await Promise.all(filenames.map((name) => writeFile(join(root, name), "unrelated\n")));
  const files = await query("find_files", root, { pattern: "needle" });
  assert.equal(files.ok, true);
  assert.equal(files.truncated, false);
  assert.deepEqual(files.output.split("\n").slice(1), filenames);
  const legacyFiles = await query("find_files", root, { pattern: "needle", limit: 1 });
  assert.equal(legacyFiles.truncated, false);
  assert.equal(legacyFiles.output, files.output);
});

test("real matches retain full output beyond 64 KiB and individual lines beyond 256 KiB", async (t) => {
  const root = await workspace(t);
  const line = `needle${"甲".repeat(300)}`;
  await writeFile(join(root, "many.ts"), `${line}\n`.repeat(1000));
  const all = await query("search_content", root, { text: "needle" });
  assert.equal(all.ok, true);
  assert.equal(all.truncated, false);
  assert.ok(Buffer.byteLength(all.output) > 64 * 1024);
  assert.deepEqual(all.output.split("\n").slice(1), Array.from({ length: 1000 }, (_, i) => `many.ts:${i + 1}: ${line}`));
  const giantLine = `needle${"x".repeat(512 * 1024)}世界😀`;
  await writeFile(join(root, "many.ts"), `${giantLine}\n`);
  const giant = await query("search_content", root, { text: "needle" });
  assert.equal(giant.ok, true);
  assert.equal(giant.truncated, false);
  assert.equal(giant.output, `<search_root>.</search_root>\nmany.ts:1: ${giantLine}`);
});

test("Unicode matching and context lines retain every character beyond 300", async (t) => {
  const root = await workspace(t);
  const before = "甲😀".repeat(400);
  const match = `needle${"😀".repeat(400)}tail`;
  const after = "乙😀".repeat(400);
  await writeFile(join(root, "a.ts"), `${before}\n${match}\n${after}\n`);
  const result = await query("search_content", root, { text: "needle", contextLines: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert.equal(result.output, `<search_root>.</search_root>\na.ts:1: ${before}\na.ts:2: ${match}\na.ts:3: ${after}`);
});

test("contextLines above five follow caller input and numeric parameters require valid integers", async (t) => {
  const root = await workspace(t);
  const lines = Array.from({ length: 17 }, (_, i) => i === 8 ? "needle" : `context-${i + 1}`);
  await writeFile(join(root, "a.ts"), `${lines.join("\n")}\n`);
  const result = await query("search_content", root, { text: "needle", contextLines: 8 });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.output.split("\n").slice(1), lines.map((line, i) => `a.ts:${i + 1}: ${line}`));
  for (const contextLines of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "8", null]) {
    const invalid = await query("search_content", root, { text: "needle", contextLines });
    assert.equal(invalid.error, "invalid_arguments");
  }
});

test("find_files traverses past 20000 streamed paths without a scan cap", async (t) => {
  const root = await workspace(t);
  substituteProcess(t, String.raw`for (let i = 0; i < 20000; i++) process.stdout.write("ordinary-" + i + ".ts\0"); process.stdout.write("last-needle.ts\0");`);
  const result = await query("find_files", root, { pattern: "needle" });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert.match(result.output, /last-needle\.ts/);
  t.mock.restoreAll();
  substituteProcess(t, String.raw`for (let i = 0; i < 10000; i++) process.stdout.write("needle-" + i + ".ts\0");`);
  const all = await query("find_files", root, { pattern: "needle" });
  assert.equal(all.ok, true);
  assert.equal(all.truncated, false);
  assert.ok(Buffer.byteLength(all.output) > 64 * 1024);
  assert.deepEqual(all.output.split("\n").slice(1), Array.from({ length: 10000 }, (_, i) => `needle-${i}.ts`).sort());
});

test("stream framing preserves UTF8, NUL path boundaries and unusual filenames", async (t) => {
  const root = await workspace(t);
  const frame = matchFrame("needle 世界😀\n");
  substituteProcess(t, `const data = Buffer.from(${JSON.stringify(frame)}); let i = 0; const timer = setInterval(() => { if (i === data.length) { clearInterval(timer); return; } process.stdout.write(data.subarray(i, ++i)); }, 1);`);
  const content = await query("search_content", root, { text: "needle" });
  assert.match(content.output, /世界😀/);
  assert.equal(content.truncated, false);
  t.mock.restoreAll();
  await writeFile(join(root, "--世界\nfile.[x]"), "needle 世界😀\n");
  const files = await query("find_files", root, { pattern: "file.[x]" });
  assert.ok(files.output.includes(JSON.stringify("--世界\nfile.[x]")));
  const realContent = await query("search_content", root, { text: "世界😀" });
  assert.ok(realContent.output.includes(`${JSON.stringify("--世界\nfile.[x]")}:1: needle 世界😀`));
});

test("pre-abort and live abort kill children and return cancelled with partial evidence", async (t) => {
  const root = await workspace(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await query("search_content", root, { text: "needle" }, controller.signal)).error, "cancelled");
  const live = new AbortController();
  const child = substituteProcess(t, `process.on("SIGTERM", () => {}); process.stdout.write(${JSON.stringify(matchFrame())}); setInterval(() => {}, 1000);`, (processChild) => {
    processChild.stdout!.once("data", () => setImmediate(() => live.abort()));
  });
  const started = Date.now();
  const pending = query("search_content", root, { text: "needle" }, live.signal);
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error, "cancelled");
  assert.equal(cancelled.truncated, true);
  assert.match(cancelled.output, /a\.ts:1: needle/);
  assert.equal(child().signalCode, "SIGKILL");
  assert.ok(Date.now() - started < 2000);
});

test("real binary cancellation terminates streaming traversal", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "a.ts"), "needle\n".repeat(10000));
  const controller = new AbortController();
  const outcome = await runRipgrep({ args: ["--json", "--fixed-strings", "--regexp", "needle", "--", "."], cwd: root, signal: controller.signal, delimiter: 10, onFrame() { controller.abort(); return undefined; } });
  assert.equal(outcome.stop, "cancelled");
});

test("complete large stderr is retained on normal and failed exits", async (t) => {
  const root = await workspace(t);
  const diagnostic = `  start\n${"诊断😀".repeat(20000)}\nend  \n`;
  const script = `process.stdout.write(${JSON.stringify(matchFrame())}); const data = Buffer.from("  start\\n" + "诊断😀".repeat(20000) + "\\nend  \\n"); process.stderr.write(data.subarray(0, 9)); setImmediate(() => process.stderr.write(data.subarray(9)));`;
  substituteProcess(t, script);
  const success = await query("search_content", root, { text: "needle" });
  assert.equal(success.ok, true);
  assert.equal(success.truncated, false);
  assert.equal(success.output, `<search_root>.</search_root>\na.ts:1: needle\n${diagnostic}`);
  t.mock.restoreAll();
  substituteProcess(t, `${script} process.exitCode = 2;`);
  const failure = await query("search_content", root, { text: "needle" });
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "execution_failed");
  assert.equal(failure.returncode, 2);
  assert.equal(failure.truncated, true);
  assert.ok(failure.output.endsWith(diagnostic));
  t.mock.restoreAll();
  substituteProcess(t, 'process.stderr.write(Buffer.alloc(100000, 255)); process.exitCode = 2;');
  const invalidUtf8 = await query("search_content", root, { text: "needle" });
  assert.equal(invalidUtf8.error, "execution_failed");
  assert.equal(invalidUtf8.returncode, 2);
  assert.ok(invalidUtf8.output.endsWith("\uFFFD".repeat(100000)));
});

test("stream errors terminate children that ignore SIGTERM and retain accepted matches", async (t) => {
  const root = await workspace(t);
  for (const stream of ["stdout", "stderr"] as const) {
    const child = substituteProcess(t, `process.on("SIGTERM", () => {}); process.stdout.write(${JSON.stringify(matchFrame())}); setInterval(() => {}, 1000);`, (processChild) => {
      t.after(() => { if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL"); });
      processChild.stdout!.once("data", () => setImmediate(() => processChild[stream]!.emit("error", new Error(`${stream} read failed`))));
    });
    const started = Date.now();
    const result = await query("search_content", root, { text: "needle" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "execution_failed");
    assert.equal(result.truncated, true);
    assert.match(result.output, /a\.ts:1: needle/);
    assert.ok(result.output.includes(`${stream} read failed`));
    assert.equal(child().signalCode, "SIGKILL");
    assert.ok(Date.now() - started < 2000);
    t.mock.restoreAll();
  }
});

test("process failures and invalid frames preserve incomplete status and complete error text", async (t) => {
  const root = await workspace(t);
  const realError = await runRipgrep({ args: ["--json", "--fixed-strings", "--regexp", "needle", "--", "missing.ts"], cwd: root, delimiter: 10, onFrame() { return undefined; } });
  assert.equal(realError.code, 2);
  assert.match(realError.diagnostic, /missing\.ts/);
  const cases = [
    { script: `process.stdout.write(${JSON.stringify(matchFrame())}); process.stderr.write("permission denied"); process.exitCode = 2;`, error: "execution_failed", evidence: /permission denied/, code: 2 },
    { script: 'process.stdout.write("{invalid}\\n");', error: "invalid_output", evidence: /invalid output/, code: undefined },
    { script: 'process.stdout.write("unfinished");', error: "invalid_output", evidence: /incomplete protocol record/, code: undefined },
    { script: 'process.exitCode = 7;', error: "execution_failed", evidence: /code 7/, code: 7 },
  ];
  for (const scenario of cases) {
    substituteProcess(t, scenario.script);
    const result = await query("search_content", root, { text: "needle" });
    assert.equal(result.ok, false);
    assert.equal(result.error, scenario.error);
    assert.equal(result.truncated, true);
    assert.match(result.output, scenario.evidence);
    assert.doesNotMatch(result.output, /No matching/);
    if (scenario.code !== undefined) assert.equal(result.returncode, scenario.code);
    t.mock.restoreAll();
  }
  const diagnostic = `binary unavailable: ${"甲😀".repeat(20000)} tail`;
  t.mock.method(childProcess, "spawn", () => { throw new Error(diagnostic); });
  const missingBinary = await query("search_content", root, { text: "needle" });
  assert.equal(missingBinary.error, "execution_failed");
  assert.ok(missingBinary.output.endsWith(diagnostic));
  t.mock.restoreAll();
  t.mock.method(childProcess, "spawn", (_binary: string, _args: string[], options: Parameters<typeof nativeSpawn>[2]) => nativeSpawn(join(root, "missing-binary"), [], options));
  const spawnError = await query("search_content", root, { text: "needle" });
  assert.equal(spawnError.error, "execution_failed");
  assert.equal(spawnError.truncated, true);
  assert.match(spawnError.output, /ENOENT/);
  const path = "甲".repeat(100000);
  const invalidPath = await query("find_files", root, { pattern: "needle", path });
  assert.equal(invalidPath.ok, false);
  assert.equal(invalidPath.truncated, false);
  assert.equal(invalidPath.output, `Path not found: ${path}`);
});

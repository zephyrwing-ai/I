import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolRegistry } from "../../agent/tools/index.js";
import { createLocalBashOps } from "../../agent/environment.js";

function makeRegistry() {
  return createToolRegistry(createLocalBashOps());
}

function makeContext(cwd: string) {
  return { cwd, signal: undefined };
}

test("bash tool runs a command and reports returncode", async () => {
  const registry = makeRegistry();
  const bash = registry.get("bash")!;
  const result = await bash.execute({ command: "echo hello" }, makeContext(process.cwd()));
  assert.equal(result.ok, true);
  assert.equal(result.returncode, 0);
  assert.match(result.output, /hello/);
});

test("bash tool rejects empty command", async () => {
  const registry = makeRegistry();
  const bash = registry.get("bash")!;
  const result = await bash.execute({ command: "" }, makeContext(process.cwd()));
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_arguments");
});

test("read tool returns lines with range and reports truncation with next start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tools-read-"));
  await writeFile(join(dir, "a.txt"), Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join("\n"));

  const read = makeRegistry().get("read")!;
  const page = await read.execute({ path: "a.txt", start: 1, maxLines: 10 }, makeContext(dir));
  assert.equal(page.ok, true);
  assert.match(page.output, /已读取 1-10 行/);
  assert.match(page.output, /start=11/);
  assert.equal(page.truncated, true);

  const full = await read.execute({ path: "a.txt", maxLines: 100 }, makeContext(dir));
  assert.equal(full.ok, true);
  assert.match(full.output, /共 25 行/);
  assert.equal(full.truncated, false);
});

test("read tool reports missing file, directory and binary file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tools-read-"));
  await writeFile(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0]));
  const read = makeRegistry().get("read")!;

  const missing = await read.execute({ path: "nope.txt" }, makeContext(dir));
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "not_found");

  const dirCase = await read.execute({ path: "." }, makeContext(dir));
  assert.equal(dirCase.ok, false);
  assert.equal(dirCase.error, "target_is_directory");

  const binary = await read.execute({ path: "bin.dat" }, makeContext(dir));
  assert.equal(binary.ok, false);
  assert.equal(binary.error, "binary_file");
});

test("read tool returns image as media content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tools-read-"));
  await writeFile(join(dir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const read = makeRegistry().get("read")!;
  const result = await read.execute({ path: "pic.png" }, makeContext(dir));
  assert.equal(result.ok, true);
  assert.equal(result.media?.mediaType, "image/png");
  assert.match(result.media?.dataUrl ?? "", /^data:image\/png;base64,/);
  assert.equal(result.output.includes("base64"), false);
});

test("write tool creates file with parent dirs and reports artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tools-write-"));
  const write = makeRegistry().get("write")!;

  const result = await write.execute({ path: "src/lib/x.ts", content: "export const n = 1;" }, makeContext(dir));
  assert.equal(result.ok, true);
  assert.match(result.output, /已写入 src\/lib\/x\.ts/);
  assert.equal(result.artifacts?.length, 1);
  assert.equal(result.artifacts![0].operation, "created");

  const overwrite = await write.execute({ path: "src/lib/x.ts", content: "export const n = 2;" }, makeContext(dir));
  assert.equal(overwrite.ok, true);
  assert.equal(overwrite.artifacts![0].operation, "updated");
  assert.equal((await readFile(join(dir, "src/lib/x.ts"))).toString("utf8"), "export const n = 2;");
});

test("write tool rejects directory target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tools-write-"));
  await mkdir(join(dir, "sub"));
  const write = makeRegistry().get("write")!;
  const result = await write.execute({ path: "sub", content: "x" }, makeContext(dir));
  assert.equal(result.ok, false);
  assert.equal(result.error, "target_is_directory");
});

test("edit tool applies unique non-overlapping replacements and reports positions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tools-edit-"));
  await writeFile(join(dir, "f.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  const edit = makeRegistry().get("edit")!;

  const result = await edit.execute({
    path: "f.ts",
    edits: [
      { oldText: "const a = 1;", newText: "let a = 10;" },
      { oldText: "const c = 3;", newText: "let c = 30;" },
    ],
  }, makeContext(dir));
  assert.equal(result.ok, true);
  assert.match(result.output, /修改数量: 2/);
  assert.match(result.output, /第一处变更: 第 1 行/);
  assert.match(result.output, /第3行/);
  assert.equal((await readFile(join(dir, "f.ts"))).toString("utf8"), "let a = 10;\nconst b = 2;\nlet c = 30;\n");
  assert.equal(result.artifacts![0].operation, "updated");
});

test("edit tool fails atomically on non-unique match (no partial write)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tools-edit-"));
  await writeFile(join(dir, "f.ts"), "x\ny\nx\n");
  const edit = makeRegistry().get("edit")!;

  const result = await edit.execute({
    path: "f.ts",
    edits: [
      { oldText: "x", newText: "z" },
      { oldText: "y", newText: "w" },
    ],
  }, makeContext(dir));
  assert.equal(result.ok, false);
  assert.equal(result.error, "text_not_unique");
  assert.equal((await readFile(join(dir, "f.ts"))).toString("utf8"), "x\ny\nx\n");
});

test("edit tool fails on overlapping replacements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tools-edit-"));
  await writeFile(join(dir, "f.ts"), "abcdef\n");
  const edit = makeRegistry().get("edit")!;
  const result = await edit.execute({
    path: "f.ts",
    edits: [
      { oldText: "abc", newText: "1" },
      { oldText: "bcd", newText: "2" },
    ],
  }, makeContext(dir));
  assert.equal(result.ok, false);
  assert.equal(result.error, "edits_overlap");
});

test("list_dir tool sorts entries and marks truncation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tools-query-"));
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "b.md"), "x");
  await writeFile(join(dir, "a.ts"), "x");
  const listDir = makeRegistry().get("list_dir")!;

  const result = await listDir.execute({ path: "." }, makeContext(dir));
  assert.equal(result.ok, true);
  assert.match(result.output, /file a\.ts/);
  assert.match(result.output, /file b\.md/);
  assert.match(result.output, /dir sub\//);
  assert.ok(result.output.indexOf("file a.ts") < result.output.indexOf("file b.md"));
});

test("find_files tool returns relative paths and skips ignored directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tools-query-"));
  await mkdir(join(dir, "node_modules/pkg"), { recursive: true });
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src/app.ts"), "x");
  await writeFile(join(dir, "node_modules/pkg/index.ts"), "x");
  const findFiles = makeRegistry().get("find_files")!;

  const result = await findFiles.execute({ pattern: "app.ts", path: "." }, makeContext(dir));
  assert.equal(result.ok, true);
  assert.match(result.output, /src\/app\.ts/);
  assert.doesNotMatch(result.output, /node_modules/);
});

test("search_content tool finds lines and honors types filter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tools-query-"));
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src/app.ts"), "import { run } from './loop';\nrun();\n");
  await writeFile(join(dir, "src/app.md"), "import { run } from './loop';\n");
  const search = makeRegistry().get("search_content")!;

  const result = await search.execute({ text: "run", path: ".", types: ["ts"] }, makeContext(dir));
  assert.equal(result.ok, true);
  assert.match(result.output, /app\.ts:1: import/);
  assert.match(result.output, /app\.ts:2: run\(\)/);
  assert.doesNotMatch(result.output, /app\.md/);
});

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { createWriteTool } from "../../agent/tools/write.js";
import { createEditTool } from "../../agent/tools/edit.js";
import type { PreparedToolExecution, RegisteredTool, ToolCheckpoint, ToolExecutionContext } from "../../agent/tools/types.js";

const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const writeInput = { path: "file.txt", content: "after 中文\n" };
const editInput = { path: "file.txt", edits: [{ oldText: "before", newText: "after 中文" }] };

async function workspace(t: TestContext): Promise<ToolExecutionContext> {
  const dir = await fs.mkdtemp(join(tmpdir(), "file-publication-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { cwd: await fs.realpath(dir), invocationId: "test-invocation", attempt: 1 };
}

async function ready(tool: RegisteredTool, input: Record<string, unknown>, context: ToolExecutionContext): Promise<Extract<PreparedToolExecution, { kind: "ready" }>> {
  const prepared = await tool.prepare!(input, context);
  if (prepared.kind !== "ready") assert.fail(prepared.result.output);
  assert.ok(prepared.checkpoint);
  return prepared;
}

function checkpoint(prepared: Extract<PreparedToolExecution, { kind: "ready" }>): ToolCheckpoint {
  assert.ok(prepared.checkpoint);
  return prepared.checkpoint;
}

function stagingPath(evidence: ToolCheckpoint): string {
  const target = evidence.data.targetPath;
  const receipt = evidence.data.staging;
  assert.ok(typeof target === "string");
  assert.ok(receipt && typeof receipt === "object" && "relativePath" in receipt);
  assert.ok(typeof receipt.relativePath === "string");
  return join(dirname(target), receipt.relativePath);
}

async function unchanged(context: ToolExecutionContext, content = "before\n"): Promise<void> {
  assert.equal(await fs.readFile(join(context.cwd, "file.txt"), "utf8"), content);
  assert.deepEqual(await fs.readdir(context.cwd), ["file.txt"]);
}

test("abandoned preparations own no disk entries or publication locks", async (t) => {
  const context = await workspace(t);
  const write = createWriteTool();
  const input = { path: "nested/file.txt", content: "" };
  const abandoned = await ready(write, input, context);
  assert.equal(checkpoint(abandoned).version, 2);
  assert.equal(write.recovery.version, "1");
  assert.deepEqual(await fs.readdir(context.cwd), []);
  const prepared = await ready(write, input, { ...context, attempt: 2 });
  assert.notEqual(stagingPath(checkpoint(abandoned)), stagingPath(checkpoint(prepared)));
  assert.equal((await prepared.execute({ ...context, attempt: 2 })).ok, true);
  assert.equal((await fs.readFile(join(context.cwd, input.path))).length, 0);
  assert.deepEqual(await fs.readdir(join(context.cwd, "nested")), ["file.txt"]);
});

for (const [name, createTool, input] of [
  ["Write", createWriteTool, writeInput], ["Edit", createEditTool, editInput],
] as const) {
  test(`${name} prepared execution freezes its input and publishes the checkpoint's exact bytes`, async (t) => {
    const context = await workspace(t);
    await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
    const tool = createTool();
    const mutable: Record<string, unknown> = structuredClone(input);
    const prepared = await ready(tool, mutable, context);
    mutable.path = "elsewhere.txt";
    mutable.content = "unexpected";
    mutable.edits = [{ oldText: "before", newText: "unexpected" }];
    const result = await prepared.execute(context);
    assert.equal(result.ok, true);
    const bytes = await fs.readFile(join(context.cwd, "file.txt"));
    assert.equal(bytes.toString("utf8"), "after 中文\n");
    assert.equal(checkpoint(prepared).data.afterHash, digest(bytes));
    assert.equal(result.artifacts?.[0].byteSize, bytes.length);
    assert.deepEqual(await fs.readdir(context.cwd), ["file.txt"]);
    assert.equal((await prepared.execute(context)).ok, true);
    assert.equal((await tool.recovery.reconcile!(input, checkpoint(prepared), context)).kind, "succeeded");
  });

  test(`${name} rejects changed sources and a freshly prepared attempt can proceed`, async (t) => {
    const context = await workspace(t);
    await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
    const tool = createTool();
    const prepared = await ready(tool, input, context);
    assert.equal((await tool.recovery.reconcile!(input, checkpoint(prepared), context)).kind, "retry");
    await fs.writeFile(join(context.cwd, "file.txt"), "before external\n");
    assert.equal((await prepared.execute(context)).error, "file_changed");
    await unchanged(context, "before external\n");
    assert.equal((await tool.recovery.reconcile!(input, checkpoint(prepared), context)).kind, "interrupted");
    assert.equal((await tool.execute(input, { ...context, attempt: 2 })).ok, true);
  });
}

test("direct Edit and prepared Edit share validation, BOM, line positions and disjoint replacement semantics", async (t) => {
  const context = await workspace(t);
  const original = "\uFEFFfirst=1\r\nsecond=2\r\nthird=3\r\n";
  for (const path of ["direct.txt", "prepared.txt"]) await fs.writeFile(join(context.cwd, path), original);
  const edits = [{ oldText: "third=3", newText: "third=中文" }, { oldText: "first=1\r\n", newText: "first=longer\r\n" }];
  const tool = createEditTool();
  const prepared = await ready(tool, { path: "prepared.txt", edits }, context);
  const direct = await tool.execute({ path: "direct.txt", edits }, context);
  const published = await prepared.execute(context);
  assert.equal(direct.ok, true);
  assert.equal(published.ok, true);
  const bytes = await fs.readFile(join(context.cwd, "prepared.txt"));
  assert.deepEqual(bytes, await fs.readFile(join(context.cwd, "direct.txt")));
  assert.equal(bytes.toString(), "\uFEFFfirst=longer\r\nsecond=2\r\nthird=中文\r\n");
  assert.match(published.output, /#1 line 3/);
  assert.match(published.output, /First change: line 1/);
  assert.equal(checkpoint(prepared).data.afterHash, digest(bytes));
  for (const invalid of [null, [], {}, { oldText: "", newText: "x" }, { oldText: "first", newText: "x\0" }]) {
    const input = { path: "direct.txt", edits: [invalid] };
    const validation = await tool.prepare!(input, context);
    assert.equal(validation.kind, "result");
    assert.equal((await tool.execute(input, context)).error, "invalid_arguments");
  }
});

test("NUL and invalid UTF-8 policies preserve raw source bytes and hash the encoded Write payload", async (t) => {
  const context = await workspace(t);
  const file = join(context.cwd, "file.txt");
  const edit = createEditTool();
  for (const [bytes, error] of [[Buffer.from([0, 65]), "binary_file"], [Buffer.from([0xff, 65]), "invalid_encoding"]] as const) {
    await fs.writeFile(file, bytes);
    assert.equal((await edit.execute(editInput, context)).error, error);
    assert.deepEqual(await fs.readFile(file), bytes);
  }
  const write = createWriteTool();
  const input = { path: "file.txt", content: "NUL:\0 surrogate:\ud800 中文" };
  const prepared = await ready(write, input, context);
  assert.equal(checkpoint(prepared).data.beforeHash, digest(Buffer.from([0xff, 65])));
  assert.equal((await prepared.execute(context)).ok, true);
  const bytes = await fs.readFile(file);
  assert.deepEqual(bytes, Buffer.from(input.content, "utf8"));
  assert.equal(checkpoint(prepared).data.afterHash, digest(bytes));
  assert.equal((await write.execute({ path: "file\0.txt", content: "x" }, context)).error, "invalid_arguments");
});

test("v1 evidence conservatively reconciles raw bytes, absence, divergence and malformed sizes", async (t) => {
  const context = await workspace(t);
  const path = join(context.cwd, "file.txt");
  const tool = createWriteTool();
  const legacy: ToolCheckpoint = { version: 1, kind: "text_file", data: { path, beforeHash: null, afterHash: digest("after 中文\n"),
    operation: "created", mediaType: "text/plain", byteSize: Buffer.byteLength("after 中文\n") } };
  assert.equal((await tool.recovery.reconcile!(writeInput, legacy, context)).kind, "retry");
  await fs.writeFile(path, "before\n");
  legacy.data.operation = "updated";
  legacy.data.beforeHash = digest("before\n");
  assert.equal((await tool.recovery.reconcile!(writeInput, legacy, context)).kind, "retry");
  await fs.writeFile(path, "after 中文\n");
  assert.equal((await tool.recovery.reconcile!(writeInput, legacy, context)).kind, "succeeded");
  legacy.data.byteSize = 1;
  assert.equal((await tool.recovery.reconcile!(writeInput, legacy, context)).kind, "interrupted");
  await fs.writeFile(path, Buffer.from([0xff]));
  legacy.data.afterHash = digest("\uFFFD");
  legacy.data.byteSize = 3;
  assert.equal((await tool.recovery.reconcile!(writeInput, legacy, context)).kind, "interrupted");
});

test("v2 before evidence detects inode replacement even when bytes are identical", async (t) => {
  const context = await workspace(t);
  const path = join(context.cwd, "file.txt");
  await fs.writeFile(path, "before\n");
  const tool = createWriteTool();
  const prepared = await ready(tool, writeInput, context);
  await fs.writeFile(join(context.cwd, "replacement"), "before\n");
  await fs.rename(join(context.cwd, "replacement"), path);
  assert.equal((await tool.recovery.reconcile!(writeInput, checkpoint(prepared), context)).kind, "interrupted");
  assert.equal((await prepared.execute(context)).error, "file_changed");
  await unchanged(context);
});

test("checkpoint parsers reject malformed versions, fields, receipts and mismatched invocation or attempt", async (t) => {
  const context = await workspace(t);
  await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
  const tool = createWriteTool();
  const evidence = checkpoint(await ready(tool, writeInput, context));
  const patches: Array<Partial<ToolCheckpoint>> = [
    { version: 3 }, { kind: "other" }, { data: {} },
    ...[{ path: "relative" }, { beforeHash: "bad" }, { afterHash: 2 }, { byteSize: -1 }, { mediaType: null },
      { operation: "created" }, { before: { exists: true } }, { afterMode: -1 }, { staging: { relativePath: "../victim" } }]
      .map((patch) => ({ data: { ...evidence.data, ...patch } })),
  ];
  for (const patch of patches) {
    assert.equal((await tool.recovery.reconcile!(writeInput, { ...evidence, ...patch }, context)).kind, "interrupted");
  }
  assert.equal((await tool.recovery.reconcile!(writeInput, evidence, { ...context, invocationId: "other" })).kind, "interrupted");
  assert.equal((await tool.recovery.reconcile!(writeInput, evidence, { ...context, attempt: 2 })).kind, "interrupted");
  assert.equal((await tool.recovery.reconcile!({ path: "other.txt" }, evidence, context)).kind, "interrupted");
  assert.equal((await tool.recovery.reconcile!({}, evidence, context)).kind, "interrupted");
  await unchanged(context);
});

test("prepared plans bind execution to their invocation and attempt", async (t) => {
  const context = await workspace(t);
  await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
  const prepared = await ready(createWriteTool(), writeInput, context);
  assert.equal((await prepared.execute({ ...context, attempt: 2 })).error, "invalid_arguments");
  assert.equal((await prepared.execute({ ...context, invocationId: "other" })).error, "invalid_arguments");
  await unchanged(context);
  assert.equal((await prepared.execute(context)).ok, true);
});

test("publication retains executable permissions and ownership", async (t) => {
  const context = await workspace(t);
  const path = join(context.cwd, "file.txt");
  await fs.writeFile(path, "before\n");
  await fs.chmod(path, 0o751);
  const before = await fs.stat(path);
  assert.equal((await createEditTool().execute(editInput, context)).ok, true);
  const after = await fs.stat(path);
  assert.equal(after.mode & 0o777, 0o751);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
});

test("read-only targets respect the original file's write permissions", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root bypasses discretionary file permissions");
  const context = await workspace(t);
  const path = join(context.cwd, "file.txt");
  await fs.writeFile(path, "before\n");
  await fs.chmod(path, 0o444);
  for (const [tool, input] of [[createWriteTool(), writeInput], [createEditTool(), editInput]] as const) {
    assert.equal((await tool.execute(input, context)).error, "permission_denied");
  }
  await unchanged(context);
});

test("Write and Edit follow symbolic links while preserving the link itself", async (t) => {
  const context = await workspace(t);
  await fs.mkdir(join(context.cwd, "real"));
  await fs.writeFile(join(context.cwd, "real/file.txt"), "before\n");
  await fs.symlink("real/file.txt", join(context.cwd, "file.txt"));
  assert.equal((await createEditTool().execute(editInput, context)).ok, true);
  assert.equal((await createWriteTool().execute(writeInput, context)).ok, true);
  assert.equal((await fs.lstat(join(context.cwd, "file.txt"))).isSymbolicLink(), true);
  assert.equal(await fs.readlink(join(context.cwd, "file.txt")), "real/file.txt");
  assert.equal(await fs.readFile(join(context.cwd, "real/file.txt"), "utf8"), "after 中文\n");
  assert.deepEqual(await fs.readdir(join(context.cwd, "real")), ["file.txt"]);
});

test("Write creates a dangling symbolic link's real target and follows linked ancestors", async (t) => {
  const context = await workspace(t);
  await fs.mkdir(join(context.cwd, "real"));
  await fs.symlink("real", join(context.cwd, "alias"));
  await fs.symlink("alias/missing/file.txt", join(context.cwd, "file.txt"));
  assert.equal((await createWriteTool().execute(writeInput, context)).ok, true);
  assert.equal(await fs.readFile(join(context.cwd, "real/missing/file.txt"), "utf8"), writeInput.content);
  assert.equal((await fs.lstat(join(context.cwd, "file.txt"))).isSymbolicLink(), true);
});

test("symbolic link retargeting stops publication and recovery even when foreign bytes match", async (t) => {
  const context = await workspace(t);
  await fs.writeFile(join(context.cwd, "original"), "before\n");
  await fs.writeFile(join(context.cwd, "foreign"), writeInput.content);
  await fs.symlink("original", join(context.cwd, "file.txt"));
  const tool = createWriteTool();
  const prepared = await ready(tool, writeInput, context);
  await fs.unlink(join(context.cwd, "file.txt"));
  await fs.symlink("foreign", join(context.cwd, "file.txt"));
  assert.equal((await prepared.execute(context)).error, "file_changed");
  assert.equal((await tool.recovery.reconcile!(writeInput, checkpoint(prepared), context)).kind, "interrupted");
  assert.equal(await fs.readFile(join(context.cwd, "original"), "utf8"), "before\n");
  assert.equal(await fs.readFile(join(context.cwd, "foreign"), "utf8"), writeInput.content);
});

test("hard links fail explicitly and both names retain their shared original inode", async (t) => {
  const context = await workspace(t);
  await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
  await fs.link(join(context.cwd, "file.txt"), join(context.cwd, "other.txt"));
  for (const [tool, input] of [[createWriteTool(), writeInput], [createEditTool(), editInput]] as const) {
    assert.equal((await tool.execute(input, context)).error, "unsupported_file");
  }
  assert.equal(await fs.readFile(join(context.cwd, "other.txt"), "utf8"), "before\n");
  assert.equal((await fs.stat(join(context.cwd, "file.txt"))).nlink, 2);
});

for (const code of ["EACCES", "EIO", "ENOTDIR"] as const) {
  test(`${code} inspection errors remain errors in preparation and recovery`, async (t) => {
    const context = await workspace(t);
    await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
    const tool = createWriteTool();
    const evidence = checkpoint(await ready(tool, writeInput, context));
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === join(context.cwd, "file.txt")) throw Object.assign(new Error(code), { code });
      return open(...args);
    });
    assert.equal((await tool.execute(writeInput, context)).error, code === "EACCES" ? "permission_denied" : "read_failed");
    assert.equal((await tool.recovery.reconcile!(writeInput, evidence, context)).kind, "interrupted");
    await unchanged(context);
  });
}

for (const failure of ["partial_write", "file_sync", "cancel"] as const) {
  test(`${failure} before rename preserves the source and cleans the owned staging file`, async (t) => {
    const context = await workspace(t);
    const controller = new AbortController();
    context.signal = controller.signal;
    await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
    const tool = createWriteTool();
    const prepared = await ready(tool, writeInput, context);
    const open = fs.open;
    const spy = t.mock.method(fs, "rename");
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[1] === "wx") {
        if (failure === "partial_write") {
          const write = handle.writeFile.bind(handle);
          t.mock.method(handle, "writeFile", async () => { await write("partial"); throw new Error("write fault"); });
        } else {
          const sync = handle.sync.bind(handle);
          t.mock.method(handle, "sync", async () => {
            if (failure === "file_sync") throw new Error("file sync fault");
            await sync();
            controller.abort();
          });
        }
      }
      return handle;
    });
    const result = await prepared.execute(context);
    assert.equal(result.error, failure === "cancel" ? "cancelled" : "write_failed");
    assert.equal(spy.mock.callCount(), 0);
    await unchanged(context);
    t.mock.restoreAll();
    assert.equal((await tool.execute(writeInput, { ...context, signal: undefined, attempt: 2 })).ok, true);
  });
}

test("cancelled preparation and cancelled ready plans create no staging entries", async (t) => {
  const context = await workspace(t);
  await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
  const controller = new AbortController();
  const prepared = await ready(createWriteTool(), writeInput, { ...context, signal: controller.signal });
  controller.abort();
  assert.equal((await prepared.execute({ ...context, signal: controller.signal })).error, "cancelled");
  assert.equal((await createWriteTool().execute(writeInput, { ...context, signal: controller.signal })).error, "cancelled");
  await unchanged(context);
});

test("staging is exclusive and collisions keep the existing entry intact", async (t) => {
  const context = await workspace(t);
  await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
  const prepared = await ready(createWriteTool(), writeInput, context);
  const path = stagingPath(checkpoint(prepared));
  await fs.writeFile(path, "foreign staging");
  assert.equal((await prepared.execute(context)).error, "write_failed");
  assert.equal(await fs.readFile(path, "utf8"), "foreign staging");
  assert.equal(await fs.readFile(join(context.cwd, "file.txt"), "utf8"), "before\n");
});

test("publication syncs and closes prepared bytes before rename, then syncs the parent directory", async (t) => {
  const context = await workspace(t);
  await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
  const events: string[] = [];
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[1] === "wx") {
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      t.mock.method(handle, "sync", async () => { await sync(); events.push("file-sync"); });
      t.mock.method(handle, "close", async () => { await close(); events.push("stage-close"); });
    } else if (typeof args[1] === "number" && (args[1] & constants.O_DIRECTORY)) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => { await sync(); events.push("directory-sync"); });
    }
    return handle;
  });
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    assert.deepEqual(events, ["file-sync", "stage-close"]);
    assert.equal(await fs.readFile(join(context.cwd, "file.txt"), "utf8"), "before\n");
    assert.equal(await fs.readFile(args[0], "utf8"), writeInput.content);
    await rename(...args);
    events.push("rename");
  });
  assert.equal((await createWriteTool().execute(writeInput, context)).ok, true);
  assert.deepEqual(events, ["file-sync", "stage-close", "rename", "directory-sync"]);
});

for (const precreated of [false, true]) {
  test(`new directory links sync from child to established ancestor after rename (created before execute: ${precreated})`, async (t) => {
    const context = await workspace(t);
    const controller = new AbortController();
    context.signal = controller.signal;
    const input = { path: "new/deep/file.txt", content: "durable" };
    const tool = createWriteTool();
    const prepared = await ready(tool, input, context);
    const root = checkpoint(prepared).data.directoryBoundary;
    assert.ok(root && typeof root === "object" && "path" in root);
    assert.equal(root.path, context.cwd);
    if (precreated) await fs.mkdir(join(context.cwd, "new/deep"), { recursive: true });
    const events: string[] = [];
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const path = String(args[0]);
      if (typeof args[1] === "number" && (args[1] & constants.O_DIRECTORY)) {
        const sync = handle.sync.bind(handle);
        t.mock.method(handle, "sync", async () => {
          await sync();
          events.push(path);
          if (path === join(context.cwd, "new/deep")) controller.abort();
        });
      }
      return handle;
    });
    const rename = fs.rename;
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      assert.equal(events.length, 0);
      await rename(...args);
      events.push("rename");
    });
    assert.equal((await prepared.execute(context)).ok, true);
    assert.deepEqual(events, ["rename", join(context.cwd, "new/deep"), join(context.cwd, "new"), context.cwd]);
    assert.equal(await fs.readFile(join(context.cwd, input.path), "utf8"), input.content);
    assert.equal(controller.signal.aborted, true);
  });
}

for (const failingDirectory of ["new", "."]) {
  test(`new parent sync failure at ${failingDirectory} preserves the published file and remains interrupted until recovery syncs`, async (t) => {
    const context = await workspace(t);
    const input = { path: "new/deep/file.txt", content: "durable" };
    const tool = createWriteTool();
    const prepared = await ready(tool, input, context);
    const evidence = checkpoint(prepared);
    const serialized = JSON.stringify(evidence);
    const open = fs.open;
    const failurePath = join(context.cwd, failingDirectory);
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]) === failurePath && typeof args[1] === "number" && (args[1] & constants.O_DIRECTORY)) {
        t.mock.method(handle, "sync", async () => { throw new Error("ancestor sync fault"); });
      }
      return handle;
    });
    const result = await prepared.execute(context);
    assert.equal(result.error, "interrupted");
    assert.equal(result.artifacts?.[0].path, join(context.cwd, input.path));
    assert.equal(await fs.readFile(join(context.cwd, input.path), "utf8"), input.content);
    assert.equal((await tool.recovery.reconcile!(input, evidence, context)).kind, "interrupted");
    assert.equal(JSON.stringify(evidence), serialized);
    assert.deepEqual(await fs.readdir(join(context.cwd, "new/deep")), ["file.txt"]);
    t.mock.restoreAll();
    assert.equal((await tool.recovery.reconcile!(input, evidence, context)).kind, "succeeded");
    assert.equal(evidence.data.afterHash, digest(await fs.readFile(join(context.cwd, input.path))));
  });
}

test("after recovery syncs a retained matching inode before its directories and returns success only afterward", async (t) => {
  const context = await workspace(t);
  const path = join(context.cwd, "file.txt");
  await fs.writeFile(path, writeInput.content);
  const before = await fs.stat(path);
  const tool = createWriteTool();
  const evidence = checkpoint(await ready(tool, writeInput, context));
  const events: string[] = [];
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    t.mock.method(handle, "sync", async () => {
      await sync();
      events.push(String(args[0]) === path ? "file" : "directory");
    });
    return handle;
  });
  const rename = t.mock.method(fs, "rename");
  const recovered = await tool.recovery.reconcile!(writeInput, evidence, context);
  events.push(recovered.kind);
  assert.deepEqual(events, ["file", "directory", "succeeded"]);
  assert.equal(rename.mock.callCount(), 0);
  assert.equal((await fs.stat(path)).ino, before.ino);
  assert.equal(await fs.readFile(path, "utf8"), writeInput.content);
});

for (const failure of ["file", "leaf", "ancestor"] as const) {
  test(`recovery ${failure} sync failure preserves evidence and effects without reporting succeeded`, async (t) => {
    const context = await workspace(t);
    const input = { path: "new/deep/file.txt", content: "durable" };
    const tool = createWriteTool();
    const prepared = await ready(tool, input, context);
    assert.equal((await prepared.execute(context)).ok, true);
    const evidence = checkpoint(prepared);
    const serialized = JSON.stringify(evidence);
    const failurePath = join(context.cwd, failure === "file" ? input.path : failure === "leaf" ? "new/deep" : "new");
    const events: string[] = [];
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        events.push(String(args[0]));
        if (String(args[0]) === failurePath) throw new Error("recovery durability fault");
        await sync();
      });
      return handle;
    });
    const rename = t.mock.method(fs, "rename");
    const recovered = await tool.recovery.reconcile!(input, evidence, context);
    assert.equal(recovered.kind, "interrupted");
    if (recovered.kind === "interrupted") assert.match(recovered.reason, /recovery durability fault/);
    assert.equal(events[0], join(context.cwd, input.path));
    assert.equal(events.at(-1), failurePath);
    assert.equal(rename.mock.callCount(), 0);
    assert.equal(JSON.stringify(evidence), serialized);
    assert.equal(await fs.readFile(join(context.cwd, input.path), "utf8"), input.content);
    t.mock.restoreAll();
    assert.equal((await tool.recovery.reconcile!(input, evidence, context)).kind, "succeeded");
  });
}

for (const legacyVersion of [1, 2] as const) {
  test(`legacy v${legacyVersion} after recovery syncs the target and conservatively includes all ancestor directory links`, async (t) => {
    const context = await workspace(t);
    const input = { path: "new/deep/file.txt", content: "durable" };
    const tool = createWriteTool();
    const prepared = await ready(tool, input, context);
    assert.equal((await prepared.execute(context)).ok, true);
    const evidence = structuredClone(checkpoint(prepared));
    delete evidence.data.directoryBoundary;
    evidence.version = legacyVersion;
    const events: string[] = [];
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => { await sync(); events.push(String(args[0])); });
      return handle;
    });
    assert.equal((await tool.recovery.reconcile!(input, evidence, context)).kind, "succeeded");
    assert.deepEqual(events.slice(0, 4), [join(context.cwd, input.path), join(context.cwd, "new/deep"), join(context.cwd, "new"), context.cwd]);
    assert.equal(events.at(-1), parse(context.cwd).root);
  });
}

test("directory durability boundaries are validated and their recorded identity participates in recovery", async (t) => {
  const context = await workspace(t);
  const tool = createWriteTool();
  const prepared = await ready(tool, writeInput, context);
  assert.equal((await prepared.execute(context)).ok, true);
  const evidence = checkpoint(prepared);
  const boundary = evidence.data.directoryBoundary;
  assert.ok(boundary && typeof boundary === "object" && "path" in boundary && "ino" in boundary);
  assert.ok(typeof boundary.ino === "number");
  for (const invalid of [null, {}, { ...boundary, path: join(context.cwd, "sibling") }, { ...boundary, ino: -1 }, { ...boundary, ino: boundary.ino + 1 }]) {
    const corrupted: ToolCheckpoint = { ...evidence, data: { ...evidence.data, directoryBoundary: invalid } };
    assert.equal((await tool.recovery.reconcile!(writeInput, corrupted, context)).kind, "interrupted");
  }
  assert.equal(await fs.readFile(join(context.cwd, "file.txt"), "utf8"), writeInput.content);
});

test("publication and after recovery sync the physical directory chain behind a symbolic link", async (t) => {
  const context = await workspace(t);
  const real = join(context.cwd, "real");
  await fs.mkdir(real);
  await fs.symlink("real", join(context.cwd, "alias"));
  await fs.symlink("alias/new/deep/file.txt", join(context.cwd, "file.txt"));
  const tool = createWriteTool();
  const prepared = await ready(tool, writeInput, context);
  const evidence = checkpoint(prepared);
  const events: string[] = [];
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const sync = handle.sync.bind(handle);
    t.mock.method(handle, "sync", async () => { await sync(); events.push(String(args[0])); });
    return handle;
  });
  assert.equal((await prepared.execute(context)).ok, true);
  assert.deepEqual(events.slice(-3), [join(real, "new/deep"), join(real, "new"), real]);
  events.length = 0;
  assert.equal((await tool.recovery.reconcile!(writeInput, evidence, context)).kind, "succeeded");
  assert.deepEqual(events, [join(real, "new/deep/file.txt"), join(real, "new/deep"), join(real, "new"), real]);
  assert.equal((await fs.lstat(join(context.cwd, "file.txt"))).isSymbolicLink(), true);
});

test("source changes during staging verification are checked before publication", async (t) => {
  const context = await workspace(t);
  await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
  const prepared = await ready(createWriteTool(), writeInput, context);
  const path = stagingPath(checkpoint(prepared));
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === path && args[1] !== "wx") await fs.writeFile(join(context.cwd, "file.txt"), "external\n");
    return open(...args);
  });
  assert.equal((await prepared.execute(context)).error, "file_changed");
  await unchanged(context, "external\n");
});

test("cleanup IO failures report interrupted and recovery cleans only verified staging", async (t) => {
  const context = await workspace(t);
  const controller = new AbortController();
  context.signal = controller.signal;
  await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
  const tool = createWriteTool();
  const prepared = await ready(tool, writeInput, context);
  const path = stagingPath(checkpoint(prepared));
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[1] === "wx") {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => { await sync(); controller.abort(); });
    }
    return handle;
  });
  const unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]) === path) throw Object.assign(new Error("cleanup IO fault"), { code: "EIO" });
    return unlink(...args);
  });
  assert.equal((await prepared.execute(context)).error, "interrupted");
  assert.equal(await fs.readFile(path, "utf8"), writeInput.content);
  assert.equal(await fs.readFile(join(context.cwd, "file.txt"), "utf8"), "before\n");
  t.mock.restoreAll();
  assert.equal((await tool.recovery.reconcile!(writeInput, checkpoint(prepared), { ...context, signal: undefined })).kind, "retry");
  await unchanged(context);
});

for (const outcome of ["cancel_after_rename", "rename_error", "rename_effect_then_error", "directory_sync_error"] as const) {
  test(`${outcome} reports the publication fact and recovery verifies the final hash`, async (t) => {
    const context = await workspace(t);
    const controller = new AbortController();
    context.signal = controller.signal;
    await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
    const tool = createWriteTool();
    const prepared = await ready(tool, writeInput, context);
    const rename = fs.rename;
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      assert.equal(await fs.readFile(join(context.cwd, "file.txt"), "utf8"), "before\n");
      if (outcome === "rename_error") throw new Error("rename fault");
      await rename(...args);
      if (outcome === "cancel_after_rename") controller.abort();
      if (outcome === "rename_effect_then_error") throw new Error("uncertain rename reply");
    });
    if (outcome === "directory_sync_error") {
      const open = fs.open;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (typeof args[1] === "number" && (args[1] & constants.O_DIRECTORY)) {
          t.mock.method(handle, "sync", async () => { throw new Error("directory sync fault"); });
        }
        return handle;
      });
    }
    const result = await prepared.execute(context);
    assert.equal(result.ok, outcome === "cancel_after_rename");
    if (!result.ok) assert.equal(result.error, "interrupted");
    if (outcome === "directory_sync_error") assert.equal(result.artifacts?.[0].path, join(context.cwd, "file.txt"));
    assert.equal(await fs.readFile(join(context.cwd, "file.txt"), "utf8"), outcome === "rename_error" ? "before\n" : writeInput.content);
    assert.deepEqual(await fs.readdir(context.cwd), ["file.txt"]);
    t.mock.restoreAll();
    assert.equal((await tool.recovery.reconcile!(writeInput, checkpoint(prepared), { ...context, signal: undefined })).kind,
      outcome === "rename_error" ? "retry" : "succeeded");
  });
}

test("recovery cleans complete receipt-bound staging and preserves unverified partial staging", async (t) => {
  const context = await workspace(t);
  await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
  const tool = createWriteTool();
  const evidence = checkpoint(await ready(tool, writeInput, context));
  const path = stagingPath(evidence);
  await fs.writeFile(path, "partial");
  assert.equal((await tool.recovery.reconcile!(writeInput, evidence, context)).kind, "interrupted");
  assert.equal(await fs.readFile(path, "utf8"), "partial");
  await fs.writeFile(path, writeInput.content);
  assert.equal((await tool.recovery.reconcile!(writeInput, evidence, { ...context, attempt: 2 })).kind, "interrupted");
  assert.equal(await fs.readFile(path, "utf8"), writeInput.content);
  assert.equal((await tool.recovery.reconcile!(writeInput, evidence, context)).kind, "retry");
  await unchanged(context);
});

test("recovery rejects traversal, absolute staging paths, symlinks and hard links without touching foreign files", async (t) => {
  const context = await workspace(t);
  const foreign = join(context.cwd, "foreign");
  await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
  await fs.writeFile(foreign, writeInput.content);
  const tool = createWriteTool();
  const evidence = checkpoint(await ready(tool, writeInput, context));
  const path = stagingPath(evidence);
  for (const relativePath of ["../foreign", foreign, "foreign"]) {
    const invalid = structuredClone(evidence);
    const receipt = invalid.data.staging;
    assert.ok(receipt && typeof receipt === "object" && "relativePath" in receipt);
    receipt.relativePath = relativePath;
    assert.equal((await tool.recovery.reconcile!(writeInput, invalid, context)).kind, "interrupted");
  }
  await fs.symlink(foreign, path);
  assert.equal((await tool.recovery.reconcile!(writeInput, evidence, context)).kind, "interrupted");
  assert.equal((await fs.lstat(path)).isSymbolicLink(), true);
  await fs.unlink(path);
  await fs.link(foreign, path);
  assert.equal((await tool.recovery.reconcile!(writeInput, evidence, context)).kind, "interrupted");
  assert.equal(await fs.readFile(foreign, "utf8"), writeInput.content);
  assert.equal((await fs.stat(foreign)).nlink, 2);
});

test("staging replacement during execution produces interrupted and keeps the foreign entry", async (t) => {
  const context = await workspace(t);
  await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
  await fs.writeFile(join(context.cwd, "foreign"), "foreign");
  const prepared = await ready(createWriteTool(), writeInput, context);
  const path = stagingPath(checkpoint(prepared));
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[1] === "wx") {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        await sync();
        await fs.rename(path, join(context.cwd, "owned-moved"));
        await fs.symlink("foreign", path);
      });
    }
    return handle;
  });
  assert.equal((await prepared.execute(context)).error, "interrupted");
  assert.equal((await fs.lstat(path)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(join(context.cwd, "foreign"), "utf8"), "foreign");
  assert.equal(await fs.readFile(join(context.cwd, "file.txt"), "utf8"), "before\n");
});

test("cancelled queue waiters keep active publication serialized and fresh attempts can continue", async (t) => {
  const context = await workspace(t);
  await fs.writeFile(join(context.cwd, "file.txt"), "before\n");
  const tool = createWriteTool();
  const first = await ready(tool, writeInput, context);
  const secondContext = { ...context, invocationId: "second" };
  const second = await ready(tool, writeInput, secondContext);
  const thirdContext = { ...context, invocationId: "third" };
  const third = await ready(tool, writeInput, thirdContext);
  const rename = fs.rename;
  let release: () => void = () => {};
  const barrier = new Promise<void>((done) => { release = done; });
  let entered: () => void = () => {};
  const atRename = new Promise<void>((done) => { entered = done; });
  let calls = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    calls += 1;
    entered();
    await barrier;
    return rename(...args);
  });
  const publishing = first.execute(context);
  await atRename;
  const controller = new AbortController();
  const cancelled = second.execute({ ...secondContext, signal: controller.signal });
  controller.abort();
  assert.equal((await cancelled).error, "cancelled");
  const queued = third.execute(thirdContext);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(calls, 1);
  release();
  assert.equal((await publishing).ok, true);
  assert.equal((await queued).error, "file_changed");
  t.mock.restoreAll();
  assert.equal((await tool.execute({ ...writeInput, content: "fresh" }, context)).ok, true);
  await unchanged(context, "fresh");
});

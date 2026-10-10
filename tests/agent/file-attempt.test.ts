import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { run } from "../../agent/loop.js";
import { createHistoryRecorder, SqliteHistoryRepository, RepositoryError } from "../../agent/memory/index.js";
import type { ToolCall } from "../../agent/model/types.js";
import { createEditTool } from "../../agent/tools/edit.js";
import { hashBytes } from "../../agent/tools/atomic-file.js";
import { readToolCheckpoint } from "../../agent/tools/result.js";

const model = { provider: "openai" as const, model: "test" };

async function setup(t: TestContext) {
  const cwd = await fs.mkdtemp(join(tmpdir(), "agent-file-attempt-"));
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  t.after(async () => { await recorder.close(); repository.close(); await fs.rm(cwd, { recursive: true, force: true }); });
  return { cwd, repository, recorder };
}

function editCall(id: string, oldText: string, newText: string): ToolCall {
  return { id, name: "edit", input: { path: "file.txt", edits: [{ oldText, newText }] }, inputComplete: true };
}

test("same-file batch preparation follows each completed edit and its checkpoint describes the actual bytes", async (t) => {
  const { cwd, repository, recorder } = await setup(t);
  await fs.writeFile(join(cwd, "file.txt"), "count=1; name=old");
  let requests = 0;
  const result = await run("edit", model, {
    runId: "run", cwd, systemPrompt: "", recorder, tools: new Map([["edit", createEditTool()]]),
    responseImpl: async function* () {
      requests += 1;
      yield { type: "completed", content: requests === 1 ? "" : "done", toolCalls: requests === 1 ? [editCall("a", "count=1", "count=2"), editCall("b", "name=old", "name=new")] : [], stopReason: requests === 1 ? "tool_use" : "stop" };
    },
  }, { onAssistantCompleted: (response) => {
    if (response.toolCalls.length) {
      const planned = repository.database.prepare("SELECT phase, attempt_count, checkpoint_json FROM tool_invocations ORDER BY ordinal").all();
      assert.deepEqual(planned.map((row) => [row.phase, row.attempt_count, row.checkpoint_json]), [["planned", 0, null], ["planned", 0, null]]);
    }
  } });
  assert.equal(result.status, "completed", result.error?.message);
  assert.equal(await fs.readFile(join(cwd, "file.txt"), "utf8"), "count=2; name=new");
  const first = readToolCheckpoint((await repository.getToolInvocation(null, "run", "a"))!.checkpoint)!;
  const second = readToolCheckpoint((await repository.getToolInvocation(null, "run", "b"))!.checkpoint)!;
  assert.equal(first.data.afterHash, hashBytes(Buffer.from("count=2; name=old")));
  assert.equal(second.data.beforeHash, first.data.afterHash);
  assert.equal(second.data.afterHash, hashBytes(Buffer.from("count=2; name=new")));
});

test("rename followed by an outcome commit failure confirms durability before completing without applying Edit twice", { timeout: 5_000 }, async (t) => {
  const { cwd, repository, recorder } = await setup(t);
  await fs.writeFile(join(cwd, "file.txt"), "old");
  const tool = createEditTool();
  const prepare = tool.prepare!.bind(tool);
  let preparations = 0;
  tool.prepare = async (...args) => { preparations += 1; return prepare(...args); };
  const save = repository.saveToolOutcome.bind(repository);
  repository.saveToolOutcome = async () => { throw new RepositoryError("simulated storage interruption after rename", "storage"); };
  const first = await run("edit", model, {
    runId: "first", cwd, systemPrompt: "", recorder, tools: new Map([["edit", tool]]),
    responseImpl: async function* () { yield { type: "completed", content: "", toolCalls: [editCall("edit", "old", "new")], stopReason: "tool_use" }; },
  });
  assert.equal(first.status, "failed");
  assert.equal(await fs.readFile(join(cwd, "file.txt"), "utf8"), "new");
  assert.equal((await repository.getToolInvocation(null, "first", "edit"))!.phase, "effect_pending");
  await recorder.close();
  repository.saveToolOutcome = save;
  const restored = await createHistoryRecorder(repository, null);
  t.after(() => restored.close());
  const targetDirectory = dirname(await fs.realpath(join(cwd, "file.txt")));
  const open = fs.open;
  let enterSync: () => void = () => {};
  let releaseSync: () => void = () => {};
  const atDirectorySync = new Promise<void>((resolve) => { enterSync = resolve; });
  const syncBarrier = new Promise<void>((resolve) => { releaseSync = resolve; });
  t.after(releaseSync);
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === targetDirectory && typeof args[1] === "number" && (args[1] & constants.O_DIRECTORY)) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => { enterSync(); await syncBarrier; await sync(); });
    }
    return handle;
  });
  let modelRequests = 0;
  const recovery = run("resume", model, {
    runId: "second", cwd, systemPrompt: "", recorder: restored, tools: new Map([["edit", tool]]),
    responseImpl: async function* (_model, messages) {
      modelRequests += 1;
      assert.equal(messages.filter((message) => message.role === "tool" && message.toolCallId === "edit").length, 1);
      assert.equal((await repository.getToolInvocation(null, "first", "edit"))!.phase, "completed");
      yield { type: "completed", content: "done", toolCalls: [], stopReason: "stop" };
    },
  });
  await atDirectorySync;
  const awaitingDurability = (await repository.getToolInvocation(null, "first", "edit"))!;
  assert.equal(awaitingDurability.phase, "effect_pending");
  assert.equal(await repository.getEntry(awaitingDurability.resultEntryId!), null);
  assert.equal(modelRequests, 0);
  releaseSync();
  const second = await recovery;
  assert.equal(second.status, "completed", second.error?.message);
  assert.equal(preparations, 1);
  assert.equal(modelRequests, 1);
  assert.equal((await repository.getToolInvocation(null, "first", "edit"))!.attemptCount, 1);
  assert.equal(await fs.readFile(join(cwd, "file.txt"), "utf8"), "new");
});

test("execution intent storage failure leaves the target untouched and the invocation planned", async (t) => {
  const { cwd, repository, recorder } = await setup(t);
  await fs.writeFile(join(cwd, "file.txt"), "old");
  repository.beginToolAttempt = async () => { throw new RepositoryError("intent commit failed", "storage"); };
  const result = await run("edit", model, {
    runId: "run", cwd, systemPrompt: "", recorder, tools: new Map([["edit", createEditTool()]]),
    responseImpl: async function* () { yield { type: "completed", content: "", toolCalls: [editCall("edit", "old", "new")], stopReason: "tool_use" }; },
  });
  assert.equal(result.status, "failed");
  assert.equal(await fs.readFile(join(cwd, "file.txt"), "utf8"), "old");
  assert.deepEqual(await fs.readdir(cwd), ["file.txt"]);
  const invocation = (await repository.getToolInvocation(null, "run", "edit"))!;
  assert.deepEqual([invocation.phase, invocation.attemptCount, invocation.checkpoint, invocation.outcomeJson], ["planned", 0, null, null]);
});

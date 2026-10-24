import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { SqliteHistoryRepository } from "../../../agent/memory/sqlite-repository.js";
import type { HistoryScope } from "../../../agent/memory/types.js";
import { createHistoryReadTool } from "../../../agent/tools/history-read.js";
import type { ToolResult } from "../../../agent/tools/types.js";

function setup(t: TestContext): SqliteHistoryRepository {
  const repository = new SqliteHistoryRepository(":memory:");
  t.after(() => repository.close());
  return repository;
}

function unpack(result: ToolResult): { header: Record<string, unknown>; text: string } {
  const split = result.output.indexOf("\n");
  return { header: JSON.parse(result.output.slice(0, split)), text: result.output.slice(split + 1) };
}

async function userEntry(repository: SqliteHistoryRepository, scope: HistoryScope, id: string, content: string) {
  return repository.appendEntry(scope, {
    id, type: "user_message", status: "completed", runId: `run-${id}`, payload: { role: "user", content },
  });
}

test("history_read exposes exact source identity within its captured project or General scope", async (t) => {
  const repository = setup(t);
  const project = await repository.createProject({ canonicalPath: "/tmp/history-read", displayName: "history-read" });
  const general = await userEntry(repository, null, "general", "General original evidence");
  const projectEntry = await userEntry(repository, project.id, "project", "Project original evidence");
  const generalTool = createHistoryReadTool(repository, null);
  const projectTool = createHistoryReadTool(repository, project.id);
  assert.equal(generalTool.definition.name, "history_read");
  assert.deepEqual(generalTool.recovery, { version: "1", mode: "safe" });
  for (const [tool, entry] of [[generalTool, general], [projectTool, projectEntry]] as const) {
    const result = await tool.execute({ entryId: entry.id }, { cwd: "/tmp" });
    const { header, text } = unpack(result);
    assert.equal(result.ok, true);
    assert.deepEqual([header.entryId, header.entryOrder, header.revision, header.role], [entry.id, entry.entryOrder, entry.revision, "user"]);
    assert.deepEqual(JSON.parse(text), entry.payload);
  }
  const foreign = await generalTool.execute({ entryId: projectEntry.id }, { cwd: "/tmp" });
  const otherForeign = await projectTool.execute({ entryId: general.id }, { cwd: "/tmp" });
  const missing = await generalTool.execute({ entryId: "missing" }, { cwd: "/tmp" });
  assert.deepEqual(foreign, missing);
  assert.deepEqual(otherForeign, missing);
  assert.equal(missing.error, "not_found");
});

test("unfinished, interrupted and failed entries share the missing-entry response", async (t) => {
  const repository = setup(t);
  const tool = createHistoryReadTool(repository, null);
  const missing = await tool.execute({ entryId: "missing" }, { cwd: "/tmp" });
  for (const status of ["streaming", "interrupted", "failed"] as const) {
    await repository.appendEntry(null, {
      id: status, type: "assistant_message", status, runId: status, turnId: status,
      payload: { role: "assistant", content: `private ${status} text` },
    });
    assert.deepEqual(await tool.execute({ entryId: status }, { cwd: "/tmp" }), missing);
  }
});

test("character pages reconstruct original Unicode text and large tool-call arguments within the requested budget", async (t) => {
  const repository = setup(t);
  const payload = {
    role: "assistant" as const, content: "原文🙂".repeat(600), reasoning: "stored reasoning",
    toolCalls: [{ id: "large-call", name: "write", input: { content: "x".repeat(24_000) }, inputComplete: true }],
  };
  await repository.appendEntry(null, {
    id: "large", type: "assistant_message", status: "completed", runId: "large-run", turnId: "large-turn", payload,
  });
  const tool = createHistoryReadTool(repository, null);
  const original = await repository.getEntry("large");
  let offset = 0;
  let reconstructed = "";
  let pageCount = 0;
  while (true) {
    const result = await tool.execute({ entryId: "large", offset, limit: 137 }, { cwd: "/tmp" });
    const { header, text } = unpack(result);
    assert.equal(result.ok, true);
    assert.ok(Array.from(text).length <= 137);
    assert.ok(result.output.length <= 800);
    assert.equal(text.includes("\uFFFD"), false);
    reconstructed += text;
    pageCount += 1;
    if (header.nextOffset === null) {
      assert.equal(result.truncated, false);
      assert.equal(header.totalCharacters, Array.from(reconstructed).length);
      break;
    }
    assert.equal(result.truncated, true);
    assert.ok(Number(header.nextOffset) > offset);
    offset = Number(header.nextOffset);
  }
  assert.ok(pageCount > 20);
  assert.deepEqual(JSON.parse(reconstructed), payload);
  assert.deepEqual(await repository.getEntry("large"), original);
  const beyond = unpack(await tool.execute({ entryId: "large", offset: 1_000_000 }, { cwd: "/tmp" }));
  assert.equal(beyond.text, "");
  assert.equal(beyond.header.nextOffset, null);
});

test("default and maximum page sizes bound text rather than duplicating large call metadata", async (t) => {
  const repository = setup(t);
  await userEntry(repository, null, "long", "a".repeat(30_000));
  const tool = createHistoryReadTool(repository, null);
  const defaultPage = unpack(await tool.execute({ entryId: "long" }, { cwd: "/tmp" }));
  const maximumPage = unpack(await tool.execute({ entryId: "long", limit: 12_000 }, { cwd: "/tmp" }));
  assert.equal(defaultPage.text.length, 6_000);
  assert.equal(maximumPage.text.length, 12_000);
  assert.equal(defaultPage.header.nextOffset, 6_000);
  assert.equal(maximumPage.header.nextOffset, 12_000);
});

test("tool result metadata is preserved and image bytes use the media channel on the first page", async (t) => {
  const repository = setup(t);
  const media = { mediaType: "image/png", dataUrl: "data:image/png;base64,cG5n" };
  const payload = { role: "tool" as const, content: "original image result", toolCallId: "image-call", toolName: "read", isError: false, media };
  await repository.appendEntry(null, {
    id: "image", type: "tool_result", status: "completed", runId: "image-run", turnId: "image-turn", toolCallId: "image-call", payload,
  });
  const tool = createHistoryReadTool(repository, null);
  const result = await tool.execute({ entryId: "image" }, { cwd: "/tmp" });
  assert.deepEqual(result.media, media);
  assert.equal(result.output.includes(media.dataUrl), false);
  const { header, text } = unpack(result);
  assert.equal(header.role, "tool");
  assert.deepEqual(JSON.parse(text), { ...payload, media: { mediaType: media.mediaType } });
  assert.equal((await tool.execute({ entryId: "image", offset: 1 }, { cwd: "/tmp" })).media, undefined);
  assert.deepEqual((await repository.getEntry("image"))?.payload, payload);
});

test("history reads observe cancellation before storage and after an outstanding read", async (t) => {
  const repository = setup(t);
  const entry = await userEntry(repository, null, "cancel", "original");
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const originalGet = repository.getEntry.bind(repository);
  repository.getEntry = async (id) => { reads += 1; return originalGet(id); };
  const cancelled = await createHistoryReadTool(repository, null).execute({ entryId: entry.id }, { cwd: "/tmp", signal: controller.signal });
  assert.equal(cancelled.error, "cancelled");
  assert.equal(reads, 0);
  const during = new AbortController();
  let completeRead!: (value: typeof entry) => void;
  repository.getEntry = () => new Promise<typeof entry>((resolve) => { completeRead = resolve; });
  const pending = createHistoryReadTool(repository, null).execute({ entryId: entry.id }, { cwd: "/tmp", signal: during.signal });
  during.abort();
  completeRead(entry);
  assert.equal((await pending).error, "cancelled");
});

test("history_read rejects invalid identifiers, offsets, limits and unknown parameters", async (t) => {
  const repository = setup(t);
  const tool = createHistoryReadTool(repository, null);
  const invalid = [
    {}, { entryId: "" }, { entryId: " " }, { entryId: "x".repeat(257) }, { entryId: 2 },
    { entryId: "x", offset: -1 }, { entryId: "x", offset: 0.5 }, { entryId: "x", offset: "0" }, { entryId: "x", offset: null },
    { entryId: "x", offset: Number.MAX_SAFE_INTEGER + 1 }, { entryId: "x", limit: 0 },
    { entryId: "x", limit: 12_001 }, { entryId: "x", limit: 1.5 }, { entryId: "x", limit: "100" }, { entryId: "x", limit: null },
    { entryId: "x", projectId: "foreign" },
  ];
  for (const input of invalid) {
    const result = await tool.execute(input, { cwd: "/tmp" });
    assert.equal(result.error, "invalid_arguments");
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../../../agent/loop.js";
import { createHistoryRecorder, SqliteHistoryRepository } from "../../../agent/memory/index.js";
import type { ToolResult } from "../../../agent/tools/types.js";
import { toolResultMessage } from "../../../agent/tools/result.js";
import { HistoryError, HistoryService } from "../../../shell/main/session-history.js";
import { toPublicToolResult } from "../../../shell/shared/tool-result.js";

test("paginated history delivers the same public tool result and web sources as live execution", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const result: ToolResult = {
    ok: false, output: "first lines", returncode: 42, truncated: true, error: "nonzero_exit",
    fullOutputPath: "/private/full-output.txt",
    artifacts: [{ path: "/private/artifact.txt", operation: "created", mediaType: "text/plain", byteSize: 10, updatedAt: "2026-10-07T00:00:00Z" }],
    web: { pages: [{ url: "https://example.com/docs", title: "Documentation", snippet: "Original result" }] },
  };
  let liveResult: ReturnType<typeof toPublicToolResult> | undefined;
  let requests = 0;
  try {
    const terminal = await run("task", { provider: "openai", model: "test" }, {
      runId: "run", cwd: "/tmp", systemPrompt: "test", recorder,
      tools: new Map([["test", {
        definition: { name: "test", description: "test", parameters: { type: "object", properties: {}, required: [] } },
        recovery: { version: "1", mode: "safe" },
        execute: async () => result,
      }]]),
      responseImpl: async function* () {
        requests += 1;
        yield {
          type: "completed", content: requests === 1 ? "" : "done",
          toolCalls: requests === 1 ? [{ id: "call", name: "test", input: {}, inputComplete: true }] : [],
          stopReason: requests === 1 ? "tool_use" : "stop",
        };
      },
    }, { onToolCompleted: (_call, outcome) => { liveResult = toPublicToolResult(outcome); } });
    assert.equal(terminal.status, "completed");
    await recorder.close();
    const service = new HistoryService(() => null, repository);
    const latest = await service.loadPage({ cursor: null, limit: 1 });
    const older = await service.loadPage({ cursor: latest.nextCursor, limit: 1 });
    const entry = older.entries[0]!;
    assert.equal(entry.type, "tool_result");
    assert.deepEqual(entry.toolResult, liveResult);
    assert.equal(entry.toolResult?.returncode, 42);
    assert.equal(entry.toolResult?.truncated, true);
    assert.equal(entry.toolResult?.output, "first lines");
    assert.deepEqual(entry.toolResult?.web, result.web);
    assert.deepEqual(Object.keys(entry.toolResult!).sort(), ["error", "ok", "output", "returncode", "truncated", "web"]);
    assert.equal(JSON.stringify(entry.toolResult).includes("/private/"), false);
    assert.equal(entry.payload.isError, true);
    assert.match(entry.payload.content, /<returncode>42<\/returncode>/);
  } finally {
    await recorder.close();
    repository.close();
  }
});

test("history outcome association checks project, run, turn and tool identities", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const firstProject = await repository.createProject({ canonicalPath: "/tmp/history-a", displayName: "A" });
  const secondProject = await repository.createProject({ canonicalPath: "/tmp/history-b", displayName: "B" });
  try {
    for (const [index, projectId] of [null, firstProject.id, secondProject.id].entries()) {
      const runId = `run-${index}`;
      const entryId = `result-${index}`;
      const invocation = await repository.registerToolInvocation({
        projectId, runId, turnId: `turn-${index}`, cwd: "/tmp", assistantEntryId: `assistant-${index}`,
        toolCallId: "same-call", ordinal: 0, toolName: "test", toolVersion: "1", inputJson: "{}", inputHash: "hash",
        recoveryModeSnapshot: "safe", resultEntryId: entryId,
      });
      await repository.beginToolAttempt(invocation.id);
      const outcome = { ok: true, output: `scope-${index}`, returncode: 0, truncated: false };
      await repository.saveToolOutcome(invocation.id, { status: "succeeded", outcome });
      await repository.commitToolResult(projectId, {
        id: entryId, type: "tool_result", status: "completed", runId, turnId: `turn-${index}`, toolCallId: "same-call",
        payload: toolResultMessage({ id: "same-call", name: "test" }, outcome),
      }, invocation.id);
    }
    const ids = ["result-0", "result-1", "result-2"];
    assert.deepEqual([...await repository.getToolOutcomesForEntries(null, ids)].map(([id]) => id), ["result-0"]);
    const service = new HistoryService(() => firstProject.id, repository);
    const page = await service.loadPage({ cursor: null, limit: 10 });
    assert.equal(page.entries[0]?.toolResult?.output, "scope-1");
    for (const [column, replacement] of [["run_id", "other-run"], ["turn_id", "other-turn"], ["tool_call_id", "other-call"]]) {
      const invocation = (await repository.getToolInvocation(firstProject.id, "run-1", "same-call"))!;
      repository.database.prepare(`UPDATE tool_invocations SET ${column} = ? WHERE id = ?`).run(replacement, invocation.id);
      assert.equal((await repository.getToolOutcomesForEntries(firstProject.id, ["result-1"])).size, 0);
      repository.database.prepare(`UPDATE tool_invocations SET ${column} = ? WHERE id = ?`).run(column === "run_id" ? "run-1" : column === "turn_id" ? "turn-1" : "same-call", invocation.id);
    }
  } finally {
    repository.close();
  }
});

test("legacy tool messages remain readable without a structured invocation outcome", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    await repository.appendEntry(null, {
      id: "legacy", type: "tool_result", status: "completed", runId: "legacy-run", turnId: "legacy-turn", toolCallId: "legacy-call",
      payload: { role: "tool", content: "old text result", toolCallId: "legacy-call" },
    });
    const page = await new HistoryService(() => null, repository).loadPage({ cursor: null, limit: 10 });
    assert.equal(page.entries[0]?.payload.content, "old text result");
    assert.equal(page.entries[0]?.toolResult, undefined);
  } finally {
    repository.close();
  }
});

test("a malformed stored outcome produces a history storage error", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const invocation = await repository.registerToolInvocation({
      projectId: null, runId: "run", turnId: "turn", cwd: "/tmp", assistantEntryId: "assistant", toolCallId: "call",
      ordinal: 0, toolName: "test", toolVersion: "1", inputJson: "{}", inputHash: "hash", recoveryModeSnapshot: "safe", resultEntryId: "result",
    });
    await repository.beginToolAttempt(invocation.id);
    await repository.saveToolOutcome(invocation.id, { status: "failed", outcome: { ok: false, output: "bad data", returncode: -1, truncated: false } });
    repository.database.prepare("UPDATE tool_invocations SET outcome_json = ? WHERE id = ?").run(JSON.stringify({ ok: "false", output: "bad data", returncode: -1, truncated: false }), invocation.id);
    await repository.appendEntry(null, {
      id: "result", type: "tool_result", status: "completed", runId: "run", turnId: "turn", toolCallId: "call",
      payload: { role: "tool", content: "message", toolCallId: "call" },
    });
    await assert.rejects(new HistoryService(() => null, repository).loadPage({ cursor: null, limit: 10 }),
      (error: unknown) => error instanceof HistoryError && error.code === "storage");
  } finally {
    repository.close();
  }
});

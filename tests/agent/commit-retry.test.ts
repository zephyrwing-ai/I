import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";
import { run } from "../../agent/loop.js";
import { RepositoryError, SqliteHistoryRepository, createHistoryRecorder } from "../../agent/memory/index.js";
import type { ModelStreamEvent } from "../../agent/model/types.js";

const call = { id: "call", name: "test", input: {}, inputComplete: true };
const transient = () => new RepositoryError("Database is busy", "storage", { retryable: true });

test("complete answers and tool batches retry the same local commit without regenerating responses", async () => {
  for (const toolResponse of [false, true]) {
    for (const streamingDraft of [false, true]) {
      const repository = new SqliteHistoryRepository(":memory:");
      const recorder = await createHistoryRecorder(repository, null);
      const entryIds: string[] = [];
      const plans: unknown[] = [];
      let requests = 0;
      let executions = 0;
      let preparations = 0;
      let modelRetries = 0;
      let firstTurnId: string | null | undefined;
      const commit = repository.commitAssistantAttempt.bind(repository);
      repository.commitAssistantAttempt = async (scope, assistant, inputs) => {
        if (assistant.entry.status !== "completed") return commit(scope, assistant, inputs);
        firstTurnId ??= assistant.entry.turnId;
        if (assistant.entry.turnId !== firstTurnId) return commit(scope, assistant, inputs);
        entryIds.push(assistant.entry.id);
        plans.push(structuredClone(inputs));
        if (entryIds.length < 3) {
          assert.deepEqual(recorder.snapshot().map((message) => message.role), ["user"]);
          assert.deepEqual(await repository.listOpenToolInvocations(null), []);
          assert.equal(executions, 0);
          assert.equal(preparations, 0);
          throw transient();
        }
        return commit(scope, assistant, inputs);
      };
      try {
        const result = await run("task", { provider: "openai", model: "fake" }, {
          runId: "run", systemPrompt: "test", cwd: "/tmp", recorder,
          commitRetry: { baseDelayMs: 0 },
          tools: new Map([["test", {
            definition: { name: "test", description: "test", parameters: { type: "object", properties: {}, required: [] } },
            recovery: { version: "1", mode: "safe" },
            prepare: async () => {
              preparations += 1;
              return {
                kind: "ready" as const,
                checkpoint: { version: 1, kind: "test", data: { preparation: preparations } },
                execute: async (context) => {
                  assert.equal(context.attempt, 1);
                  assert.equal(context.checkpoint?.data.preparation, 1);
                  executions += 1;
                  return { ok: true, output: "result", returncode: 0, truncated: false };
                },
              };
            },
            execute: async () => { executions += 1; return { ok: true, output: "result", returncode: 0, truncated: false }; },
          }]]),
          responseImpl: async function* (_config, messages): AsyncGenerator<ModelStreamEvent> {
            requests += 1;
            if (requests === 2) {
              assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool"]);
              yield { type: "completed", content: "done", toolCalls: [], stopReason: "stop" };
              return;
            }
            if (streamingDraft) {
              yield { type: "text_delta", delta: "draft".repeat(1000) };
              await nextTick();
              assert.equal((await repository.listEntries(null)).at(-1)!.status, "streaming");
            }
            yield { type: "completed", content: "complete", toolCalls: toolResponse ? [call] : [], stopReason: toolResponse ? "tool_use" : "stop" };
          },
        }, { onTurnRetrying: () => { modelRetries += 1; } });
        assert.equal(result.status, "completed", JSON.stringify({ toolResponse, streamingDraft, error: result.error, entryIds }));
        assert.equal(requests, toolResponse ? 2 : 1);
        assert.equal(executions, toolResponse ? 1 : 0);
        assert.equal(preparations, toolResponse ? 1 : 0);
        assert.equal(modelRetries, 0);
        assert.equal(entryIds.length, 3);
        assert.equal(new Set(entryIds).size, 1);
        if (toolResponse) assert.deepEqual(plans, [plans[0], plans[0], plans[0]]);
        const entries = await repository.listEntries(null);
        assert.deepEqual(entries.map((entry) => entry.status), Array(toolResponse ? 4 : 2).fill("completed"));
        assert.deepEqual(recorder.snapshot().map((message) => message.role), toolResponse ? ["user", "assistant", "tool", "assistant"] : ["user", "assistant"]);
      } finally {
        await recorder.close();
        repository.close();
      }
    }
  }
});

test("permanent errors and exhausted commit retries fail without executing or requesting the model again", async () => {
  for (const [error, expectedAttempts] of [
    [new RepositoryError("Identity conflict", "conflict"), 1],
    [new RepositoryError("Disk full", "storage"), 1],
    [new Error("Unknown failure"), 1],
    [transient(), 3],
  ] as const) {
    const repository = new SqliteHistoryRepository(":memory:");
    const recorder = await createHistoryRecorder(repository, null);
    let attempts = 0;
    let requests = 0;
    let executions = 0;
    let preparations = 0;
    let completed = 0;
    const commit = repository.commitAssistantAttempt.bind(repository);
    repository.commitAssistantAttempt = async (scope, assistant, plans) => {
      if (assistant.entry.status === "completed") { attempts += 1; throw error; }
      return commit(scope, assistant, plans);
    };
    try {
      const result = await run("task", { provider: "openai", model: "fake" }, {
        runId: "run", systemPrompt: "test", cwd: "/tmp", recorder, commitRetry: { baseDelayMs: 0 },
        tools: new Map([["test", {
          definition: { name: "test", description: "test", parameters: { type: "object", properties: {}, required: [] } },
          recovery: { version: "1", mode: "safe" },
          prepare: async () => { preparations += 1; return { kind: "result" as const, result: { ok: false, output: "invalid", returncode: -1, truncated: false, error: "invalid_input" } }; },
          execute: async () => { executions += 1; return { ok: true, output: "result", returncode: 0, truncated: false }; },
        }]]),
        responseImpl: async function* (): AsyncGenerator<ModelStreamEvent> {
          requests += 1;
          yield { type: "text_delta", delta: "complete" };
          yield { type: "completed", content: "complete", toolCalls: [call], stopReason: "tool_use" };
        },
      }, { onAssistantCompleted: () => { completed += 1; } });
      assert.equal(result.status, "failed");
      assert.equal(result.error?.message, error.message);
      assert.deepEqual([attempts, requests, executions, completed], [expectedAttempts, 1, 0, 0]);
      assert.equal(preparations, 0);
      assert.deepEqual(await repository.listOpenToolInvocations(null), []);
      assert.deepEqual((await repository.listEntries(null)).map((entry) => entry.status), ["completed", "failed"]);
      assert.deepEqual(recorder.snapshot().map((message) => message.role), ["user"]);
    } finally {
      await recorder.close();
      repository.close();
    }
  }
});

test("Stop interrupts commit backoff or a just-committed response before tools start", { timeout: 1000 }, async () => {
  for (const [toolResponse, cancelAfterCommit] of [[false, false], [true, false], [false, true], [true, true]]) {
    const repository = new SqliteHistoryRepository(":memory:");
    const recorder = await createHistoryRecorder(repository, null);
    const controller = new AbortController();
    let attempts = 0;
    let requests = 0;
    let completed = 0;
    let preparations = 0;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => { abortTimer = setTimeout(() => controller.abort(), 5); throw transient(); };
    const commit = repository.commitAssistantAttempt.bind(repository);
    repository.commitAssistantAttempt = async (scope, assistant, plans) => {
      if (assistant.entry.status === "completed") {
        attempts += 1;
        if (!cancelAfterCommit) fail();
        const saved = await commit(scope, assistant, plans);
        controller.abort();
        return saved;
      }
      return commit(scope, assistant, plans);
    };
    try {
      const result = await run("task", { provider: "openai", model: "fake" }, {
        runId: "run", systemPrompt: "test", cwd: "/tmp", recorder, signal: controller.signal,
        tools: new Map([["test", {
          definition: { name: "test", description: "test", parameters: { type: "object", properties: {}, required: [] } },
          recovery: { version: "1", mode: "safe" },
          prepare: async () => { preparations += 1; return { kind: "result" as const, result: { ok: false, output: "invalid", returncode: -1, truncated: false, error: "invalid_input" } }; },
          execute: async () => { throw new Error("Cancelled tools must remain unstarted"); },
        }]]),
        commitRetry: { baseDelayMs: 10_000, maxDelayMs: 10_000 },
        responseImpl: async function* (): AsyncGenerator<ModelStreamEvent> {
          requests += 1;
          yield { type: "text_delta", delta: "complete" };
          yield { type: "completed", content: "complete", toolCalls: toolResponse ? [call] : [], stopReason: toolResponse ? "tool_use" : "stop" };
        },
      }, { onAssistantCompleted: () => { completed += 1; } });
      assert.equal(result.status, "cancelled");
      assert.deepEqual([attempts, requests, completed], [1, 1, 0]);
      assert.equal(preparations, 0);
      assert.equal(await repository.isRunCancelled(null, "run"), true);
      if (!cancelAfterCommit) {
        assert.deepEqual((await repository.listEntries(null)).map((entry) => entry.status), ["completed", "interrupted"]);
        assert.deepEqual(recorder.snapshot().map((message) => message.role), ["user"]);
      } else if (toolResponse) {
        const invocation = (await repository.getToolInvocation(null, "run", call.id))!;
        assert.deepEqual([invocation.phase, invocation.outcomeStatus, invocation.attemptCount], ["completed", "cancelled", 0]);
      }
    } finally {
      clearTimeout(abortTimer);
      await recorder.close();
      repository.close();
    }
  }
});

test("successful final answer or atomic tool commit clears its own earlier background draft failure", async () => {
  for (const toolResponse of [false, true]) {
    const repository = new SqliteHistoryRepository(":memory:");
    const recorder = await createHistoryRecorder(repository, null);
    const append = repository.appendEntry.bind(repository);
    let failures = 0;
    let requests = 0;
    repository.appendEntry = async (scope, entry) => {
      if (entry.type === "assistant_message" && entry.status === "streaming") { failures += 1; throw transient(); }
      return append(scope, entry);
    };
    try {
      const result = await run("task", { provider: "openai", model: "fake" }, {
        runId: "run", systemPrompt: "test", cwd: "/tmp", recorder, tools: new Map(),
        responseImpl: async function* (): AsyncGenerator<ModelStreamEvent> {
          requests += 1;
          if (requests === 1) {
            yield { type: "text_delta", delta: "draft".repeat(1000) };
            await nextTick();
          }
          yield { type: "completed", content: "complete", toolCalls: toolResponse && requests === 1 ? [call] : [], stopReason: toolResponse && requests === 1 ? "tool_use" : "stop" };
        },
      });
      assert.equal(failures, 1);
      assert.equal(result.status, "completed");
      assert.equal(requests, toolResponse ? 2 : 1);
      assert.equal((await repository.listEntries(null)).every((entry) => entry.status === "completed"), true);
    } finally {
      await recorder.close();
      repository.close();
    }
  }
});

test("tool outcome and materialization retries preserve one physical execution even after a lost storage acknowledgement", async () => {
  for (const failurePoint of ["outcome", "message"] as const) {
    const repository = new SqliteHistoryRepository(":memory:");
    const recorder = await createHistoryRecorder(repository, null);
    let executions = 0;
    let preparations = 0;
    let requests = 0;
    const attemptedIds: string[] = [];
    if (failurePoint === "outcome") {
      const save = repository.saveToolOutcome.bind(repository);
      repository.saveToolOutcome = async (id, outcome) => {
        attemptedIds.push(id);
        const saved = await save(id, outcome);
        if (attemptedIds.length < 3) throw transient();
        return saved;
      };
    } else {
      const commit = repository.commitToolResult.bind(repository);
      repository.commitToolResult = async (scope, entry, invocationId) => {
        attemptedIds.push(entry.id);
        const saved = await commit(scope, entry, invocationId);
        if (attemptedIds.length < 3) throw transient();
        return saved;
      };
    }
    try {
      const result = await run("task", { provider: "openai", model: "fake" }, {
        runId: "run", systemPrompt: "test", cwd: "/tmp", recorder, commitRetry: { baseDelayMs: 0 },
        tools: new Map([["test", {
          definition: { name: "test", description: "test", parameters: { type: "object", properties: {}, required: [] } },
          recovery: { version: "1", mode: "safe" },
          prepare: async () => {
            preparations += 1;
            return {
              kind: "ready" as const, checkpoint: { version: 1, kind: "test", data: { attempt: preparations } },
              execute: async () => { executions += 1; return { ok: true, output: "once", returncode: 0, truncated: false }; },
            };
          },
          execute: async () => { throw new Error("Prepared execution owns the physical effect"); },
        }]]),
        responseImpl: async function* (_config, messages): AsyncGenerator<ModelStreamEvent> {
          requests += 1;
          if (requests === 1) yield { type: "completed", content: "", toolCalls: [call], stopReason: "tool_use" };
          else {
            assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool"]);
            yield { type: "completed", content: "done", toolCalls: [], stopReason: "stop" };
          }
        },
      });
      assert.equal(result.status, "completed", result.error?.message);
      assert.deepEqual([requests, preparations, executions], [2, 1, 1]);
      assert.equal(attemptedIds.length, 3);
      assert.equal(new Set(attemptedIds).size, 1);
      const invocation = (await repository.getToolInvocation(null, "run", "call"))!;
      assert.deepEqual([invocation.phase, invocation.attemptCount], ["completed", 1]);
      assert.equal((await repository.listEntries(null)).filter((entry) => entry.type === "tool_result").length, 1);
      assert.deepEqual(recorder.snapshot().map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
    } finally { await recorder.close(); repository.close(); }
  }
});

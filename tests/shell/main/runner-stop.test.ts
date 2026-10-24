import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../../../agent/loop.js";
import { SqliteHistoryRepository, createHistoryRecorder } from "../../../agent/memory/index.js";
import { AgentRunner, type ResolvedRunRequest } from "../../../shell/main/runner.js";
import type { AgentEvent } from "../../../shell/shared/ipc.js";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderStore } from "../../../shell/main/provider-store.js";

function request(historyRecorder: ResolvedRunRequest["historyRecorder"]): ResolvedRunRequest {
  return {
    runId: "stopped-run", initialUserEntryId: "accepted-task", initialUserCreatedAt: 1_234, task: "never execute", cwd: process.cwd(), projectId: null,
    projectContextVersion: null, historyRecorder, modelOptionId: "fake-model", providerProfileId: "fake-provider",
    provider: "openai", modelId: "fake", getApiKey: async () => { throw new Error("The stopped run must not request an API key."); },
  };
}

test("Main persists Stop before the deferred runtime starts and completes as cancelled", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  const runner = new AgentRunner();
  let resolveCompleted!: (event: Extract<AgentEvent, { type: "runCompleted" }>) => void;
  const completed = new Promise<Extract<AgentEvent, { type: "runCompleted" }>>((resolve) => { resolveCompleted = resolve; });
  const handle = runner.start(request(recorder), (event) => { if (event.type === "runCompleted") resolveCompleted(event); });
  handle.stop();
  assert.equal(await repository.isRunCancelled(null, handle.runId), true);
  const terminal = await completed;
  assert.equal(terminal.status, "cancelled");
  assert.deepEqual(terminal.unappliedInputIds, ["accepted-task"]);
  assert.equal(runner.isActive, false);
  const archived = await repository.getEntry("accepted-task");
  assert.equal(archived?.payload.content, "never execute");
  assert.equal(archived?.status, "interrupted");
  assert.equal(archived?.createdAt, 1_234);
  assert.equal(archived?.completedAt, null);
  assert.deepEqual(recorder.snapshot(), []);
  await recorder.close();
  const restored = await createHistoryRecorder(repository, null);
  assert.deepEqual(restored.snapshot(), []);
  const next = await run("next task", { provider: "openai", model: "fake" }, {
    runId: "next", cwd: process.cwd(), systemPrompt: "", tools: new Map(), recorder: restored,
    responseImpl: async function* (_config, messages) {
      assert.deepEqual(messages.map((message) => message.content), ["next task"]);
      yield { type: "completed", content: "answer", toolCalls: [], stopReason: "stop" };
    },
  });
  assert.equal(next.status, "completed");
  await restored.close();
  repository.close();
});

test("Main aborts on Stop persistence failure and reports it through run completion", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  recorder.requestRunCancellation = () => Promise.reject(new Error("Stop could not be persisted"));
  const runner = new AgentRunner();
  let resolveCompleted!: (event: Extract<AgentEvent, { type: "runCompleted" }>) => void;
  const completed = new Promise<Extract<AgentEvent, { type: "runCompleted" }>>((resolve) => { resolveCompleted = resolve; });
  const handle = runner.start(request(recorder), (event) => { if (event.type === "runCompleted") resolveCompleted(event); });
  assert.doesNotThrow(() => handle.stop());
  const event = await completed;
  assert.equal(event.status, "failed");
  assert.match(event.error!.message, /Stop could not be persisted/);
  assert.equal(runner.isActive, false);
  await recorder.close();
  repository.close();
});

test("Main delivers native no-tool content and reasoning from compatible SSE through IPC and storage", async (t) => {
  const answer = "以下是各项指标的分析结果。";
  const reasoning = "PRIVATE ENGLISH REASONING";
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer((request, reply) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(body) as typeof requests[number]);
      reply.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] })}\n\n`);
      for (let index = 0; index < answer.length; index += 3) {
        reply.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(index, index + 3) }, finish_reason: null }] })}\n\n`);
      }
      reply.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const repository = new SqliteHistoryRepository(":memory:");
  const recorder = await createHistoryRecorder(repository, null);
  t.after(async () => { await recorder.close(); repository.close(); });
  const events: AgentEvent[] = [];
  let resolveTerminal!: (event: Extract<AgentEvent, { type: "runCompleted" }>) => void;
  const terminal = new Promise<Extract<AgentEvent, { type: "runCompleted" }>>((resolve) => { resolveTerminal = resolve; });
  const runner = new AgentRunner();
  runner.start({
    ...request(recorder), runId: "progress-http", initialUserEntryId: "progress-user", task: "请分析语音识别评价指标",
    baseURL: `http://127.0.0.1:${address.port}/v1`, getApiKey: async () => "fixture",
  }, (event) => { events.push(event); if (event.type === "runCompleted") resolveTerminal(event); });
  const completed = await terminal;
  assert.equal(completed.status, "completed", completed.error?.message);
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.messages[0]!.content, /Use ordinary prose for these updates and normal Markdown for the final answer/);
  assert.doesNotMatch(requests[0]!.messages[0]!.content, /I_PROGRESS|I_ANSWER/);
  assert.equal(events.filter((event) => event.type === "progressDelta").length, 0);
  assert.equal(events.filter((event) => event.type === "assistantDelta").map((event) => event.delta).join(""), answer);
  assert.equal(events.filter((event) => event.type === "reasoningDelta").map((event) => event.delta).join(""), reasoning);
  const assistantEvent = events.find((event) => event.type === "assistantCompleted");
  assert.equal(assistantEvent?.progress, undefined);
  assert.equal(assistantEvent?.content, answer);
  assert.equal(events.filter((event) => event.type === "toolStarted").length, 0);
  const stored = (await repository.listEntries(null)).find((entry) => entry.type === "assistant_message");
  assert.equal(stored?.payload.progress, undefined);
  assert.equal(stored?.payload.content, answer);
  assert.equal(stored?.payload.reasoning, reasoning);
  assert.equal(stored?.completedAt, assistantEvent?.completedAt);
  assert.equal(runner.isActive, false);
});

test("persisted model capabilities reach Runner requests and switching to a smaller model triggers compaction", async (t) => {
  const requests: Array<{ model: string; max_tokens: number; tools: unknown[]; messages: Array<{ content: string }> }> = [];
  const server = createServer((request, reply) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as typeof requests[number];
      requests.push(parsed);
      const content = parsed.tools.length ? "Task complete." : "Goal: continue. Evidence: old-0.";
      reply.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "model-budget-integration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "providers.json");
  const codec = { available: () => true, encrypt: (secret: string) => secret, decrypt: (secret: string) => secret };
  const profile = await new ProviderStore(file, codec).save({
    name: "Fixture", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture",
    models: [
      { id: "large-model", displayName: "Large", capabilities: { contextWindowTokens: 131_072, maxOutputTokens: 16_384, source: "provider" } },
      { id: "small-model", displayName: "Small", capabilities: { contextWindowTokens: 4096, maxOutputTokens: 256, source: "provider" } },
    ],
  });
  const store = new ProviderStore(file, codec);
  const repository = new SqliteHistoryRepository(":memory:");
  t.after(() => repository.close());
  for (let index = 0; index < 6; index += 1) {
    await repository.appendEntry(null, {
      id: `old-${index}`, runId: `old-${index}`, type: index % 2 ? "assistant_message" : "user_message", status: "completed",
      payload: { role: index % 2 ? "assistant" : "user", content: "Earlier findings ".repeat(90) },
    });
  }
  const recorder = await createHistoryRecorder(repository, null);
  t.after(() => recorder.close());
  const runner = new AgentRunner();
  const start = async (index: number) => {
    const resolved = await store.resolve(profile.models[index]!.modelOptionId);
    return new Promise<Extract<AgentEvent, { type: "runCompleted" }>>((resolve) => {
      runner.start({ task: "Continue the task.", cwd: process.cwd(), projectId: null, projectContextVersion: null, historyRecorder: recorder, ...resolved }, (event) => {
        if (event.type === "runCompleted") resolve(event);
      });
    });
  };
  const first = await start(0);
  assert.equal(first.status, "completed", first.error?.message);
  assert.equal(await repository.getLatestContextSnapshot(null), null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.max_tokens, 8192);
  const second = await start(1);
  assert.equal(second.status, "completed", second.error?.message);
  assert.ok(await repository.getLatestContextSnapshot(null));
  assert.equal(requests.length, 3);
  assert.equal(requests[1]!.model, "small-model");
  assert.equal(requests[1]!.tools.length, 0);
  assert.equal(requests[1]!.max_tokens, 64);
  assert.equal(requests[2]!.max_tokens, 256);
  assert.ok(requests[2]!.messages.some((message) => message.content.includes("Evidence: old-0")));
});

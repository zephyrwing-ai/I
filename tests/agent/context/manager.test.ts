import assert from "node:assert/strict";
import test from "node:test";
import { ContextManager, type PrepareContextInput } from "../../../agent/context/manager.js";
import { contextInputLimit, resolveContextPolicy } from "../../../agent/context/policy.js";
import { estimateRequestTokens, estimateTextTokens } from "../../../agent/context/tokens.js";
import { SqliteHistoryRepository } from "../../../agent/memory/sqlite-repository.js";
import type { HistoryEntry } from "../../../agent/memory/types.js";
import type { ModelConfig, response } from "../../../agent/model/index.js";
import { ModelAdapterError, type ModelMessage, type ModelStreamEvent, type ToolDef } from "../../../agent/model/types.js";

const model: ModelConfig = {
  provider: "openai",
  model: "context-test",
  context: {
    windowTokens: 4_096,
    outputReserveTokens: 256,
    safetyTokens: 128,
    growthTokens: 500,
    recentTokens: 200,
    summaryTokens: 256,
  },
};
const tools: ToolDef[] = [{
  name: "read", description: "Read a project file.",
  parameters: { type: "object", properties: { path: { type: "string", description: "File path." } }, required: ["path"] },
}];
const completed = (content: string): ModelStreamEvent => ({ type: "completed", content, toolCalls: [], stopReason: "stop" });

type SummarySource = { entryId: string; order: number; role: ModelMessage["role"]; content: string; progress?: string; toolCalls?: ModelMessage["toolCalls"]; toolCallId?: string };
type SummaryRequest = { previousSummary: string; summaryFragment?: string; conversation: SummarySource[] };
type CapturedRequest = { config: ModelConfig; messages: ModelMessage[]; system: string; tools: ToolDef[] };

function responder() {
  const requests: CapturedRequest[] = [];
  const respond: typeof response = async function* (config, messages, system, definitions) {
    requests.push({ config, messages: structuredClone(messages), system, tools: structuredClone(definitions) });
    yield completed(`Continuity summary ${requests.length}: preserve the goal, pending work, and evidence.`);
  };
  return { requests, respond };
}

function source(request: CapturedRequest): SummaryRequest {
  return JSON.parse(request.messages[0]!.content) as SummaryRequest;
}

async function append(repository: SqliteHistoryRepository, messages: ModelMessage[], prefix = "history"): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  for (const [index, payload] of messages.entries()) {
    entries.push(await repository.appendEntry(null, {
      id: `${prefix}-${index}`, runId: `${prefix}-run`, turnId: payload.role === "user" ? null : `${prefix}-turn-${index}`,
      type: payload.role === "user" ? "user_message" : payload.role === "assistant" ? "assistant_message" : "tool_result",
      status: "completed", payload, toolCallId: payload.toolCallId,
    }));
  }
  return entries;
}

function input(user: HistoryEntry, overrides: Partial<PrepareContextInput> = {}): PrepareContextInput {
  return { model, system: "Continue the user's project work.", tools, userEntryId: user.id, materials: [], ...overrides };
}

async function compactableHistory(repository: SqliteHistoryRepository): Promise<HistoryEntry[]> {
  return append(repository, [
    { role: "user", content: `Original requirement: ${"a".repeat(900)}` },
    { role: "assistant", content: `Earlier investigation: ${"b".repeat(900)}` },
    { role: "user", content: "Keep this latest correction verbatim." },
  ]);
}

function assertToolPairsTogether(requests: CapturedRequest[]): void {
  for (const request of requests) {
    const conversation = source(request).conversation;
    const calls = conversation.flatMap((entry) => entry.toolCalls ?? []);
    assert.deepEqual(
      conversation.filter((entry) => entry.role === "tool").map((entry) => entry.toolCallId).sort(),
      calls.map((call) => call.id).sort(),
    );
  }
}

test("context budgeting and compaction retain independent public process explanations", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const progress = `Comparison checkpoints: ${"p".repeat(1_800)}`;
    const entries = await append(repository, [
      { role: "user", content: "Compare these metrics." },
      { role: "assistant", content: "Analysis delivered.", progress },
      { role: "user", content: "Continue with the corrections." },
    ], "process-context");
    const { requests, respond } = responder();
    await new ContextManager(repository, null, respond).prepare(input(entries[2]!));
    assert.equal(requests.length, 1, "Progress contributes to the existing growth budget");
    const assistant = source(requests[0]!).conversation.find((entry) => entry.role === "assistant");
    assert.equal(assistant?.progress, progress);
    assert.equal(assistant?.content, "Analysis delivered.");
    assert.equal((await repository.getEntry(entries[1]!.id))?.payload.progress, progress);
  } finally {
    repository.close();
  }
});

test("persisted summaries survive a new ContextManager without replaying covered history", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const entries = await compactableHistory(repository);
    const { requests, respond } = responder();
    const material: ModelMessage = { role: "user", content: "Frozen canvas selection: selected-node." };
    const first = await new ContextManager(repository, null, respond).prepare(input(entries[2]!, { materials: [material] }));
    const snapshot = await repository.getLatestContextSnapshot(null);
    assert.equal(requests.length, 1);
    assert.ok(snapshot);
    assert.equal(first.snapshotVersion, snapshot.version);
    assert.equal(snapshot.coveredThroughOrder, entries[1]!.entryOrder);
    assert.deepEqual(source(requests[0]!).conversation.map((entry) => entry.entryId), entries.slice(0, 2).map((entry) => entry.id));
    assert.equal(requests[0]!.config.maxOutputTokens, 256);
    assert.deepEqual(requests[0]!.tools, []);
    assert.match(requests[0]!.system, /continuity/i);
    assert.deepEqual((await repository.listEntries(null)).map((entry) => entry.payload), entries.map((entry) => entry.payload));

    const next = (await append(repository, [{ role: "user", content: "Continue from the saved result." }], "new"))[0]!;
    const restarted = await new ContextManager(repository, null, respond).prepare(input(next, { materials: [material] }));
    assert.equal(requests.length, 1);
    assert.equal(restarted.snapshotVersion, snapshot.version);
    assert.ok(restarted.messages.some((message) => message.content.includes(snapshot.summary)));
    assert.ok(restarted.messages.every((message) => !message.content.includes("a".repeat(100)) && !message.content.includes("b".repeat(100))));
    assert.equal(restarted.messages.filter((message) => message.content === entries[2]!.payload.content).length, 1);
    assert.equal(restarted.messages.filter((message) => message.content === next.payload.content).length, 1);
    assert.equal(restarted.messages.filter((message) => message.content === material.content).length, 1);
    assert.equal((await repository.listEntries(null)).length, 4);
    assert.equal((await repository.getLatestContextSnapshot(null))?.version, snapshot.version);
  } finally { repository.close(); }
});

test("growth reaches its threshold while total input still has space", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const [firstUser] = await append(repository, [{ role: "user", content: "a".repeat(900) }], "first");
    const { requests, respond } = responder();
    const manager = new ContextManager(repository, null, respond);
    const initial = await manager.prepare(input(firstUser!));
    assert.equal(requests.length, 0);
    assert.ok(initial.growthTokens < 500);
    assert.ok(initial.totalTokens < initial.inputLimit);
    const entries = await append(repository, [
      { role: "assistant", content: "b".repeat(900) },
      { role: "user", content: "Next task." },
    ], "next");
    const prepared = await manager.prepare(input(entries[1]!));
    assert.equal(requests.length, 1);
    assert.equal(prepared.snapshotVersion, 1);
    assert.ok(prepared.totalTokens < prepared.inputLimit);
    assert.equal(prepared.growthTokens, 0);
  } finally { repository.close(); }
});

test("the total-input limit triggers independently of a larger growth threshold", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const entries = await append(repository, [
      { role: "user", content: "a".repeat(1_300) },
      { role: "assistant", content: "b".repeat(1_300) },
      { role: "user", content: "Current task." },
    ]);
    const highGrowth: ModelConfig = { ...model, context: { ...model.context!, growthTokens: 3_500 } };
    const { requests, respond } = responder();
    const manager = new ContextManager(repository, null, respond);
    const belowTotal = await manager.prepare(input(entries[2]!, { model: highGrowth }));
    assert.equal(requests.length, 0);
    assert.ok(belowTotal.growthTokens < 3_500);
    assert.ok(belowTotal.totalTokens < belowTotal.inputLimit);
    const prepared = await manager.prepare(input(entries[2]!, { model: highGrowth, system: "s".repeat(9_300) }));
    assert.equal(requests.length, 1);
    assert.equal(prepared.snapshotVersion, 1);
    assert.ok(prepared.totalTokens < prepared.inputLimit);
    assert.equal(prepared.messages.at(-1)?.content, entries[2]!.payload.content);
  } finally { repository.close(); }
});

test("compaction keeps complete tool exchanges on either side of its boundary", async (t) => {
  for (const retainToolExchange of [false, true]) {
    await t.test(retainToolExchange ? "recent tools remain verbatim" : "older tools enter one summary", async () => {
      const repository = new SqliteHistoryRepository(":memory:");
      try {
        const latest: ModelMessage = { role: "user", content: "Latest requested adjustment." };
        const exchange: ModelMessage[] = [
          { role: "assistant", content: "", toolCalls: [
            { id: "read-a", name: "read", input: { path: "a.ts" }, inputComplete: true },
            { id: "read-b", name: "read", input: { path: "b.ts" }, inputComplete: true },
          ] },
          { role: "tool", content: "A".repeat(900), toolCallId: "read-a", toolName: "read" },
          { role: "tool", content: "B".repeat(900), toolCallId: "read-b", toolName: "read" },
        ];
        const messages: ModelMessage[] = [
          { role: "user", content: "Original task " + "a".repeat(1_800) },
          { role: "assistant", content: "Prior progress " + "b".repeat(900) },
          ...(retainToolExchange ? [latest, ...exchange] : [...exchange, latest]),
        ];
        const entries = await append(repository, messages);
        const current = entries.find((entry) => entry.payload.content === latest.content)!;
        const material: ModelMessage = { role: "user", content: "Frozen task attachment path: /project/source.txt" };
        const { requests, respond } = responder();
        const prepared = await new ContextManager(repository, null, respond).prepare(input(current, { materials: [material] }));
        assert.equal(requests.length, 1);
        assertToolPairsTogether(requests);
        const keptCalls = prepared.messages.flatMap((message) => message.toolCalls ?? []).map((call) => call.id).sort();
        const keptResults = prepared.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId).sort();
        assert.deepEqual(keptCalls, retainToolExchange ? ["read-a", "read-b"] : []);
        assert.deepEqual(keptResults, keptCalls);
        assert.equal(prepared.messages.filter((message) => message.content === latest.content).length, 1);
        assert.equal(prepared.messages.filter((message) => message.content === material.content).length, 1);
        assert.equal((await repository.listEntries(null)).length, messages.length);
      } finally { repository.close(); }
    });
  }
});

test("cancelled or invalid summaries leave snapshots and source history unchanged", async (t) => {
  const cases: Array<{ name: string; events?: ModelStreamEvent[]; cancel?: "before" | "during" }> = [
    { name: "cancelled before preparation", cancel: "before" },
    { name: "cancelled while the summary runs", cancel: "during" },
    { name: "output is truncated", events: [{ type: "completed", content: "partial summary", toolCalls: [], stopReason: "length" }] },
    { name: "output is empty", events: [completed("  ")] },
    { name: "output calls a tool", events: [{ type: "completed", content: "summary", stopReason: "tool_use", toolCalls: [{ id: "bad", name: "read", input: {}, inputComplete: true }] }] },
    { name: "stream has no completed event", events: [{ type: "text_delta", delta: "partial summary" }] },
    { name: "output exceeds the summary budget", events: [completed("x".repeat(1_000))] },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const repository = new SqliteHistoryRepository(":memory:");
      try {
        const entries = await compactableHistory(repository);
        const controller = new AbortController();
        if (scenario.cancel === "before") controller.abort();
        let calls = 0;
        const respond: typeof response = async function* () {
          calls += 1;
          if (scenario.cancel === "during") controller.abort();
          for (const event of scenario.events ?? [completed("A valid short summary.")]) yield event;
        };
        await assert.rejects(
          new ContextManager(repository, null, respond).prepare(input(entries[2]!, { signal: controller.signal })),
          (error: unknown) => error instanceof ModelAdapterError,
        );
        assert.equal(calls, scenario.cancel === "before" ? 0 : 1);
        assert.equal(await repository.getLatestContextSnapshot(null), null);
        assert.deepEqual((await repository.listEntries(null)).map((entry) => entry.payload), entries.map((entry) => entry.payload));
      } finally { repository.close(); }
    });
  }
});

test("large histories are summarized in bounded batches without splitting tool exchanges", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const messages: ModelMessage[] = [];
    for (let index = 0; index < 5; index += 1) {
      messages.push(
        { role: "user", content: `Requirement ${index}: ` + "u".repeat(1_200) },
        { role: "assistant", content: "", toolCalls: [
          { id: `call-${index}-a`, name: "read", input: { path: `source-${index}-a.ts` }, inputComplete: true },
          { id: `call-${index}-b`, name: "read", input: { path: `source-${index}-b.ts` }, inputComplete: true },
        ] },
        { role: "tool", content: `Evidence ${index}a: ` + "a".repeat(1_800), toolCallId: `call-${index}-a`, toolName: "read" },
        { role: "tool", content: `Evidence ${index}b: ` + "b".repeat(1_800), toolCallId: `call-${index}-b`, toolName: "read" },
      );
    }
    messages.push({ role: "user", content: "Use all prior findings for the final change." });
    const entries = await append(repository, messages);
    const { requests, respond } = responder();
    const prepared = await new ContextManager(repository, null, respond).prepare(input(entries.at(-1)!));
    assert.ok(requests.length > 1);
    assertToolPairsTogether(requests);
    assert.deepEqual(requests.flatMap((request) => source(request).conversation.map((entry) => entry.entryId)), entries.slice(0, -1).map((entry) => entry.id));
    for (const [index, request] of requests.entries()) {
      assert.equal(source(request).previousSummary, index === 0 ? "" : `Continuity summary ${index}: preserve the goal, pending work, and evidence.`);
      assert.equal(request.config.maxOutputTokens, 256);
      assert.deepEqual(request.tools, []);
    }
    const snapshot = await repository.getLatestContextSnapshot(null);
    assert.ok(snapshot);
    assert.match(snapshot.summary, new RegExp(`Continuity summary ${requests.length}:`));
    assert.equal(prepared.messages.at(-1)?.content, messages.at(-1)?.content);
    assert.equal((await repository.listEntries(null)).length, messages.length);
  } finally { repository.close(); }
});

test("a long pinned input and a short tool continuation stay usable without an unproductive summary", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const [user] = await append(repository, [{ role: "user", content: "a".repeat(900) }], "pinned");
    const budget: ModelConfig = { ...model, context: {
      windowTokens: 2000, outputReserveTokens: 200, safetyTokens: 50, growthTokens: 200, recentTokens: 200, summaryTokens: 100,
    } };
    const manager = new ContextManager(repository, null, async function* () { throw new Error("Pinned input alone is not reclaimable history."); });
    await manager.prepare(input(user!, { model: budget }));
    await append(repository, [
      { role: "assistant", content: "", toolCalls: [{ id: "short-read", name: "read", input: { path: "a.ts" }, inputComplete: true }] },
      { role: "tool", content: "short result", toolCallId: "short-read" },
    ], "short-tool");
    const next = await manager.prepare(input(user!, { model: budget }));
    assert.ok(next.totalTokens < next.inputLimit);
    assert.deepEqual(next.messages.map((message) => message.role), ["user", "assistant", "tool"]);
    assert.equal(next.messages[0]!.content, user!.payload.content);
    assert.equal(await repository.getLatestContextSnapshot(null), null);
  } finally { repository.close(); }
});

test("provider measurement remains identified when the estimate is already conservative", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const [user] = await append(repository, [{ role: "user", content: "A short question." }]);
    const manager = new ContextManager(repository, null, responder().respond);
    const first = await manager.prepare(input(user!));
    manager.observeUsage(first, { inputTokens: Math.max(0, first.estimatedTokens - 10) }, model);
    const next = await manager.prepare(input(user!));
    assert.equal(next.measurement, "provider_adjusted");
    assert.equal(next.totalTokens, next.estimatedTokens);
  } finally { repository.close(); }
});

test("summary output accepts provider-measured tokens within the limit despite a larger text estimate", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const entries = await compactableHistory(repository);
    const manager = new ContextManager(repository, null, async function* () {
      yield { type: "completed", content: "x".repeat(1000), toolCalls: [], stopReason: "stop", usage: { inputTokens: 900, outputTokens: 250 } };
    });
    const prepared = await manager.prepare(input(entries[2]!));
    assert.equal(prepared.snapshotVersion, 1);
    assert.equal((await repository.getLatestContextSnapshot(null))?.usage?.outputTokens, 250);
    assert.ok(prepared.totalTokens < prepared.inputLimit);
  } finally { repository.close(); }
});

test("switching to a smaller model can replace only the saved summary without replaying covered history", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const archived = await append(repository, [
      { role: "user", content: "Covered original requirement " + "raw".repeat(500) },
      { role: "assistant", content: "Covered original progress " + "raw".repeat(500) },
    ], "archived");
    const originalSummary = `Source entries: ${archived.map((entry) => entry.id).join(", ")}. ` + "Prior detail. ".repeat(260);
    const oldSnapshot = await repository.saveContextSnapshot({
      projectId: null, expectedVersion: null, summary: originalSummary,
      coveredThroughOrder: archived.at(-1)!.entryOrder, baselineThroughOrder: archived.at(-1)!.entryOrder,
      baselineTokens: 2_000, modelId: "large-model", policyVersion: "context-v1",
      sourceVersion: await repository.getContextSourceVersion(null, archived.at(-1)!.entryOrder),
    });
    const [user] = await append(repository, [{ role: "user", content: "Continue with the smaller model." }], "small");
    const originalEntries = await repository.listEntries(null);
    const smaller: ModelConfig = { ...model, model: "smaller-model", capabilities: {
      contextWindowTokens: 2_048, maxOutputTokens: 1_024, source: "provider",
    }, context: {
      windowTokens: 2_048, outputReserveTokens: 1_024, safetyTokens: 128, growthTokens: 500, recentTokens: 200, summaryTokens: 128,
    } };
    const { requests, respond } = responder();
    const prepared = await new ContextManager(repository, null, respond).prepare(input(user!, { model: smaller }));
    assert.equal(requests.length, 1);
    assert.equal(source(requests[0]!).previousSummary, originalSummary);
    assert.deepEqual(source(requests[0]!).conversation, []);
    assert.ok(prepared.totalTokens < prepared.inputLimit);
    assert.equal(prepared.growthTokens, 0);
    assert.equal(prepared.messages.filter((message) => message.content === user!.payload.content).length, 1);
    const snapshot = await repository.getLatestContextSnapshot(null);
    assert.ok(snapshot);
    assert.equal(snapshot.version, oldSnapshot.version + 1);
    assert.equal(snapshot.coveredThroughOrder, oldSnapshot.coveredThroughOrder);
    assert.equal(snapshot.baselineThroughOrder, user!.entryOrder);
    assert.deepEqual(snapshot.sourceVersion, await repository.getContextSourceVersion(null, user!.entryOrder));
    assert.deepEqual(await repository.listEntries(null), originalEntries);

    const resumed = await new ContextManager(repository, null, respond).prepare(input(user!, { model: smaller }));
    assert.equal(requests.length, 1);
    assert.deepEqual(resumed.messages, prepared.messages);
  } finally { repository.close(); }
});

test("oversized saved summaries are merged in bounded text fragments before complete new tool history", async () => {
  const repository = new SqliteHistoryRepository(":memory:");
  try {
    const archived = await append(repository, [
      { role: "user", content: "Archived requirement remains available." },
      { role: "assistant", content: "Archived evidence remains available." },
    ], "archived");
    const originalSummary = Array.from({ length: 150 }, (_, index) => `Evidence ${index} from archived-1: 项目🧭 retains its exact source.\n`).join("");
    await repository.saveContextSnapshot({
      projectId: null, expectedVersion: null, summary: originalSummary,
      coveredThroughOrder: archived.at(-1)!.entryOrder, baselineThroughOrder: archived.at(-1)!.entryOrder,
      baselineTokens: 6_000, modelId: "large-model", policyVersion: "context-v1",
      sourceVersion: await repository.getContextSourceVersion(null, archived.at(-1)!.entryOrder),
    });
    const added = await append(repository, [
      { role: "user", content: "New investigation " + "u".repeat(900) },
      { role: "assistant", content: "", toolCalls: [{ id: "new-read", name: "read", input: { path: "source.ts" }, inputComplete: true }] },
      { role: "tool", content: "Source findings. " + "e".repeat(900), toolCallId: "new-read", toolName: "read" },
      { role: "user", content: "Apply the findings." },
    ], "new");
    const originalEntries = await repository.listEntries(null);
    const requests: CapturedRequest[] = [];
    const smaller: ModelConfig = { ...model, model: "smaller-model", capabilities: {
      contextWindowTokens: 2_048, maxOutputTokens: 256, source: "provider",
    }, context: {
      windowTokens: 2_048, outputReserveTokens: 256, safetyTokens: 128, growthTokens: 500, recentTokens: 200, summaryTokens: 128,
    } };
    const respond: typeof response = async function* (config, messages, system, definitions) {
      requests.push({ config, messages: structuredClone(messages), system, tools: definitions });
      const content = `Continuity ${requests.length}: archived-1 and new-2 retain source evidence.`;
      const inputTokens = estimateRequestTokens(system, definitions, messages);
      const outputTokens = estimateTextTokens(content);
      yield { ...completed(content), usage: { inputTokens, outputTokens, cachedInputTokens: 0, totalTokens: inputTokens + outputTokens } };
    };
    const prepared = await new ContextManager(repository, null, respond).prepare(input(added.at(-1)!, { model: smaller }));
    const policy = resolveContextPolicy(smaller.context, smaller.capabilities);
    const limit = contextInputLimit({ ...policy, outputReserveTokens: policy.summaryTokens }, smaller.capabilities);
    const fragments = requests.filter((request) => source(request).summaryFragment !== undefined);
    assert.ok(fragments.length > 1);
    assert.equal(fragments.map((request) => source(request).summaryFragment).join(""), originalSummary);
    assert.equal(source(requests[0]!).previousSummary, "");
    for (const [index, request] of requests.entries()) {
      assert.ok(estimateRequestTokens(request.system, request.tools, request.messages) <= limit);
      assert.equal(request.config.maxOutputTokens, 128);
      assert.deepEqual(request.tools, []);
      if (index > 0) assert.equal(source(request).previousSummary, `Continuity ${index}: archived-1 and new-2 retain source evidence.`);
    }
    assert.deepEqual(requests.flatMap((request) => source(request).conversation.map((entry) => entry.entryId)), added.slice(0, -1).map((entry) => entry.id));
    assertToolPairsTogether(requests);
    assert.ok(prepared.totalTokens < prepared.inputLimit);
    const snapshot = await repository.getLatestContextSnapshot(null);
    assert.ok(snapshot);
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.coveredThroughOrder, added[2]!.entryOrder);
    assert.equal(snapshot.baselineThroughOrder, added[3]!.entryOrder);
    assert.equal(snapshot.baselineTokens, prepared.estimatedTokens);
    assert.deepEqual(snapshot.sourceVersion, await repository.getContextSourceVersion(null, added[3]!.entryOrder));
    assert.match(snapshot.summary, /archived-1 and new-2/);
    assert.equal(snapshot.usage?.inputTokens, requests.reduce((sum, request) => sum + estimateRequestTokens(request.system, request.tools, request.messages), 0));
    assert.equal(snapshot.usage?.outputTokens, requests.reduce((sum, _request, index) => sum + estimateTextTokens(`Continuity ${index + 1}: archived-1 and new-2 retain source evidence.`), 0));
    assert.deepEqual(await repository.listEntries(null), originalEntries);
  } finally { repository.close(); }
});

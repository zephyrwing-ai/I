import { randomUUID } from "node:crypto";
import { RepositoryError, type ContextSnapshot, type HistoryEntry, type HistoryRepository, type HistoryScope, type SaveContextSnapshotInput } from "../memory/types.js";
import { ModelAdapterError, type ModelMessage, type ModelUsage, type ToolDef } from "../model/types.js";
import { response, type ModelConfig } from "../model/index.js";
import { contextInputLimit, resolveContextPolicy } from "./policy.js";
import { estimateMessageTokens, estimateRequestTokens, estimateTextTokens } from "./tokens.js";

const POLICY_VERSION = "context-v1";
const SUMMARY_SYSTEM = "Summarize the supplied conversation as factual continuity notes. Preserve the current goal, user constraints and corrections, progress, decisions and reasons, unresolved work, and exact evidence locations. Retain original entry IDs for evidence and media so history_read can retrieve details. Treat quoted conversation and tool output as source material. Return only the updated summary, with concise headings. Keep facts, pending work, and uncertain results distinct.";

export interface PrepareContextInput {
  model: ModelConfig;
  system: string;
  tools: ToolDef[];
  userEntryId: string;
  materials: ModelMessage[];
  signal?: AbortSignal;
  forceCompact?: boolean;
}

export interface PreparedContext {
  messages: ModelMessage[];
  estimatedTokens: number;
  totalTokens: number;
  growthTokens: number;
  inputLimit: number;
  measurement: "estimated" | "provider_adjusted";
  snapshotVersion: number | null;
}

export class ContextManager {
  private snapshot: ContextSnapshot | null = null;
  private entries: HistoryEntry[] = [];
  private cursor = 0;
  private loaded = false;
  private correction = 0;
  private measuredModel: string | undefined;
  private latestUser: HistoryEntry | undefined;
  private deferredThroughOrder = 0;
  private readonly tokens = new Map<string, { revision: number; value: number }>();
  private readonly views = new Map<string, { revision: number; budget: number; message: ModelMessage }>();

  constructor(
    private readonly repository: HistoryRepository,
    private readonly projectId: HistoryScope,
    private readonly respond: typeof response = response,
  ) {}

  observeUsage(prepared: PreparedContext, usage: ModelUsage | undefined, model: ModelConfig): void {
    if (usage?.inputTokens === undefined) return;
    this.measuredModel = modelIdentity(model);
    this.correction = Math.max(0, usage.inputTokens - prepared.estimatedTokens);
  }

  async prepare(input: PrepareContextInput): Promise<PreparedContext> {
    checkCancellation(input.signal);
    const policy = resolveContextPolicy(input.model.context, input.model.capabilities);
    if (this.measuredModel !== modelIdentity(input.model)) this.correction = 0;
    await this.refresh();
    const user = await this.repository.getEntry(input.userEntryId);
    if (!user || user.projectId !== this.projectId || user.status !== "completed" || user.payload.role !== "user") {
      throw new ModelAdapterError("model_protocol", "The current user input must be committed before context preparation.");
    }
    this.latestUser = [...this.entries].reverse().find((entry) => entry.payload.role === "user") ?? this.latestUser;
    const pinned = [user, ...(this.latestUser && this.latestUser.id !== user.id ? [this.latestUser] : [])];
    const pinnedIds = new Set(pinned.map((entry) => entry.id));
    const previewBudget = Math.max(128, Math.min(4096, Math.floor(policy.recentTokens / 2)));
    const assemble = (entries: HistoryEntry[], summary = this.snapshot?.summary ?? "", through = Infinity): ModelMessage[] => {
      const result: ModelMessage[] = summary ? [{ role: "user", content: `Earlier conversation summary:\n${summary}` }] : [];
      const raw = entries.filter((entry) => entry.entryOrder <= through);
      for (const entry of pinned) {
        if (entry.entryOrder <= through && !raw.some((rawEntry) => rawEntry.id === entry.id)) {
          if (entry.id === user.id) result.push(...input.materials);
          result.push(entry.payload);
        }
      }
      for (const entry of raw) {
        if (entry.id === user.id) result.push(...input.materials);
        result.push(this.messageView(entry, previewBudget));
      }
      if (user.entryOrder > through) result.push(...input.materials);
      return result;
    };
    const measure = (messages: ModelMessage[]): number => estimateRequestTokens(input.system, input.tools, messages);
    const inputLimit = contextInputLimit(policy, input.model.capabilities);
    const current = assemble(this.entries);
    validateToolGroups(current);
    const estimatedTokens = measure(current);
    const totalTokens = estimatedTokens + this.correction;
    const baselineTokens = measure(this.snapshot ? assemble(this.entries, this.snapshot.summary, this.snapshot.baselineThroughOrder) : []);
    const growthTokens = Math.max(0, estimatedTokens - baselineTokens);
    const result = (messages: ModelMessage[], estimate: number, growth: number): PreparedContext => ({
      messages: structuredClone(messages), estimatedTokens: estimate, totalTokens: estimate + this.correction,
      growthTokens: growth, inputLimit, measurement: this.measuredModel === modelIdentity(input.model) ? "provider_adjusted" : "estimated",
      snapshotVersion: this.snapshot?.version ?? null,
    });
    if (!input.forceCompact && totalTokens < inputLimit && growthTokens < policy.growthTokens) {
      return result(current, estimatedTokens, growthTokens);
    }

    const forced = input.forceCompact === true || totalTokens >= inputLimit;
    const requiredTokens = measure([...input.materials, ...pinned.map((entry) => entry.payload)]);
    const recentBudget = Math.max(1, Math.min(policy.recentTokens, inputLimit - requiredTokens - policy.summaryTokens - this.correction));
    const cut = this.findCut(recentBudget, forced, pinnedIds);
    if (cut === 0 && (!forced || !this.snapshot)) {
      if (input.forceCompact || totalTokens >= inputLimit) {
        throw new ModelAdapterError("context_overflow", `Context input is estimated at ${totalTokens} tokens with an input budget of ${inputLimit}. Required instructions, current input, materials, and recent tool results leave no reducible interval. Reduce the material scope or increase the configured window.`);
      }
      return result(current, estimatedTokens, growthTokens);
    }
    const prefix = this.entries.slice(0, cut);
    const tail = this.entries.slice(cut);
    const coveredThroughOrder = prefix.at(-1)?.entryOrder ?? this.snapshot!.coveredThroughOrder;
    if (!forced && coveredThroughOrder <= this.deferredThroughOrder) return result(current, estimatedTokens, growthTokens);
    const baselineThroughOrder = this.entries.at(-1)!.entryOrder;
    const sourceVersion = await this.repository.getContextSourceVersion(this.projectId, baselineThroughOrder);
    const summarized = await this.summarize(prefix, input);
    checkCancellation(input.signal);
    const candidate = assemble(tail, summarized.summary);
    validateToolGroups(candidate);
    const candidateTokens = measure(candidate);
    if (candidateTokens >= estimatedTokens && !forced) {
      this.deferredThroughOrder = coveredThroughOrder;
      return result(current, estimatedTokens, growthTokens);
    }
    if (candidateTokens >= inputLimit || candidateTokens >= estimatedTokens) {
      throw new ModelAdapterError("context_overflow", `The candidate context uses an estimated ${candidateTokens} tokens (previously ${estimatedTokens}, input budget ${inputLimit}). Reduce required material or the summary and recent-history budgets.`);
    }
    const snapshot = await this.saveSnapshot({
      id: randomUUID(), createdAt: Date.now(),
      projectId: this.projectId,
      expectedVersion: this.snapshot?.version ?? null,
      summary: summarized.summary,
      coveredThroughOrder,
      baselineThroughOrder,
      sourceVersion,
      policyVersion: POLICY_VERSION,
      modelId: modelIdentity(input.model),
      baselineTokens: candidateTokens,
      usage: summarized.usage,
    }, input.signal);
    this.snapshot = snapshot;
    this.entries = tail;
    for (const entry of prefix) {
      this.tokens.delete(entry.id);
      this.views.delete(entry.id);
    }
    this.correction = 0;
    this.measuredModel = undefined;
    return result(candidate, candidateTokens, 0);
  }

  private async refresh(): Promise<void> {
    if (!this.loaded) {
      this.snapshot = await this.repository.getLatestContextSnapshot(this.projectId);
      this.cursor = this.snapshot?.coveredThroughOrder ?? 0;
      this.loaded = true;
    }
    while (true) {
      const batch = await this.repository.listEntries(this.projectId, this.cursor, 500);
      this.entries.push(...batch.filter((entry) => entry.status === "completed"));
      if (batch.length) this.cursor = batch.at(-1)!.entryOrder;
      if (batch.length < 500) break;
    }
  }

  private entryTokens(entry: HistoryEntry): number {
    const cached = this.tokens.get(entry.id);
    if (cached?.revision === entry.revision) return cached.value;
    const value = estimateMessageTokens(entry.payload);
    this.tokens.set(entry.id, { revision: entry.revision, value });
    return value;
  }

  private findCut(recentTokens: number, forced: boolean, pinnedIds: Set<string>): number {
    const firstReclaimable = this.entries.findIndex((entry) => !pinnedIds.has(entry.id));
    const cuts = validCuts(this.entries.map((entry) => entry.payload)).filter((index) =>
      firstReclaimable >= 0 && index < this.entries.length && index > firstReclaimable);
    let retained = 0;
    let desired = this.entries.length;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const size = this.entryTokens(this.entries[index]!);
      if (retained + size > recentTokens && retained > 0) break;
      retained += size;
      desired = index;
    }
    let cut = cuts.filter((index) => index > 0 && index <= desired).at(-1) ?? 0;
    if (!cut && forced) cut = cuts.find((index) => index > 0 && index < this.entries.length) ?? 0;
    return cut;
  }

  private messageView(entry: HistoryEntry, budget: number): ModelMessage {
    const cached = this.views.get(entry.id);
    if (cached?.revision === entry.revision && cached.budget === budget) return cached.message;
    const message = historyMessageView(entry, budget);
    this.views.set(entry.id, { revision: entry.revision, budget, message });
    return message;
  }

  private async summarize(entries: HistoryEntry[], input: PrepareContextInput): Promise<{ summary: string; usage?: ModelUsage }> {
    const policy = resolveContextPolicy(input.model.context, input.model.capabilities);
    const limit = contextInputLimit({ ...policy, outputReserveTokens: policy.summaryTokens }, input.model.capabilities);
    const groups: HistoryEntry[][] = [];
    let start = 0;
    for (const end of validCuts(entries.map((entry) => entry.payload))) {
      groups.push(entries.slice(start, end));
      start = end;
    }
    let summary = this.snapshot?.summary ?? "";
    let usage: ModelUsage | undefined;
    let requests = 0;
    let batch: HistoryEntry[] = [];
    const requestMessages = (items: HistoryEntry[], previousSummary = summary, summaryFragment?: string): ModelMessage[] => [{
      role: "user",
      content: JSON.stringify({ previousSummary, summaryFragment, conversation: items.map((entry) => ({
        entryId: entry.id, order: entry.entryOrder, role: entry.payload.role,
        content: this.messageView(entry, Math.max(128, Math.floor(policy.recentTokens / 2))).content,
        ...(entry.payload.progress !== undefined ? { progress: entry.payload.progress } : {}),
        toolCalls: entry.payload.toolCalls, toolCallId: entry.payload.toolCallId, isError: entry.payload.isError,
        media: entry.payload.media ? "Image remains available through history_read for this entry ID." : undefined,
      })) }),
    }];
    const completeSummary = async (messages: ModelMessage[]): Promise<void> => {
      checkCancellation(input.signal);
      const inputTokens = estimateRequestTokens(SUMMARY_SYSTEM, [], messages);
      if (inputTokens > limit) {
        throw new ModelAdapterError("context_overflow", `The summary request needs an estimated ${inputTokens} tokens with an input budget of ${limit}.`);
      }
      let completed = false;
      let text = "";
      let batchUsage: ModelUsage | undefined;
      for await (const event of this.respond({ ...input.model, maxOutputTokens: policy.summaryTokens }, messages, SUMMARY_SYSTEM, [], input.signal)) {
        if (completed) throw new ModelAdapterError("model_protocol", "The summary stream continued after its completion event.");
        if (event.type !== "completed") continue;
        if (event.stopReason !== "stop" || event.toolCalls.length || !event.content.trim()) {
          throw new ModelAdapterError("model_protocol", "Context summarization requires a complete text response.");
        }
        text = event.content.trim();
        batchUsage = event.usage;
        completed = true;
      }
      checkCancellation(input.signal);
      if (!completed || (batchUsage?.outputTokens ?? estimateTextTokens(text)) > policy.summaryTokens) {
        throw new ModelAdapterError("model_protocol", "Context summary is missing or exceeds its configured output budget.");
      }
      summary = text;
      usage = requests === 0 ? batchUsage : sumUsage(usage, batchUsage);
      requests += 1;
    };
    const compactSummary = async (): Promise<void> => {
      if (estimateRequestTokens(SUMMARY_SYSTEM, [], requestMessages([])) <= limit) {
        await completeSummary(requestMessages([]));
        return;
      }
      const fragments = Array.from(summary);
      summary = "";
      let offset = 0;
      while (offset < fragments.length) {
        checkCancellation(input.signal);
        let low = 0;
        let high = fragments.length - offset;
        while (low < high) {
          const length = Math.ceil((low + high) / 2);
          const messages = requestMessages([], summary, fragments.slice(offset, offset + length).join(""));
          if (estimateRequestTokens(SUMMARY_SYSTEM, [], messages) <= limit) low = length;
          else high = length - 1;
        }
        if (low === 0) {
          throw new ModelAdapterError("context_overflow", `The previous summary cannot be merged within the current summary input budget of ${limit} tokens.`);
        }
        await completeSummary(requestMessages([], summary, fragments.slice(offset, offset + low).join("")));
        offset += low;
      }
    };
    const flush = async (): Promise<void> => {
      await completeSummary(requestMessages(batch));
      batch = [];
    };
    if (!groups.length && summary) await compactSummary();
    for (const group of groups) {
      const next = [...batch, ...group];
      if (estimateRequestTokens(SUMMARY_SYSTEM, [], requestMessages(next)) > limit) {
        if (batch.length) await flush();
        if (summary && estimateRequestTokens(SUMMARY_SYSTEM, [], requestMessages(group)) > limit) await compactSummary();
        const groupTokens = estimateRequestTokens(SUMMARY_SYSTEM, [], requestMessages(group));
        if (groupTokens > limit) {
          throw new ModelAdapterError("context_overflow", `Historical entries ${group[0]!.id} through ${group.at(-1)!.id} require an estimated ${groupTokens} tokens with a summary input budget of ${limit}. Adjust the summary working window or retrieve a bounded preview of the original material.`);
        }
      }
      batch.push(...group);
    }
    if (batch.length) await flush();
    return { summary, usage };
  }

  private async saveSnapshot(input: SaveContextSnapshotInput, signal?: AbortSignal): Promise<ContextSnapshot> {
    for (let attempt = 0; ; attempt += 1) {
      checkCancellation(signal);
      try {
        return await this.repository.saveContextSnapshot(input);
      } catch (error) {
        if (!(error instanceof RepositoryError) || !error.retryable || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  }
}

function sumUsage(left: ModelUsage | undefined, right: ModelUsage | undefined): ModelUsage | undefined {
  if (!left || !right) return undefined;
  const result: ModelUsage = {};
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"] as const) {
    if (left[key] !== undefined && right[key] !== undefined) result[key] = left[key]! + right[key]!;
  }
  return Object.keys(result).length ? result : undefined;
}

function historyMessageView(entry: HistoryEntry, budget: number): ModelMessage {
  const message = entry.payload;
  if (message.role !== "tool" || estimateTextTokens(message.content) <= budget) return message;
  const note = `\n[Original history entry: ${entry.id}. Use history_read with this entryId to page the complete message.]\n`;
  let low = 0;
  let high = message.content.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    const head = Math.ceil(length / 2);
    const tail = Math.floor(length / 2);
    const text = message.content.slice(0, head) + note + (tail ? message.content.slice(-tail) : "");
    if (estimateTextTokens(text) <= budget) low = length;
    else high = length - 1;
  }
  return { ...message, content: message.content.slice(0, Math.ceil(low / 2)) + note + (Math.floor(low / 2) ? message.content.slice(-Math.floor(low / 2)) : "") };
}

function modelIdentity(model: ModelConfig): string {
  return JSON.stringify([model.provider, model.openai?.baseURL ?? "", model.model]);
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ModelAdapterError("network", "Context preparation was cancelled.");
}

function validCuts(messages: ModelMessage[]): number[] {
  const pending = new Set<string>();
  const cuts: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== "tool" && pending.size) throw new ModelAdapterError("model_protocol", "Historical tool calls are missing their results.");
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (pending.has(call.id)) throw new ModelAdapterError("model_protocol", "Historical tool call identities are duplicated.");
        pending.add(call.id);
      }
    }
    if (message.role === "tool" && (!message.toolCallId || !pending.delete(message.toolCallId))) {
      throw new ModelAdapterError("model_protocol", "A historical tool result has no matching call.");
    }
    if (!pending.size) cuts.push(index + 1);
  }
  if (pending.size) throw new ModelAdapterError("model_protocol", "Historical tool calls are missing their results.");
  return cuts;
}

function validateToolGroups(messages: ModelMessage[]): void {
  validCuts(messages);
}

import { randomUUID } from "node:crypto";
import { RepositoryError, ToolAttemptBlockedError, type HistoryRecorder, type ToolInvocationPlan, type ToolInvocationRecord } from "./memory/types.js";
import { response, type ModelConfig } from "./model/index.js";
import { ModelAdapterError, type LlmResponse, type ModelMessage, type ToolCall, type ToolDef } from "./model/types.js";
import { canonicalJson } from "./json.js";
import { toolInputHash } from "./tools/identity.js";
import type { RegisteredTool, PreparedToolExecution, ToolExecutionContext, ToolRecoveryResult, ToolResult } from "./tools/index.js";
import { readToolCheckpoint, readToolResult, toolOutcomeStatus, toolResultMessage } from "./tools/result.js";

export type RunStatus = "completed" | "cancelled" | "failed";

interface RetryConfig {
  /** 一次操作的总尝试次数，包含首次调用。 */
  maxAttempts?: number;
  /** 首次重试等待时间；测试可设为 0。 */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export type ModelRetryConfig = RetryConfig;
export type CommitRetryConfig = RetryConfig;

const DEFAULT_MODEL_RETRY: Required<ModelRetryConfig> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
};

const DEFAULT_COMMIT_RETRY: Required<CommitRetryConfig> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 1000,
};

export interface AgentRunConfig {
  runId: string;
  systemPrompt: string;
  cwd: string;
  tools: Map<string, RegisteredTool>;
  signal?: AbortSignal;
  /** 运行绑定的历史 Recorder；Recorder 提供初始的已提交消息快照。 */
  recorder?: HistoryRecorder;
  /** 测试注入点：与 provider-model-discovery 的 fetchImpl 同理。 */
  responseImpl?: typeof response;
  modelRetry?: ModelRetryConfig;
  /** Retries the same complete response locally, without another model request. */
  commitRetry?: CommitRetryConfig;
  /** Clock injection keeps run-level duration deterministic in tests. */
  clock?: () => number;
  /** Context supplied for this run only; it is intentionally not committed. */
  runScopedContext?: ModelMessage[];
  /** Main-generated ID shared with the optimistic initial user message. */
  initialUserEntryId?: string;
  /** Fixed user creation time shared with the admission ACK and history entry. */
  initialUserCreatedAt?: number;
  steeringInbox?: AgentSteeringInbox;
  /** The host persists Stop before aborting; failures must reach run completion. */
  cancellationBarrier?: () => Promise<void>;
}

export interface SteeringInput {
  inputId: string;
  content: string;
}

/** Host-owned admission queue. Runtime reads it only between complete model turns. */
export interface AgentSteeringInbox {
  stopAdmission(): void;
  takePending(): Promise<SteeringInput[]>;
  takePendingOrSeal(): Promise<SteeringInput[]>;
  closeAndAbandon(reason: RunStatus): Promise<string[]>;
}

export interface TurnContext {
  runId: string;
  turnId: string;
  turnOrdinal: number;
  /** 同一逻辑 turn 内的模型尝试次数。 */
  attempt: number;
}

export type RetryReason =
  | "reasoning_only"
  | "empty_response"
  | "length"
  | "missing_finish_reason"
  | "invalid_tool_calls"
  | "network_error"
  | "provider_error"
  | "model_protocol";

export type TurnOutcome =
  | { kind: "answer"; response: LlmResponse }
  | { kind: "tool_calls"; response: LlmResponse }
  | { kind: "incomplete"; reason: RetryReason; response?: LlmResponse }
  | { kind: "failed"; reason: "content_filtered" | "provider_error" | "network_error" | "model_protocol" | "unknown_stop_reason"; error: AgentError }
  | { kind: "cancelled"; reason: "aborted" };

export interface AgentEvents {
  onRunStart?: (ctx: { runId: string; startedAt: string }) => void;
  onTurnStart?: (ctx: TurnContext) => void;
  onReasoningDelta?: (delta: string, ctx: TurnContext) => void;
  onAssistantDelta?: (delta: string, ctx: TurnContext) => void;
  onAssistantCompleted?: (response: LlmResponse, ctx: TurnContext & { completedAt: number }) => void;
  onToolStart?: (call: ToolCall, ctx: TurnContext) => void;
  onToolCompleted?: (call: ToolCall, result: ToolResult, ctx: TurnContext) => void;
  onTurnRetrying?: (ctx: {
    runId: string;
    turnId: string;
    attempt: number;
    nextAttempt: number;
    reason: RetryReason;
    delayMs: number;
    maxAttempts: number;
  }) => void;
  onTurnCompleted?: (ctx: TurnContext) => void;
  onInputsApplied?: (result: { runId: string; inputIds: string[]; startedAt: number }) => void;
  onRunCompleted?: (result: { runId: string; status: RunStatus; error?: AgentError; turnCount: number; unappliedInputIds?: string[]; finalTurnId?: string; finalDurationMs?: number }) => void;
}

export interface AgentError {
  kind: "config" | "network" | "provider" | "model_protocol" | "tool" | "runtime";
  message: string;
  retryable?: boolean;
}

const DEFAULT_SYSTEM_PROMPT = "You are a coding agent. Use the available tools when needed, then provide a concise final answer.";

/**
 * 流式输出的唯一处理函数：消费模型事件流、同步 Recorder 与宿主事件、聚合整回合。
 * Adapter 的 completed 只表示流解析完成，Runtime 仍需把聚合结果分类为 TurnOutcome。
 */
async function collectTurn(
  modelConfig: ModelConfig,
  messages: ModelMessage[],
  system: string,
  tools: ToolDef[],
  ctx: TurnContext,
  events: AgentEvents,
  recorder: HistoryRecorder | undefined,
  signal: AbortSignal | undefined,
  responseImpl: typeof response,
): Promise<{ response: LlmResponse; completed: boolean }> {
  const aggregated: LlmResponse = { content: "", toolCalls: [], stopReason: "unknown" };
  let completed = false;
  for await (const event of responseImpl(modelConfig, messages, system, tools, signal)) {
    switch (event.type) {
      case "reasoning_delta":
        aggregated.reasoning = (aggregated.reasoning ?? "") + event.delta;
        recorder?.recordAssistantDelta("reasoning", event.delta, ctx);
        events.onReasoningDelta?.(event.delta, ctx);
        break;
      case "text_delta":
        aggregated.content += event.delta;
        recorder?.recordAssistantDelta("text", event.delta, ctx);
        events.onAssistantDelta?.(event.delta, ctx);
        break;
      case "completed":
        completed = true;
        aggregated.content = event.content;
        aggregated.reasoning = event.reasoning;
        aggregated.toolCalls = event.toolCalls;
        aggregated.stopReason = event.stopReason;
        aggregated.rawStopReason = event.rawStopReason;
        break;
    }
  }
  return { response: aggregated, completed };
}

export async function run(
  task: string,
  modelConfig: ModelConfig,
  config: AgentRunConfig,
  events: AgentEvents = {},
): Promise<{ runId: string; status: RunStatus; error?: AgentError; turnCount: number; unappliedInputIds?: string[]; finalTurnId?: string; finalDurationMs?: number }> {
  const clock = config.clock ?? Date.now;
  const runStartedAt = clock();
  const startedAt = new Date(runStartedAt).toISOString();
  const messages: ModelMessage[] = [...(config.recorder?.snapshot() ?? [])];
  const userMessage: ModelMessage = { role: "user", content: task };
  const initialUserEntryId = config.initialUserEntryId ?? randomUUID();
  const initialUserCreatedAt = config.initialUserCreatedAt ?? runStartedAt;
  const tools = [...config.tools.values()].map((tool) => tool.definition);
  const retryConfig = { ...DEFAULT_MODEL_RETRY, ...config.modelRetry };
  const commitRetryConfig = { ...DEFAULT_COMMIT_RETRY, ...config.commitRetry };
  let turnOrdinal = 0;
  let currentTurnId: string | undefined;
  let attempt = 0;
  let finished = false;
  let initialUserCommitted = false;
  let readyInputs: SteeringInput[] = [];

  const finish = async (status: RunStatus, error?: AgentError, finalTurnId?: string) => {
    if (finished) return { runId: config.runId, status, error, turnCount: turnOrdinal };
    config.steeringInbox?.stopAdmission();
    let finalStatus = status;
    let finalError = error;
    let unappliedInputIds: string[] = [];
    try {
      if (status === "cancelled") {
        await config.cancellationBarrier?.();
        await config.recorder?.requestRunCancellation(config.runId);
        if (!initialUserCommitted && config.recorder) {
          await config.recorder.archiveUnappliedUser(userMessage, { runId: config.runId, entryId: initialUserEntryId, createdAt: initialUserCreatedAt });
          unappliedInputIds.push(initialUserEntryId);
        }
        await recoverOpenToolInvocations(config, config.runId, true);
      }
      await config.recorder?.finishRun({ runId: config.runId, status });
    } catch (finishError) {
      finalStatus = "failed";
      finalError = toAgentError(finishError);
    }
    try {
      const abandoned = await config.steeringInbox?.closeAndAbandon(finalStatus) ?? [];
      unappliedInputIds = [...new Set([...unappliedInputIds, ...abandoned])];
    } catch (abandonError) {
      finalStatus = "failed";
      finalError = toAgentError(abandonError);
    }
    if (finalStatus === "completed" && unappliedInputIds.length > 0) {
      finalStatus = "failed";
      finalError = { kind: "runtime", message: "Accepted steering remained unapplied at run completion." };
    }
    let finalDurationMs: number | undefined;
    if (finalStatus === "completed" && finalTurnId) {
      finalDurationMs = Math.max(0, clock() - runStartedAt);
      try {
        await config.recorder?.finalizeAnswerDuration(finalTurnId, finalDurationMs);
      } catch (durationError) {
        finalStatus = "failed";
        finalError = toAgentError(durationError);
      }
    }
    const result = {
      runId: config.runId,
      status: finalStatus,
      error: finalError,
      turnCount: turnOrdinal,
      ...(unappliedInputIds.length ? { unappliedInputIds } : {}),
      ...(finalStatus === "completed" && finalTurnId && finalDurationMs !== undefined ? { finalTurnId, finalDurationMs } : {}),
    };
    finished = true;
    events.onRunCompleted?.(result);
    return result;
  };

  const applyInputs = async (batch: SteeringInput[]): Promise<void> => {
    if (batch.length === 0) return;
    const inputIds = batch.map((input) => input.inputId);
    const entries = config.recorder
      ? await config.recorder.applyRunInputs(config.runId, inputIds)
      : batch.map((input) => ({ id: input.inputId, payload: { role: "user" as const, content: input.content } }));
    if (entries.length !== batch.length || entries.some((entry, index) => entry.id !== inputIds[index])) {
      throw new Error("Steering input persistence returned a different input batch.");
    }
    messages.push(...entries.map((entry) => entry.payload));
    events.onInputsApplied?.({ runId: config.runId, inputIds, startedAt: clock() });
  };

  try {
    if (config.signal?.aborted) return finish("cancelled");
    await recoverOpenToolInvocations(config);
    if (config.signal?.aborted) return finish("cancelled");
    if (config.recorder) messages.splice(0, messages.length, ...config.recorder.snapshot());
  } catch (error) {
    return finish("failed", toAgentError(error));
  }

  try {
    await config.recorder?.commitUser(userMessage, { runId: config.runId, entryId: initialUserEntryId, createdAt: initialUserCreatedAt });
    initialUserCommitted = true;
  } catch (error) {
    return finish("failed", toAgentError(error));
  }
  messages.push(...(config.runScopedContext ?? []), userMessage);
  events.onRunStart?.({ runId: config.runId, startedAt });

  while (true) {
    if (config.signal?.aborted) return finish("cancelled");
    if (!currentTurnId) {
      try {
        const incoming = config.steeringInbox ? await config.steeringInbox.takePending() : [];
        await applyInputs([...readyInputs, ...incoming]);
        readyInputs = [];
      } catch (error) {
        return finish("failed", toAgentError(error));
      }
      if (config.signal?.aborted) return finish("cancelled");
      currentTurnId = randomUUID();
      turnOrdinal += 1;
      attempt = 0;
    }
    attempt += 1;
    const ctx: TurnContext = { runId: config.runId, turnId: currentTurnId, turnOrdinal, attempt };
    events.onTurnStart?.(ctx);

    let collected: { response: LlmResponse; completed: boolean } | undefined;
    let outcome: TurnOutcome;
    try {
      collected = await collectTurn(modelConfig, messages, config.systemPrompt || DEFAULT_SYSTEM_PROMPT, tools, ctx, events, config.recorder, config.signal, config.responseImpl ?? response);
      if (config.signal?.aborted) outcome = { kind: "cancelled", reason: "aborted" };
      else if (!collected.completed) outcome = { kind: "incomplete", reason: "missing_finish_reason", response: collected.response };
      else outcome = classifyTurn(collected.response);
    } catch (error) {
      if (config.signal?.aborted) outcome = { kind: "cancelled", reason: "aborted" };
      else {
        const agentError = toAgentError(error);
        outcome = {
          kind: "failed",
          reason: agentError.kind === "network" ? "network_error" : agentError.kind === "model_protocol" ? "model_protocol" : "provider_error",
          error: agentError,
        };
      }
    }

    const partialMessage = collected ? assistantMessage(collected.response) : undefined;
    if (outcome.kind === "cancelled") {
      try {
        await config.recorder?.finishAssistantAttempt(ctx, "interrupted", partialMessage);
      } catch (error) {
        return finish("failed", toAgentError(error));
      }
      return finish("cancelled");
    }

    if (outcome.kind === "answer" || outcome.kind === "tool_calls") {
      const message = assistantMessage(outcome.response);
      const commitContext = { ...ctx, entryId: randomUUID(), completedAt: clock() };
      let invocations = new Map<string, ToolInvocationRecord>();
      try {
        // Logical identities stay fixed across storage retries; preparation belongs to each execution attempt.
        const inputs = outcome.kind === "tool_calls" ? planToolBatch(outcome.response.toolCalls, ctx, config) : [];
        await commitWithRetry(async () => {
          if (config.recorder) {
            const records = await config.recorder.finishAssistantAttempt(commitContext, "completed", message, inputs);
            invocations = new Map(records.map((record) => [record.toolCallId, record]));
          }
        }, commitRetryConfig, config.signal);
      } catch (error) {
        if (config.signal?.aborted) return finish("cancelled");
        return finish("failed", toAgentError(error));
      }
      if (config.signal?.aborted) return finish("cancelled");
      messages.push(message);
      events.onAssistantCompleted?.(outcome.response, { ...ctx, completedAt: commitContext.completedAt });

      if (outcome.kind === "answer") {
        events.onTurnCompleted?.(ctx);
        try {
          readyInputs = await config.steeringInbox?.takePendingOrSeal() ?? [];
        } catch (error) {
          return finish("failed", toAgentError(error));
        }
        if (readyInputs.length > 0) {
          currentTurnId = undefined;
          continue;
        }
        return finish("completed", undefined, ctx.turnId);
      }

      for (const call of outcome.response.toolCalls) {
        if (config.signal?.aborted) return finish("cancelled");
        events.onToolStart?.(call, ctx);
        const invocation = invocations.get(call.id);
        let toolResult: ToolResult;
        let toolMessage: ModelMessage;
        try {
          let executionInvocation = invocation;
          if (invocation?.phase === "completed" || invocation?.phase === "outcome_ready") {
            toolResult = toolResultFromInvocation(invocation);
          } else {
            const recovered = invocation?.phase === "effect_pending"
              ? await recoverToolInvocation(call, invocation, config)
              : undefined;
            if (recovered?.kind === "succeeded") toolResult = recovered.result;
            else if (recovered?.kind === "interrupted") toolResult = recovered.result ?? interruptedToolResult(recovered.reason);
            else {
              const executed = await executeToolAttempt(call, config, invocation);
              executionInvocation = executed.invocation;
              toolResult = executed.result;
            }
          }
          toolMessage = await materializeToolResult(call, toolResult, config, executionInvocation, ctx);
        } catch (error) {
          if (error instanceof ToolAttemptBlockedError && error.reason === "cancelled") return finish("cancelled");
          if (config.signal?.aborted && !(error instanceof RepositoryError)) return finish("cancelled");
          return finish("failed", toAgentError(error));
        }
        messages.push(toolMessage);
        events.onToolCompleted?.(call, toolResult, ctx);
      }
      events.onTurnCompleted?.(ctx);
      currentTurnId = undefined;
      continue;
    }

    const attemptStatus = outcome.kind === "incomplete" ? "interrupted" : "failed";
    try {
      await config.recorder?.finishAssistantAttempt(ctx, attemptStatus, partialMessage);
    } catch (error) {
      return finish("failed", toAgentError(error));
    }

    if (outcome.kind === "incomplete") {
      const canRetry = await retryModelTurn({
        runId: config.runId,
        turnId: ctx.turnId,
        attempt,
        reason: outcome.reason,
        maxAttempts: retryConfig.maxAttempts,
        baseDelayMs: retryConfig.baseDelayMs,
        maxDelayMs: retryConfig.maxDelayMs,
        signal: config.signal,
        events,
      });
      if (canRetry) continue;
      return finish("failed", { kind: "model_protocol", message: retryFailureMessage(outcome.reason) });
    }

    if (outcome.kind === "failed" && outcome.error.retryable) {
      const reason: RetryReason = outcome.reason === "network_error" ? "network_error" : outcome.reason === "provider_error" ? "provider_error" : "model_protocol";
      const canRetry = await retryModelTurn({
        runId: config.runId,
        turnId: ctx.turnId,
        attempt,
        reason,
        maxAttempts: retryConfig.maxAttempts,
        baseDelayMs: retryConfig.baseDelayMs,
        maxDelayMs: retryConfig.maxDelayMs,
        signal: config.signal,
        events,
      });
      if (canRetry) continue;
    }
    return finish("failed", outcome.error);
  }
}

export function classifyTurn(response: LlmResponse): TurnOutcome {
  if (response.error) {
    return { kind: "failed", reason: response.error.kind === "network" ? "network_error" : response.error.kind === "model_protocol" ? "model_protocol" : "provider_error", error: response.error };
  }
  if (response.stopReason === "aborted") return { kind: "cancelled", reason: "aborted" };
  if (response.stopReason === "content_filter") return { kind: "failed", reason: "content_filtered", error: { kind: "provider", message: "The provider filtered this response." } };
  if (response.stopReason === "unknown") return { kind: "failed", reason: "unknown_stop_reason", error: { kind: "model_protocol", message: `Unknown model stop reason: ${response.rawStopReason ?? "unknown"}.` } };
  if (response.stopReason === "length") return { kind: "incomplete", reason: "length", response };
  if (response.toolCalls.length > 0) {
    if (response.toolCalls.some((call) => !call.inputComplete)) return { kind: "incomplete", reason: "invalid_tool_calls", response };
    return { kind: "tool_calls", response };
  }
  if (response.stopReason === "tool_use") return { kind: "incomplete", reason: "invalid_tool_calls", response };
  if (response.content.trim()) return { kind: "answer", response };
  if (response.reasoning?.trim()) return { kind: "incomplete", reason: "reasoning_only", response };
  return { kind: "incomplete", reason: "empty_response", response };
}

export async function retryModelTurn(input: {
  runId: string;
  turnId: string;
  attempt: number;
  reason: RetryReason;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  events: AgentEvents;
}): Promise<boolean> {
  if (input.attempt >= input.maxAttempts || input.signal?.aborted) return false;
  const delayMs = Math.min(input.maxDelayMs, input.baseDelayMs * (2 ** Math.max(0, input.attempt - 1)));
  input.events.onTurnRetrying?.({
    runId: input.runId,
    turnId: input.turnId,
    attempt: input.attempt,
    nextAttempt: input.attempt + 1,
    reason: input.reason,
    delayMs,
    maxAttempts: input.maxAttempts,
  });
  if (!(await waitForRetryDelay(delayMs, input.signal))) return false;
  return !input.signal?.aborted;
}

function toAgentError(error: unknown): AgentError {
  if (error instanceof ModelAdapterError) return { kind: error.kind, message: error.message, retryable: error.retryable };
  return { kind: "runtime", message: error instanceof Error ? error.message : String(error) };
}

function assistantMessage(response: LlmResponse): ModelMessage {
  return { role: "assistant", content: response.content, reasoning: response.reasoning, toolCalls: response.toolCalls };
}

function retryFailureMessage(reason: RetryReason): string {
  const messages: Record<RetryReason, string> = {
    reasoning_only: "The model did not produce a complete response after retries.",
    empty_response: "The model returned an empty response after retries.",
    length: "The model response was truncated after retries.",
    missing_finish_reason: "The model stream ended without a complete termination signal.",
    invalid_tool_calls: "The model did not produce a complete tool call after retries.",
    network_error: "The model request failed after retries.",
    provider_error: "The provider request failed after retries.",
    model_protocol: "The model response did not satisfy the protocol after retries.",
  };
  return messages[reason];
}

function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(!signal?.aborted);
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => finish(false);
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(!signal?.aborted), delayMs);
  });
}

async function commitWithRetry(operation: () => Promise<void>, policy: Required<CommitRetryConfig>, signal?: AbortSignal): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      await operation();
      return;
    } catch (error) {
      if (!(error instanceof RepositoryError) || !error.retryable || attempt >= policy.maxAttempts) throw error;
      const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** (attempt - 1)));
      if (!(await waitForRetryDelay(delayMs, signal))) throw error;
    }
  }
}

async function recoverOpenToolInvocations(config: AgentRunConfig, runId?: string, forceCancellation = false): Promise<void> {
  const recorder = config.recorder;
  if (!recorder) return;
  const records = await recorder.listOpenToolInvocations(runId);
  let recoveryCancelled = forceCancellation;
  const persistRecoveryCancellation = async () => {
    if (!config.signal?.aborted || recoveryCancelled) return;
    // Stop applies to the older batches that this run is recovering as well.
    for (const queuedRun of new Set(records.map((record) => record.runId))) await recorder.requestRunCancellation(queuedRun);
    recoveryCancelled = true;
  };
  for (const invocation of records) {
    if (invocation.phase === "completed") continue;
    await persistRecoveryCancellation();
    const cancelled = recoveryCancelled || await recorder.isRunCancelled(invocation.runId);
    const call = await recorder.getToolInvocationCall(invocation.id);
    let executionInvocation = invocation;
    let toolResult: ToolResult;
    if (invocation.phase === "outcome_ready") {
      toolResult = toolResultFromInvocation(invocation);
    } else if (cancelled) {
      toolResult = invocation.phase === "planned"
        ? cancelledToolResult("This tool call was not executed because the user stopped its run.")
        : interruptedToolResult("The user stopped this run after execution began. Its effects require confirmation; it was not replayed.");
    } else {
      try {
        const registeredTool = config.tools.get(call.name);
        const recovered = invocation.phase === "effect_pending"
          ? await recoverToolInvocation(call, invocation, config)
          : !invocation.cwd || !registeredTool || registeredTool.recovery.resumePlanned === false || registeredTool.recovery.version !== invocation.toolVersion
            ? { kind: "interrupted" as const, reason: `Tool ${call.name} belongs to an earlier run and requires a new request.` }
            : undefined;
        if (recovered?.kind === "succeeded") toolResult = recovered.result;
        else if (recovered?.kind === "interrupted") toolResult = recovered.result ?? interruptedToolResult(recovered.reason);
        else if (config.signal?.aborted) {
          toolResult = invocation.phase === "planned" ? cancelledToolResult("The user stopped recovery before this tool could execute.") : interruptedToolResult("The user stopped tool recovery; no replay was started.");
        } else {
          const executed = await executeToolAttempt(call, config, invocation);
          executionInvocation = executed.invocation ?? invocation;
          toolResult = executed.result;
        }
      } catch (error) {
        // A storage failure leaves the ledger open; it must not become a fictitious tool outcome.
        if (error instanceof ToolAttemptBlockedError && error.reason === "cancelled") {
          toolResult = invocation.phase === "planned" ? cancelledToolResult("The run was stopped before execution intent could commit.")
            : interruptedToolResult("The run was stopped before recovery execution intent could commit.");
        } else {
          if (error instanceof RepositoryError) throw error;
          toolResult = interruptedToolResult(error instanceof Error ? error.message : String(error));
        }
      }
    }
    await persistRecoveryCancellation();
    await materializeToolResult(call, toolResult, config, executionInvocation, {
      runId: invocation.runId,
      turnId: invocation.turnId,
      turnOrdinal: invocation.ordinal,
    });
  }
}

function planToolBatch(
  calls: ToolCall[],
  ctx: TurnContext,
  config: AgentRunConfig,
): ToolInvocationPlan[] {
  const inputs: ToolInvocationPlan[] = [];
  if (!config.recorder) return inputs;
  for (const [ordinal, call] of calls.entries()) {
    const tool = config.tools.get(call.name);
    const toolVersion = tool?.recovery.version ?? "unknown";
    const recoveryMode = tool?.recovery.mode ?? "never";
    const inputJson = canonicalJson(call.input);
    const inputHash = toolInputHash(call.name, toolVersion, call.input);
    inputs.push({
      runId: ctx.runId,
      turnId: ctx.turnId,
      cwd: config.cwd,
      toolCallId: call.id,
      ordinal,
      toolName: call.name,
      toolVersion,
      inputJson,
      inputHash,
      recoveryModeSnapshot: recoveryMode,
      resultEntryId: randomUUID(),
    });
  }
  return inputs;
}

async function recoverToolInvocation(
  call: ToolCall,
  invocation: ToolInvocationRecord,
  config: AgentRunConfig,
): Promise<ToolRecoveryResult | undefined> {
  const tool = config.tools.get(call.name);
  if (!tool || !config.recorder) return { kind: "interrupted", reason: `Tool ${call.name} is unavailable during recovery.` };
  if (!invocation.cwd) return { kind: "interrupted", reason: "The original execution directory is unavailable. This tool requires a new request." };
  if (config.signal?.aborted || await config.recorder.isRunCancelled(invocation.runId)) return { kind: "interrupted", reason: "The user stopped this run; automatic replay is disabled." };
  if (invocation.phase !== "effect_pending") return undefined;
  if (tool.recovery.version !== invocation.toolVersion) {
    return { kind: "interrupted", reason: `Tool ${call.name} version ${invocation.toolVersion} requires a matching recovery implementation.` };
  }
  if (invocation.recoveryModeSnapshot === "never") return { kind: "interrupted", reason: `Tool ${call.name} requires manual recovery after an interrupted execution.` };
  if (invocation.recoveryModeSnapshot === "reconcile" && !tool.recovery.reconcile) {
    return { kind: "interrupted", reason: `Tool ${call.name} has no recovery reconciler.` };
  }
  if (invocation.recoveryModeSnapshot === "reconcile" && tool.recovery.reconcile) {
    if (config.signal?.aborted) return { kind: "interrupted", reason: "The user stopped tool recovery; reconciliation was not started." };
    const checkpoint = invocationCheckpoint(invocation);
    const recovered = await tool.recovery.reconcile(call.input, checkpoint, {
      cwd: invocation.cwd,
      signal: config.signal,
      invocationId: invocation.id,
      toolCallId: call.id,
      attempt: invocation.attemptCount,
      checkpoint,
    });
    if (recovered.kind !== "retry") return recovered;
  }
  return { kind: "retry", reason: "tool recovery permits another execution attempt" };
}

function toolResultFromInvocation(invocation: ToolInvocationRecord): ToolResult {
  const result = readToolResult(invocation.outcomeJson);
  if (!result || toolOutcomeStatus(result) !== invocation.outcomeStatus) {
    throw new RepositoryError(`Invalid persisted tool outcome: ${invocation.id}`, "storage");
  }
  return result;
}

function interruptedToolResult(reason: string): ToolResult {
  return { ok: false, output: reason, returncode: -1, truncated: false, error: "interrupted" };
}

function cancelledToolResult(reason: string): ToolResult {
  return { ok: false, output: reason, returncode: -1, truncated: false, error: "cancelled" };
}

function invocationCheckpoint(invocation: ToolInvocationRecord) {
  if (invocation.checkpoint == null) return undefined;
  const checkpoint = readToolCheckpoint(invocation.checkpoint);
  if (!checkpoint) throw new RepositoryError(`Invalid tool checkpoint: ${invocation.id}`, "storage");
  return checkpoint;
}

/** Prepare once, persist intent, then execute precisely the prepared operation. */
async function executeToolAttempt(
  call: ToolCall,
  config: AgentRunConfig,
  invocation?: ToolInvocationRecord,
): Promise<{ result: ToolResult; invocation?: ToolInvocationRecord }> {
  const immediate = (result: ToolResult) => ({ result, invocation });
  if (config.signal?.aborted) return immediate(invocation?.phase === "effect_pending"
    ? interruptedToolResult("The user stopped recovery before a new execution attempt.")
    : cancelledToolResult("The user stopped before this tool could execute."));
  if (invocation?.phase === "planned" && await config.recorder?.isToolInvocationBlocked(invocation.id)) {
    return immediate(interruptedToolResult("This tool call was skipped because an earlier call in its batch has an uncertain outcome."));
  }
  if (!call.inputComplete) return immediate(invalidResult("The tool arguments were truncated by the model response and were not executed. Please regenerate the complete tool call.", "truncated_arguments"));
  const tool = config.tools.get(call.name);
  if (!tool) return immediate(invalidResult(`Unknown tool: ${call.name}`, "unknown_tool"));
  const preparationContext: ToolExecutionContext = {
    cwd: invocation?.cwd ?? config.cwd,
    signal: config.signal,
    invocationId: invocation?.id,
    toolCallId: call.id,
    attempt: (invocation?.attemptCount ?? 0) + 1,
  };
  let prepared: PreparedToolExecution;
  try {
    prepared = tool.prepare ? await tool.prepare(call.input, preparationContext)
      : { kind: "ready", execute: (context) => tool.execute(call.input, context) };
    if (prepared.kind === "result") {
      const result = readToolResult(prepared.result);
      if (!result || result.ok) throw new Error("Preparation must return a valid unsuccessful result or a prepared execution.");
      return immediate(result);
    }
    if (prepared.checkpoint && !readToolCheckpoint(prepared.checkpoint)) throw new Error("Preparation returned an invalid checkpoint.");
  } catch (error) {
    return immediate(config.signal?.aborted ? cancelledToolResult("The user stopped during tool preparation.")
      : invalidResult(error instanceof Error ? error.message : String(error), "preparation_failed"));
  }
  if (config.signal?.aborted) return immediate(cancelledToolResult("The user stopped before execution intent was persisted."));
  // Keep database failures outside the tool error boundary. No effects have started here.
  let executing = invocation;
  try {
    if (invocation && config.recorder) executing = await config.recorder.beginToolAttempt(invocation.id, prepared.checkpoint);
  } catch (error) {
    if (error instanceof ToolAttemptBlockedError && error.reason === "prior_interrupted") {
      return immediate(interruptedToolResult("This tool call was skipped because an earlier call in its batch has an uncertain outcome."));
    }
    throw error;
  }
  if (config.signal?.aborted) return { result: interruptedToolResult("The user stopped after intent was persisted; execution was not started."), invocation: executing };
  try {
    const result = await prepared.execute({ ...preparationContext, attempt: executing?.attemptCount ?? 1, checkpoint: prepared.checkpoint });
    const validated = readToolResult(result);
    if (!validated) throw new Error(`Tool ${call.name} returned an invalid result.`);
    return { result: validated, invocation: executing };
  } catch (error) {
    return { result: interruptedToolResult(error instanceof Error ? error.message : String(error)), invocation: executing };
  }
}

/** Saving a result retries only persistence, never the physical tool execution. */
async function materializeToolResult(
  call: ToolCall,
  result: ToolResult,
  config: AgentRunConfig,
  invocation: ToolInvocationRecord | undefined,
  context: { runId: string; turnId: string; turnOrdinal: number },
): Promise<ModelMessage> {
  if (!readToolResult(result)) throw new Error(`Tool ${call.name} returned an invalid result.`);
  const message = toolResultMessage(call, result);
  const entryId = invocation?.resultEntryId ?? randomUUID();
  await commitWithRetry(async () => {
    if (invocation && config.recorder) {
      const outcome = { status: toolOutcomeStatus(result), outcome: result };
      if (invocation.phase === "planned") await config.recorder.settleUnstartedToolInvocation(invocation.id, outcome);
      else if (invocation.phase === "effect_pending") await config.recorder.saveToolOutcome(invocation.id, outcome);
    }
    await config.recorder?.commitToolResult(message, { ...context, toolCallId: call.id, entryId, invocationId: invocation?.id });
  }, { ...DEFAULT_COMMIT_RETRY, ...config.commitRetry });
  return message;
}

function invalidResult(output: string, error: string): ToolResult {
  return { ok: false, output, returncode: -1, truncated: false, error };
}

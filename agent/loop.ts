import { randomUUID } from "node:crypto";
import type { SessionRecorder, ToolInvocationRecord, ToolOutcomeStatus } from "./memory/types.js";
import { response, type ModelConfig } from "./model/index.js";
import { ModelAdapterError, type LlmResponse, type ModelMessage, type ToolCall, type ToolDef } from "./model/types.js";
import { canonicalJson, toolInputHash } from "./tools/recovery.js";
import type { RegisteredTool, ToolRecoveryResult, ToolResult } from "./tools/index.js";

export type RunStatus = "completed" | "cancelled" | "failed";

export interface ModelRetryConfig {
  /** 一次逻辑 turn 包含的总模型尝试次数。 */
  maxAttempts?: number;
  /** 首次重试等待时间；测试可设为 0。 */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_MODEL_RETRY: Required<ModelRetryConfig> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
};

export interface AgentRunConfig {
  runId: string;
  systemPrompt: string;
  cwd: string;
  tools: Map<string, RegisteredTool>;
  signal?: AbortSignal;
  /** 运行绑定的本地会话 Recorder；Recorder 提供初始的已提交消息快照。 */
  recorder?: SessionRecorder;
  /** 测试注入点：与 provider-model-discovery 的 fetchImpl 同理。 */
  responseImpl?: typeof response;
  modelRetry?: ModelRetryConfig;
  /** Context supplied for this run only; it is intentionally not committed. */
  runScopedContext?: ModelMessage[];
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
  onAssistantCompleted?: (response: LlmResponse, ctx: TurnContext) => void;
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
  onRunCompleted?: (result: { runId: string; status: RunStatus; error?: AgentError; turnCount: number }) => void;
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
  recorder: SessionRecorder | undefined,
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
): Promise<{ runId: string; status: RunStatus; error?: AgentError; turnCount: number }> {
  const startedAt = new Date().toISOString();
  const messages: ModelMessage[] = [...(config.recorder?.snapshot() ?? [])];
  const userMessage: ModelMessage = { role: "user", content: task };
  const tools = [...config.tools.values()].map((tool) => tool.definition);
  const retryConfig = { ...DEFAULT_MODEL_RETRY, ...config.modelRetry };
  let turnOrdinal = 0;
  let currentTurnId: string | undefined;
  let attempt = 0;
  let finished = false;

  const finish = async (status: RunStatus, error?: AgentError) => {
    if (finished) return { runId: config.runId, status, error, turnCount: turnOrdinal };
    let finalStatus = status;
    let finalError = error;
    try {
      await config.recorder?.finishRun({ runId: config.runId, status });
    } catch (finishError) {
      finalStatus = "failed";
      finalError = toAgentError(finishError);
    }
    const result = { runId: config.runId, status: finalStatus, error: finalError, turnCount: turnOrdinal };
    finished = true;
    events.onRunCompleted?.(result);
    return result;
  };

  try {
    await recoverOpenToolInvocations(config, messages);
    if (config.recorder) messages.splice(0, messages.length, ...config.recorder.snapshot());
  } catch (error) {
    return finish("failed", toAgentError(error));
  }

  try {
    await config.recorder?.commitUser(userMessage, { runId: config.runId });
  } catch (error) {
    return finish("failed", toAgentError(error));
  }
  messages.push(...(config.runScopedContext ?? []), userMessage);
  events.onRunStart?.({ runId: config.runId, startedAt });

  while (true) {
    if (config.signal?.aborted) return finish("cancelled");
    if (!currentTurnId) {
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
      try {
        await config.recorder?.finishAssistantAttempt(ctx, "completed", message);
      } catch (error) {
        return finish("failed", toAgentError(error));
      }
      messages.push(message);
      events.onAssistantCompleted?.(outcome.response, ctx);

      if (outcome.kind === "answer") {
        events.onTurnCompleted?.(ctx);
        return finish("completed");
      }

      let invocations: Map<string, ToolInvocationRecord>;
      try {
        invocations = await registerToolBatch(outcome.response.toolCalls, ctx, config);
      } catch (error) {
        return finish("failed", toAgentError(error));
      }
      for (const call of outcome.response.toolCalls) {
        if (config.signal?.aborted) return finish("cancelled");
        events.onToolStart?.(call, ctx);
        const invocation = invocations.get(call.id);
        let executionInvocation = invocation;
        let toolResult: ToolResult;
        if (invocation?.phase === "completed" || invocation?.phase === "outcome_ready") {
          toolResult = toolResultFromInvocation(invocation);
        } else {
          const recovered = invocation?.phase === "effect_pending"
            ? await recoverToolInvocation(call, invocation, config)
            : undefined;
          if (recovered?.kind === "succeeded") toolResult = recovered.result;
          else if (recovered?.kind === "interrupted") toolResult = recovered.result ?? interruptedToolResult(recovered.reason);
          else {
            if (invocation && config.recorder) executionInvocation = await config.recorder.beginToolAttempt(invocation.id);
            try {
              toolResult = await executeTool(call, config.tools, executionInvocation?.cwd ?? config.cwd, config.signal, executionInvocation);
            } catch (error) {
              toolResult = interruptedToolResult(error instanceof Error ? error.message : String(error));
            }
          }
        }
        const toolMessage: ModelMessage = { role: "tool", content: formatToolResult(toolResult), toolCallId: call.id, toolName: call.name, isError: !toolResult.ok, media: toolResult.media };
        const resultEntryId = executionInvocation?.resultEntryId ?? randomUUID();
        try {
          if (executionInvocation && config.recorder) {
            await config.recorder.saveToolOutcome(executionInvocation.id, {
              status: toolOutcomeStatus(toolResult),
              outcome: toolResult,
            });
          }
          await config.recorder?.commitToolResult(toolMessage, { ...ctx, toolCallId: call.id, entryId: resultEntryId });
          if (executionInvocation && config.recorder) await config.recorder.completeToolInvocation(executionInvocation.id, resultEntryId);
        } catch (error) {
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
  if (delayMs <= 0) return Promise.resolve(!signal?.aborted);
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => finish(false);
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    setTimeout(() => finish(!signal?.aborted), delayMs);
  });
}

async function recoverOpenToolInvocations(config: AgentRunConfig, messages: ModelMessage[]): Promise<void> {
  const recorder = config.recorder;
  if (!recorder || typeof recorder.listOpenToolInvocations !== "function") return;
  const records = await recorder.listOpenToolInvocations(recorder.sessionId);
  for (const invocation of records) {
    if (invocation.phase === "completed") continue;
    let input: Record<string, unknown>;
    try {
      const parsed = JSON.parse(invocation.inputJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool input must be an object.");
      input = parsed as Record<string, unknown>;
    } catch (error) {
      const result = interruptedToolResult(error instanceof Error ? error.message : String(error));
      await recorder.saveToolOutcome(invocation.id, { status: "interrupted", outcome: result });
      continue;
    }
    const call: ToolCall = { id: invocation.toolCallId, name: invocation.toolName, input, inputComplete: true };
    let executionInvocation = invocation;
    let toolResult: ToolResult;
    if (invocation.phase === "outcome_ready") {
      toolResult = toolResultFromInvocation(invocation);
    } else {
      const recovered = invocation.phase === "effect_pending"
        ? await recoverToolInvocation(call, invocation, config)
        : undefined;
      if (recovered?.kind === "succeeded") toolResult = recovered.result;
      else if (recovered?.kind === "interrupted") toolResult = recovered.result ?? interruptedToolResult(recovered.reason);
      else {
        executionInvocation = await recorder.beginToolAttempt(invocation.id);
        try {
          toolResult = await executeTool(call, config.tools, executionInvocation.cwd, config.signal, executionInvocation);
        } catch (error) {
          toolResult = interruptedToolResult(error instanceof Error ? error.message : String(error));
        }
      }
    }
    const toolMessage: ModelMessage = {
      role: "tool",
      content: formatToolResult(toolResult),
      toolCallId: call.id,
      toolName: call.name,
      isError: !toolResult.ok,
      media: toolResult.media,
    };
    const resultEntryId = executionInvocation.resultEntryId ?? randomUUID();
    await recorder.saveToolOutcome(executionInvocation.id, { status: toolOutcomeStatus(toolResult), outcome: toolResult });
    await recorder.commitToolResult(toolMessage, {
      runId: invocation.runId,
      turnId: invocation.turnId,
      turnOrdinal: invocation.ordinal,
      toolCallId: call.id,
      entryId: resultEntryId,
    });
    await recorder.completeToolInvocation(executionInvocation.id, resultEntryId);
    if (!messages.some((message) => message.role === "tool" && message.toolCallId === call.id)) messages.push(toolMessage);
  }
}

async function registerToolBatch(
  calls: ToolCall[],
  ctx: TurnContext,
  config: AgentRunConfig,
): Promise<Map<string, ToolInvocationRecord>> {
  const records = new Map<string, ToolInvocationRecord>();
  const recorder = config.recorder;
  if (!recorder || typeof recorder.registerToolInvocation !== "function" || typeof recorder.getToolInvocation !== "function") return records;
  for (const [ordinal, call] of calls.entries()) {
    const existing = await recorder.getToolInvocation(recorder.sessionId, call.id);
    const tool = config.tools.get(call.name);
    const toolVersion = tool?.recovery.version ?? "unknown";
    const recoveryMode = tool?.recovery.mode ?? "never";
    const inputJson = canonicalJson(call.input);
    const inputHash = toolInputHash(call.name, toolVersion, call.input);
    if (existing) {
      if (existing.inputHash !== inputHash || existing.toolName !== call.name) throw new Error(`Tool call identity conflict: ${call.id}`);
      records.set(call.id, existing);
      continue;
    }
    const checkpoint = tool?.recovery.prepare
      ? await tool.recovery.prepare(call.input, { cwd: config.cwd, toolCallId: call.id })
      : undefined;
    const assistantEntryId = await recorder.getAssistantEntryId?.(ctx.turnId) ?? `${ctx.turnId}:assistant:${ctx.attempt}`;
    const record = await recorder.registerToolInvocation({
      runId: ctx.runId,
      turnId: ctx.turnId,
      cwd: config.cwd,
      assistantEntryId,
      toolCallId: call.id,
      ordinal,
      toolName: call.name,
      toolVersion,
      inputJson,
      inputHash,
      recoveryModeSnapshot: recoveryMode,
      resultEntryId: randomUUID(),
      checkpoint,
    });
    records.set(call.id, record);
  }
  return records;
}

async function recoverToolInvocation(
  call: ToolCall,
  invocation: ToolInvocationRecord,
  config: AgentRunConfig,
): Promise<ToolRecoveryResult | undefined> {
  const tool = config.tools.get(call.name);
  if (!tool || !config.recorder) return { kind: "interrupted", reason: `Tool ${call.name} is unavailable during recovery.` };
  if (invocation.phase !== "effect_pending") return undefined;
  if (tool.recovery.version !== invocation.toolVersion) {
    return { kind: "interrupted", reason: `Tool ${call.name} version ${invocation.toolVersion} requires a matching recovery implementation.` };
  }
  if (invocation.recoveryModeSnapshot === "never") return { kind: "interrupted", reason: `Tool ${call.name} requires manual recovery after an interrupted execution.` };
  if (invocation.recoveryModeSnapshot === "reconcile" && !tool.recovery.reconcile) {
    return { kind: "interrupted", reason: `Tool ${call.name} has no recovery reconciler.` };
  }
  if (invocation.recoveryModeSnapshot === "reconcile" && tool.recovery.reconcile) {
    const recovered = await tool.recovery.reconcile(call.input, invocation.checkpoint as never, {
      cwd: invocation.cwd,
      signal: config.signal,
      invocationId: invocation.id,
      toolCallId: call.id,
      attempt: invocation.attemptCount,
      checkpoint: invocation.checkpoint as never,
    });
    if (recovered.kind !== "retry") return recovered;
  }
  return { kind: "retry", reason: "tool recovery permits another execution attempt" };
}

function toolResultFromInvocation(invocation: ToolInvocationRecord): ToolResult {
  const outcome = invocation.outcomeJson;
  if (outcome && typeof outcome === "object" && "ok" in outcome && "output" in outcome) return outcome as ToolResult;
  return interruptedToolResult("The persisted tool outcome is missing or invalid.");
}

function interruptedToolResult(reason: string): ToolResult {
  return { ok: false, output: reason, returncode: -1, truncated: false, error: "interrupted" };
}

function toolOutcomeStatus(result: ToolResult): ToolOutcomeStatus {
  return result.error === "interrupted" ? "interrupted" : result.ok ? "succeeded" : "failed";
}

async function executeTool(
  call: ToolCall,
  tools: Map<string, RegisteredTool>,
  cwd: string,
  signal?: AbortSignal,
  invocation?: ToolInvocationRecord,
): Promise<ToolResult> {
  if (!call.inputComplete) return invalidResult("The tool arguments were truncated by the model response and were not executed. Please regenerate the complete tool call.", "truncated_arguments");
  const tool = tools.get(call.name);
  if (!tool) return invalidResult(`Unknown tool: ${call.name}`, "unknown_tool");
  return tool.execute(call.input, {
    cwd,
    signal,
    invocationId: invocation?.id,
    toolCallId: call.id,
    attempt: invocation?.attemptCount,
    checkpoint: invocation?.checkpoint as never,
  });
}

function invalidResult(output: string, error: string): ToolResult {
  return { ok: false, output, returncode: -1, truncated: false, error };
}

function formatToolResult(result: ToolResult): string {
  const note = result.truncated && result.fullOutputPath ? `\nFull output: ${result.fullOutputPath}` : "";
  return `<returncode>${result.returncode}</returncode>\n<output>\n${result.output}\n</output>${note}`;
}

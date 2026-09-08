import { randomUUID } from "node:crypto";
import { response, type ModelConfig } from "./model/index.js";
import type { LlmResponse, ModelMessage, ModelStopReason, ToolCall, ToolDef } from "./model/types.js";
import type { RegisteredTool, ToolResult } from "./tools/index.js";

export type RunStatus = "completed" | "cancelled" | "failed";

export interface AgentRunConfig {
  runId: string;
  systemPrompt: string;
  cwd: string;
  tools: Map<string, RegisteredTool>;
  signal?: AbortSignal;
  /** 会话历史（跨 run 累积）；本 run 产生的新消息经 onMessageFinalized 追加回外部。 */
  history?: ModelMessage[];
  /** 测试注入点：与 provider-model-discovery 的 fetchImpl 同理。 */
  responseImpl?: typeof response;
}

export interface TurnContext {
  runId: string;
  turnId: string;
  turnOrdinal: number;
}

export interface AgentEvents {
  onRunStart?: (ctx: { runId: string; startedAt: string }) => void;
  onTurnStart?: (ctx: TurnContext) => void;
  onReasoningDelta?: (delta: string, ctx: TurnContext) => void;
  onAssistantDelta?: (delta: string, ctx: TurnContext) => void;
  onAssistantCompleted?: (response: LlmResponse, ctx: TurnContext) => void;
  onToolStart?: (call: ToolCall, ctx: TurnContext) => void;
  onToolCompleted?: (call: ToolCall, result: ToolResult, ctx: TurnContext) => void;
  onTurnCompleted?: (ctx: TurnContext) => void;
  onRunCompleted?: (result: { runId: string; status: RunStatus; error?: AgentError; turnCount: number }) => void;
  /** 一条消息提交进对话（用户消息/助手完整消息/工具结果）——会话历史由外部维护时用于增量追加。 */
  onMessageFinalized?: (message: ModelMessage) => void;
}

export interface AgentError {
  kind: "config" | "network" | "provider" | "model_protocol" | "tool" | "runtime";
  message: string;
  retryable?: boolean;
}

const DEFAULT_SYSTEM_PROMPT = "You are a coding agent. Use the available tools when needed, then provide a concise final answer.";

/**
 * 流式输出的唯一处理函数（本文件内）：
 * 消费模型事件流 → 转发 UI 增量事件（reasoning/text）+ 聚合整回合（content/reasoning/toolCalls）。
 * context 写入不在这里——由 run() 在聚合完成后一次性 messages.push。
 */
async function collectTurn(
  modelConfig: ModelConfig,
  messages: ModelMessage[],
  system: string,
  tools: ToolDef[],
  ctx: TurnContext,
  events: AgentEvents,
  signal: AbortSignal | undefined,
  responseImpl: typeof response,
): Promise<LlmResponse> {
  const aggregated: LlmResponse = { content: "", toolCalls: [], stopReason: "stop" };
  for await (const event of responseImpl(modelConfig, messages, system, tools, signal)) {
    switch (event.type) {
      case "reasoning_delta":
        aggregated.reasoning = (aggregated.reasoning ?? "") + event.delta;
        events.onReasoningDelta?.(event.delta, ctx);
        break;
      case "text_delta":
        aggregated.content += event.delta;
        events.onAssistantDelta?.(event.delta, ctx);
        break;
      case "completed":
        aggregated.content = event.content;
        aggregated.reasoning = event.reasoning;
        aggregated.toolCalls = event.toolCalls;
        aggregated.stopReason = event.stopReason;
        aggregated.rawStopReason = event.rawStopReason;
        break;
    }
  }
  return aggregated;
}

export async function run(
  task: string,
  modelConfig: ModelConfig,
  config: AgentRunConfig,
  events: AgentEvents = {},
): Promise<{ runId: string; status: RunStatus; error?: AgentError; turnCount: number }> {
  const startedAt = new Date().toISOString();
  events.onRunStart?.({ runId: config.runId, startedAt });
  const messages: ModelMessage[] = [...(config.history ?? []), { role: "user", content: task }];
  const userMessage = messages[messages.length - 1];
  events.onMessageFinalized?.(userMessage);
  const tools = [...config.tools.values()].map((tool) => tool.definition);
  let turnOrdinal = 0;

  const finish = (status: RunStatus, error?: AgentError) => {
    const result = { runId: config.runId, status, error, turnCount: turnOrdinal };
    events.onRunCompleted?.(result);
    return result;
  };

  while (true) {
    if (config.signal?.aborted) return finish("cancelled");

    const ctx: TurnContext = { runId: config.runId, turnId: randomUUID(), turnOrdinal: ++turnOrdinal };
    events.onTurnStart?.(ctx);

    let result: LlmResponse;
    try {
      result = await collectTurn(modelConfig, messages, config.systemPrompt || DEFAULT_SYSTEM_PROMPT, tools, ctx, events, config.signal, config.responseImpl ?? response);
    } catch (error) {
      if (config.signal?.aborted) return finish("cancelled");
      return finish("failed", { kind: "runtime", message: error instanceof Error ? error.message : String(error) });
    }

    events.onAssistantCompleted?.(result, ctx);
    const assistantMessage: ModelMessage = { role: "assistant", content: result.content, reasoning: result.reasoning, toolCalls: result.toolCalls };
    messages.push(assistantMessage);
    events.onMessageFinalized?.(assistantMessage);

    if (config.signal?.aborted || result.stopReason === "aborted") return finish("cancelled");
    if (result.stopReason === "error" || result.error) {
      return finish("failed", result.error ?? { kind: "provider", message: "模型请求失败。" });
    }
    if (result.toolCalls.length === 0) {
      events.onTurnCompleted?.(ctx);
      return finish("completed");
    }

    for (const call of result.toolCalls) {
      if (config.signal?.aborted) return finish("cancelled");
      events.onToolStart?.(call, ctx);
      const result = await executeTool(call, config.tools, config.cwd, config.signal);
      const toolMessage: ModelMessage = { role: "tool", content: formatToolResult(result), toolCallId: call.id, toolName: call.name, isError: !result.ok, media: result.media };
      messages.push(toolMessage);
      events.onMessageFinalized?.(toolMessage);
      events.onToolCompleted?.(call, result, ctx);
    }
    events.onTurnCompleted?.(ctx);
  }
}

async function executeTool(call: ToolCall, tools: Map<string, RegisteredTool>, cwd: string, signal?: AbortSignal): Promise<ToolResult> {
  if (!call.inputComplete) return invalidResult("工具参数被模型响应截断，未执行。请重新生成完整的工具调用。", "truncated_arguments");
  const tool = tools.get(call.name);
  if (!tool) return invalidResult(`未知工具：${call.name}`, "unknown_tool");
  return tool.execute(call.input, { cwd, signal });
}

function invalidResult(output: string, error: string): ToolResult {
  return { ok: false, output, returncode: -1, truncated: false, error };
}

function formatToolResult(result: ToolResult): string {
  const note = result.truncated && result.fullOutputPath ? `\n完整输出：${result.fullOutputPath}` : "";
  return `<returncode>${result.returncode}</returncode>\n<output>\n${result.output}\n</output>${note}`;
}

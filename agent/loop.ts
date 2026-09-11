import { randomUUID } from "node:crypto";
import type { SessionRecorder } from "./memory/types.js";
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
  /** 运行绑定的本地会话 Recorder；Recorder 提供初始的已提交消息快照。 */
  recorder?: SessionRecorder;
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
}

export interface AgentError {
  kind: "config" | "network" | "provider" | "model_protocol" | "tool" | "runtime";
  message: string;
  retryable?: boolean;
}

const DEFAULT_SYSTEM_PROMPT = "You are a coding agent. Use the available tools when needed, then provide a concise final answer.";

/**
 * 流式输出的唯一处理函数（本文件内）：
 * 消费模型事件流 → 同步通知 Recorder 与宿主事件接收器 → 聚合整回合（content/reasoning/toolCalls）。
 * 完整消息的会话提交仍由 run() 在聚合完成后负责。
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
  const aggregated: LlmResponse = { content: "", toolCalls: [], stopReason: "stop" };
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
  const messages: ModelMessage[] = [...(config.recorder?.snapshot() ?? []), { role: "user", content: task }];
  const userMessage = messages[messages.length - 1];
  const tools = [...config.tools.values()].map((tool) => tool.definition);
  let turnOrdinal = 0;
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
    await config.recorder?.commitUser(userMessage, { runId: config.runId });
  } catch (error) {
    return finish("failed", toAgentError(error));
  }
  events.onRunStart?.({ runId: config.runId, startedAt });

  while (true) {
    if (config.signal?.aborted) return finish("cancelled");

    const ctx: TurnContext = { runId: config.runId, turnId: randomUUID(), turnOrdinal: ++turnOrdinal };
    events.onTurnStart?.(ctx);

    let result: LlmResponse;
    try {
      const collected = await collectTurn(modelConfig, messages, config.systemPrompt || DEFAULT_SYSTEM_PROMPT, tools, ctx, events, config.recorder, config.signal, config.responseImpl ?? response);
      if (config.signal?.aborted) return finish("cancelled");
      if (!collected.completed) {
        return finish("failed", { kind: "model_protocol", message: "模型流结束时缺少 completed 终态。" });
      }
      result = collected.response;
    } catch (error) {
      if (config.signal?.aborted) return finish("cancelled");
      return finish("failed", toAgentError(error));
    }

    const assistantMessage: ModelMessage = { role: "assistant", content: result.content, reasoning: result.reasoning, toolCalls: result.toolCalls };
    try {
      await config.recorder?.commitAssistant(assistantMessage, ctx);
    } catch (error) {
      return finish("failed", toAgentError(error));
    }
    messages.push(assistantMessage);
    events.onAssistantCompleted?.(result, ctx);

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
      let toolResult: ToolResult;
      try {
        toolResult = await executeTool(call, config.tools, config.cwd, config.signal);
      } catch (error) {
        return finish("failed", { kind: "tool", message: error instanceof Error ? error.message : String(error) });
      }
      const toolMessage: ModelMessage = { role: "tool", content: formatToolResult(toolResult), toolCallId: call.id, toolName: call.name, isError: !toolResult.ok, media: toolResult.media };
      try {
        await config.recorder?.commitToolResult(toolMessage, { ...ctx, toolCallId: call.id });
      } catch (error) {
        return finish("failed", toAgentError(error));
      }
      messages.push(toolMessage);
      events.onToolCompleted?.(call, toolResult, ctx);
    }
    events.onTurnCompleted?.(ctx);
  }
}

function toAgentError(error: unknown): AgentError {
  return { kind: "runtime", message: error instanceof Error ? error.message : String(error) };
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

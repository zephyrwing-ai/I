/** Provider 与 Runtime 之间共享的结构化模型契约。 */

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Provider 报告长度截断时，Runtime 禁止执行这次调用。 */
  inputComplete: boolean;
}

export type ModelStopReason = "stop" | "tool_use" | "length" | "error" | "aborted";

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** 思考内容（模型推理过程）；随消息一起回传给模型，供后续推理使用（pi 的 string-thinking 方案）。 */
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/** 统一的模型返回，Runtime 不读取 Provider 原始响应格式。 */
export interface LlmResponse {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  stopReason: ModelStopReason;
  rawStopReason?: string;
  error?: { kind: "config" | "network" | "provider" | "model_protocol" | "runtime"; message: string; retryable?: boolean };
}

/**
 * 模型流式事件（adapter 与 loop 之间的契约，增量分片）。
 * adapter 解析各家 SSE 后 yield 统一事件；loop 消费它转发 UI 事件并聚合整回合。
 * 工具调用不在分片中逐个给——由 adapter 聚合后随 completed 一次性给出。
 */
export type ModelStreamEvent =
  | { type: "reasoning_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "completed"; content: string; reasoning?: string; toolCalls: ToolCall[]; stopReason: ModelStopReason; rawStopReason?: string };

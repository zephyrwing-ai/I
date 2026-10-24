/** Provider 与 Runtime 之间共享的结构化模型契约。 */

export interface ModelCapabilities {
  contextWindowTokens: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  source: "provider" | "catalog" | "manual";
}

/** 工具参数属性描述 — 支持嵌套 object 与 array（items），与 OpenAI schema 对应。 */
export interface ToolParamSpec {
  type: string;
  description: string;
  enum?: string[];
  items?: ToolParamSpec;
  properties?: Record<string, ToolParamSpec>;
  required?: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParamSpec>;
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

export type ModelStopReason = "stop" | "tool_use" | "length" | "content_filter" | "unknown" | "error" | "aborted";

export type ModelErrorKind = "config" | "network" | "provider" | "model_protocol" | "context_overflow";

/** Adapter 归一化后的模型请求错误；Runtime 决定是否恢复。 */
export class ModelAdapterError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ModelAdapterError";
  }
}

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** 兼容既有消息中的独立公开说明；原生响应使用 content。 */
  progress?: string;
  /** 思考内容（模型推理过程）；由具体 Provider Adapter 决定是否以及如何回传。 */
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** 图片类工具结果（Read 图片）：适配层拼入 tool 消息图片部分。 */
  media?: { mediaType: string; dataUrl: string };
}

/** Validate stored model-message fields while preserving their JSON payload. */
export function readModelMessage(value: unknown): ModelMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (!["user", "assistant", "tool"].includes(message.role as string) || typeof message.content !== "string") return undefined;
  for (const field of ["progress", "reasoning", "toolCallId", "toolName"]) {
    if (message[field] !== undefined && typeof message[field] !== "string") return undefined;
  }
  if (message.isError !== undefined && typeof message.isError !== "boolean") return undefined;
  if (message.toolCalls !== undefined) {
    if (!Array.isArray(message.toolCalls) || !message.toolCalls.every((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const call = item as Record<string, unknown>;
      return typeof call.id === "string" && typeof call.name === "string" && typeof call.inputComplete === "boolean"
        && call.input !== null && typeof call.input === "object" && !Array.isArray(call.input);
    })) return undefined;
  }
  if (message.media !== undefined) {
    if (!message.media || typeof message.media !== "object" || Array.isArray(message.media)) return undefined;
    const media = message.media as Record<string, unknown>;
    if (typeof media.mediaType !== "string" || typeof media.dataUrl !== "string") return undefined;
  }
  return value as ModelMessage;
}

/** Provider-reported counts; estimates belong to the context projection. */
export interface ModelUsage {
  /** Provider input count includes cached tokens. Missing counts remain unknown. */
  inputTokens?: number;
  /** Provider output count includes reasoning tokens. */
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

/** 统一的模型返回，Runtime 不读取 Provider 原始响应格式。 */
export interface LlmResponse {
  content: string;
  progress?: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  stopReason: ModelStopReason;
  rawStopReason?: string;
  usage?: ModelUsage;
  error?: { kind: ModelErrorKind | "runtime"; message: string; retryable?: boolean };
}

/**
 * 模型流式事件（adapter 与 loop 之间的契约，增量分片）。
 * adapter 解析各家 SSE 后 yield 统一事件；loop 消费它转发 UI 事件并聚合整回合。
 * 工具调用不在分片中逐个给——由 adapter 聚合后随 completed 一次性给出。
 */
export type ModelStreamEvent =
  | { type: "reasoning_delta"; delta: string }
  | { type: "progress_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "completed"; content: string; progress?: string; reasoning?: string; toolCalls: ToolCall[]; stopReason: ModelStopReason; rawStopReason?: string; usage?: ModelUsage };

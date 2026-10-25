/**
 * 统一模型层 — agent 循环只调 response 这一个事件流函数。
 * 内部根据 provider 动态加载对应实现（不用的 SDK 不需要装）。
 */

import type { ToolDef, LlmResponse, ModelMessage, ModelStreamEvent, ModelCapabilities, ResolveAttachmentImages } from "./types.js";

export type { ToolDef, LlmResponse, ModelMessage, ModelStreamEvent, ToolCall, ModelStopReason, ModelErrorKind, ModelUsage, ModelCapabilities } from "./types.js";
export { ModelAdapterError } from "./types.js";

/** 只保留 OpenAI 兼容协议（DeepSeek 等均走此协议）。 */
export type Provider = "openai";

export interface ModelContextConfig {
  windowTokens: number;
  outputReserveTokens: number;
  safetyTokens: number;
  growthTokens: number;
  recentTokens: number;
  summaryTokens: number;
}

export interface ModelConfig {
  provider: Provider;
  model: string;
  capabilities?: ModelCapabilities;
  context?: ModelContextConfig;
  maxOutputTokens?: number;
  resolveAttachmentImages?: ResolveAttachmentImages;
  /** OpenAI 兼容接口的额外配置 (baseURL、凭据和 Provider 思考字段)。 */
  openai?: {
    baseURL?: string;
    apiKey?: string;
    apiKeyProvider?: () => Promise<string>;
    reasoningField?: "reasoning_content";
    maxOutputParameter?: "max_tokens" | "max_completion_tokens";
    streamUsage?: boolean;
  };
}

/**
 * 模型事件流入口：按 provider 分发到对应 adapter，adapter 边解析 SSE 边 yield 统一事件。
 * 调用链等价于：response → 分发 → adapter.stream（各家协议）→ loop 的 for await。
 * tools 由调用方（运行循环）从注册表取值后显式传入；模型层不内置具体工具。
 */
export async function* response(
  config: ModelConfig,
  messages: ModelMessage[],
  system: string,
  tools: ToolDef[],
  signal?: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  switch (config.provider) {
    case "openai": {
      const { streamOpenAI } = await import("./openai.js");
      yield* streamOpenAI(messages, tools, { ...config.openai, model: config.model, maxOutputTokens: config.maxOutputTokens, resolveAttachmentImages: config.resolveAttachmentImages, inputModalities: config.capabilities?.inputModalities }, system, signal);
      return;
    }
  }
}

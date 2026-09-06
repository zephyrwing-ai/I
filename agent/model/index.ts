/**
 * 统一模型层 — agent 循环只调 response 这一个事件流函数。
 * 内部根据 provider 动态加载对应实现（不用的 SDK 不需要装）。
 */

import type { ToolDef, LlmResponse, ModelMessage, ModelStreamEvent } from "./types.js";

export type { ToolDef, LlmResponse, ModelMessage, ModelStreamEvent, ToolCall, ModelStopReason } from "./types.js";

/** 只保留 OpenAI 兼容协议（DeepSeek 等均走此协议）。 */
export type Provider = "openai";

export interface ModelConfig {
  provider: Provider;
  model: string;
  /** OpenAI 兼容接口的额外配置 (baseURL 等) */
  openai?: { baseURL?: string; apiKey?: string };
}

/** BASH 工具定义 — 只用这一个工具 */
export const BASH_TOOL: ToolDef = {
  name: "bash",
  description: "Execute a bash command",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute" },
    },
    required: ["command"],
  },
};

/**
 * 模型事件流入口：按 provider 分发到对应 adapter，adapter 边解析 SSE 边 yield 统一事件。
 * 调用链等价于：response → 分发 → adapter.stream（各家协议）→ loop 的 for await。
 */
export async function* response(
  config: ModelConfig,
  messages: ModelMessage[],
  system: string,
  tools: ToolDef[] = [BASH_TOOL],
  signal?: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  switch (config.provider) {
    case "openai": {
      const { streamOpenAI } = await import("./openai.js");
      yield* streamOpenAI(messages, tools, { model: config.model, ...config.openai }, system, signal);
      return;
    }
  }
}

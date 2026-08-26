/**
 * 统一模型层 — agent 循环只调这一个函数。
 * 内部根据 provider 动态加载对应实现（不用的 SDK 不需要装）。
 */

import type { ToolDef, LlmResponse } from "./types.js";

export type { ToolDef, LlmResponse } from "./types.js";

export type Provider = "anthropic" | "openai" | "google";

export interface ModelConfig {
  provider: Provider;
  model: string;
  /** OpenAI provider 的额外配置 (baseURL 等) */
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

export async function query(
  config: ModelConfig,
  messages: Array<{ role: string; content: string }>,
  system: string,
): Promise<LlmResponse> {
  switch (config.provider) {
    case "anthropic": {
      const { queryAnthropic } = await import("./anthropic.js");
      const anthropicMsgs = messages
        .filter(m => m.role !== "system")
        .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));
      return queryAnthropic(anthropicMsgs, system, [BASH_TOOL], config.model);
    }

    case "openai": {
      const { queryOpenAI } = await import("./openai.js");
      const openaiMsgs: Array<{ role: "user" | "assistant" | "system"; content: string }> = [
        { role: "system", content: system },
        ...messages.filter(m => m.role !== "system").map(m => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];
      return queryOpenAI(openaiMsgs, [BASH_TOOL], {
        model: config.model,
        ...config.openai,
      });
    }

    case "google": {
      const { queryGoogle } = await import("./google.js");
      const geminiMsgs = messages
        .filter(m => m.role !== "system")
        .map(m => ({
          role: m.role === "assistant" ? "model" as const : "user" as const,
          parts: [{ text: m.content }],
        }));
      return queryGoogle(geminiMsgs, system, [BASH_TOOL], config.model);
    }
  }
}

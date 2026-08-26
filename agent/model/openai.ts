/**
 * OpenAI-compatible provider (OpenAI / DeepSeek / 任何兼容 API)
 *
 * 调 /v1/chat/completions，Tool Calling 模式。
 * 返回格式:
 *   choices[0].message.tool_calls[i].function.name
 *   choices[0].message.tool_calls[i].function.arguments  ← JSON 字符串，要自己 parse
 *
 * DeepSeek 使用方式:
 *   设 baseURL="https://api.deepseek.com"，model="deepseek-chat"
 */

import OpenAI from "openai";
import type { ToolDef, LlmResponse } from "./types.js";

function toOpenAITool(t: ToolDef): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  };
}

export interface OpenAIConfig {
  baseURL?: string;   // DeepSeek: "https://api.deepseek.com"
  apiKey?: string;    // 不传则从 OPENAI_API_KEY 或 DEEPSEEK_API_KEY 环境变量读取
  model?: string;     // 默认 "deepseek-chat"
}

export async function queryOpenAI(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
  tools: ToolDef[],
  config: OpenAIConfig = {},
): Promise<LlmResponse> {
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "未提供 API Key。请在桌面端「设置」面板填入，或设置 DEEPSEEK_API_KEY / OPENAI_API_KEY 环境变量。",
    );
  }
  const client = new OpenAI({
    baseURL: config.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    apiKey,
  });

  const resp = await client.chat.completions.create({
    model: config.model ?? "deepseek-chat",
    messages,
    tools: tools.map(toOpenAITool),
  });

  const actions: Array<{ command: string }> = [];
  const choice = resp.choices[0];
  const textParts: string[] = [choice.message.content ?? ""];

  for (const tc of choice.message.tool_calls ?? []) {
    if (tc.function.name === "bash") {
      try {
        // OpenAI/DeepSeek 的 arguments 是 JSON 字符串，需要 parse
        const args = JSON.parse(tc.function.arguments);
        if (typeof args.command === "string") {
          actions.push({ command: args.command });
        }
      } catch {
        // 参数解析失败，跳过
      }
    }
  }

  return { content: textParts.join("\n"), actions };
}

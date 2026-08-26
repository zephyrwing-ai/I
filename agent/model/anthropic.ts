/**
 * Anthropic (Claude) provider
 *
 * 调 Anthropic Messages API，Tool Calling 模式。
 * 返回格式:
 *   stop_reason: "tool_use"
 *   content: [TextBlock, ToolUseBlock, ...]
 *   ToolUseBlock.input 直接是 JSON 对象 { command: "ls" }
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ToolDef, LlmResponse } from "./types.js";

const client = new Anthropic();

function toAnthropicTool(t: ToolDef): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  };
}

export async function queryAnthropic(
  messages: Anthropic.Messages.MessageParam[],
  system: string,
  tools: ToolDef[],
  model: string = "claude-sonnet-4-20250514",
): Promise<LlmResponse> {
  const resp = await client.messages.create({
    model,
    max_tokens: 4096,
    system,
    tools: tools.map(toAnthropicTool),
    messages,
  });

  const actions: Array<{ command: string }> = [];
  const textParts: string[] = [];

  for (const block of resp.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      // Anthropic 的 tool_use block: .input 直接是已解析的 JSON 对象
      if (block.name === "bash" && typeof block.input === "object" && "command" in block.input) {
        actions.push({ command: block.input.command as string });
      }
    }
  }

  return { content: textParts.join("\n"), actions };
}

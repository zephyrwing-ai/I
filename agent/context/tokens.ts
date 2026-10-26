import type { ModelMessage, ToolDef } from "../model/types.js";
import { serializeAssistantText } from "../model/assistant-text.js";
import { modelInputText } from "../model/attachment-input.js";

export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let unicode = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 128) ascii += 1;
    else unicode += Buffer.byteLength(char, "utf8");
  }
  return Math.ceil(ascii / 3 + unicode / 2);
}

export function estimateMessageTokens(message: ModelMessage): number {
  const text = message.role === "assistant" ? serializeAssistantText(message) : modelInputText(message);
  return 8 + estimateTextTokens(text) + estimateTextTokens(message.reasoning ?? "")
    + estimateTextTokens(message.toolCalls?.length ? JSON.stringify(message.toolCalls) : "")
    + estimateTextTokens(message.toolCallId ?? "") + (message.media ? 4_096 : 0)
    + (message.attachments?.reduce((count, attachment) => count + attachment.imageLabels.length, 0) ?? 0) * 4_096;
}

export function estimateRequestTokens(system: string, tools: ToolDef[], messages: ModelMessage[]): number {
  return 12 + estimateTextTokens(system) + estimateTextTokens(tools.length ? JSON.stringify(tools) : "")
    + messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

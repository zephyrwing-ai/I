import type { ModelMessage } from "./types.js";

/**
 * Shared by Provider continuation and context token estimation.
 * Stored progress remains a separate history field; replay it as ordinary prose
 * before content so older messages retain both bodies without a wire envelope.
 */
export function serializeAssistantText(message: Pick<ModelMessage, "content" | "progress">): string {
  if (!message.progress) return message.content;
  return message.content ? `${message.progress}\n${message.content}` : message.progress;
}

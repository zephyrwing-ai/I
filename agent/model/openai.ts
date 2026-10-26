/**
 * OpenAI 兼容协议适配器（DeepSeek / 任何 OpenAI 兼容 API）
 *
 * 调 /chat/completions 流式接口（stream: true），Tool Calling 模式。
 * 流式格式:
 *   choices[0].delta.content            ← 正文增量
 *   choices[0].delta.reasoning_content  ← DeepSeek 思考增量（非 OpenAI 标准字段）
 *   choices[0].delta.tool_calls[i]      ← 工具调用分片（按 index 聚合，arguments 为 JSON 片段）
 *
 * 思考的两种形态都在适配层归入 reasoning 通道（不回传 UI 正文；后续请求按 Provider 能力回传）：
 *   1) reasoning_content 字段 → reasoning_delta；
 *   2) 夹带在正文里的 <thinking>…</thinking> 与 </| | DSML | | parameter> 标记 → stripStreamThinking 剥离。
 *
 * DeepSeek 使用方式:
 *   设 baseURL="https://api.deepseek.com"，model="deepseek-chat" / "deepseek-reasoner"
 */

import OpenAI from "openai";
import { serializeAssistantText } from "./assistant-text.js";
import { ModelAdapterError, type ModelMessage, type ModelImage, type ResolveAttachmentImages, type ModelStopReason, type ModelStreamEvent, type ModelUsage, type ToolCall, type ToolDef } from "./types.js";
import { attachmentImageKey, modelInputText } from "./attachment-input.js";

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
  apiKey?: string;    // 不传则从 DEEPSEEK_API_KEY 或 OPENAI_API_KEY 环境变量读取
  apiKeyProvider?: () => Promise<string>;
  model?: string;     // 默认 "deepseek-chat"
  /** DeepSeek 等 Provider 使用的 assistant 思考字段；未声明时不添加非标准字段。 */
  reasoningField?: "reasoning_content";
  maxOutputTokens?: number;
  maxOutputParameter?: "max_tokens" | "max_completion_tokens";
  streamUsage?: boolean;
  resolveAttachmentImages?: ResolveAttachmentImages;
  inputModalities?: Array<"text" | "image">;
}

export function toOpenAIMessages(
  messages: ModelMessage[],
  system: string,
  reasoningField?: "reasoning_content",
  attachmentImages: ReadonlyMap<string, ModelImage[]> = new Map(),
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  let toolImages: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  const flushToolImages = (): void => {
    if (toolImages.length) result.push({ role: "user", content: toolImages });
    toolImages = [];
  };
  for (const message of messages) {
    if (message.role !== "tool") flushToolImages();
    if (message.role === "tool") {
      result.push({ role: "tool", tool_call_id: message.toolCallId ?? "unknown", content: message.content });
      if (message.media) toolImages.push(
        { type: "text", text: `Image returned by tool ${message.toolName ?? ""}, call ${message.toolCallId ?? "unknown"}:` },
        { type: "image_url", image_url: { url: message.media.dataUrl } },
      );
      continue;
    }
    if (message.role === "assistant") {
      const assistant: Record<string, unknown> = {
        role: "assistant",
        content: serializeAssistantText(message) || null,
      };
      if (reasoningField && message.reasoning) assistant[reasoningField] = message.reasoning;
      if (message.toolCalls?.length) {
        assistant.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        }));
      }
      result.push(assistant as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      continue;
    }
    const text = modelInputText(message);
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = text ? [{ type: "text", text }] : [];
    if (message.media) content.push({ type: "image_url", image_url: { url: message.media.dataUrl } });
    for (const attachment of message.attachments ?? []) {
      const images = attachmentImages.get(attachmentImageKey(attachment)) ?? [];
      if (images.length !== attachment.imageLabels.length) throw new ModelAdapterError("config", `Attachment images could not be prepared: ${attachment.name}`);
      for (const [index, image] of images.entries()) content.push(
        { type: "text", text: `${attachment.name}: ${attachment.imageLabels[index]}` },
        { type: "image_url", image_url: { url: image.dataUrl } },
      );
    }
    result.push({ role: "user", content: content.some((part) => part.type === "image_url") ? content : text });
  }
  flushToolImages();
  return result;
}

/** Resolve only the images kept by context projection; never silently drop visual input. */
export async function prepareAttachmentImages(messages: ModelMessage[], config: Pick<OpenAIConfig, "resolveAttachmentImages" | "inputModalities">, signal?: AbortSignal): Promise<Map<string, ModelImage[]>> {
  const images = new Map<string, ModelImage[]>();
  const hasImages = messages.some((message) => message.media || message.attachments?.some((item) => item.imageLabels.length));
  if (hasImages && config.inputModalities && !config.inputModalities.includes("image")) throw new ModelAdapterError("config", "This model accepts text only. Choose a vision-capable model for image attachments.");
  for (const message of messages) for (const attachment of message.attachments ?? []) {
    const key = attachmentImageKey(attachment);
    if (!attachment.imageLabels.length || images.has(key)) continue;
    if (signal?.aborted) throw new ModelAdapterError("network", "Attachment preparation was cancelled.");
    if (!config.resolveAttachmentImages) throw new ModelAdapterError("config", "The attachment storage is unavailable for this model request.");
    images.set(key, await config.resolveAttachmentImages(attachment, signal));
  }
  return images;
}

const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

/**
 * 流式剥离正文中夹带的思考标记（<thinking>…</thinking>、孤立 thinking 标签、</| | DSML | | parameter> 等）。
 * 分片可能切断标签（"<thin" + "king>"），因此未闭合的 "<…" 尾部会暂扣为 pending，
 * 等下一片段拼回再处理；流结束时 endOfStream=true 收尾。剥离出的思考内容返回 thinking，
 * 由调用方归入 reasoning 通道，主体不进入正文展示。
 */
export function stripStreamThinking(
  chunk: string,
  held: string,
  endOfStream: boolean,
): { text: string; thinking: string; pending: string } {
  let rest = held + chunk;
  let text = "";
  const parts: string[] = [];
  let pending = "";

  while (rest.length > 0) {
    // 未闭合的 <thinking> 块：等待 </thinking>，整块暂扣不进入展示
    if (rest.startsWith(THINKING_OPEN)) {
      const close = rest.indexOf(THINKING_CLOSE, THINKING_OPEN.length);
      if (close === -1) {
        pending = rest;
        break;
      }
      parts.push(rest.slice(THINKING_OPEN.length, close));
      rest = rest.slice(close + THINKING_CLOSE.length);
      continue;
    }
    // 尾部可能是被切断的标签（最后一个 "<" 之后没有 ">"）：暂扣待补齐
    const cut = rest.lastIndexOf("<");
    if (cut >= 0 && rest.indexOf(">", cut) === -1) {
      pending = rest.slice(cut);
      rest = rest.slice(0, cut);
    }
    if (rest.length === 0) break;
    // 正文里出现打开未闭合的 <thinking>：从该标签起整块扣住
    const open = rest.indexOf(THINKING_OPEN);
    if (open !== -1) {
      const close = rest.indexOf(THINKING_CLOSE, open);
      if (close !== -1) {
        parts.push(rest.slice(open + THINKING_OPEN.length, close));
        rest = rest.slice(0, open) + rest.slice(close + THINKING_CLOSE.length);
        continue;
      }
      pending = rest.slice(open) + pending;
      rest = rest.slice(0, open);
    }
    if (rest.length === 0) break;
    text += rest.replace(/<\/?thinking>/g, "").replace(/<[^>]*DSML[^>]*>/g, "");
    break;
  }

  // 流结束：暂扣碎片不再等待补齐 —— 思考块归入 thinking，散落标记碎片丢弃，其余按文本收尾
  if (endOfStream && pending) {
    if (pending.startsWith(THINKING_OPEN)) {
      parts.push(pending.slice(THINKING_OPEN.length).replace(/<\/?thinking>/g, "").replace(/<[^>]*DSML[^>]*>/g, ""));
    } else if (/^<\/?thinking|<[^>]*DSML|<\|/.test(pending)) {
      // 孤立/散落的 thinking 或 DSML 标记碎片，丢弃
    } else {
      text += pending;
    }
  }
  return { text, thinking: parts.join("\n"), pending };
}

/**
 * 流式解析 DeepSeek/OpenAI 兼容响应：reasoning_content → reasoning_delta，
 * content 经夹带思考剥离 → text_delta，
 * 工具调用分片在流结束后聚合为 completed。
 */
export async function* streamOpenAI(
  messages: ModelMessage[],
  tools: ToolDef[],
  config: OpenAIConfig = {},
  system = "",
  signal?: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
  if (config.maxOutputTokens !== undefined && (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0)) {
    throw new ModelAdapterError("config", "The model output token limit must be a positive integer.");
  }
  const apiKey = config.apiKeyProvider
    ? await config.apiKeyProvider()
    : config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ModelAdapterError(
      "config",
      "No API Key provided. Enter it in the desktop Settings panel, or set the DEEPSEEK_API_KEY / OPENAI_API_KEY environment variable.",
    );
  }
  const client = new OpenAI({
    baseURL: config.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    apiKey,
  });
  const outputParameter = config.maxOutputParameter
    ?? (new URL(client.baseURL).hostname === "api.openai.com" ? "max_completion_tokens" : "max_tokens");
  const attachmentImages = await prepareAttachmentImages(messages, config, signal);

  let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
  try {
    stream = await client.chat.completions.create({
      model: config.model ?? "deepseek-chat",
      messages: toOpenAIMessages(messages, system, config.reasoningField, attachmentImages),
      tools: tools.map(toOpenAITool),
      stream: true,
      ...(config.streamUsage === false ? {} : { stream_options: { include_usage: true } }),
      ...(config.maxOutputTokens === undefined ? {} : { [outputParameter]: config.maxOutputTokens }),
    }, { signal });
  } catch (error) {
    throw normalizeOpenAIError(error, signal);
  }

  let content = "";
  let reasoning = "";
  let held = "";
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: string | null = null;
  let usage: ModelUsage | undefined;
  let streamError: ModelAdapterError | undefined;

  try {
    for await (const chunk of stream) {
      const reportedUsage = normalizeOpenAIUsage(chunk.usage);
      if (reportedUsage) usage = { ...usage, ...reportedUsage };
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      const reasoningDelta = (delta as { reasoning_content?: string }).reasoning_content;
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        yield { type: "reasoning_delta", delta: reasoningDelta };
      }
      if (delta.content) {
        // 正文夹带的思考标记在适配层剥离：思考归入 reasoning 通道，正文保持干净。
        const cleaned = stripStreamThinking(delta.content, held, false);
        if (cleaned.thinking) {
          reasoning += cleaned.thinking;
          yield { type: "reasoning_delta", delta: cleaned.thinking };
        }
        if (cleaned.text) {
          content += cleaned.text;
          yield { type: "text_delta", delta: cleaned.text };
        }
        held = cleaned.pending;
      }
      for (const part of delta.tool_calls ?? []) {
        const acc = toolAcc.get(part.index) ?? { id: part.id ?? "", name: part.function?.name ?? "", arguments: "" };
        if (part.id) acc.id = part.id;
        if (part.function?.name) acc.name = part.function.name;
        if (part.function?.arguments) acc.arguments += part.function.arguments;
        toolAcc.set(part.index, acc);
      }
    }
  } catch (error) {
    streamError = normalizeOpenAIError(error, signal);
  }

  // Flush withheld thinking/text before completion or a stream error so
  // interrupted attempts persist the same body delivered by the Provider.
  const tail = stripStreamThinking("", held, true);
  if (tail.thinking) {
    reasoning += tail.thinking;
    yield { type: "reasoning_delta", delta: tail.thinking };
  }
  if (tail.text) {
    content += tail.text;
    yield { type: "text_delta", delta: tail.text };
  }
  if (streamError) throw streamError;

  if (finishReason === null) {
    throw new ModelAdapterError("model_protocol", "The model stream ended without a finish_reason.", true);
  }

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc]) => {
      try {
        const input: unknown = JSON.parse(acc.arguments || "{}");
        if (input && typeof input === "object" && !Array.isArray(input)) {
          return { id: acc.id, name: acc.name, input: input as Record<string, unknown>, inputComplete: finishReason !== "length" };
        }
      } catch {
        // 参数被截断或非法 JSON：按空参数处理并标记 inputComplete=false
      }
      return { id: acc.id, name: acc.name, input: {}, inputComplete: false };
    });

  const stopReason = normalizeStopReason(finishReason);
  yield { type: "completed", content, reasoning: reasoning || undefined, toolCalls, stopReason, rawStopReason: finishReason ?? undefined, ...(usage ? { usage } : {}) };
}

export function normalizeOpenAIUsage(value: unknown): ModelUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reported = value as Record<string, unknown>;
  const usage: ModelUsage = {};
  const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (count(reported.prompt_tokens)) usage.inputTokens = reported.prompt_tokens;
  if (count(reported.completion_tokens)) usage.outputTokens = reported.completion_tokens;
  if (count(reported.total_tokens)) usage.totalTokens = reported.total_tokens;
  const details = reported.prompt_tokens_details;
  const cached = details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>).cached_tokens
    : undefined;
  const cachedInput = cached ?? reported.prompt_cache_hit_tokens;
  if (count(cachedInput) && (usage.inputTokens === undefined || cachedInput <= usage.inputTokens)) usage.cachedInputTokens = cachedInput;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function normalizeStopReason(value: string): ModelStopReason {
  if (value === "tool_calls" || value === "function_call") return "tool_use";
  if (value === "length") return "length";
  if (value === "content_filter") return "content_filter";
  if (value === "stop") return "stop";
  return "unknown";
}

function normalizeOpenAIError(error: unknown, signal?: AbortSignal): ModelAdapterError {
  if (signal?.aborted) return new ModelAdapterError("network", "The model request was cancelled.", false);
  if (error instanceof ModelAdapterError) return error;
  const value = error as { status?: unknown; code?: unknown; message?: unknown; error?: { code?: unknown } } | null;
  const status = typeof value?.status === "number" ? value.status : undefined;
  const code = typeof value?.code === "string" ? value.code : typeof value?.error?.code === "string" ? value.error.code : "";
  const message = typeof value?.message === "string" ? value.message : String(error);
  if (["context_length_exceeded", "context_window_exceeded", "maximum_context_length_exceeded"].includes(code)
    || (status === 400 && /maximum context length|context (?:length|window).{0,60}(?:exceed|too (?:long|large))|(?:exceed|too (?:long|large)).{0,60}context (?:length|window)/i.test(message))) {
    return new ModelAdapterError("context_overflow", message);
  }
  const retryable = status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)
    || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code);
  const kind = status === undefined && code ? "network" : "provider";
  return new ModelAdapterError(kind, message, retryable);
}

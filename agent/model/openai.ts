/**
 * OpenAI 兼容协议适配器（DeepSeek / 任何 OpenAI 兼容 API）
 *
 * 调 /chat/completions 流式接口（stream: true），Tool Calling 模式。
 * 流式格式:
 *   choices[0].delta.content            ← 正文增量
 *   choices[0].delta.reasoning_content  ← DeepSeek 思考增量（非 OpenAI 标准字段）
 *   choices[0].delta.tool_calls[i]      ← 工具调用分片（按 index 聚合，arguments 为 JSON 片段）
 *
 * 思考的两种形态都在适配层归入 reasoning 通道（不回传 UI 正文；后续请求按 string-thinking 方案回传）：
 *   1) reasoning_content 字段 → reasoning_delta；
 *   2) 夹带在正文里的 <thinking>…</thinking> 与 </| | DSML | | parameter> 标记 → stripStreamThinking 剥离。
 *
 * DeepSeek 使用方式:
 *   设 baseURL="https://api.deepseek.com"，model="deepseek-chat" / "deepseek-reasoner"
 */

import OpenAI from "openai";
import type { ModelMessage, ModelStopReason, ModelStreamEvent, ToolCall, ToolDef } from "./types.js";

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
  model?: string;     // 默认 "deepseek-chat"
}

function toOpenAIMessages(messages: ModelMessage[], system: string): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return [
    { role: "system", content: system },
    ...messages.map((message): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
      if (message.role === "tool") {
        // 图片类工具结果走多模态内容数组：文本 + 图片部分一起回填模型。
        // SDK 的 ToolMessage content 类型只声明了文本部分，图片部分随 API 支持，这里绕过类型收窄。
        const content: OpenAI.Chat.Completions.ChatCompletionMessageParam["content"] = message.media
          ? ([
              { type: "text" as const, text: message.content },
              { type: "image_url" as const, image_url: { url: message.media.dataUrl } },
            ] as unknown as string)
          : message.content;
        return { role: "tool", tool_call_id: message.toolCallId ?? "unknown", content };
      }
      if (message.role === "assistant") {
        // 思考回传：Anthropic 用 signature 回放；OpenAI 兼容协议没有标准字段，
        // 采用 string-thinking 方案——拼成 <thinking> 文本随消息一起回传。
        const text = message.reasoning
          ? `<thinking>\n${message.reasoning}\n</thinking>${message.content ? `\n${message.content}` : ""}`
          : message.content;
        if (message.toolCalls?.length) {
          return {
            role: "assistant",
            content: text || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          };
        }
        return { role: "assistant", content: text };
      }
      return { role: message.role, content: message.content };
    }),
  ];
}

const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

/**
 * 流式剥离正文中夹带的思考标记（<thinking>…</thinking>、孤立 thinking 标签、</| | DSML | | parameter> 等）。
 * 分片可能切断标签（"<thin" + "king>"），因此未闭合的 "<…" 尾部会暂扣为 pending，
 * 等下一片段拼回再处理；流结束时 endOfStream=true 收尾。剥离出的思考内容返回 thinking，
 * 由调用方归入 reasoning 通道（供 string-thinking 回传），主体不进入正文展示。
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
 * content → text_delta，工具调用分片在流结束后聚合为 completed。
 */
export async function* streamOpenAI(
  messages: ModelMessage[],
  tools: ToolDef[],
  config: OpenAIConfig = {},
  system = "",
  signal?: AbortSignal,
): AsyncGenerator<ModelStreamEvent> {
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

  const stream = await client.chat.completions.create({
    model: config.model ?? "deepseek-chat",
    messages: toOpenAIMessages(messages, system),
    tools: tools.map(toOpenAITool),
    stream: true,
  }, { signal });

  let content = "";
  let reasoning = "";
  let held = "";
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: string | null = null;

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    const reasoningDelta = (delta as { reasoning_content?: string }).reasoning_content;
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      yield { type: "reasoning_delta", delta: reasoningDelta };
    }
    if (delta.content) {
      // 正文夹带的思考标记在适配层剥离：思考归入 reasoning 通道保留，正文保持干净
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

  // 流结束收尾：暂扣的思考块与标记碎片此后不再等待补齐
  const tail = stripStreamThinking("", held, true);
  if (tail.thinking) reasoning += tail.thinking;
  if (tail.text) content += tail.text;

  const stopReason: ModelStopReason = finishReason === "tool_calls" ? "tool_use" : finishReason === "length" ? "length" : "stop";
  yield { type: "completed", content, reasoning: reasoning || undefined, toolCalls, stopReason, rawStopReason: finishReason ?? undefined };
}

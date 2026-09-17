import OpenAI from "openai";
import { M as ModelAdapterError } from "./index.js";
function toOpenAITool(t) {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  };
}
function toOpenAIMessages(messages, system, reasoningField) {
  return [
    { role: "system", content: system },
    ...messages.map((message) => {
      if (message.role === "tool") {
        const content = message.media ? [
          { type: "text", text: message.content },
          { type: "image_url", image_url: { url: message.media.dataUrl } }
        ] : message.content;
        return { role: "tool", tool_call_id: message.toolCallId ?? "unknown", content };
      }
      if (message.role === "assistant") {
        const assistant = {
          role: "assistant",
          content: message.content || null
        };
        if (reasoningField && message.reasoning) assistant[reasoningField] = message.reasoning;
        if (message.toolCalls?.length) {
          assistant.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.input) }
          }));
        }
        return assistant;
      }
      return { role: message.role, content: message.content };
    })
  ];
}
const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";
function stripStreamThinking(chunk, held, endOfStream) {
  let rest = held + chunk;
  let text = "";
  const parts = [];
  let pending = "";
  while (rest.length > 0) {
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
    const cut = rest.lastIndexOf("<");
    if (cut >= 0 && rest.indexOf(">", cut) === -1) {
      pending = rest.slice(cut);
      rest = rest.slice(0, cut);
    }
    if (rest.length === 0) break;
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
  if (endOfStream && pending) {
    if (pending.startsWith(THINKING_OPEN)) {
      parts.push(pending.slice(THINKING_OPEN.length).replace(/<\/?thinking>/g, "").replace(/<[^>]*DSML[^>]*>/g, ""));
    } else if (/^<\/?thinking|<[^>]*DSML|<\|/.test(pending)) ;
    else {
      text += pending;
    }
  }
  return { text, thinking: parts.join("\n"), pending };
}
async function* streamOpenAI(messages, tools, config = {}, system = "", signal) {
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ModelAdapterError(
      "config",
      "未提供 API Key。请在桌面端「设置」面板填入，或设置 DEEPSEEK_API_KEY / OPENAI_API_KEY 环境变量。"
    );
  }
  const client = new OpenAI({
    baseURL: config.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    apiKey
  });
  let stream;
  try {
    stream = await client.chat.completions.create({
      model: config.model ?? "deepseek-chat",
      messages: toOpenAIMessages(messages, system, config.reasoningField),
      tools: tools.map(toOpenAITool),
      stream: true
    }, { signal });
  } catch (error) {
    throw normalizeOpenAIError(error, signal);
  }
  let content = "";
  let reasoning = "";
  let held = "";
  const toolAcc = /* @__PURE__ */ new Map();
  let finishReason = null;
  try {
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason !== null && choice.finish_reason !== void 0) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      const reasoningDelta = delta.reasoning_content;
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        yield { type: "reasoning_delta", delta: reasoningDelta };
      }
      if (delta.content) {
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
    throw normalizeOpenAIError(error, signal);
  }
  if (finishReason === null) {
    throw new ModelAdapterError("model_protocol", "模型流结束时缺少 finish_reason。", true);
  }
  const toolCalls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, acc]) => {
    try {
      const input = JSON.parse(acc.arguments || "{}");
      if (input && typeof input === "object" && !Array.isArray(input)) {
        return { id: acc.id, name: acc.name, input, inputComplete: finishReason !== "length" };
      }
    } catch {
    }
    return { id: acc.id, name: acc.name, input: {}, inputComplete: false };
  });
  const tail = stripStreamThinking("", held, true);
  if (tail.thinking) reasoning += tail.thinking;
  if (tail.text) content += tail.text;
  const stopReason = normalizeStopReason(finishReason);
  yield { type: "completed", content, reasoning: reasoning || void 0, toolCalls, stopReason, rawStopReason: finishReason ?? void 0 };
}
function normalizeStopReason(value) {
  if (value === "tool_calls" || value === "function_call") return "tool_use";
  if (value === "length") return "length";
  if (value === "content_filter") return "content_filter";
  if (value === "stop") return "stop";
  return "unknown";
}
function normalizeOpenAIError(error, signal) {
  if (signal?.aborted) return new ModelAdapterError("network", "模型请求已取消。", false);
  if (error instanceof ModelAdapterError) return error;
  const value = error;
  const status = typeof value?.status === "number" ? value.status : void 0;
  const code = typeof value?.code === "string" ? value.code : "";
  const retryable = status === 408 || status === 409 || status === 429 || status !== void 0 && status >= 500 || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code);
  const kind = status === void 0 && code ? "network" : "provider";
  return new ModelAdapterError(kind, typeof value?.message === "string" ? value.message : String(error), retryable);
}
export {
  streamOpenAI,
  stripStreamThinking,
  toOpenAIMessages
};

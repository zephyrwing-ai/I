/**
 * Google Gemini provider
 *
 * 调 Gemini API (generateContent)，Tool Calling 模式。
 * 返回格式:
 *   candidates[0].content.parts[i].functionCall.name
 *   candidates[0].content.parts[i].functionCall.args  ← 已解析的 JSON 对象，不需要 parse
 */

import { GoogleGenAI } from "@google/genai";
import type { ToolDef, LlmResponse } from "./types.js";

function toGeminiTool(t: ToolDef) {
  return {
    functionDeclarations: [{
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }],
  };
}

export async function queryGoogle(
  messages: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }>,
  system: string,
  tools: ToolDef[],
  model: string = "gemini-2.5-flash",
): Promise<LlmResponse> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });

  const resp = await ai.models.generateContent({
    model,
    config: {
      systemInstruction: system,
      tools: tools.map(toGeminiTool),
    },
    contents: messages,
  });

  const actions: Array<{ command: string }> = [];
  const textParts: string[] = [];

  for (const part of resp.candidates?.[0]?.content?.parts ?? []) {
    if (part.text) {
      textParts.push(part.text);
    } else if (part.functionCall) {
      if (part.functionCall.name === "bash" && part.functionCall.args) {
        const args = part.functionCall.args as Record<string, unknown>;
        if (typeof args.command === "string") {
          actions.push({ command: args.command });
        }
      }
    }
  }

  return { content: textParts.join("\n"), actions };
}

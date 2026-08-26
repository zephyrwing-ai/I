/** 统一的工具定义 — 所有 provider 都用这个格式 */

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** 统一的 LLM 返回 — agent 循环只认这个格式 */
export interface LlmResponse {
  content: string;
  actions: Array<{ command: string }>;
}

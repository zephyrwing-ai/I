import type { Provider } from "../../../shell/shared/ipc";

/** 顶级运行设置 — Toolbar 与 ConfigPanel 共用，由 App 统一持有。 */
export interface RunSettings {
  provider: Provider;
  model: string;
  baseURL: string;
  apiKey: string;
  useDocker: boolean;
  stepLimit: number;
  cwd: string;
}

export const DEFAULT_SETTINGS: RunSettings = {
  provider: "openai",
  model: "deepseek-chat",
  baseURL: "https://api.deepseek.com",
  apiKey: "",
  useDocker: false,
  stepLimit: 20,
  cwd: "",
};

export const PROVIDERS: Record<Provider, { label: string; defaultModel: string; baseURL: string }> = {
  openai: { label: "OpenAI / DeepSeek", defaultModel: "deepseek-chat", baseURL: "https://api.deepseek.com" },
  anthropic: { label: "Anthropic (Claude)", defaultModel: "claude-sonnet-4-20250514", baseURL: "" },
  google: { label: "Google (Gemini)", defaultModel: "gemini-2.5-flash", baseURL: "" },
};

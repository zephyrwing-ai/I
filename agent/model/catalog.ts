import type { ModelCapabilities } from "./types.js";

type Limits = readonly [contextWindowTokens: number, maxOutputTokens: number];

// Verified 2026-10-19 against each exact model's page under https://developers.openai.com/api/docs/models/.
// Family limits: https://developers.openai.com/api/docs/models/gpt-4.1 and https://developers.openai.com/api/docs/models/gpt-5
const OPENAI_MODELS = new Map<string, Limits>([
  ["gpt-4.1", [1_047_576, 32_768]],
  ["gpt-4.1-mini", [1_047_576, 32_768]],
  ["gpt-4.1-nano", [1_047_576, 32_768]],
  ["gpt-5", [400_000, 128_000]],
  ["gpt-5-mini", [400_000, 128_000]],
  ["gpt-5-nano", [400_000, 128_000]],
  ["gpt-5.1", [400_000, 128_000]],
  ["gpt-5.2", [400_000, 128_000]],
  ["gpt-5.3-codex", [400_000, 128_000]],
]);

// Verified 2026-10-19: https://api-docs.deepseek.com/quick_start/pricing/
// Exact 1M window: https://api-docs.deepseek.com/quick_start/agent_integrations/codex/
const DEEPSEEK_MODELS = new Map<string, Limits>([
  ["deepseek-flash", [1_048_576, 393_216]],
  ["deepseek-v4-pro", [1_048_576, 393_216]],
]);

export function lookupModelCapabilities(baseURL: string | undefined, modelId: string): ModelCapabilities | undefined {
  let endpoint: URL;
  try {
    endpoint = new URL(baseURL ?? "https://api.deepseek.com");
  } catch {
    return undefined;
  }
  if (endpoint.protocol !== "https:" || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return undefined;

  const path = endpoint.pathname.replace(/\/$/, "");
  let models: ReadonlyMap<string, Limits> | undefined;
  if (endpoint.hostname === "api.openai.com" && (path === "" || path === "/v1")) models = OPENAI_MODELS;
  if (endpoint.hostname === "api.deepseek.com" && (path === "" || path === "/v1" || path === "/beta")) models = DEEPSEEK_MODELS;
  const limits = models?.get(modelId);
  return limits ? { contextWindowTokens: limits[0], maxOutputTokens: limits[1], source: "catalog" } : undefined;
}

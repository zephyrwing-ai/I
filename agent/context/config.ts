import { ModelAdapterError, type ModelCapabilities, type ModelContextConfig } from "../model/index.js";
import { resolveContextPolicy } from "./policy.js";

const ENVIRONMENT_FIELDS: Record<keyof ModelContextConfig, string> = {
  windowTokens: "I_CONTEXT_WINDOW_TOKENS",
  outputReserveTokens: "I_CONTEXT_OUTPUT_RESERVE_TOKENS",
  safetyTokens: "I_CONTEXT_SAFETY_TOKENS",
  growthTokens: "I_CONTEXT_GROWTH_TOKENS",
  recentTokens: "I_CONTEXT_RECENT_TOKENS",
  summaryTokens: "I_CONTEXT_SUMMARY_TOKENS",
};

export function loadContextPolicy(environment: Record<string, string | undefined> = process.env, capabilities?: ModelCapabilities): ModelContextConfig {
  const overrides: Partial<ModelContextConfig> = {};
  for (const [field, variable] of Object.entries(ENVIRONMENT_FIELDS) as Array<[keyof ModelContextConfig, string]>) {
    const raw = environment[variable];
    if (raw === undefined) continue;
    const text = raw.trim();
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) {
      throw new ModelAdapterError("config", `${variable} must be a non-negative safe integer.`);
    }
    overrides[field] = value;
  }
  return resolveContextPolicy(overrides, capabilities);
}

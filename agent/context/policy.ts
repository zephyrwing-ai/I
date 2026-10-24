import { ModelAdapterError, type ModelCapabilities } from "../model/types.js";
import type { ModelContextConfig } from "../model/index.js";

export const DEFAULT_CONTEXT_POLICY: Readonly<ModelContextConfig> = Object.freeze({
  windowTokens: 32_768,
  outputReserveTokens: 4_096,
  safetyTokens: 2_048,
  growthTokens: 8_192,
  recentTokens: 8_192,
  summaryTokens: 2_048,
});

export function contextInputLimit(policy: ModelContextConfig, capabilities?: ModelCapabilities): number {
  return Math.min(policy.windowTokens - policy.outputReserveTokens, capabilities?.maxInputTokens ?? Infinity) - policy.safetyTokens;
}

export function resolveContextPolicy(overrides?: Partial<ModelContextConfig>, capabilities?: ModelCapabilities): ModelContextConfig {
  if (capabilities) {
    if (!["provider", "catalog", "manual"].includes(capabilities.source)) {
      throw new ModelAdapterError("config", "Model capabilities require a known source.");
    }
    for (const field of ["contextWindowTokens", "maxInputTokens", "maxOutputTokens"] as const) {
      const value = capabilities[field];
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new ModelAdapterError("config", `Model capability ${field} must be a positive safe integer.`);
      }
    }
    if (!Number.isSafeInteger(capabilities.contextWindowTokens) || capabilities.contextWindowTokens < 1) {
      throw new ModelAdapterError("config", "Model context window must be a positive safe integer.");
    }
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!Number.isSafeInteger(value) || value < (name === "safetyTokens" ? 0 : 1)) {
      throw new ModelAdapterError("config", `Context ${name} must be a positive safe integer.`);
    }
  }
  const windowTokens = Math.min(overrides?.windowTokens ?? capabilities?.contextWindowTokens ?? DEFAULT_CONTEXT_POLICY.windowTokens,
    capabilities?.contextWindowTokens ?? Infinity);
  const adaptive = capabilities !== undefined || overrides?.windowTokens !== undefined;
  const outputCap = Math.min(capabilities?.maxOutputTokens ?? Infinity, windowTokens - 1);
  const outputReserveTokens = Math.min(overrides?.outputReserveTokens
    ?? (adaptive ? Math.max(1, Math.min(16_384, Math.floor(windowTokens / 16))) : DEFAULT_CONTEXT_POLICY.outputReserveTokens), outputCap);
  const safetyTokens = overrides?.safetyTokens
    ?? (adaptive ? Math.max(0, Math.min(16_384, Math.floor(windowTokens / 16), Math.floor((capabilities?.maxInputTokens ?? windowTokens) / 16))) : DEFAULT_CONTEXT_POLICY.safetyTokens);
  const inputLimit = Math.min(windowTokens - outputReserveTokens, capabilities?.maxInputTokens ?? Infinity) - safetyTokens;
  const summaryTokens = Math.min(overrides?.summaryTokens
    ?? (adaptive ? Math.max(1, Math.min(8_192, Math.floor(windowTokens / 64), Math.floor(inputLimit / 8))) : DEFAULT_CONTEXT_POLICY.summaryTokens), outputCap);
  const policy: ModelContextConfig = {
    windowTokens, outputReserveTokens, safetyTokens, summaryTokens,
    growthTokens: overrides?.growthTokens ?? (adaptive
      ? Math.max(1, Math.min(Math.floor(windowTokens / 2), inputLimit - 1)) : DEFAULT_CONTEXT_POLICY.growthTokens),
    recentTokens: overrides?.recentTokens ?? (adaptive
      ? Math.max(1, Math.min(64_000, Math.floor(windowTokens * 0.15), inputLimit - summaryTokens - 1)) : DEFAULT_CONTEXT_POLICY.recentTokens),
  };
  if (outputReserveTokens < 1 || summaryTokens < 1 || inputLimit <= 1
    || policy.growthTokens >= inputLimit || policy.recentTokens + summaryTokens >= inputLimit) {
    throw new ModelAdapterError("config", "Context reserves and retention budgets must leave space inside the model's input limits.");
  }
  return policy;
}

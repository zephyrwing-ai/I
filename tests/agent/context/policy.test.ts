import assert from "node:assert/strict";
import test from "node:test";
import { loadContextPolicy } from "../../../agent/context/config.js";
import { contextInputLimit, DEFAULT_CONTEXT_POLICY, resolveContextPolicy } from "../../../agent/context/policy.js";
import type { ModelCapabilities } from "../../../agent/model/types.js";

const capabilities = (contextWindowTokens: number, extra: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  contextWindowTokens, maxOutputTokens: 32_768, source: "provider", ...extra,
});

test("model windows produce distinct growth thresholds and complete-input limits", () => {
  const smaller = resolveContextPolicy(undefined, capabilities(131_072));
  const larger = resolveContextPolicy(undefined, capabilities(262_144));
  assert.equal(smaller.growthTokens, 65_536);
  assert.equal(contextInputLimit(smaller), 114_688);
  assert.equal(larger.growthTokens, 131_072);
  assert.equal(contextInputLimit(larger), 229_376);
  assert.ok(larger.recentTokens > smaller.recentTokens);
  assert.ok(larger.summaryTokens > smaller.summaryTokens);
});

test("request output and summary reserves respect model output ceilings", () => {
  const caps = capabilities(131_072, { maxOutputTokens: 1024 });
  const policy = resolveContextPolicy({ outputReserveTokens: 9000, summaryTokens: 4000 }, caps);
  assert.equal(policy.outputReserveTokens, 1024);
  assert.equal(policy.summaryTokens, 1024);
  assert.ok(contextInputLimit(policy, caps) + policy.outputReserveTokens + policy.safetyTokens <= caps.contextWindowTokens);
});

test("separate provider input limits constrain task and summary budgets", () => {
  const caps = capabilities(1_048_576, { maxInputTokens: 16_384 });
  const policy = resolveContextPolicy(undefined, caps);
  const limit = contextInputLimit(policy, caps);
  assert.ok(limit > 0 && limit < caps.maxInputTokens!);
  assert.ok(policy.growthTokens < limit);
  assert.ok(policy.recentTokens + policy.summaryTokens < limit);
  assert.ok(contextInputLimit({ ...policy, outputReserveTokens: policy.summaryTokens }, caps) <= caps.maxInputTokens!);
});

test("explicit configuration overrides automatic values while retaining model hard limits", () => {
  const caps = capabilities(131_072);
  const policy = loadContextPolicy({
    I_CONTEXT_WINDOW_TOKENS: "262144", I_CONTEXT_GROWTH_TOKENS: "40000", I_CONTEXT_SAFETY_TOKENS: "1000",
  }, caps);
  assert.equal(policy.windowTokens, caps.contextWindowTokens);
  assert.equal(policy.growthTokens, 40_000);
  assert.equal(policy.safetyTokens, 1000);
  const reduced = resolveContextPolicy({ windowTokens: 65_536 }, caps);
  assert.equal(reduced.windowTokens, 65_536);
  assert.equal(reduced.growthTokens, 32_768);
});

test("a declared window alone enables derived budgets and unknown models retain the fallback", () => {
  assert.deepEqual(resolveContextPolicy(), DEFAULT_CONTEXT_POLICY);
  const configured = loadContextPolicy({ I_CONTEXT_WINDOW_TOKENS: "131072" });
  assert.equal(configured.growthTokens, 65_536);
  assert.equal(contextInputLimit(configured), 114_688);
});

test("invalid capability numbers and incompatible explicit budgets fail as configuration errors", () => {
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => resolveContextPolicy(undefined, capabilities(value)), /context|capability/i);
    assert.throws(() => resolveContextPolicy(undefined, capabilities(131_072, { maxInputTokens: value })), /capability/i);
  }
  assert.throws(() => resolveContextPolicy({ growthTokens: 120_000 }, capabilities(131_072)), /input limits/);
  assert.throws(() => resolveContextPolicy({ safetyTokens: 131_072 }, capabilities(131_072)), /input limits/);
});

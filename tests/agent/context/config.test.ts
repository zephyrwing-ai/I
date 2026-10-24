import assert from "node:assert/strict";
import test from "node:test";
import { loadContextPolicy } from "../../../agent/context/config.js";
import { DEFAULT_CONTEXT_POLICY } from "../../../agent/context/policy.js";
import { ModelAdapterError } from "../../../agent/model/index.js";

test("uses the shared application budget when environment overrides are absent", () => {
  const policy = loadContextPolicy({});
  for (const [field, value] of Object.entries(DEFAULT_CONTEXT_POLICY)) {
    assert.equal(policy[field as keyof typeof policy], value);
  }
});

test("reads all explicit token budgets from the environment", () => {
  const policy = loadContextPolicy({
    I_CONTEXT_WINDOW_TOKENS: " 65536 ",
    I_CONTEXT_OUTPUT_RESERVE_TOKENS: "6000",
    I_CONTEXT_SAFETY_TOKENS: "1024",
    I_CONTEXT_GROWTH_TOKENS: "12000",
    I_CONTEXT_RECENT_TOKENS: "10000",
    I_CONTEXT_SUMMARY_TOKENS: "2000",
  });
  assert.equal(policy.windowTokens, 65536);
  assert.equal(policy.outputReserveTokens, 6000);
  assert.equal(policy.safetyTokens, 1024);
  assert.equal(policy.growthTokens, 12000);
  assert.equal(policy.recentTokens, 10000);
  assert.equal(policy.summaryTokens, 2000);
});

test("rejects malformed explicit budgets instead of silently installing defaults", () => {
  for (const value of ["", "1.5", "-1", "NaN", "Infinity", "1e5", "9007199254740992"]) {
    assert.throws(() => loadContextPolicy({ I_CONTEXT_WINDOW_TOKENS: value }),
      (error: unknown) => error instanceof ModelAdapterError && error.kind === "config" && error.message.includes("I_CONTEXT_WINDOW_TOKENS"));
  }
});

test("validates the relationship between explicitly configured budgets", () => {
  assert.throws(() => loadContextPolicy({ I_CONTEXT_WINDOW_TOKENS: "1024", I_CONTEXT_OUTPUT_RESERVE_TOKENS: "1024" }));
  assert.throws(() => loadContextPolicy({ I_CONTEXT_WINDOW_TOKENS: "1024", I_CONTEXT_GROWTH_TOKENS: "1024" }));
});

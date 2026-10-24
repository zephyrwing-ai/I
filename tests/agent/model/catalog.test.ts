import assert from "node:assert/strict";
import test from "node:test";
import { lookupModelCapabilities } from "../../../agent/model/catalog.js";

test("native OpenAI catalog distinguishes published context and output limits", () => {
  for (const model of ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"]) {
    assert.deepEqual(lookupModelCapabilities("https://api.openai.com/v1", model), {
      contextWindowTokens: 1_047_576,
      maxOutputTokens: 32_768,
      source: "catalog",
    });
  }
  for (const model of ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5.1", "gpt-5.2", "gpt-5.3-codex"]) {
    assert.deepEqual(lookupModelCapabilities("https://api.openai.com/v1/", model), {
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
      source: "catalog",
    });
  }
});

test("default adapter endpoint uses current native DeepSeek capabilities", () => {
  for (const baseURL of [undefined, "https://api.deepseek.com", "https://api.deepseek.com/v1", "https://api.deepseek.com/beta/"]) {
    for (const model of ["deepseek-flash", "deepseek-v4-pro"]) {
      assert.deepEqual(lookupModelCapabilities(baseURL, model), {
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 393_216,
        source: "catalog",
      });
    }
  }
});

test("catalog lookup requires an exact native endpoint and model identity", () => {
  for (const baseURL of [
    "https://gateway.example/v1",
    "https://api.openai.com.example/v1",
    "https://api.deepseek.com.example/v1",
    "http://api.openai.com/v1",
    "https://api.openai.com:8443/v1",
    "https://user:password@api.openai.com/v1",
    "https://api.openai.com/proxy/v1",
    "https://api.openai.com/v1?gateway=other",
    "https://api.openai.com/v1#other",
    "api.openai.com/v1",
    "",
  ]) {
    assert.equal(lookupModelCapabilities(baseURL, "gpt-5"), undefined, baseURL);
  }
  for (const model of ["gpt-5-custom", "vendor/gpt-5", "GPT-5", "gpt-5 ", "constructor", "toString"]) {
    assert.equal(lookupModelCapabilities("https://api.openai.com/v1", model), undefined, model);
  }
  assert.equal(lookupModelCapabilities("https://api.deepseek.com/v1", "gpt-5"), undefined);
  assert.equal(lookupModelCapabilities("https://api.openai.com/v1", "deepseek-flash"), undefined);
  assert.equal(lookupModelCapabilities(undefined, "gpt-5"), undefined);
  assert.equal(lookupModelCapabilities(undefined, "deepseek-chat"), undefined);
  assert.equal(lookupModelCapabilities(undefined, "deepseek-reasoner"), undefined);
});

test("returned capabilities cannot mutate the catalog for another run", () => {
  const first = lookupModelCapabilities("https://api.openai.com/v1", "gpt-5");
  assert.ok(first);
  first.contextWindowTokens = 1;
  first.maxOutputTokens = 1;
  const second = lookupModelCapabilities("https://api.openai.com/v1", "gpt-5");
  assert.notEqual(first, second);
  assert.equal(second?.contextWindowTokens, 400_000);
  assert.equal(second?.maxOutputTokens, 128_000);
});

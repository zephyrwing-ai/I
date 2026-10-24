import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import {
  ProviderDiscoveryError,
  buildModelEndpointProbes,
  discoverProviderModels,
  discoveryErrorResult,
  inferProviderFromBaseURL,
  normalizeDiscoveredModels,
} from "../../../shell/main/provider-model-discovery.js";

type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

async function withServer<T>(handler: RequestHandler, run: (baseURL: string) => Promise<T>): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("OpenAI compatible discovery paginates, normalizes and deduplicates models", async () => {
  const authorization: string[] = [];
  await withServer((request, response) => {
    authorization.push(String(request.headers.authorization));
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.searchParams.get("after") === "page-one") {
      json(response, { data: [{ id: "model-b", name: "Model B" }] });
      return;
    }
    json(response, {
      data: [
        { id: " model-a ", name: "Model A" },
        { id: "model-a", name: "Duplicate" },
        { name: "invalid" },
      ],
      has_more: true,
      last_id: "page-one",
    });
  }, async (baseURL) => {
    const models = await discoverProviderModels({ provider: "openai", baseURL: `${baseURL}/v1`, apiKey: "secret-key" });
    assert.deepEqual(models, [
      { id: "model-a", displayName: "Model A" },
      { id: "model-b", displayName: "Model B" },
    ]);
  });
  assert.deepEqual(authorization, ["Bearer secret-key", "Bearer secret-key"]);
});

test("OpenAI compatible discovery falls back to the root /models endpoint", async () => {
  const requested: string[] = [];
  await withServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requested.push(url.pathname);
    if (url.pathname === "/models") {
      json(response, {
        data: [
          { id: "deepseek-chat", name: "DeepSeek Chat" },
          { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
        ],
      });
      return;
    }
    json(response, { error: "not found" }, 404);
  }, async (baseURL) => {
    const models = await discoverProviderModels({ provider: "openai", baseURL, apiKey: "deepseek-secret" });
    assert.deepEqual(models, [
      { id: "deepseek-chat", displayName: "DeepSeek Chat" },
      { id: "deepseek-reasoner", displayName: "DeepSeek Reasoner" },
    ]);
    assert.deepEqual(requested, ["/v1/models", "/models"]);
  });
});

test("Discovery classifies authentication, invalid responses and empty results", async () => {
  for (const scenario of ["authentication", "invalid", "empty"] as const) {
    await withServer((_request, response) => {
      if (scenario === "authentication") {
        json(response, { error: "denied", apiKey: "must-not-leak" }, 401);
      } else if (scenario === "invalid") {
        json(response, { unexpected: true, apiKey: "must-not-leak" });
      } else {
        json(response, { data: [] });
      }
    }, async (baseURL) => {
      try {
        await discoverProviderModels({ provider: "openai", baseURL, apiKey: "secret-key" });
        assert.fail("expected discovery to fail");
      } catch (error) {
        assert.ok(error instanceof ProviderDiscoveryError);
        const expected = scenario === "authentication" ? "authentication" : scenario === "invalid" ? "invalid_response" : "empty";
        assert.equal(error.kind, expected);
        const result = discoveryErrorResult(error);
        assert.equal(JSON.stringify(result).includes("secret-key"), false);
        assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
      }
    });
  }
});

test("Discovery classifies unsupported endpoints and network failures", async () => {
  await withServer((_request, response) => {
    json(response, { error: "not found", apiKey: "must-not-leak" }, 404);
  }, async (baseURL) => {
    await assert.rejects(
      () => discoverProviderModels({ provider: "openai", baseURL, apiKey: "secret-key" }),
      (error: unknown) => error instanceof ProviderDiscoveryError && error.kind === "unsupported" && !error.message.includes("must-not-leak"),
    );
  });

  await assert.rejects(
    () => discoverProviderModels(
      { provider: "openai", baseURL: "https://api.example.com/v1", apiKey: "secret-key" },
      { fetchImpl: async () => { throw new Error("offline"); } },
    ),
    (error: unknown) => error instanceof ProviderDiscoveryError && error.kind === "network" && !error.message.includes("secret-key"),
  );
});

test("OpenAI compatible pagination rejects a cross-origin next link", async () => {
  await withServer((_request, response) => {
    json(response, { data: [{ id: "model-a" }], next: "https://untrusted.example/models" });
  }, async (baseURL) => {
    await assert.rejects(
      () => discoverProviderModels({ provider: "openai", baseURL, apiKey: "secret-key" }),
      (error: unknown) => error instanceof ProviderDiscoveryError
        && error.kind === "invalid_response"
        && !error.message.includes("secret-key"),
    );
  });
});

test("Discovery distinguishes timeout from explicit cancellation", async () => {
  await withServer((_request, _response) => undefined, async (baseURL) => {
    await assert.rejects(
      () => discoverProviderModels({ provider: "openai", baseURL, apiKey: "secret-key" }, { timeoutMs: 25 }),
      (error: unknown) => error instanceof ProviderDiscoveryError && error.kind === "timeout",
    );

    const controller = new AbortController();
    const request = discoverProviderModels(
      { provider: "openai", baseURL, apiKey: "secret-key" },
      { signal: controller.signal, timeoutMs: 1_000 },
    );
    controller.abort();
    await assert.rejects(
      () => request,
      (error: unknown) => error instanceof ProviderDiscoveryError && error.kind === "cancelled",
    );
  });
});

test("Provider inference keeps adapter selection inside Main", () => {
  assert.equal(inferProviderFromBaseURL("https://api.deepseek.com"), "openai");
  assert.equal(inferProviderFromBaseURL("https://openrouter.ai/api/v1"), "openai");
  // 历史兼容子路径（/anthropic）也归为 openai：只有 OpenAI 兼容协议一种运行时
  assert.equal(inferProviderFromBaseURL("https://api.deepseek.com/anthropic"), "openai");
});

test("Probe ladder prefers the literal URL and falls back to the root endpoint", () => {
  assert.deepEqual(
    buildModelEndpointProbes("https://api.deepseek.com", "openai").map((probe) => probe.url),
    ["https://api.deepseek.com/v1/models", "https://api.deepseek.com/models"],
  );
  // 已带版本段时不再重复拼接 /v1
  assert.deepEqual(
    buildModelEndpointProbes("https://api.deepseek.com/v1", "openai").map((probe) => probe.url),
    ["https://api.deepseek.com/v1/models"],
  );
  // provider 参数不再影响探测路径（只有 openai 一种方言）
  assert.deepEqual(
    buildModelEndpointProbes("https://api.example.com/anthropic", "openai").map((probe) => probe.url),
    ["https://api.example.com/anthropic/v1/models", "https://api.example.com/anthropic/models"],
  );
});

test("Discovery reads explicit window, input and output limits from supported response layouts", async () => {
  const records = [
    { id: "top", context_window: 131072, max_input_tokens: 114688, max_output_tokens: 8192 },
    { id: "aliases", context_length: 128000, max_prompt_tokens: 120000, max_completion_tokens: 8000 },
    { id: "max-context", max_context_length: 64000 },
    { id: "limits", limits: { context: 100000, input: 90000, output: 10000 } },
    { id: "context", context: { window: 65536, max_input_tokens: 60000, max_output_tokens: 4096 } },
    { id: "top-provider", top_provider: { context_length: 128000, max_completion_tokens: 16384 } },
  ];
  const models = await discoverProviderModels({ provider: "openai", baseURL: "https://models.example.com/v1", apiKey: "test" }, {
    fetchImpl: async () => new Response(JSON.stringify({ data: records }), { headers: { "content-type": "application/json" } }),
  });
  const expected = new Map([
    ["top", { contextWindowTokens: 131072, maxInputTokens: 114688, maxOutputTokens: 8192, source: "provider" }],
    ["aliases", { contextWindowTokens: 128000, maxInputTokens: 120000, maxOutputTokens: 8000, source: "provider" }],
    ["max-context", { contextWindowTokens: 64000, source: "provider" }],
    ["limits", { contextWindowTokens: 100000, maxInputTokens: 90000, maxOutputTokens: 10000, source: "provider" }],
    ["context", { contextWindowTokens: 65536, maxInputTokens: 60000, maxOutputTokens: 4096, source: "provider" }],
    ["top-provider", { contextWindowTokens: 128000, maxOutputTokens: 16384, source: "provider" }],
  ]);
  for (const model of models) assert.deepEqual(model.capabilities, expected.get(model.id), model.id);
});

test("remote canonical numeric capabilities always retain provider provenance", async () => {
  const records = ["manual", "catalog", "provider", undefined].map((source, index) => ({
    id: `canonical-${index}`, capabilities: { contextWindowTokens: 96000, maxInputTokens: 88000, maxOutputTokens: 8000, source },
  }));
  const models = await discoverProviderModels({ provider: "openai", baseURL: "https://models.example.com/v1", apiKey: "test" }, {
    fetchImpl: async () => new Response(JSON.stringify({ data: records })),
  });
  for (const model of models) assert.deepEqual(model.capabilities, {
    contextWindowTokens: 96000, maxInputTokens: 88000, maxOutputTokens: 8000, source: "provider",
  });
});

test("Discovery accepts only positive safe integers and keeps unknown limits unknown", async () => {
  const records: unknown[] = [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "128000", null, Number.NaN, Number.POSITIVE_INFINITY]
    .map((context_window, index) => ({ id: `invalid-${index}`, context_window }));
  records.push(
    { id: "only-output", max_output_tokens: 8000 },
    { id: "only-input", max_input_tokens: 120000 },
    { id: "ambiguous", max_tokens: 64000, architecture: { context_length: 128000 } },
    { id: "optional-invalid", context_window: 64000, max_input_tokens: -1, max_output_tokens: 0.5 },
  );
  const models = await discoverProviderModels({ provider: "openai", baseURL: "https://models.example.com/v1", apiKey: "test" }, {
    fetchImpl: async () => new Response(JSON.stringify({ data: records })),
  });
  for (const model of models) {
    assert.deepEqual(model.capabilities, model.id === "optional-invalid" ? { contextWindowTokens: 64000, source: "provider" } : undefined);
  }
});

test("Discovery prefers provider windows and combines catalog fallback with explicit provider limits", async () => {
  const models = await discoverProviderModels({ provider: "openai", baseURL: "https://api.openai.com/v1", apiKey: "test" }, {
    fetchImpl: async () => new Response(JSON.stringify({ data: [
      { id: "gpt-4.1", context_window: 96000, max_output_tokens: 8000 },
      { id: "gpt-4.1-mini", max_prompt_tokens: 900000, max_completion_tokens: 4096 },
      { id: "unknown-model" },
    ] })),
  });
  assert.deepEqual(models.find((model) => model.id === "gpt-4.1")?.capabilities, { contextWindowTokens: 96000, maxOutputTokens: 8000, source: "provider" });
  assert.deepEqual(models.find((model) => model.id === "gpt-4.1-mini")?.capabilities, {
    contextWindowTokens: 1047576, maxInputTokens: 900000, maxOutputTokens: 4096, source: "catalog",
  });
  assert.equal(models.find((model) => model.id === "unknown-model")?.capabilities, undefined);
  const proxyModels = await discoverProviderModels({ provider: "openai", baseURL: "https://proxy.example.com/v1", apiKey: "test" }, {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "gpt-4.1" }] })),
  });
  assert.equal(proxyModels[0].capabilities, undefined);
});

test("duplicate IDs enrich capabilities across pages while preserving the first name and consistent fields", async () => {
  await withServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    json(response, url.searchParams.has("after") ? { data: [
      { id: "same", display_name: "Later name", context_window: 64000, max_input_tokens: 60000 },
      { id: "same", context_window: 64000, max_input_tokens: 50000, max_output_tokens: 4000 },
    ] } : { data: [{ id: "same", display_name: "First name" }], has_more: true, last_id: "page-one" });
  }, async (baseURL) => {
    assert.deepEqual(await discoverProviderModels({ provider: "openai", baseURL, apiKey: "test" }), [{
      id: "same", displayName: "First name",
      capabilities: { contextWindowTokens: 64000, maxInputTokens: 60000, maxOutputTokens: 4000, source: "provider" },
    }]);
  });
  const manual = { contextWindowTokens: 50000, source: "manual" as const };
  assert.deepEqual(normalizeDiscoveredModels([{ id: " manual ", displayName: " Manual ", capabilities: manual }]), [
    { id: "manual", displayName: "Manual", capabilities: manual },
  ]);
});

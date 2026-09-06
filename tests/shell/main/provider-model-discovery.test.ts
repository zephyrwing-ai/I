import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import {
  ProviderDiscoveryError,
  buildModelEndpointProbes,
  discoverProviderModels,
  discoveryErrorResult,
  inferProviderFromBaseURL,
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

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderStore, type SecretCodec } from "../../../shell/main/provider-store.js";

const codec: SecretCodec = {
  available: () => true,
  encrypt: (secret) => Buffer.from(`encrypted:${secret}`, "utf8").toString("base64"),
  decrypt: (payload) => Buffer.from(payload, "base64").toString("utf8").replace(/^encrypted:/, ""),
};

test("ProviderStore encrypts credentials in the provider file and preserves imported model identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-provider-"));
  const file = join(directory, "providers.json");
  try {
    const store = new ProviderStore(file, codec);
    const created = await store.save({
      name: "工作模型",
      baseURL: "https://api.example.com/v1",
      apiKey: "secret-key",
      models: [{ id: "model-a", displayName: "Model A" }],
    });
    assert.equal(created.models.length, 1);
    assert.equal(created.models[0].available, true);
    assert.equal(created.models[0].imported, true);
    assert.equal(created.models[0].state, "saved");
    assert.equal((await readFile(file, "utf8")).includes("secret-key"), false);
    assert.equal(typeof (JSON.parse(await readFile(file, "utf8")) as { profiles: Array<Record<string, unknown>> }).profiles[0]?.encryptedApiKey, "string");

    const resolved = await store.resolve(created.models[0].modelOptionId);
    assert.equal(await resolved.getApiKey(), "secret-key");
    assert.equal(resolved.modelId, "model-a");
    assert.equal(resolved.provider, "openai");
    const discoveryConnection = await store.discoveryConnection({
      requestId: "request-one",
      providerProfileId: created.providerProfileId,
      providerName: "工作模型",
      baseURL: "https://api.example.com/v1",
    });
    assert.equal(discoveryConnection.apiKey, "secret-key");

    const updated = await store.save({
      providerProfileId: created.providerProfileId,
      name: "工作模型",
      baseURL: "https://api.example.com/v1",
      models: [
        { id: "model-a", displayName: "Model A updated" },
        { id: "model-b", displayName: "model-b" },
      ],
    });
    assert.equal(updated.models[0].modelOptionId, created.models[0].modelOptionId);
    assert.notEqual(updated.models[1].modelOptionId, created.models[0].modelOptionId);

    const refreshed = await store.applyRefresh(created.providerProfileId, [
      { id: "model-a", displayName: "Model A remote" },
      { id: "model-c", displayName: "Model C" },
    ]);
    const modelA = refreshed.models.find((model) => model.modelId === "model-a");
    const modelB = refreshed.models.find((model) => model.modelId === "model-b");
    const modelC = refreshed.models.find((model) => model.modelId === "model-c");
    assert.deepEqual({ imported: modelA?.imported, available: modelA?.available, state: modelA?.state }, { imported: true, available: true, state: "saved" });
    assert.equal(modelB, undefined);
    assert.deepEqual({ imported: modelC?.imported, available: modelC?.available, state: modelC?.state }, { imported: true, available: true, state: "saved" });
    assert.equal((await store.resolve(modelC!.modelOptionId)).modelId, "model-c");

    const imported = await store.save({
      providerProfileId: created.providerProfileId,
      name: "工作模型",
      baseURL: "https://api.example.com/v1",
      models: [
        { id: "model-a", displayName: "Model A remote" },
        { id: "model-c", displayName: "Model C" },
      ],
    });
    assert.equal(imported.models.find((model) => model.modelId === "model-c")?.imported, true);

    const reloaded = new ProviderStore(file, codec);
    assert.equal((await reloaded.list())[0].models.length, 2);
    await reloaded.delete(created.providerProfileId);
    assert.deepEqual(await reloaded.list(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ProviderStore rejects saved credentials for another origin in both saving and discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-provider-origin-"));
  const file = join(directory, "providers.json");
  try {
    const store = new ProviderStore(file, codec);
    const created = await store.save({
      name: "Original provider",
      baseURL: "https://api.example.com/v1",
      apiKey: "original-key",
      models: [{ id: "model-a", displayName: "Model A" }],
    });
    const savedDocument = await readFile(file, "utf8");
    for (const baseURL of [
      "https://other.example.com/v1",
      "https://api.example.com:8443/v1",
      "http://api.example.com/v1",
    ]) {
      await assert.rejects(() => store.discoveryConnection({
        requestId: "request-changed-origin",
        providerProfileId: created.providerProfileId,
        providerName: created.name,
        baseURL,
        apiKey: "  ",
      }), /Enter an API Key for the new provider address/);
      await assert.rejects(() => store.save({
        providerProfileId: created.providerProfileId,
        name: created.name,
        baseURL,
        models: [{ id: "model-a", displayName: "Model A" }],
      }), /Enter an API Key for the new provider address/);
      assert.equal(await readFile(file, "utf8"), savedDocument);
    }
    assert.equal((await store.refreshConnection(created.providerProfileId)).apiKey, "original-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ProviderStore reuses credentials for canonical same-origin path changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-provider-same-origin-"));
  const file = join(directory, "providers.json");
  try {
    const store = new ProviderStore(file, codec);
    const created = await store.save({
      name: "Provider",
      baseURL: "https://api.example.com/v1",
      apiKey: "saved-key",
      models: [{ id: "model-a", displayName: "Model A" }],
    });
    const baseURL = "https://API.EXAMPLE.COM:443/custom/v2/";
    const discovered = await store.discoveryConnection({
      requestId: "request-same-origin",
      providerProfileId: created.providerProfileId,
      providerName: created.name,
      baseURL,
    });
    assert.equal(discovered.apiKey, "saved-key");
    const saved = await store.save({
      providerProfileId: created.providerProfileId,
      name: created.name,
      baseURL,
      models: [{ id: "model-a", displayName: "Model A" }],
    });
    assert.equal(saved.baseURL, "https://api.example.com/custom/v2");
    assert.equal(saved.models[0].modelOptionId, created.models[0].modelOptionId);
    assert.equal((await store.refreshConnection(created.providerProfileId)).apiKey, "saved-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ProviderStore requires an explicit replacement key for a changed origin and preserves connection snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-provider-snapshot-"));
  const file = join(directory, "providers.json");
  try {
    const store = new ProviderStore(file, codec);
    const created = await store.save({
      name: "Provider",
      baseURL: "https://original.example.com/v1",
      apiKey: "original-key",
      models: [{ id: "model-a", displayName: "Model A" }],
    });
    const originalConnection = await store.resolve(created.models[0].modelOptionId);
    const discovered = await store.discoveryConnection({
      requestId: "request-replacement-key",
      providerProfileId: created.providerProfileId,
      providerName: created.name,
      baseURL: "https://replacement.example.com/v2",
      apiKey: "replacement-key",
    });
    assert.equal(discovered.baseURL, "https://replacement.example.com/v2");
    assert.equal(discovered.apiKey, "replacement-key");
    // Discovery validates a draft and must not replace the saved connection.
    assert.equal((await store.refreshConnection(created.providerProfileId)).apiKey, "original-key");

    const updated = await store.save({
      providerProfileId: created.providerProfileId,
      name: created.name,
      baseURL: discovered.baseURL,
      apiKey: discovered.apiKey,
      models: [{ id: "model-a", displayName: "Model A" }],
    });
    const replacementConnection = await store.resolve(updated.models[0].modelOptionId);
    assert.equal(updated.models[0].modelOptionId, created.models[0].modelOptionId);
    assert.equal(originalConnection.baseURL, "https://original.example.com/v1");
    assert.equal(await originalConnection.getApiKey(), "original-key");
    assert.equal(replacementConnection.baseURL, discovered.baseURL);
    assert.equal(await replacementConnection.getApiKey(), "replacement-key");

    await store.save({
      providerProfileId: created.providerProfileId,
      name: created.name,
      baseURL: "https://replacement.example.com/v3",
      apiKey: "rotated-key",
      models: [{ id: "model-a", displayName: "Model A" }],
    });
    assert.equal(await replacementConnection.getApiKey(), "replacement-key");
    const latestConnection = await store.resolve(created.models[0].modelOptionId);
    assert.equal(latestConnection.baseURL, "https://replacement.example.com/v3");
    assert.equal(await latestConnection.getApiKey(), "rotated-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ProviderStore persists independent credentials and model identities across providers and restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-providers-independent-"));
  const file = join(directory, "providers.json");
  try {
    const store = new ProviderStore(file, codec);
    const [first, second] = await Promise.all([
      store.save({
        name: "First provider",
        baseURL: "https://first.example.com/v1",
        apiKey: "first-key",
        models: [{ id: "shared-model", displayName: "Shared model" }],
      }),
      store.save({
        name: "Second provider",
        baseURL: "https://second.example.com/v1",
        apiKey: "second-key",
        models: [{ id: "shared-model", displayName: "Shared model" }],
      }),
    ]);
    assert.notEqual(first.providerProfileId, second.providerProfileId);
    assert.notEqual(first.models[0].modelOptionId, second.models[0].modelOptionId);
    const reloaded = new ProviderStore(file, codec);
    assert.equal((await reloaded.list()).length, 2);
    for (const [profile, baseURL, apiKey] of [
      [first, "https://first.example.com/v1", "first-key"],
      [second, "https://second.example.com/v1", "second-key"],
    ] as const) {
      const resolved = await reloaded.resolve(profile.models[0].modelOptionId);
      assert.equal(resolved.baseURL, baseURL);
      assert.equal(await resolved.getApiKey(), apiKey);
    }
    const document = await readFile(file, "utf8");
    assert.equal(document.includes("first-key"), false);
    assert.equal(document.includes("second-key"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ProviderStore migrates version one profiles without exposing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-provider-v1-"));
  const file = join(directory, "providers.json");
  try {
    await writeFile(file, JSON.stringify({
      version: 1,
      profiles: [{
        providerProfileId: "legacy-profile",
        provider: "openai",
        displayName: "Legacy",
        baseURL: "https://api.deepseek.com/v1",
        encryptedApiKey: codec.encrypt("legacy-secret"),
        models: [{ modelOptionId: "legacy-model", modelId: "deepseek-chat", displayName: "DeepSeek Chat" }],
      }, {
        // 非 openai 的历史 profile 视为废弃数据，加载时被丢弃
        providerProfileId: "legacy-anthropic",
        provider: "anthropic",
        displayName: "Legacy Anthropic",
        baseURL: "https://api.anthropic.com",
        encryptedApiKey: codec.encrypt("anthropic-secret"),
        models: [{ modelOptionId: "legacy-anthropic-model", modelId: "claude-test", displayName: "Claude Test" }],
      }],
    }));
    const store = new ProviderStore(file, codec);
    const profiles = await store.list();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].name, "Legacy");
    assert.equal(profiles[0].models[0].imported, true);
    assert.equal(JSON.stringify(profiles).includes("legacy-secret"), false);
    assert.equal((JSON.parse(await readFile(file, "utf8")) as { version: number }).version, 1);
    assert.equal((await store.resolve("legacy-model")).provider, "openai");
    assert.equal((await store.discoveryConnection({
      requestId: "legacy-discovery",
      providerProfileId: "legacy-profile",
      providerName: "Legacy",
      baseURL: "https://api.deepseek.com/v2",
    })).apiKey, "legacy-secret");
    await assert.rejects(() => store.discoveryConnection({
      requestId: "legacy-changed-origin",
      providerProfileId: "legacy-profile",
      providerName: "Legacy",
      baseURL: "https://other.example.com/v1",
    }), /Enter an API Key for the new provider address/);
    await assert.rejects(() => store.resolve("legacy-anthropic-model"), /does not exist|unavailable/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ProviderStore removes legacy unavailable models when loading the catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-provider-cleanup-"));
  const file = join(directory, "providers.json");
  try {
    await writeFile(file, JSON.stringify({
      version: 2,
      profiles: [{
        providerProfileId: "stored-profile",
        provider: "openai",
        name: "Stored",
        baseURL: "https://api.example.com/v1",
        encryptedApiKey: codec.encrypt("stored-secret"),
        models: [
          {
            modelOptionId: "live-model",
            modelId: "model-live",
            displayName: "Model Live",
            available: true,
            imported: false,
            state: "new",
          },
          {
            modelOptionId: "old-model",
            modelId: "model-old",
            displayName: "Model Old",
            available: false,
            imported: true,
            state: "unavailable",
          },
        ],
      }],
    }));

    const store = new ProviderStore(file, codec);
    const profiles = await store.list();
    assert.deepEqual(profiles[0].models.map((model) => model.modelId), ["model-live"]);
    assert.equal(profiles[0].models[0].imported, true);
    assert.equal(profiles[0].models[0].state, "saved");
    await assert.rejects(() => store.resolve("old-model"), /does not exist|unavailable/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

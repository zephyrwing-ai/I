import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelCapabilities } from "../../../agent/model/types.js";
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

async function withCapabilityStore(run: (store: ProviderStore, file: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "provider-capabilities-"));
  const file = join(directory, "providers.json");
  try {
    await run(new ProviderStore(file, codec), file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ProviderStore retains provider capabilities through save, refresh, resolve and restart", async () => {
  await withCapabilityStore(async (store, file) => {
    const capabilities: ModelCapabilities = { contextWindowTokens: 96000, maxInputTokens: 88000, maxOutputTokens: 8000, source: "provider" };
    const profile = await store.save({
      name: "Capabilities", baseURL: "https://models.example.com/v1", apiKey: "secret",
      models: [{ id: "model-a", displayName: "Model A", capabilities }],
    });
    assert.deepEqual(profile.models[0].capabilities, capabilities);
    const id = profile.models[0].modelOptionId;
    const original = await store.resolve(id);
    assert.deepEqual(original.capabilities, capabilities);
    const saved = await store.save({
      providerProfileId: profile.providerProfileId, name: profile.name, baseURL: "https://models.example.com/v2",
      models: [{ id: "model-a", displayName: "Renamed" }],
    });
    assert.deepEqual(saved.models[0].capabilities, capabilities);
    const updated: ModelCapabilities = { contextWindowTokens: 128000, maxInputTokens: 120000, maxOutputTokens: 12000, source: "provider" };
    const refreshed = await store.applyRefresh(profile.providerProfileId, [{ id: "model-a", displayName: "Remote", capabilities: updated }]);
    assert.deepEqual(refreshed.models[0].capabilities, updated);
    assert.deepEqual(original.capabilities, capabilities);
    refreshed.models[0].capabilities!.contextWindowTokens = 1;
    assert.deepEqual((await store.list())[0].models[0].capabilities, updated);
    assert.deepEqual((await new ProviderStore(file, codec).resolve(id)).capabilities, updated);
    const document = JSON.parse(await readFile(file, "utf8"));
    assert.equal(document.version, 4);
    assert.deepEqual(document.profiles[0].models[0].capabilities, updated);
    assert.equal(JSON.stringify(document).includes("secret"), false);
  });
});

test("manual capabilities survive same-origin refreshes and explicit new-origin capabilities replace them", async () => {
  await withCapabilityStore(async (store) => {
    const manual: ModelCapabilities = { contextWindowTokens: 64000, maxOutputTokens: 4096, source: "manual" };
    const profile = await store.save({
      name: "Manual", baseURL: "https://api.openai.com/v1", apiKey: "original",
      models: [{ id: "gpt-4.1", displayName: "GPT", capabilities: manual }],
    });
    const remote: ModelCapabilities = { contextWindowTokens: 128000, maxInputTokens: 60000, maxOutputTokens: 8192, source: "provider" };
    const refreshed = await store.applyRefresh(profile.providerProfileId, [{ id: "gpt-4.1", displayName: "GPT", capabilities: remote }]);
    assert.deepEqual(refreshed.models[0].capabilities, { ...manual, maxInputTokens: 60000 });
    const saved = await store.save({
      providerProfileId: profile.providerProfileId, name: profile.name, baseURL: "https://API.OPENAI.COM:443/v2",
      models: [{ id: "gpt-4.1", displayName: "GPT" }],
    });
    assert.deepEqual(saved.models[0].capabilities, { ...manual, maxInputTokens: 60000 });
    const changed = await store.save({
      providerProfileId: profile.providerProfileId, name: profile.name, baseURL: "https://other.example.com/v1", apiKey: "replacement",
      models: [{ id: "gpt-4.1", displayName: "GPT" }],
    });
    assert.equal(changed.models[0].capabilities, undefined);
    const explicit = await store.save({
      providerProfileId: profile.providerProfileId, name: profile.name, baseURL: "https://new.example.com/v1", apiKey: "new-key",
      models: [{ id: "gpt-4.1", displayName: "GPT", capabilities: remote }],
    });
    assert.deepEqual(explicit.models[0].capabilities, remote);
  });
});

test("catalog fallback follows current provider metadata and precedes stale saved limits", async () => {
  await withCapabilityStore(async (store) => {
    const provider: ModelCapabilities = { contextWindowTokens: 500000, maxOutputTokens: 16000, source: "provider" };
    const profile = await store.save({
      name: "Catalog", baseURL: "https://api.openai.com/v1", apiKey: "key",
      models: [{ id: "gpt-4.1", displayName: "GPT", capabilities: provider }],
    });
    assert.deepEqual(profile.models[0].capabilities, provider);
    const refreshed = await store.applyRefresh(profile.providerProfileId, [{ id: "gpt-4.1", displayName: "GPT" }]);
    assert.deepEqual(refreshed.models[0].capabilities, { contextWindowTokens: 1047576, maxOutputTokens: 32768, source: "catalog" });
    assert.deepEqual((await store.resolve(profile.models[0].modelOptionId)).capabilities, refreshed.models[0].capabilities);
  });
});

test("legacy version-three profiles resolve catalog capabilities lazily while unknown models remain usable", async () => {
  await withCapabilityStore(async (_store, file) => {
    const profiles = [
      { providerProfileId: "known", provider: "openai", name: "Known", baseURL: "https://api.openai.com/v1", encryptedApiKey: codec.encrypt("known-key"),
        models: [{ modelOptionId: "known-model", modelId: "gpt-4.1", displayName: "GPT", available: true, imported: true, state: "saved" }] },
      { providerProfileId: "unknown", provider: "openai", name: "Unknown", baseURL: "https://custom.example.com/v1", encryptedApiKey: codec.encrypt("unknown-key"),
        models: [{ modelOptionId: "unknown-model", modelId: "custom-model", displayName: "Custom", available: true, imported: true, state: "saved" }] },
    ];
    const original = JSON.stringify({ version: 3, profiles });
    await writeFile(file, original);
    const store = new ProviderStore(file, codec);
    const known = await store.resolve("known-model");
    const unknown = await store.resolve("unknown-model");
    assert.deepEqual(known.capabilities, { contextWindowTokens: 1047576, maxOutputTokens: 32768, source: "catalog" });
    assert.equal(unknown.capabilities, undefined);
    assert.equal(await unknown.getApiKey(), "unknown-key");
    assert.deepEqual((await store.list())[0].models[0].capabilities, known.capabilities);
    assert.equal(await readFile(file, "utf8"), original);
  });
});

test("malformed explicit capabilities reject saving without replacing the profile or token limits", async () => {
  await withCapabilityStore(async (store, file) => {
    const valid: ModelCapabilities = { contextWindowTokens: 64000, source: "manual" };
    const profile = await store.save({
      name: "Validate", baseURL: "https://custom.example.com/v1", apiKey: "key",
      models: [{ id: "custom", displayName: "Custom", capabilities: valid }],
    });
    const before = await readFile(file, "utf8");
    const invalid = [null, {}, { contextWindowTokens: 0, source: "manual" }, { contextWindowTokens: "64000", source: "manual" },
      { contextWindowTokens: 64000, source: "unknown" }, { contextWindowTokens: 64000, source: "manual", maxInputTokens: -1 },
      { contextWindowTokens: 64000, source: "manual", maxOutputTokens: 0.5 }, { contextWindowTokens: 64000, source: "manual", maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 }];
    for (const capabilities of invalid) {
      await assert.rejects(store.save({
        providerProfileId: profile.providerProfileId, name: profile.name, baseURL: profile.baseURL,
        models: [{ id: "custom", displayName: "Custom", capabilities: capabilities as ModelCapabilities }],
      }), /capabilities.*positive safe integer/i);
      assert.equal(await readFile(file, "utf8"), before);
    }
    assert.deepEqual((await store.resolve(profile.models[0].modelOptionId)).capabilities, valid);
  });
});

test("loading a profile sanitizes old malformed capabilities without dropping the model or credentials", async () => {
  await withCapabilityStore(async (_store, file) => {
    await writeFile(file, JSON.stringify({ version: 4, profiles: [{
      providerProfileId: "sanitize", provider: "openai", name: "Sanitize", baseURL: "https://custom.example.com/v1", encryptedApiKey: codec.encrypt("key"),
      models: [
        { modelOptionId: "bad-window", modelId: "bad-window", displayName: "Bad", available: true, imported: true, state: "saved", capabilities: { contextWindowTokens: -1, source: "manual" } },
        { modelOptionId: "bad-output", modelId: "bad-output", displayName: "Output", available: true, imported: true, state: "saved", capabilities: { contextWindowTokens: 64000, maxOutputTokens: -1, source: "provider" } },
      ],
    }] }));
    const store = new ProviderStore(file, codec);
    const models = (await store.list())[0].models;
    assert.equal(models.length, 2);
    assert.equal(models[0].capabilities, undefined);
    assert.deepEqual(models[1].capabilities, { contextWindowTokens: 64000, source: "provider" });
    assert.equal(await (await store.resolve("bad-window")).getApiKey(), "key");
  });
});

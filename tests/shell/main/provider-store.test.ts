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
